import { Hono, type Context, type Next } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { hashKey, type Agent, type Card, type PurchaseRequest, type Wallet, WalletError } from "./wallet.js";
import type { Notifier, WalletEvent } from "./notify.js";
import { formatUsd } from "./rules.js";

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
});

const chargeSchema = z.object({ amount_cents: z.number().int().positive(), merchant: z.string().trim().min(1) });

/** What an agent sees about its own request. Card details only while usable. */
function agentView(request: PurchaseRequest, card?: Card) {
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
    message: messages[request.status],
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

export function createApp(opts: { wallet: Wallet; notifier: Notifier; ownerTokenHash: string; enableDemoCharge?: boolean }) {
  const { wallet, notifier, ownerTokenHash } = opts;
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof WalletError) return c.json({ error: err.message }, err.status);
    if (err instanceof z.ZodError) return c.json({ error: "Invalid input.", issues: err.issues }, 400);
    console.error(err);
    return c.json({ error: "Something went wrong." }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  // ---------- agent API (Bearer = agent key) ----------

  const agentAuth = async (c: Context<Env>, next: Next) => {
    const key = bearer(c);
    const agent = key ? wallet.agentByKey(key) : undefined;
    if (!agent) return c.json({ error: "Invalid agent key." }, 401);
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
    const body = purchaseSchema.parse(await c.req.json());
    const { request, card } = await wallet.requestPurchase(c.get("agent"), {
      amountCents: body.amount_cents,
      merchant: body.merchant,
      category: body.category,
      reason: body.reason,
    });
    return c.json(agentView(request, card), request.status === "blocked" ? 403 : 201);
  });

  app.get("/v1/purchases/:id", (c) => {
    const request = wallet.getRequest(c.req.param("id"));
    if (request.agentId !== c.get("agent").id) throw new WalletError("Purchase request not found.", 404);
    return c.json(agentView(request, wallet.cardForRequest(request.id)));
  });

  // Stand-in for a real store charging the card. Only in mock mode.
  if (opts.enableDemoCharge) {
    app.post("/v1/cards/:id/charge", async (c) => {
      const body = chargeSchema.parse(await c.req.json());
      const result = await wallet.recordCharge(c.req.param("id"), body.amount_cents, body.merchant);
      return c.json(result, result.ok ? 200 : 402);
    });
  }

  // ---------- owner API (Bearer = owner token) ----------

  app.use("/api/*", async (c, next) => {
    // EventSource can't set headers, so the stream also accepts ?token=.
    const token = bearer(c) ?? c.req.query("token");
    if (!token || hashKey(token) !== ownerTokenHash) return c.json({ error: "Invalid owner token." }, 401);
    await next();
  });

  app.get("/api/agents", (c) => c.json(wallet.listAgents()));

  app.post("/api/agents", async (c) => {
    const body = newAgentSchema.parse(await c.req.json());
    return c.json(wallet.createAgent(body), 201);
  });

  app.patch("/api/agents/:id", async (c) => {
    const body = updateAgentSchema.parse(await c.req.json());
    return c.json(wallet.updateAgent(c.req.param("id"), body));
  });

  app.get("/api/requests", (c) => {
    const status = c.req.query("status") as PurchaseRequest["status"] | undefined;
    return c.json(wallet.listRequests({ status }));
  });

  app.post("/api/requests/:id/approve", async (c) => c.json(await wallet.approve(c.req.param("id"))));

  app.post("/api/requests/:id/deny", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { note?: string };
    return c.json(wallet.deny(c.req.param("id"), body.note));
  });

  app.get("/api/events", (c) => c.json(wallet.listEvents()));

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
