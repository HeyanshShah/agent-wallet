// Records the launch demo video of the real app.
// 1. Start a fresh server:  rm -rf data && OWNER_TOKEN=demo-owner PRICE_CHECK=demo npm start
// 2. Run:                   node scripts/launch/record-demo.cjs   (needs Playwright + ffmpeg)
// Output: docs/media/demo.mp4 and docs/media/demo.gif
const { chromium } = require("playwright");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const BASE = "http://localhost:3000";
const OWNER = process.env.OWNER_TOKEN || "demo-owner";
const OUT = path.join(__dirname, "../../docs/media");
const STAGE = fs.readFileSync(path.join(__dirname, "stage.html"), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body, key = OWNER) {
  const res = await fetch(BASE + p, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { apiKey } = await api("POST", "/api/agents", {
    name: "Shopping agent",
    monthlyBudgetCents: 50_000,
    perPurchaseCapCents: 30_000,
    autoApproveUnderCents: 2_500,
  });
  // A little history so the scam check has something to compare against.
  for (const [amount_cents, merchant] of [[1299, "Amazon"], [2400, "Instacart"], [899, "Uber Eats"]]) {
    const r = await api("POST", "/v1/purchases", { amount_cents, merchant, reason: "Weekly stuff" }, apiKey);
    if (r.card) await api("POST", `/v1/cards/${r.card.id}/charge`, { amount_cents, merchant }, apiKey);
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: "/tmp/agent-wallet-video", size: { width: 1440, height: 900 } },
  });
  await context.addInitScript((t) => localStorage.setItem("ownerToken", t), OWNER);
  await context.route(`${BASE}/__stage`, (route) => route.fulfill({ contentType: "text/html", body: STAGE }));
  const page = await context.newPage();
  const started = Date.now();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  await page.goto(`${BASE}/__stage`);
  const app = page.frameLocator("#app");

  // Setup (trimmed from the video): Face ID on, required over $50.
  await app.locator("nav button[data-tab=agents]").click();
  await app.locator("#add-passkey").click();
  await app.locator("#passkey-form input[name=over]").fill("50");
  await app.locator("#passkey-form button[type=submit]").click();
  await sleep(600);
  await app.locator("nav button[data-tab=approvals]").click();
  await sleep(3800); // let the "Saved." toast fade before the video starts
  const trimStart = (Date.now() - started) / 1000;

  const say = (who, html) => page.evaluate(([w, h]) => window.say(w, h), [who, html]);
  const caption = (t) => page.evaluate((x) => window.caption(x), t);

  // 1. A real purchase, with a price check and Face ID.
  await sleep(800);
  await say("user", "Find me noise-cancelling headphones for my flight. Under $100.");
  await sleep(1600);
  await say("agent", "Found the Sony WH-CH720N at Best Buy for $89.00. Asking your wallet for the money.");
  await sleep(1200);
  await say("tool", "request_purchase($89.00, Best Buy, \"Sony WH-CH720N headphones\")");
  const big = await api("POST", "/v1/purchases", {
    amount_cents: 8900, merchant: "Best Buy", category: "electronics",
    reason: "Noise-cancelling headphones for your flight", product: "Sony WH-CH720N headphones",
  }, apiKey);
  await sleep(700);
  await say("tool", "<span class='warn'>⏳ waiting for your approval…</span>");
  await caption("Your phone buzzes");
  await app.locator(`[data-approve="${big.id}"]`).waitFor();
  await sleep(2600);
  await caption("It checks the price elsewhere first");
  await sleep(2800);
  await caption("Big purchases need Face ID");
  await page.evaluate(() => window.faceid(true));
  await sleep(900);
  await app.locator(`[data-approve="${big.id}"]`).click();
  await sleep(900);
  await page.evaluate(() => window.faceid(false));
  const approved = await api("GET", `/v1/purchases/${big.id}`, null, apiKey);
  await say("tool", `<span class='ok'>✓ approved · one-time card •••• ${approved.card.number.slice(-4)}, max ${approved.card.limit}</span>`);
  await api("POST", `/v1/cards/${approved.card.id}/charge`, { amount_cents: 8900, merchant: "Best Buy" }, apiKey);
  await sleep(1000);
  await say("agent", "Ordered! That card worked once and is already dead. Your real card was never shared.");
  await caption("The agent never sees your real card");
  await sleep(3000);

  // 2. A scam site gets flagged.
  await caption("");
  await say("user", "Also grab a phone charger.");
  await sleep(1300);
  await say("tool", "request_purchase($19.99, amaz0n-deals.com, \"USB-C charger\")");
  const scam = await api("POST", "/v1/purchases", { amount_cents: 1999, merchant: "amaz0n-deals.com", reason: "USB-C charger, 60% off" }, apiKey);
  await caption("Fake stores get caught, even small ones");
  await app.locator(`[data-deny="${scam.id}"]`).waitFor();
  await sleep(3400);
  await app.locator(`[data-deny="${scam.id}"]`).click();
  await sleep(700);
  await say("tool", "<span class='bad'>✗ denied: looks like an imitation of Amazon</span>");
  await sleep(900);
  await say("agent", "Good catch, that was a fake store. I'll find the charger on the real Amazon.");
  await sleep(2400);

  // 3. Rules it can't get around.
  await caption("");
  await say("user", "Actually, get me that 65\" TV too.");
  await sleep(1300);
  await say("tool", "request_purchase($449.00, Best Buy, \"65-inch TV\")");
  const tv = await api("POST", "/v1/purchases", { amount_cents: 44900, merchant: "Best Buy", reason: "65-inch TV" }, apiKey);
  await sleep(700);
  await say("tool", `<span class='bad'>✗ blocked: ${tv.decision_reason}</span>`);
  await caption("Your rules. It can't get around them.");
  await sleep(1200);
  await say("agent", "That's over your $300 limit per purchase, so I can't. Want to raise it?");
  await sleep(2800);

  // 4. Insights.
  await caption("Every dollar, accounted for");
  await app.locator("nav button[data-tab=insights]").click();
  await sleep(4200);
  await caption("Agent Wallet · open source · github.com/HeyanshShah/agent-wallet");
  await sleep(3500);

  const videoPath = await page.video().path();
  await context.close();
  await browser.close();

  const mp4 = path.join(OUT, "demo.mp4");
  const gif = path.join(OUT, "demo.gif");
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(trimStart), "-i", videoPath, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "26", "-movflags", "+faststart", "-an", mp4]);
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", mp4, "-vf", "fps=8,scale=880:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4", gif]);
  console.log(`Wrote ${mp4} and ${gif}`);
})();
