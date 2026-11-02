import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { openDb, getSetting, setSetting } from "./db.js";
import { issuerFromEnv } from "./cards.js";
import { Notifier } from "./notify.js";
import { Wallet, hashKey } from "./wallet.js";
import { createApp } from "./app.js";
import { Passkeys, passkeyConfigFromUrl } from "./passkeys.js";
import { priceLookupFromEnv } from "./prices.js";
import { readFileSync } from "node:fs";
import { Vault } from "./vault.js";
import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile(".env");
} catch {
  // No .env file; use defaults and the real environment.
}

const env = process.env;
const databasePath = env.DATABASE_PATH ?? "./data/wallet.db";
const db = openDb(databasePath);
const vault = Vault.fromEnv(env, databasePath);
const issuer = issuerFromEnv(env);
const notifier = new Notifier(db, { subject: env.VAPID_SUBJECT });
const priceLookup = priceLookupFromEnv(env);
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

const port = Number(env.PORT ?? 3000);
const passkeys = new Passkeys(db, passkeyConfigFromUrl(env.PUBLIC_URL ?? `http://localhost:${port}`));

const app = createApp({
  wallet,
  notifier,
  passkeys,
  ownerTokenHash,
  enableDemoCharge: issuer.name === "mock",
  publicUrl: env.PUBLIC_URL,
  lithicWebhookSecret: env.LITHIC_WEBHOOK_SECRET,
});
if (issuer.name === "lithic" && !env.LITHIC_WEBHOOK_SECRET) {
  console.warn("  CARD_ISSUER=lithic without LITHIC_WEBHOOK_SECRET: charges won't be recorded. See README → Real cards.");
}
// The browser half of passkeys, served to the approval app from the installed package.
const webauthnBundle = readFileSync(new URL("../dist/bundle/index.umd.min.js", import.meta.resolve("@simplewebauthn/browser")));
app.get("/vendor/simplewebauthn.js", (c) => c.body(webauthnBundle, 200, { "Content-Type": "text/javascript" }));
app.use("/*", serveStatic({ root: fileURLToPath(new URL("../public", import.meta.url)) }));

serve({ fetch: app.fetch, port }, () => {
  console.log(`Agent Wallet running at http://localhost:${port} (cards: ${issuer.name}, price checks: ${priceLookup?.name ?? "off"})`);
});
