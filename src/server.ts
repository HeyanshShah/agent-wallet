import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";
import { openDb, getSetting, setSetting } from "./db.js";
import { issuerFromEnv } from "./cards.js";
import { Notifier } from "./notify.js";
import { Wallet, hashKey } from "./wallet.js";
import { createApp } from "./app.js";
import { Passkeys, passkeyConfigFromUrl } from "./passkeys.js";
import { priceLookupFromEnv } from "./prices.js";
import { Vault } from "./vault.js";
import { createHostedApp } from "./hosted.js";

try {
  process.loadEnvFile(".env");
} catch {
  // No .env file; use defaults and the real environment.
}

const env = process.env;
const port = Number(env.PORT ?? 3000);
const publicUrl = env.PUBLIC_URL ?? `http://localhost:${port}`;
const issuer = issuerFromEnv(env);
const priceLookup = priceLookupFromEnv(env);
const hosted = env.HOSTED === "1" || env.HOSTED === "true";

if (issuer.name === "lithic" && !env.LITHIC_WEBHOOK_SECRET) {
  console.warn("  CARD_ISSUER=lithic without LITHIC_WEBHOOK_SECRET: charges won't be recorded. See README → Real cards.");
}

function selfHosted(): Hono<any> {
  const databasePath = env.DATABASE_PATH ?? "./data/wallet.db";
  const db = openDb(databasePath);
  const vault = Vault.fromEnv(env, databasePath);
  const notifier = new Notifier(db, { subject: env.VAPID_SUBJECT });
  const wallet = new Wallet(db, issuer, notifier, Number(env.APPROVAL_TIMEOUT_MINUTES ?? 15), priceLookup, { vault });

  // The owner token unlocks the approval app. Generated once and shown on first start.
  let ownerTokenHash = getSetting(db, "owner_token_hash");
  if (env.OWNER_TOKEN) {
    ownerTokenHash = hashKey(env.OWNER_TOKEN);
  } else if (!ownerTokenHash) {
    const token = `aw_owner_${randomBytes(24).toString("base64url")}`;
    ownerTokenHash = hashKey(token);
    setSetting(db, "owner_token_hash", ownerTokenHash);
    console.log("\n  Your owner token (shown once, save it to sign in to the approval app):\n");
    console.log(`  ${token}\n`);
  }

  const app = createApp({
    wallet,
    notifier,
    passkeys: new Passkeys(db, passkeyConfigFromUrl(publicUrl)),
    ownerTokenHash,
    enableDemoCharge: issuer.name === "mock",
    publicUrl: env.PUBLIC_URL,
    lithicWebhookSecret: env.LITHIC_WEBHOOK_SECRET,
  });
  app.get("/config", (c) => c.json({ hosted: false }));
  return app;
}

function hostedApp(): Hono<any> {
  const dataDir = env.DATA_DIR ?? "./data";
  if (!env.PUBLIC_URL) console.warn("  HOSTED=1 without PUBLIC_URL: sign-in with Face ID and signed approvals will use localhost.");
  return createHostedApp({
    dataDir,
    publicUrl,
    vault: Vault.fromEnv(env, `${dataDir}/control.db`),
    issuer,
    priceLookup,
    lithicWebhookSecret: env.LITHIC_WEBHOOK_SECRET,
    vapidSubject: env.VAPID_SUBJECT,
    approvalTimeoutMinutes: Number(env.APPROVAL_TIMEOUT_MINUTES ?? 15),
    freeUntil: env.FREE_UNTIL || undefined,
    signupsOpen: env.SIGNUPS_OPEN !== "0",
  }).app;
}

const app = hosted ? hostedApp() : selfHosted();

// The browser half of passkeys, served to the approval app from the installed package.
const webauthnBundle = readFileSync(new URL("../dist/bundle/index.umd.min.js", import.meta.resolve("@simplewebauthn/browser")));
app.get("/vendor/simplewebauthn.js", (c) => c.body(webauthnBundle, 200, { "Content-Type": "text/javascript" }));
app.use("/*", serveStatic({ root: fileURLToPath(new URL("../public", import.meta.url)) }));

serve({ fetch: app.fetch, port }, () => {
  console.log(
    `Agent Wallet running at http://localhost:${port} (${hosted ? "hosted, multi-account" : "self-hosted"}, cards: ${issuer.name}, price checks: ${priceLookup?.name ?? "off"})`,
  );
});
