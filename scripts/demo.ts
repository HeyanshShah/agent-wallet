// Walks through the three outcomes against a running server:
// auto-approve, wait for your tap, and blocked by rules.
// Usage: OWNER_TOKEN=aw_owner_... npm run demo
const URL = (process.env.WALLET_URL ?? "http://localhost:3000").replace(/\/$/, "");
const OWNER = process.env.OWNER_TOKEN;
if (!OWNER) {
  console.error("Set OWNER_TOKEN to the token the server printed on first start.");
  process.exit(1);
}

async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json() as Promise<any>;
}

const step = (s: string) => console.log(`\n▶ ${s}`);

const { agent, apiKey } = await call(OWNER, "POST", "/api/agents", {
  name: "Demo shopper",
  monthlyBudgetCents: 20_000,
  perPurchaseCapCents: 15_000,
  autoApproveUnderCents: 2_500,
  blockedMerchants: ["casino"],
});
console.log(`Created agent "${agent.name}": $200/month, $150 max per purchase, auto-approve up to $25.`);

step("Agent buys a $19.99 phone case (under the auto-approve limit)");
const small = await call(apiKey, "POST", "/v1/purchases", { amount_cents: 1999, merchant: "Amazon", category: "electronics", reason: "Phone case the owner asked for" });
console.log(`  ${small.status}: card ending ${small.card.number.slice(-4)}, limit ${small.card.limit}`);
const charge = await call(apiKey, "POST", `/v1/cards/${small.card.id}/charge`, { amount_cents: 1999, merchant: "Amazon" });
console.log(`  Store charged the card: ${charge.reason}`);
const reuse = await call(apiKey, "POST", `/v1/cards/${small.card.id}/charge`, { amount_cents: 500, merchant: "Amazon" });
console.log(`  Store tries to charge it again: ${reuse.reason}`);

step("Agent wants $89 headphones (needs your approval)");
const big = await call(apiKey, "POST", "/v1/purchases", { amount_cents: 8900, merchant: "Best Buy", category: "electronics", reason: "Noise-cancelling headphones for the flight" });
console.log(`  ${big.status}. Open the app and tap Approve or Deny…`);
let polled = big;
while (polled.status === "pending") {
  await new Promise((r) => setTimeout(r, 2000));
  polled = await call(apiKey, "GET", `/v1/purchases/${big.id}`);
}
console.log(`  ${polled.status}${polled.card ? `: card ending ${polled.card.number.slice(-4)}, limit ${polled.card.limit}` : ""}`);

step("Agent tries to spend $300 on a TV (over the $150 cap)");
const blocked = await call(apiKey, "POST", "/v1/purchases", { amount_cents: 30000, merchant: "Best Buy", reason: "Bigger TV" });
console.log(`  ${blocked.status}: ${blocked.decision_reason}`);

step("Agent tries a casino");
const casino = await call(apiKey, "POST", "/v1/purchases", { amount_cents: 1000, merchant: "Lucky Casino", reason: "Feeling lucky" });
console.log(`  ${casino.status}: ${casino.decision_reason}`);
console.log("\nDone. Check the Activity tab for the full log.");
