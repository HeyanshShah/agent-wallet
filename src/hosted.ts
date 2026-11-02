// Hosted mode: one server, many customers. Each customer signs up with an email and password and
// gets their own wallet in its own SQLite file, so one customer's data never shares tables with another's.
// A small control database holds accounts, login sessions, and which wallet each agent key and card belongs to.
import { Hono, type Context } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { rmSync } from "node:fs";
import { promisify } from "node:util";
import { type Db, openDb } from "./db.js";
import { hashKey, Wallet } from "./wallet.js";
import { Notifier } from "./notify.js";
import { Passkeys, passkeyConfigFromUrl } from "./passkeys.js";
import { createApp } from "./app.js";
import type { CardIssuer } from "./cards.js";
import type { PriceLookup } from "./prices.js";
import type { Vault } from "./vault.js";
import { RateLimiter } from "./rate-limit.js";
import { verifyWebhookSignature } from "./lithic-webhooks.js";

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const SESSION_DAYS = 30;

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt:${salt.toString("base64")}:${key.toString("base64")}`;
}

async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [, salt, key] = stored.split(":");
  const expected = Buffer.from(key, "base64");
  const given = await scryptAsync(password, Buffer.from(salt, "base64"), expected.length);
  return timingSafeEqual(given, expected);
}

export interface Account {
  id: string;
  email: string;
  createdAt: string;
}

export class Accounts {
  constructor(readonly db: Db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_routes (
        key_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS card_routes (
        provider_card_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE
      );
    `);
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n;
  }

  get(id: string): Account | undefined {
    const r = this.db.prepare("SELECT id, email, created_at FROM accounts WHERE id = ?").get(id) as any;
    return r ? { id: r.id, email: r.email, createdAt: r.created_at } : undefined;
  }

  async create(email: string, password: string): Promise<Account> {
    const exists = this.db.prepare("SELECT 1 FROM accounts WHERE email = ?").get(email);
    if (exists) throw new HostedError("An account with that email already exists. Sign in instead.", 409);
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO accounts (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(id, email, await hashPassword(password), new Date().toISOString());
    return this.get(id)!;
  }

  async login(email: string, password: string): Promise<Account | undefined> {
    const r = this.db.prepare("SELECT id, password_hash FROM accounts WHERE email = ?").get(email) as any;
    // Hash anyway when the email is unknown, so response time doesn't reveal which emails have accounts.
    if (!r) {
      await hashPassword(password);
      return undefined;
    }
    return (await checkPassword(password, r.password_hash)) ? this.get(r.id) : undefined;
  }

  async verifyPassword(accountId: string, password: string): Promise<boolean> {
    const r = this.db.prepare("SELECT password_hash FROM accounts WHERE id = ?").get(accountId) as any;
    return !!r && checkPassword(password, r.password_hash);
  }

  startSession(accountId: string): string {
    const token = `aw_sess_${randomBytes(32).toString("base64url")}`;
    const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
    this.db.prepare("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)").run(hashKey(token), accountId, expires);
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());
    return token;
  }

  sessionAccount(token: string): string | undefined {
    const r = this.db.prepare("SELECT account_id, expires_at FROM sessions WHERE token_hash = ?").get(hashKey(token)) as any;
    return r && r.expires_at > new Date().toISOString() ? r.account_id : undefined;
  }

  endSession(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashKey(token));
  }

  routeAgent(keyHash: string, accountId: string): void {
    this.db.prepare("INSERT OR REPLACE INTO agent_routes (key_hash, account_id) VALUES (?, ?)").run(keyHash, accountId);
  }

  agentAccount(key: string): string | undefined {
    return (this.db.prepare("SELECT account_id FROM agent_routes WHERE key_hash = ?").get(hashKey(key)) as any)?.account_id;
  }

  routeCard(providerCardId: string, accountId: string): void {
    this.db.prepare("INSERT OR REPLACE INTO card_routes (provider_card_id, account_id) VALUES (?, ?)").run(providerCardId, accountId);
  }

  cardAccount(providerCardId: string): string | undefined {
    return (this.db.prepare("SELECT account_id FROM card_routes WHERE provider_card_id = ?").get(providerCardId) as any)?.account_id;
  }

  delete(accountId: string): void {
    this.db.prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
  }
}

export class HostedError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 409 | 429 = 400,
  ) {
    super(message);
  }
}

export interface HostedOptions {
  /** Folder for control.db and one wallet file per customer. ":memory:" keeps everything in memory (tests). */
  dataDir: string;
  publicUrl: string;
  vault: Vault;
  issuer: CardIssuer;
  priceLookup?: PriceLookup;
  lithicWebhookSecret?: string;
  vapidSubject?: string;
  enablePush?: boolean;
  approvalTimeoutMinutes?: number;
  /** Everything is free until this date (early access). Shown in the app. */
  freeUntil?: string;
  /** Set to false to close sign-ups. */
  signupsOpen?: boolean;
}

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10, "Use at least 10 characters for your password.").max(200),
});

function bearer(c: Context): string | undefined {
  const h = c.req.header("Authorization");
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
}

export function createHostedApp(opts: HostedOptions) {
  const memory = opts.dataDir === ":memory:";
  const accounts = new Accounts(openDb(memory ? ":memory:" : `${opts.dataDir}/control.db`));
  const base = opts.publicUrl.replace(/\/$/, "");
  const tenants = new Map<string, { app: ReturnType<typeof createApp>; wallet: Wallet; db: Db }>();
  const tenantPath = (id: string) => `${opts.dataDir}/tenants/${id}.db`;

  const tenant = (accountId: string) => {
    let t = tenants.get(accountId);
    if (t) return t;
    const db = openDb(memory ? ":memory:" : tenantPath(accountId));
    const notifier = new Notifier(db, { subject: opts.vapidSubject, enablePush: opts.enablePush, basePath: `/t/${accountId}` });
    const wallet = new Wallet(db, opts.issuer, notifier, opts.approvalTimeoutMinutes ?? 15, opts.priceLookup, {
      vault: opts.vault,
      onAgentCreated: (keyHash) => accounts.routeAgent(keyHash, accountId),
      onCardIssued: (cardId) => accounts.routeCard(cardId, accountId),
    });
    const passkeys = new Passkeys(db, passkeyConfigFromUrl(base));
    const app = createApp({
      wallet,
      notifier,
      passkeys,
      ownerAuth: (token) => accounts.sessionAccount(token) === accountId,
      enableDemoCharge: opts.issuer.name === "mock",
      publicUrl: `${base}/t/${accountId}`,
      lithicWebhookSecret: opts.lithicWebhookSecret,
    });
    t = { app, wallet, db };
    tenants.set(accountId, t);
    return t;
  };

  const app = new Hono();
  const authLimit = new RateLimiter(10, 15 * 60_000);
  const badKeys = new RateLimiter(20, 60_000);
  const clientIp = (c: Context) => c.req.header("x-forwarded-for")?.split(",")[0].trim() || c.req.header("x-real-ip") || "local";

  app.use("*", secureHeaders({ crossOriginResourcePolicy: false, crossOriginOpenerPolicy: false }));
  app.use("*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "Request too large." }, 413) }));

  app.onError((err, c) => {
    if (err instanceof HostedError) return c.json({ error: err.message }, err.status);
    if (err instanceof z.ZodError) return c.json({ error: err.issues[0]?.message ?? "Invalid input.", issues: err.issues }, 400);
    console.error(err);
    return c.json({ error: "Something went wrong." }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/config", (c) =>
    c.json({ hosted: true, freeUntil: opts.freeUntil ?? null, signupsOpen: opts.signupsOpen !== false }),
  );

  // ---------- sign-up and sign-in ----------

  app.post("/auth/signup", async (c) => {
    if (opts.signupsOpen === false) throw new HostedError("Sign-ups are closed for now.");
    if (!authLimit.hit(`signup:${clientIp(c)}`)) throw new HostedError("Too many attempts. Try again in a few minutes.", 429);
    const { email, password } = credentialsSchema.parse(await c.req.json());
    const account = await accounts.create(email, password);
    tenant(account.id);
    return c.json({ token: accounts.startSession(account.id), account }, 201);
  });

  app.post("/auth/login", async (c) => {
    const body = z.object({ email: z.string().trim().toLowerCase(), password: z.string() }).parse(await c.req.json());
    if (!authLimit.hit(`login:${clientIp(c)}`) || !authLimit.hit(`login:${body.email}`)) {
      throw new HostedError("Too many attempts. Try again in a few minutes.", 429);
    }
    const account = await accounts.login(body.email, body.password);
    if (!account) throw new HostedError("That email and password don't match.", 401);
    return c.json({ token: accounts.startSession(account.id), account });
  });

  app.post("/auth/logout", (c) => {
    const token = bearer(c);
    if (token) accounts.endSession(token);
    return c.json({ ok: true });
  });

  // ---------- the signed-in customer's own wallet ----------

  const sessionFor = (c: Context) => {
    const token = bearer(c) ?? c.req.query("token");
    return token ? accounts.sessionAccount(token) : undefined;
  };

  app.get("/api/account", (c) => {
    const id = sessionFor(c);
    const account = id && accounts.get(id);
    if (!account) return c.json({ error: "Signed out." }, 401);
    return c.json({ ...account, plan: "early_access", freeUntil: opts.freeUntil ?? null, walletUrl: `${base}/t/${account.id}` });
  });

  // Deletes the account and its whole wallet. Needs the password again.
  app.delete("/api/account", async (c) => {
    const id = sessionFor(c);
    if (!id) return c.json({ error: "Signed out." }, 401);
    const { password } = z.object({ password: z.string() }).parse(await c.req.json());
    if (!(await accounts.verifyPassword(id, password))) throw new HostedError("Wrong password.", 403);
    const t = tenants.get(id);
    t?.db.close();
    tenants.delete(id);
    accounts.delete(id);
    if (!memory) {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(tenantPath(id) + suffix, { force: true });
    }
    return c.json({ ok: true });
  });

  app.all("/api/*", (c) => {
    const id = sessionFor(c);
    if (!id) return c.json({ error: "Signed out." }, 401);
    return tenant(id).app.fetch(c.req.raw);
  });

  // ---------- agents: the agent key says which wallet ----------

  app.all("/v1/*", (c) => {
    const ip = clientIp(c);
    if (badKeys.blocked(ip)) return c.json({ error: "Too many failed attempts. Try again in a minute." }, 429);
    const key = bearer(c);
    const id = key ? accounts.agentAccount(key) : undefined;
    if (!id) {
      badKeys.hit(ip);
      return c.json({ error: "Invalid agent key." }, 401);
    }
    return tenant(id).app.fetch(c.req.raw);
  });

  // ---------- each wallet's public routes: discovery, keys, verify, notification buttons ----------

  app.all("/t/:account/*", (c) => {
    const id = c.req.param("account");
    if (!accounts.get(id)) return c.json({ error: "Not found." }, 404);
    const url = new URL(c.req.url);
    url.pathname = url.pathname.slice(`/t/${id}`.length) || "/";
    if (!/^\/(\.well-known\/|verify$|quick\/|health$)/.test(url.pathname)) return c.json({ error: "Not found." }, 404);
    return tenant(id).app.fetch(new Request(url, c.req.raw));
  });

  // ---------- real card charges: Lithic sends one webhook for every customer's cards ----------

  if (opts.lithicWebhookSecret) {
    app.post("/webhooks/lithic", async (c) => {
      const raw = await c.req.text();
      const signed = verifyWebhookSignature(
        opts.lithicWebhookSecret!,
        { id: c.req.header("webhook-id"), timestamp: c.req.header("webhook-timestamp"), signature: c.req.header("webhook-signature") },
        raw,
      );
      if (!signed) return c.json({ error: "Bad signature." }, 401);
      let cardToken: string | undefined;
      try {
        const event = JSON.parse(raw);
        cardToken = (event.payload ?? event)?.card_token;
      } catch {
        return c.json({ error: "Bad JSON." }, 400);
      }
      const id = cardToken ? accounts.cardAccount(cardToken) : undefined;
      if (!id) return c.json({ ok: true, result: "unknown_card" });
      // The wallet checks the signature again, then records the charge.
      return tenant(id).app.fetch(new Request(c.req.url, { method: "POST", headers: c.req.raw.headers, body: raw }));
    });
  }

  return { app, accounts, tenant };
}
