import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { MockIssuer } from "../src/cards.js";
import { Notifier } from "../src/notify.js";
import { Wallet, hashKey } from "../src/wallet.js";
import { createApp } from "../src/app.js";
import { Passkeys } from "../src/passkeys.js";
import { DemoLookup, type PriceLookup } from "../src/prices.js";

const OWNER = "owner-test-token";

function setup(priceLookup?: PriceLookup, extra: { lithicWebhookSecret?: string } = {}) {
  const db = openDb(":memory:");
  const notifier = new Notifier(db, { enablePush: false });
  const wallet = new Wallet(db, new MockIssuer(), notifier, 15, priceLookup);
  const passkeys = new Passkeys(db, { rpID: "localhost", rpName: "Agent Wallet", origin: "http://localhost:3000" });
  const app = createApp({ wallet, notifier, passkeys, ownerTokenHash: hashKey(OWNER), enableDemoCharge: true, ...extra });
  const req = (method: string, path: string, token: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  return { db, app, wallet, passkeys, notifier, req };
}

let t: ReturnType<typeof setup>;
let agentKey: string;

beforeEach(async () => {
  t = setup();
  const res = await t.req("POST", "/api/agents", OWNER, {
    name: "Shopping agent",
    monthlyBudgetCents: 30_000,
    perPurchaseCapCents: 20_000,
    autoApproveUnderCents: 2_500,
  });
  expect(res.status).toBe(201);
  agentKey = (await res.json()).apiKey;
});

const buy = (amount_cents: number, merchant = "Amazon") =>
  t.req("POST", "/v1/purchases", agentKey, { amount_cents, merchant, reason: "Phone case for the owner" });

describe("auth", () => {
  it("rejects bad keys", async () => {
    expect((await t.req("GET", "/api/agents", "nope")).status).toBe(401);
    expect((await t.req("GET", "/v1/me", "nope")).status).toBe(401);
    expect((await t.req("GET", "/v1/me", OWNER)).status).toBe(401);
  });
});

describe("purchase flow", () => {
  it("auto-approves small purchases and returns a one-time card", async () => {
    const res = await buy(1_999);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("auto_approved");
    expect(body.card.number).toMatch(/^\d{16}$/);
    expect(body.card.limit).toBe("$19.99");
  });

  it("blocks purchases that break the rules, with no card", async () => {
    const res = await buy(25_000);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.status).toBe("blocked");
    expect(body.card).toBeUndefined();
  });

  it("waits for approval, then issues a card the agent can fetch", async () => {
    const created = await (await buy(8_000)).json();
    expect(created.status).toBe("pending");
    expect(created.card).toBeUndefined();

    const pending = await (await t.req("GET", "/api/requests?status=pending", OWNER)).json();
    expect(pending).toHaveLength(1);

    const approved = await t.req("POST", `/api/requests/${created.id}/approve`, OWNER);
    expect(approved.status).toBe(200);

    const polled = await (await t.req("GET", `/v1/purchases/${created.id}`, agentKey)).json();
    expect(polled.status).toBe("approved");
    expect(polled.card.limit).toBe("$80.00");

    // Approving twice is rejected.
    expect((await t.req("POST", `/api/requests/${created.id}/approve`, OWNER)).status).toBe(409);
  });

  it("denies requests", async () => {
    const created = await (await buy(8_000)).json();
    await t.req("POST", `/api/requests/${created.id}/deny`, OWNER, { note: "Not now" });
    const polled = await (await t.req("GET", `/v1/purchases/${created.id}`, agentKey)).json();
    expect(polled.status).toBe("denied");
    expect(polled.decision_reason).toBe("Not now");
    expect(polled.card).toBeUndefined();
  });

  it("re-checks the budget at approval time", async () => {
    const a = await (await buy(15_000)).json();
    const b = await (await buy(15_000)).json();
    await t.req("POST", `/api/requests/${a.id}/approve`, OWNER);
    // Lower the budget so b no longer fits.
    const agents = await (await t.req("GET", "/api/agents", OWNER)).json();
    await t.req("PATCH", `/api/agents/${agents[0].id}`, OWNER, { monthlyBudgetCents: 20_000 });
    const res = await (await t.req("POST", `/api/requests/${b.id}/approve`, OWNER)).json();
    expect(res.request.status).toBe("blocked");
  });

  it("counts approved spending against the monthly budget", async () => {
    for (const id of [(await (await buy(15_000)).json()).id, (await (await buy(14_000)).json()).id]) {
      await t.req("POST", `/api/requests/${id}/approve`, OWNER);
    }
    const me = await (await t.req("GET", "/v1/me", agentKey)).json();
    expect(me.remaining_this_month).toBe("$10.00");
    expect((await buy(2_000)).status).toBe(403);
  });

  it("lets a card be charged once, within its limit", async () => {
    const { card } = await (await buy(2_000)).json();
    const over = await t.req("POST", `/v1/cards/${card.id}/charge`, agentKey, { amount_cents: 2_001, merchant: "Amazon" });
    expect(over.status).toBe(402);
    const ok = await t.req("POST", `/v1/cards/${card.id}/charge`, agentKey, { amount_cents: 1_950, merchant: "Amazon" });
    expect(ok.status).toBe(200);
    const again = await t.req("POST", `/v1/cards/${card.id}/charge`, agentKey, { amount_cents: 100, merchant: "Amazon" });
    expect(again.status).toBe(402);
  });

  it("does not let an agent read another agent's request", async () => {
    const other = await (
      await t.req("POST", "/api/agents", OWNER, { name: "Other", monthlyBudgetCents: 1000, perPurchaseCapCents: 1000 })
    ).json();
    const mine = await (await buy(8_000)).json();
    expect((await t.req("GET", `/v1/purchases/${mine.id}`, other.apiKey)).status).toBe(404);
  });

  it("expires requests nobody answers", async () => {
    const created = await (await buy(8_000)).json();
    t.db.prepare("UPDATE purchase_requests SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", created.id);
    const polled = await (await t.req("GET", `/v1/purchases/${created.id}`, agentKey)).json();
    expect(polled.status).toBe("expired");
  });

  it("never auto-approves a risky purchase, and tells the agent why", async () => {
    const res = await t.req("POST", "/v1/purchases", agentKey, { amount_cents: 999, merchant: "amaz0n-deals.com", reason: "Cheap charger" });
    const body = await res.json();
    expect(body.status).toBe("pending");
    expect(body.card).toBeUndefined();
    expect(body.risk_flags[0].code).toBe("lookalike_merchant");
    const pending = await (await t.req("GET", "/api/requests?status=pending", OWNER)).json();
    expect(pending[0].riskFlags[0].level).toBe("high");
  });

  it("requires a passkey for big or risky approvals once one is set up", async () => {
    // Can't require passkeys before registering one.
    expect((await t.req("PATCH", "/api/settings", OWNER, { passkeyRequiredOverCents: 5_000 })).status).toBe(400);

    // Pretend a passkey is registered (real registration needs a browser; covered by the e2e check).
    t.db.prepare("INSERT INTO passkeys (id, public_key, counter, created_at) VALUES ('cred', 'AA==', 0, '2026-01-01')").run();
    // With a passkey, changing rules or settings needs one too. Pausing an agent never does.
    const locked = await t.req("PATCH", "/api/settings", OWNER, { passkeyRequiredOverCents: 5_000 });
    expect(locked.status).toBe(403);
    expect((await locked.json()).passkeyRequired).toBe(true);
    const agentId = t.wallet.listAgents()[0].id;
    expect((await t.req("PATCH", `/api/agents/${agentId}`, OWNER, { autoApproveUnderCents: 99_999 })).status).toBe(403);
    expect((await t.req("PATCH", `/api/agents/${agentId}`, OWNER, { active: false })).status).toBe(200);
    expect((await t.req("PATCH", `/api/agents/${agentId}`, OWNER, { active: true })).status).toBe(403);
    t.db.prepare("UPDATE agents SET active = 1").run();
    // The fake passkey can't sign, so switch rules protection off directly to test approvals.
    t.db.prepare("INSERT INTO settings (key, value) VALUES ('passkey_for_rules', '0')").run();
    expect((await t.req("PATCH", "/api/settings", OWNER, { passkeyRequiredOverCents: 5_000 })).status).toBe(200);

    const small = await (await buy(4_000)).json();
    const big = await (await buy(8_000)).json();
    const listed = await (await t.req("GET", "/api/requests?status=pending", OWNER)).json();
    expect(listed.find((r: any) => r.id === big.id).needsPasskey).toBe(true);
    expect(listed.find((r: any) => r.id === small.id).needsPasskey).toBe(false);

    const blocked = await t.req("POST", `/api/requests/${big.id}/approve`, OWNER);
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).passkeyRequired).toBe(true);
    const fake = await t.req("POST", `/api/requests/${big.id}/approve`, OWNER, { passkey: { id: "cred", response: {} } });
    expect(fake.status).toBe(403);

    expect((await t.req("POST", `/api/requests/${small.id}/approve`, OWNER)).status).toBe(200);
    // Denying never needs a passkey.
    expect((await t.req("POST", `/api/requests/${big.id}/deny`, OWNER)).status).toBe(200);
  });

  it("approves and denies from a notification with a per-request token", async () => {
    const pushes: any[] = [];
    (t as any).notifier.push = async (p: any) => void pushes.push(p);
    const a = await (await buy(8_000)).json();
    const b = await (await buy(7_000)).json();
    const tokenA = pushes.find((p) => p.requestId === a.id).quickToken;
    const tokenB = pushes.find((p) => p.requestId === b.id).quickToken;
    const quick = (id: string, decision: string, token: string) =>
      t.req("POST", `/quick/${id}`, "", { decision, token });

    expect((await quick(a.id, "approve", tokenB)).status).toBe(401); // token is bound to one request
    expect((await quick(a.id, "approve", tokenA)).status).toBe(200);
    expect((await (await t.req("GET", `/v1/purchases/${a.id}`, agentKey)).json()).status).toBe("approved");
    expect((await quick(b.id, "deny", tokenB)).status).toBe(200);
    expect((await quick(b.id, "deny", tokenB)).status).toBe(409); // already decided
  });

  it("summarizes spending in insights", async () => {
    const small = await (await buy(2_000, "Amazon")).json();
    // Charging the card must not turn an auto-approval into "approved by you".
    await t.req("POST", `/v1/cards/${small.card.id}/charge`, agentKey, { amount_cents: 2_000, merchant: "Amazon" });
    const big = await (await t.req("POST", "/v1/purchases", agentKey, { amount_cents: 9_000, merchant: "Best Buy", category: "electronics", reason: "x" })).json();
    await t.req("POST", `/api/requests/${big.id}/approve`, OWNER);
    await buy(99_999); // blocked
    const scam = await (await buy(1_000, "paypa1.com")).json();
    await t.req("POST", `/api/requests/${scam.id}/deny`, OWNER);

    const ins = await (await t.req("GET", "/api/insights", OWNER)).json();
    expect(ins.spentCents).toBe(11_000);
    expect(ins.stoppedCents).toBe(100_999);
    expect(ins.riskyStopped).toBe(1);
    expect(ins.counts).toMatchObject({ autoApproved: 1, approved: 1, blocked: 1, denied: 1 });
    expect(ins.byCategory[0]).toEqual({ label: "electronics", cents: 9_000 });
    expect(ins.topMerchants.map((m: any) => m.label)).toEqual(["Best Buy", "Amazon"]);
    expect(ins.months).toHaveLength(6);
    expect(ins.months.at(-1).cents).toBe(11_000);
  });

  it("checks prices before you approve and tells you and the agent", async () => {
    const p = setup(new DemoLookup());
    const pushes: any[] = [];
    (p.notifier as any).push = async (x: any) => void pushes.push(x);
    const { apiKey } = await (
      await p.req("POST", "/api/agents", OWNER, { name: "A", monthlyBudgetCents: 100_000, perPurchaseCapCents: 50_000 })
    ).json();
    const created = await (
      await p.req("POST", "/v1/purchases", apiKey, {
        amount_cents: 39_999, merchant: "Best Buy", reason: "Headphones", product: "Sony WH-1000XM5", product_url: "https://bestbuy.com/x",
      })
    ).json();
    await new Promise((r) => setTimeout(r, 50));
    const polled = await (await p.req("GET", `/v1/purchases/${created.id}`, apiKey)).json();
    expect(polled.cheaper_option).toMatchObject({ merchant: "Target", price: "$327.99", savings: "$72.00", demo: true });
    expect(pushes[0].body).toContain("$72.00 cheaper at Target");
    const listed = await (await p.req("GET", "/api/requests?status=pending", OWNER)).json();
    expect(listed[0].priceCheck.cheaper.merchant).toBe("Target");
    expect(listed[0].product).toBe("Sony WH-1000XM5");
  });

  it("skips price checks when there's no product name", async () => {
    const p = setup(new DemoLookup());
    const { apiKey } = await (
      await p.req("POST", "/api/agents", OWNER, { name: "A", monthlyBudgetCents: 100_000, perPurchaseCapCents: 50_000 })
    ).json();
    const created = await (await p.req("POST", "/v1/purchases", apiKey, { amount_cents: 39_999, merchant: "Best Buy", reason: "x" })).json();
    await new Promise((r) => setTimeout(r, 50));
    expect((await (await p.req("GET", `/v1/purchases/${created.id}`, apiKey)).json()).cheaper_option).toBeUndefined();
  });

  it("treats a retry with the same Idempotency-Key as the same purchase", async () => {
    const send = () =>
      t.app.request("/v1/purchases", {
        method: "POST",
        headers: { Authorization: `Bearer ${agentKey}`, "Content-Type": "application/json", "Idempotency-Key": "order-42" },
        body: JSON.stringify({ amount_cents: 1_500, merchant: "Amazon", reason: "Cable" }),
      });
    const first = await send();
    const second = await send();
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const [a, b] = [await first.json(), await second.json()];
    expect(b.id).toBe(a.id);
    expect(b.card.number).toBe(a.card.number);
    expect(t.wallet.listRequests()).toHaveLength(1);
  });

  it("publishes a discovery document", async () => {
    const doc = await (await t.app.request("/.well-known/agent-spend")).json();
    expect(doc).toMatchObject({ protocol: "agent-spend", version: "0.2", credential_types: ["one_time_card"] });
    expect(doc.purchases_endpoint).toMatch(/\/v1\/purchases$/);
  });

  it("writes everything to the activity log", async () => {
    await buy(1_000);
    await buy(99_999);
    const types = (await (await t.req("GET", "/api/events", OWNER)).json()).map((e: any) => e.type);
    expect(types).toEqual(expect.arrayContaining(["agent_created", "request_auto_approved", "card_issued", "request_blocked"]));
  });
});
