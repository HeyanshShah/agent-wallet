import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { MockIssuer } from "../src/cards.js";
import { Notifier } from "../src/notify.js";
import { Wallet, hashKey } from "../src/wallet.js";
import { createApp } from "../src/app.js";

const OWNER = "owner-test-token";

function setup() {
  const db = openDb(":memory:");
  const notifier = new Notifier(db, { enablePush: false });
  const wallet = new Wallet(db, new MockIssuer(), notifier, 15);
  const app = createApp({ wallet, notifier, ownerTokenHash: hashKey(OWNER), enableDemoCharge: true });
  const req = (method: string, path: string, token: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  return { db, wallet, req };
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

  it("writes everything to the activity log", async () => {
    await buy(1_000);
    await buy(99_999);
    const types = (await (await t.req("GET", "/api/events", OWNER)).json()).map((e: any) => e.type);
    expect(types).toEqual(expect.arrayContaining(["agent_created", "request_auto_approved", "card_issued", "request_blocked"]));
  });
});
