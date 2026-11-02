import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createHostedApp } from "../src/hosted.js";
import { MockIssuer } from "../src/cards.js";
import { Vault } from "../src/vault.js";
import { verifyApproval } from "../src/signer.js";

const SECRET = "whsec_" + Buffer.from("hosted-webhook-secret-32-bytes!!").toString("base64");

let h: ReturnType<typeof createHostedApp>;
let ip = 0;

beforeEach(() => {
  h = createHostedApp({
    dataDir: ":memory:",
    publicUrl: "https://agentwallet.example",
    vault: Vault.ephemeral(),
    issuer: new MockIssuer(),
    enablePush: false,
    freeUntil: "2027-11-02",
    lithicWebhookSecret: SECRET,
  });
});

const call = (method: string, path: string, token?: string, body?: unknown) =>
  h.app.request(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      // A different address per call, so sign-up limits don't trip across tests.
      "x-forwarded-for": `10.0.0.${++ip % 250}`,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

async function signUp(email: string) {
  const res = await call("POST", "/auth/signup", undefined, { email, password: "correct horse battery" });
  expect(res.status).toBe(201);
  return (await res.json()).token as string;
}

async function addAgent(session: string, name = "Shopper") {
  const res = await call("POST", "/api/agents", session, {
    name,
    monthlyBudgetCents: 50_000,
    perPurchaseCapCents: 30_000,
    autoApproveUnderCents: 2_500,
  });
  expect(res.status).toBe(201);
  return (await res.json()).apiKey as string;
}

describe("accounts", () => {
  it("signs up, signs in and out", async () => {
    const session = await signUp("Ana@Example.com");
    const me = await (await call("GET", "/api/account", session)).json();
    expect(me).toMatchObject({ email: "ana@example.com", plan: "early_access", freeUntil: "2027-11-02" });

    expect((await call("POST", "/auth/login", undefined, { email: "ana@example.com", password: "wrong password!" })).status).toBe(401);
    const login = await call("POST", "/auth/login", undefined, { email: "ANA@example.com", password: "correct horse battery" });
    expect(login.status).toBe(200);
    const second = (await login.json()).token;

    await call("POST", "/auth/logout", second);
    expect((await call("GET", "/api/agents", second)).status).toBe(401);
    expect((await call("GET", "/api/agents", session)).status).toBe(200);
  });

  it("rejects duplicate emails and weak passwords", async () => {
    await signUp("bo@example.com");
    expect((await call("POST", "/auth/signup", undefined, { email: "bo@example.com", password: "another long one" })).status).toBe(409);
    const weak = await call("POST", "/auth/signup", undefined, { email: "cy@example.com", password: "short" });
    expect(weak.status).toBe(400);
    expect((await weak.json()).error).toMatch(/10 characters/);
  });

  it("stores passwords hashed", async () => {
    await signUp("di@example.com");
    const row = h.accounts.db.prepare("SELECT password_hash FROM accounts").get() as any;
    expect(row.password_hash).toMatch(/^scrypt:/);
    expect(row.password_hash).not.toContain("correct horse");
  });

  it("slows down password guessing", async () => {
    await signUp("ed@example.com");
    const statuses = [];
    for (let i = 0; i < 11; i++) statuses.push((await call("POST", "/auth/login", undefined, { email: "ed@example.com", password: "guess number " + i })).status);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe("one wallet per customer", () => {
  it("keeps customers' agents, requests and history apart", async () => {
    const ana = await signUp("ana@example.com");
    const bo = await signUp("bo@example.com");
    const anaKey = await addAgent(ana, "Ana's agent");
    await addAgent(bo, "Bo's agent");

    const buy = await call("POST", "/v1/purchases", anaKey, { amount_cents: 9_000, merchant: "Best Buy", reason: "Headphones" });
    const pending = await buy.json();
    expect(pending.status).toBe("pending");

    const boAgents = await (await call("GET", "/api/agents", bo)).json();
    expect(boAgents.map((a: any) => a.name)).toEqual(["Bo's agent"]);
    expect(await (await call("GET", "/api/requests", bo)).json()).toEqual([]);
    // Bo can't approve Ana's purchase.
    expect((await call("POST", `/api/requests/${pending.id}/approve`, bo)).status).toBe(404);
    expect((await call("POST", `/api/requests/${pending.id}/approve`, ana)).status).toBe(200);
  });

  it("routes agents by their key and rejects unknown keys", async () => {
    const ana = await signUp("ana@example.com");
    const key = await addAgent(ana);
    expect((await (await call("GET", "/v1/me", key)).json()).name).toBe("Shopper");
    expect((await call("GET", "/v1/me", "aw_agent_nope")).status).toBe(401);
    expect((await call("GET", "/v1/me", ana)).status).toBe(401);
  });

  it("gives each customer their own signing key and public routes", async () => {
    const ana = await signUp("ana@example.com");
    const key = await addAgent(ana);
    const { approval_token } = await (await call("POST", "/v1/purchases", key, { amount_cents: 1_000, merchant: "Amazon", reason: "Cable" })).json();
    const { walletUrl } = await (await call("GET", "/api/account", ana)).json();
    const path = new URL(walletUrl).pathname;

    const jwks = await (await call("GET", `${path}/.well-known/jwks.json`)).json();
    const result = verifyApproval(approval_token, jwks);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.claims.iss).toBe(walletUrl);
    expect((await (await call("GET", `${path}/.well-known/agent-spend`)).json()).issuer).toBe(walletUrl);
    expect((await (await call("POST", `${path}/verify`, undefined, { token: approval_token })).json()).valid).toBe(true);

    // Only public routes are reachable this way.
    expect((await call("GET", `${path}/api/agents`, ana)).status).toBe(404);
    expect((await call("GET", `/t/not-an-account/.well-known/jwks.json`)).status).toBe(404);
  });

  it("sends each Lithic webhook to the wallet that owns the card", async () => {
    const ana = await signUp("ana@example.com");
    const key = await addAgent(ana);
    const bought = await (await call("POST", "/v1/purchases", key, { amount_cents: 1_200, merchant: "Amazon", reason: "Cable" })).json();
    const t = h.tenant(h.accounts.sessionAccount(ana)!);
    const cardToken = (t.db.prepare("SELECT provider_card_id AS p FROM cards").get() as any).p;

    const raw = JSON.stringify({
      event_type: "card_transaction.updated",
      payload: { token: "tx_9", card_token: cardToken, status: "SETTLED", result: "APPROVED", amount: 1_150, merchant: { descriptor: "AMAZON" } },
    });
    const at = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", Buffer.from(SECRET.slice(6), "base64")).update(`msg_1.${at}.${raw}`).digest("base64");
    const res = await h.app.request("/webhooks/lithic", {
      method: "POST",
      headers: { "Content-Type": "application/json", "webhook-id": "msg_1", "webhook-timestamp": String(at), "webhook-signature": `v1,${sig}` },
      body: raw,
    });
    expect(await res.json()).toEqual({ ok: true, result: "recorded" });
    expect((await (await call("GET", `/v1/purchases/${bought.id}`, key)).json()).status).toBe("completed");

    const unsigned = await h.app.request("/webhooks/lithic", { method: "POST", body: raw });
    expect(unsigned.status).toBe(401);
  });

  it("deletes an account and everything in it, with the password", async () => {
    const ana = await signUp("ana@example.com");
    const key = await addAgent(ana);
    expect((await call("DELETE", "/api/account", ana, { password: "not my password" })).status).toBe(403);
    expect((await call("DELETE", "/api/account", ana, { password: "correct horse battery" })).status).toBe(200);
    expect((await call("GET", "/api/agents", ana)).status).toBe(401);
    expect((await call("GET", "/v1/me", key)).status).toBe(401);
    expect(h.accounts.count()).toBe(0);
  });
});
