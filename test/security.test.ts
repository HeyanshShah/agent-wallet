import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { MockIssuer } from "../src/cards.js";
import { Notifier } from "../src/notify.js";
import { Wallet, hashKey } from "../src/wallet.js";
import { createApp } from "../src/app.js";
import { Passkeys } from "../src/passkeys.js";
import { Vault } from "../src/vault.js";
import { verifyApproval } from "../src/signer.js";
import { chargeFromLithicEvent, verifyWebhookSignature } from "../src/lithic-webhooks.js";

const OWNER = "owner-test-token";
const WEBHOOK_SECRET = "whsec_" + Buffer.from("a-test-webhook-secret-32-bytes!!").toString("base64");

function setup() {
  const db = openDb(":memory:");
  const notifier = new Notifier(db, { enablePush: false });
  const vault = Vault.ephemeral();
  const wallet = new Wallet(db, new MockIssuer(), notifier, 15, undefined, { vault });
  const passkeys = new Passkeys(db, { rpID: "localhost", rpName: "Agent Wallet", origin: "http://localhost:3000" });
  const app = createApp({
    wallet,
    notifier,
    passkeys,
    ownerTokenHash: hashKey(OWNER),
    enableDemoCharge: true,
    publicUrl: "https://wallet.example",
    lithicWebhookSecret: WEBHOOK_SECRET,
  });
  const req = (method: string, path: string, token: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  return { db, app, wallet, vault, req };
}

let t: ReturnType<typeof setup>;
let agentKey: string;

beforeEach(async () => {
  t = setup();
  const res = await t.req("POST", "/api/agents", OWNER, {
    name: "Shopper",
    monthlyBudgetCents: 50_000,
    perPurchaseCapCents: 30_000,
    autoApproveUnderCents: 2_500,
  });
  agentKey = (await res.json()).apiKey;
});

const buy = async (amount_cents: number, merchant = "Best Buy") =>
  (await t.req("POST", "/v1/purchases", agentKey, { amount_cents, merchant, reason: "Charger for the owner" })).json();

function signedWebhook(body: object, secret = WEBHOOK_SECRET, at = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(body);
  const id = `msg_${Math.random().toString(36).slice(2)}`;
  const key = Buffer.from(secret.slice(6), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${at}.${raw}`).digest("base64");
  return t.app.request("/webhooks/lithic", {
    method: "POST",
    headers: { "Content-Type": "application/json", "webhook-id": id, "webhook-timestamp": String(at), "webhook-signature": `v1,${sig}` },
    body: raw,
  });
}

const lithicTx = (cardToken: string, token: string, amount: number) => ({
  event_type: "card_transaction.updated",
  payload: { token, card_token: cardToken, status: "SETTLED", result: "APPROVED", amount, merchant: { descriptor: "BEST BUY 00123" } },
});

describe("signed approvals", () => {
  it("signs auto-approvals so anyone can verify them with the public key", async () => {
    const bought = await buy(1_999);
    expect(bought.approval_token).toBeTypeOf("string");
    const jwks = await (await t.app.request("/.well-known/jwks.json")).json();
    const result = verifyApproval(bought.approval_token, jwks);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.claims).toMatchObject({
      iss: "https://wallet.example",
      jti: bought.id,
      amount: { value: 1_999, currency: "USD" },
      merchant: "Best Buy",
      approval: "auto",
      card_last4: bought.card.number.slice(-4),
    });
  });

  it("rejects edited or foreign tokens", async () => {
    const { approval_token } = await buy(1_999);
    const jwks = await (await t.app.request("/.well-known/jwks.json")).json();
    const [h, p, s] = approval_token.split(".");
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    claims.amount.value = 999_999;
    const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${s}`;
    expect(verifyApproval(forged, jwks)).toEqual({ valid: false, error: "Signature doesn't match." });
    const otherWallet = setup().wallet;
    expect(verifyApproval(approval_token, { keys: [otherWallet.signer.jwk] }).valid).toBe(false);
    expect(verifyApproval(approval_token, jwks, Date.now() + 25 * 3600_000)).toEqual({ valid: false, error: "Approval has expired." });
  });

  it("only signs approved purchases, and records how they were approved", async () => {
    const pending = await buy(9_000);
    expect(pending.status).toBe("pending");
    expect(pending.approval_token).toBeUndefined();
    await t.req("POST", `/api/requests/${pending.id}/approve`, OWNER);
    const approved = await (await t.req("GET", `/v1/purchases/${pending.id}`, agentKey)).json();
    const verified = await (await t.req("POST", "/verify", "", { token: approved.approval_token })).json();
    expect(verified).toMatchObject({ valid: true, claims: { approval: "owner", amount: { value: 9_000 } } });
  });

  it("advertises signed approvals in the discovery document", async () => {
    const doc = await (await t.app.request("/.well-known/agent-spend")).json();
    expect(doc.jwks_uri).toMatch(/\/\.well-known\/jwks\.json$/);
    expect(doc.features).toContain("signed_approvals");
  });
});

describe("card details at rest", () => {
  it("encrypts card numbers in the database and deletes them after use", async () => {
    const { card } = await buy(1_500);
    const row = t.db.prepare("SELECT pan, cvv FROM cards WHERE id = ?").get(card.id) as any;
    expect(row.pan.startsWith("enc:v1:")).toBe(true);
    expect(row.pan).not.toContain(card.number);
    expect(t.vault.decrypt(row.pan)).toBe(card.number);

    await t.req("POST", `/v1/cards/${card.id}/charge`, agentKey, { amount_cents: 1_500, merchant: "Best Buy" });
    const used = t.db.prepare("SELECT pan, cvv FROM cards WHERE id = ?").get(card.id) as any;
    expect(used).toEqual({ pan: "", cvv: "" });
  });

  it("encrypts cards written by older versions on start", () => {
    const db = openDb(":memory:");
    const vault = Vault.ephemeral();
    const w = new Wallet(db, new MockIssuer(), new Notifier(db, { enablePush: false }), 15, undefined, { vault });
    const { agent } = w.createAgent({ name: "Old", monthlyBudgetCents: 1, perPurchaseCapCents: 1 });
    db.prepare("INSERT INTO purchase_requests (id, agent_id, amount_cents, merchant, reason, status, created_at) VALUES ('r', ?, 1, 'x', 'y', 'approved', '2026-01-01')").run(agent.id);
    db.prepare("INSERT INTO cards (id, request_id, provider, provider_card_id, pan, cvv, exp_month, exp_year, last4, spend_limit_cents, state, created_at) VALUES ('c', 'r', 'mock', 'm', '4000001234567899', '123', 1, 2030, '7899', 1, 'open', '2026-01-01')").run();
    new Wallet(db, new MockIssuer(), new Notifier(db, { enablePush: false }), 15, undefined, { vault });
    const row = db.prepare("SELECT pan FROM cards WHERE id = 'c'").get() as any;
    expect(vault.decrypt(row.pan)).toBe("4000001234567899");
    expect(row.pan).not.toContain("4000001234567899");
  });

  it("can't be read with a different key", () => {
    const sealed = Vault.ephemeral().encrypt("4000001234567899");
    expect(() => Vault.ephemeral().decrypt(sealed)).toThrow();
  });
});

describe("Lithic charge webhooks", () => {
  it("records a real charge once, however many times it's delivered", async () => {
    const { card, id } = await buy(1_800);
    const cardToken = (t.db.prepare("SELECT provider_card_id AS p FROM cards WHERE id = ?").get(card.id) as any).p;
    const event = lithicTx(cardToken, "tx_1", 1_749);
    expect(await (await signedWebhook(event)).json()).toEqual({ ok: true, result: "recorded" });
    expect(await (await signedWebhook(event)).json()).toEqual({ ok: true, result: "duplicate" });
    const after = await (await t.req("GET", `/v1/purchases/${id}`, agentKey)).json();
    expect(after).toMatchObject({ status: "completed", amount_cents: 1_749 });
    expect(after.card).toBeUndefined();
  });

  it("alerts the owner if a used card is charged again", async () => {
    const { card } = await buy(1_800);
    const cardToken = (t.db.prepare("SELECT provider_card_id AS p FROM cards WHERE id = ?").get(card.id) as any).p;
    await signedWebhook(lithicTx(cardToken, "tx_1", 1_800));
    expect(await (await signedWebhook(lithicTx(cardToken, "tx_2", 1_800))).json()).toEqual({ ok: true, result: "unexpected" });
    expect(t.wallet.listEvents().map((e: any) => e.type)).toContain("charge_alert");
  });

  it("rejects unsigned, wrongly signed and stale webhooks", async () => {
    const event = lithicTx("x", "tx", 100);
    expect((await t.app.request("/webhooks/lithic", { method: "POST", body: JSON.stringify(event) })).status).toBe(401);
    expect((await signedWebhook(event, "whsec_" + Buffer.from("wrong").toString("base64"))).status).toBe(401);
    expect((await signedWebhook(event, WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 3600)).status).toBe(401);
  });

  it("ignores declines and other events", () => {
    expect(chargeFromLithicEvent({ event_type: "card_transaction.updated", payload: { token: "t", card_token: "c", status: "DECLINED", result: "INSUFFICIENT_FUNDS", amount: 5 } })).toBeUndefined();
    expect(chargeFromLithicEvent({ event_type: "card.created", payload: {} })).toBeUndefined();
    expect(verifyWebhookSignature(WEBHOOK_SECRET, {}, "{}")).toBe(false);
  });
});

describe("tamper-evident activity log", () => {
  it("detects an edited entry", async () => {
    await buy(1_000);
    await buy(99_999);
    const ok = await (await t.req("GET", "/api/events/verify", OWNER)).json();
    expect(ok).toMatchObject({ ok: true });
    expect(ok.entries).toBeGreaterThan(3);
    t.db.prepare("UPDATE events SET message = 'nothing happened' WHERE type = 'request_blocked'").run();
    const broken = await (await t.req("GET", "/api/events/verify", OWNER)).json();
    expect(broken.ok).toBe(false);
  });
});

describe("abuse protection", () => {
  it("slows down guessing keys", async () => {
    for (let i = 0; i < 20; i++) await t.req("GET", "/v1/me", "wrong", undefined, { "x-forwarded-for": "6.6.6.6" });
    expect((await t.req("GET", "/v1/me", agentKey, undefined, { "x-forwarded-for": "6.6.6.6" })).status).toBe(429);
    expect((await t.req("GET", "/v1/me", agentKey, undefined, { "x-forwarded-for": "7.7.7.7" })).status).toBe(200);
  });

  it("limits how fast one agent can ask for money", async () => {
    const statuses = [];
    for (let i = 0; i < 31; i++) statuses.push((await t.req("POST", "/v1/purchases", agentKey, { amount_cents: 100, merchant: "Amazon", reason: "x" })).status);
    expect(statuses.at(-1)).toBe(429);
  });

  it("rejects oversized requests and sends security headers", async () => {
    const big = await t.req("POST", "/v1/purchases", agentKey, { amount_cents: 100, merchant: "A", reason: "x".repeat(70_000) });
    expect(big.status).toBe(413);
    const health = await t.app.request("/health");
    expect(health.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
