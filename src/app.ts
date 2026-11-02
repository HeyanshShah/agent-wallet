import { Hono, type Context, type Next } from "hono";
import { streamSSE } from "hono/streaming";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getSetting, setSetting } from "./db.js";
import { hashKey, type Agent, type Card, type PurchaseRequest, type Wallet, WalletError } from "./wallet.js";
import type { Notifier, WalletEvent } from "./notify.js";
import { formatUsd } from "./rules.js";
import { hasHighRisk } from "./risk.js";
import type { Passkeys } from "./passkeys.js";
import { verifyApproval } from "./signer.js";
import { chargeFromLithicEvent, verifyWebhookSignature } from "./lithic-webhooks.js";
import { RateLimiter } from "./rate-limit.js";

type Env = { Variables: { agent: Agent } };

const cents = z.number().int().nonnegative();

const newAgentSchema = z.object({
  name: z.string().trim().min(1).max(80),
  monthlyBudgetCents: cents,
  perPurchaseCapCents: cents,
  autoApproveUnderCents: cents.optional(),
  allowedCategories: z.array(z.string().trim().min(1)).optional(),
  blockedMerchants: z.array(z.string().trim().min(1)).optional(),
});

const updateAgentSchema = newAgentSchema.partial().extend({ active: z.boolean().optional() });

const purchaseSchema = z.object({
  amount_cents: z.number().int().positive(),
  merchant: z.string().trim().min(1).max(200),
  category: z.string().trim().max(60).optional(),
  reason: z.string().trim().min(1).max(500),
  product: z.string().trim().max(200).optional(),
  product_url: z.string().trim().url().max(2000).optional(),
});

const chargeSchema = z.object({ amount_cents: z.number().int().positive(), merchant: z.string().trim().min(1) });

/** What an agent sees about its own request. Card details only while usable. */
function agentView(request: PurchaseRequest, card?: Card, approvalToken?: string) {
  const usable = card && card.state === "open" && (request.status === "approved" || request.status === "auto_approved");
  const messages: Record<string, string> = {
    pending: "Waiting for the owner to approve on their phone. Poll this request until it changes.",
    approved: "Approved. Use the one-time card below for this purchase only.",
    auto_approved: "Approved automatically. Use the one-time card below for this purchase only.",
    denied: "The owner denied this purchase. Do not retry without asking them.",
    blocked: "Blocked by the owner's rules. Do not retry with a different amount or merchant to get around them.",
    expired: "The owner did not answer in time. Ask them before trying again.",
    completed: "Already paid.",
  };
  return {
    id: request.id,
    status: request.status,
    amount: formatUsd(request.amountCents),
    amount_cents: request.amountCents,
    merchant: request.merchant,
    decision_reason: request.decisionReason,
    expires_at: request.expiresAt,
    risk_flags: request.riskFlags.length ? request.riskFlags : undefined,
    cheaper_option: request.priceCheck?.cheaper
      ? {
          merchant: request.priceCheck.cheaper.merchant,
          price: formatUsd(request.priceCheck.cheaper.priceCents),
          savings: formatUsd(request.priceCheck.cheaper.savingsCents),
          url: request.priceCheck.cheaper.url,
          demo: request.priceCheck.provider === "demo" || undefined,
        }
      : undefined,
    message: messages[request.status],
    approval_token: approvalToken,
    card: usable
      ? {
          id: card.id,
          number: card.pan,
          cvv: card.cvv,
          exp_month: card.expMonth,
          exp_year: card.expYear,
          limit: formatUsd(card.spendLimitCents),
        }
      : undefined,
  };
}

function bearer(c: Context): string | undefined {
  const h = c.req.header("Authorization");
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
}

export function createApp(opts: {
  wallet: Wallet;
  notifier: Notifier;
  passkeys: Passkeys;
  ownerTokenHash: string;
  enableDemoCharge?: boolean;
  /** The address the wallet is reached at. Used as the issuer of signed approvals. */
  publicUrl?: string;
  /** Turns on POST /webhooks/lithic, which records real card charges. */
  lithicWebhookSecret?: string;
}) {
  const { wallet, notifier, passkeys, ownerTokenHash } = opts;
  const ownerHashBuf = Buffer.from(ownerTokenHash, "hex");
  const isOwner = (token: string | undefined) => {
    if (!token) return false;
    const given = Buffer.from(hashKey(token), "hex");
    return given.length === ownerHashBuf.length && timingSafeEqual(given, ownerHashBuf);
  };
  const origin = (c: Context) => opts.publicUrl?.replace(/\/$/, "") ?? new URL(c.req.url).origin;
  const view = (c: Context, request: PurchaseRequest, card?: Card) =>
    agentView(request, card ?? wallet.cardForRequest(request.id), wallet.approvalToken(request, origin(c)));

  // Rules protection: with a passkey set up, changing rules needs Face ID too (pausing an agent never does).
  const rulesNeedPasskey = () => passkeys.count() > 0 && getSetting(wallet.db, "passkey_for_rules") !== "0";
  const checkRulesPasskey = async (body: { passkey?: unknown }) => {
    if (!rulesNeedPasskey()) return true;
    return !!body.passkey && (await passkeys.verifyAuthentication("rules", body.passkey as any));
  };
  const passkeyNeeded = (c: Context) =>
    c.json({ error: "Confirm with Face ID or your fingerprint to change rules.", passkeyRequired: true }, 403);

  const failedAuth = new RateLimiter(20, 60_000);
  const purchaseLimit = new RateLimiter(30, 60_000);
  const clientIp = (c: Context) => c.req.header("x-forwarded-for")?.split(",")[0].trim() || c.req.header("x-real-ip") || "local";
  const needsPasskey = (r: PurchaseRequest) => passkeys.isRequired(r.amountCents, hasHighRisk(r.riskFlags));

  // Quick tokens let a notification approve or deny one request without the owner token.
  let actionSecret = getSetting(wallet.db, "action_secret");
  if (!actionSecret) {
    actionSecret = randomBytes(32).toString("hex");
    setSetting(wallet.db, "action_secret", actionSecret);
  }
  const quickToken = (requestId: string) => createHmac("sha256", actionSecret).update(requestId).digest("base64url");
  const quickTokenValid = (requestId: string, token: string) => {
    const expected = Buffer.from(quickToken(requestId));
    const given = Buffer.from(token);
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  const notifyPending = (r: PurchaseRequest) => {
    const what = `${r.agentName} wants ${formatUsd(r.amountCents)} at ${r.merchant}`;
    const warning = r.riskFlags.find((f) => f.level === "high");
    const deal = r.priceCheck?.cheaper;
    const dealLine = deal ? ` 💰 ${formatUsd(deal.savingsCents)} cheaper at ${deal.merchant}.` : "";
    return notifier.push({
      title: warning ? "⚠️ Risky purchase request" : "Approve purchase?",
      body: (warning ? `${what}. ${warning.message}` : `${what}: ${r.reason}`) + dealLine,
      requestId: r.id,
      // Purchases that need Face ID must be opened in the app instead.
      quickToken: needsPasskey(r) ? undefined : quickToken(r.id),
    });
  };
  const app = new Hono<Env>();

  app.use("*", secureHeaders({ crossOriginResourcePolicy: false, crossOriginOpenerPolicy: false }));
  app.use("*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "Request too large." }, 413) }));

  app.onError((err, c) => {
    if (err instanceof WalletError) return c.json({ error: err.message }, err.status);
    if (err instanceof z.ZodError) return c.json({ error: "Invalid input.", issues: err.issues }, 400);
    console.error(err);
    return c.json({ error: "Something went wrong." }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  // Discovery document for the Agent Spend Protocol (docs/AGENT-SPEND-PROTOCOL.md).
  app.get("/.well-known/agent-spend", (c) => {
    const base = new URL(c.req.url).origin;
    return c.json({
      protocol: "agent-spend",
      version: "0.2",
      issuer: origin(c),
      purchases_endpoint: `${base}/v1/purchases`,
      limits_endpoint: `${base}/v1/me`,
      openapi: `${base}/openapi.json`,
      jwks_uri: `${base}/.well-known/jwks.json`,
      verify_endpoint: `${base}/verify`,
      auth: ["bearer"],
      credential_types: ["one_time_card"],
      approval_token_type: "agent-spend-approval+jwt",
      features: ["risk_flags", "price_check", "idempotency", "owner_approval", "passkey_approval", "signed_approvals"],
    });
  });

  // The public key that signs approvals, so anyone can check them.
  app.get("/.well-known/jwks.json", (c) => c.json({ keys: [wallet.signer.jwk] }));

  // For stores that would rather ask than check signatures themselves.
  app.post("/verify", async (c) => {
    const { token } = z.object({ token: z.string().min(1).max(4000) }).parse(await c.req.json());
    return c.json(verifyApproval(token, { keys: [wallet.signer.jwk] }));
  });

  // Real card charges from Lithic. Turned on by LITHIC_WEBHOOK_SECRET.
  if (opts.lithicWebhookSecret) {
    const secret = opts.lithicWebhookSecret;
    app.post("/webhooks/lithic", async (c) => {
      const raw = await c.req.text();
      const signed = verifyWebhookSignature(
        secret,
        { id: c.req.header("webhook-id"), timestamp: c.req.header("webhook-timestamp"), signature: c.req.header("webhook-signature") },
        raw,
      );
      if (!signed) return c.json({ error: "Bad signature." }, 401);
      const charge = chargeFromLithicEvent(JSON.parse(raw));
      const result = charge ? await wallet.recordNetworkCharge(charge) : "ignored";
      return c.json({ ok: true, result });
    });
  }

  // ---------- agent API (Bearer = agent key) ----------

  const agentAuth = async (c: Context<Env>, next: Next) => {
    const ip = clientIp(c);
    if (failedAuth.blocked(ip)) return c.json({ error: "Too many failed attempts. Try again in a minute." }, 429);
    const key = bearer(c);
    const agent = key ? wallet.agentByKey(key) : undefined;
    if (!agent) {
      failedAuth.hit(ip);
      return c.json({ error: "Invalid agent key." }, 401);
    }
    c.set("agent", agent);
    await next();
  };

  app.use("/v1/*", agentAuth);

  app.get("/v1/me", (c) => {
    const agent = c.get("agent");
    const spent = wallet.spentThisMonth(agent.id);
    return c.json({
      name: agent.name,
      active: agent.active,
      monthly_budget: formatUsd(agent.monthlyBudgetCents),
      spent_this_month: formatUsd(spent),
      remaining_this_month: formatUsd(Math.max(agent.monthlyBudgetCents - spent, 0)),
      per_purchase_cap: formatUsd(agent.perPurchaseCapCents),
      auto_approve_up_to: formatUsd(agent.autoApproveUnderCents),
      allowed_categories: agent.allowedCategories.length ? agent.allowedCategories : "any",
    });
  });

  app.post("/v1/purchases", async (c) => {
    if (!purchaseLimit.hit(c.get("agent").id)) {
      return c.json({ error: "Too many purchase requests. Slow down and try again in a minute." }, 429);
    }
    const body = purchaseSchema.parse(await c.req.json());
    const idempotencyKey = c.req.header("Idempotency-Key")?.trim().slice(0, 200) || undefined;
    const { request, card, replayed } = await wallet.requestPurchase(c.get("agent"), {
      amountCents: body.amount_cents,
      merchant: body.merchant,
      category: body.category,
      reason: body.reason,
      product: body.product,
      productUrl: body.product_url,
      idempotencyKey,
    });
    if (replayed) return c.json(view(c, request), 200);
    if (request.status === "pending") {
      // Give the price check a few seconds so the notification can mention a better deal.
      void Promise.race([wallet.checkPrice(request.id), new Promise((r) => setTimeout(r, 4000))]).then(() =>
        notifyPending(wallet.getRequest(request.id)),
      );
    }
    return c.json(view(c, request, card), request.status === "blocked" ? 403 : 201);
  });

  app.get("/v1/purchases/:id", (c) => {
    const request = wallet.getRequest(c.req.param("id"));
    if (request.agentId !== c.get("agent").id) throw new WalletError("Purchase request not found.", 404);
    return c.json(view(c, request));
  });

  // Stand-in for a real store charging the card. Only in mock mode.
  if (opts.enableDemoCharge) {
    app.post("/v1/cards/:id/charge", async (c) => {
      const body = chargeSchema.parse(await c.req.json());
      const result = await wallet.recordCharge(c.req.param("id"), body.amount_cents, body.merchant);
      return c.json(result, result.ok ? 200 : 402);
    });
  }

  // ---------- one-tap decisions from a notification ----------

  app.post("/quick/:id", async (c) => {
    const id = c.req.param("id");
    const body = z.object({ decision: z.enum(["approve", "deny"]), token: z.string() }).parse(await c.req.json());
    if (!quickTokenValid(id, body.token)) return c.json({ error: "Invalid link." }, 401);
    const request = wallet.getRequest(id);
    if (body.decision === "deny") return c.json({ request: wallet.deny(id) });
    if (needsPasskey(request)) return c.json({ error: "Open the app to approve with Face ID.", passkeyRequired: true }, 403);
    return c.json(await wallet.approve(id));
  });

  // ---------- owner API (Bearer = owner token) ----------

  app.use("/api/*", async (c, next) => {
    // EventSource can't set headers, so the stream also accepts ?token=.
    const ip = clientIp(c);
    if (failedAuth.blocked(ip)) return c.json({ error: "Too many failed attempts. Try again in a minute." }, 429);
    const token = bearer(c) ?? c.req.query("token");
    if (!isOwner(token)) {
      failedAuth.hit(ip);
      return c.json({ error: "Invalid owner token." }, 401);
    }
    await next();
  });

  app.get("/api/agents", (c) => c.json(wallet.listAgents()));

  app.post("/api/agents", async (c) => {
    const raw = await c.req.json();
    const body = newAgentSchema.parse(raw);
    if (!(await checkRulesPasskey(raw))) return passkeyNeeded(c);
    return c.json(wallet.createAgent(body), 201);
  });

  app.patch("/api/agents/:id", async (c) => {
    const raw = await c.req.json();
    const body = updateAgentSchema.parse(raw);
    // Pausing is always allowed without Face ID: stopping an agent should never be hard.
    const onlyPausing = Object.keys(body).length === 1 && body.active === false;
    if (!onlyPausing && !(await checkRulesPasskey(raw))) return passkeyNeeded(c);
    return c.json(wallet.updateAgent(c.req.param("id"), body));
  });

  app.post("/api/passkeys/rules/options", async (c) => c.json(await passkeys.authenticationOptions("rules")));

  app.get("/api/requests", (c) => {
    const status = c.req.query("status") as PurchaseRequest["status"] | undefined;
    return c.json(wallet.listRequests({ status }).map((r) => ({ ...r, needsPasskey: r.status === "pending" && needsPasskey(r) })));
  });

  app.post("/api/requests/:id/approve/options", async (c) => {
    const id = c.req.param("id");
    wallet.getRequest(id); // 404 if it doesn't exist
    return c.json(await passkeys.authenticationOptions(`approve:${id}`));
  });

  app.post("/api/requests/:id/approve", async (c) => {
    const id = c.req.param("id");
    const request = wallet.getRequest(id);
    const body = (await c.req.json().catch(() => ({}))) as { passkey?: any };
    const withPasskey = !!body.passkey && request.status === "pending" && (await passkeys.verifyAuthentication(`approve:${id}`, body.passkey));
    if (request.status === "pending" && needsPasskey(request) && !withPasskey) {
      return c.json({ error: "Confirm with Face ID or your fingerprint to approve this one.", passkeyRequired: true }, 403);
    }
    return c.json(await wallet.approve(id, withPasskey ? "owner_passkey" : "owner"));
  });

  // ---------- passkeys and settings ----------

  const settingsView = () => ({
    passkeyCount: passkeys.count(),
    passkeyRequiredOverCents: passkeys.requiredOverCents ?? null,
    passkeyForRules: rulesNeedPasskey(),
  });

  app.get("/api/settings", (c) => c.json(settingsView()));

  app.patch("/api/settings", async (c) => {
    const raw = await c.req.json();
    const body = z
      .object({ passkeyRequiredOverCents: cents.nullable().optional(), passkeyForRules: z.boolean().optional() })
      .parse(raw);
    if (!(await checkRulesPasskey(raw))) return passkeyNeeded(c);
    if ((body.passkeyRequiredOverCents != null || body.passkeyForRules) && passkeys.count() === 0) {
      throw new WalletError("Set up Face ID or a fingerprint first.");
    }
    if (body.passkeyRequiredOverCents !== undefined) passkeys.requiredOverCents = body.passkeyRequiredOverCents ?? undefined;
    if (body.passkeyForRules !== undefined) setSetting(wallet.db, "passkey_for_rules", body.passkeyForRules ? "1" : "0");
    return c.json(settingsView());
  });

  app.post("/api/passkeys/register/options", async (c) => c.json(await passkeys.registrationOptions()));

  app.post("/api/passkeys/register/verify", async (c) => {
    const ok = await passkeys.verifyRegistration(await c.req.json());
    if (!ok) throw new WalletError("Couldn't verify that passkey. Try again.");
    return c.json({ ok: true, passkeyCount: passkeys.count() }, 201);
  });

  app.post("/api/requests/:id/deny", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { note?: string };
    return c.json(wallet.deny(c.req.param("id"), body.note));
  });

  app.get("/api/events", (c) => c.json(wallet.listEvents()));

  app.get("/api/events/verify", (c) => c.json(wallet.verifyLog()));

  app.get("/api/insights", (c) => c.json(wallet.insights()));

  app.get("/api/push/key", (c) => c.json({ publicKey: notifier.vapidPublicKey }));

  app.post("/api/push/subscribe", async (c) => {
    const sub = z.object({ endpoint: z.string().url() }).passthrough().parse(await c.req.json());
    notifier.saveSubscription(sub);
    return c.json({ ok: true }, 201);
  });

  app.get("/api/stream", (c) =>
    streamSSE(c, async (stream) => {
      const onEvent = (e: WalletEvent) => void stream.writeSSE({ event: "wallet", data: JSON.stringify(e) });
      notifier.bus.on("event", onEvent);
      stream.onAbort(() => {
        notifier.bus.off("event", onEvent);
      });
      while (!stream.aborted) {
        await stream.writeSSE({ event: "ping", data: "" });
        await stream.sleep(25_000);
      }
    }),
  );

  return app;
}
