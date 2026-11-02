import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import type { CardIssuer } from "./cards.js";
import type { Notifier } from "./notify.js";
import { type AgentRules, evaluate, formatUsd } from "./rules.js";
import { type RiskFlag, type PastPurchase, assessRisk, hasHighRisk } from "./risk.js";

export type RequestStatus = "pending" | "approved" | "auto_approved" | "denied" | "blocked" | "expired" | "completed";

/** Statuses whose money counts against the monthly budget. */
const SPENT_STATUSES = ["approved", "auto_approved", "completed"];

export interface Agent extends AgentRules {
  id: string;
  name: string;
  createdAt: string;
}

export interface Card {
  id: string;
  pan: string;
  cvv: string;
  expMonth: number;
  expYear: number;
  last4: string;
  spendLimitCents: number;
  state: "open" | "used" | "closed";
}

export interface PurchaseRequest {
  id: string;
  agentId: string;
  agentName: string;
  amountCents: number;
  merchant: string;
  category: string | null;
  reason: string;
  status: RequestStatus;
  decisionReason: string | null;
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string | null;
  riskFlags: RiskFlag[];
}

export class WalletError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 404 | 409 = 400,
  ) {
    super(message);
  }
}

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

const now = () => new Date().toISOString();

function rowToAgent(r: any): Agent {
  return {
    id: r.id,
    name: r.name,
    active: r.active === 1,
    monthlyBudgetCents: r.monthly_budget_cents,
    perPurchaseCapCents: r.per_purchase_cap_cents,
    autoApproveUnderCents: r.auto_approve_under_cents,
    allowedCategories: JSON.parse(r.allowed_categories),
    blockedMerchants: JSON.parse(r.blocked_merchants),
    createdAt: r.created_at,
  };
}

function rowToRequest(r: any): PurchaseRequest {
  return {
    id: r.id,
    agentId: r.agent_id,
    agentName: r.agent_name,
    amountCents: r.amount_cents,
    merchant: r.merchant,
    category: r.category,
    reason: r.reason,
    status: r.status,
    decisionReason: r.decision_reason,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    expiresAt: r.expires_at,
    riskFlags: JSON.parse(r.risk_flags ?? "[]"),
  };
}

function rowToCard(r: any): Card {
  return {
    id: r.id,
    pan: r.pan,
    cvv: r.cvv,
    expMonth: r.exp_month,
    expYear: r.exp_year,
    last4: r.last4,
    spendLimitCents: r.spend_limit_cents,
    state: r.state,
  };
}

export interface NewAgentInput {
  name: string;
  monthlyBudgetCents: number;
  perPurchaseCapCents: number;
  autoApproveUnderCents?: number;
  allowedCategories?: string[];
  blockedMerchants?: string[];
}

export class Wallet {
  constructor(
    readonly db: Db,
    private readonly issuer: CardIssuer,
    private readonly notifier: Notifier,
    private readonly approvalTimeoutMinutes = 15,
  ) {}

  // ---------- activity log ----------

  private log(type: string, message: string, ids: { agentId?: string; requestId?: string } = {}): void {
    this.db
      .prepare("INSERT INTO events (agent_id, request_id, type, message, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(ids.agentId ?? null, ids.requestId ?? null, type, message, now());
    this.notifier.emit({ type, message, ...ids });
  }

  listEvents(limit = 100) {
    return this.db
      .prepare("SELECT id, agent_id AS agentId, request_id AS requestId, type, message, created_at AS createdAt FROM events ORDER BY id DESC LIMIT ?")
      .all(limit);
  }

  // ---------- agents ----------

  createAgent(input: NewAgentInput): { agent: Agent; apiKey: string } {
    const id = randomUUID();
    const apiKey = `aw_agent_${randomBytes(24).toString("base64url")}`;
    this.db
      .prepare(
        `INSERT INTO agents (id, name, key_hash, monthly_budget_cents, per_purchase_cap_cents, auto_approve_under_cents, allowed_categories, blocked_merchants, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        hashKey(apiKey),
        input.monthlyBudgetCents,
        input.perPurchaseCapCents,
        input.autoApproveUnderCents ?? 0,
        JSON.stringify(input.allowedCategories ?? []),
        JSON.stringify(input.blockedMerchants ?? []),
        now(),
      );
    this.log("agent_created", `Added agent "${input.name}".`, { agentId: id });
    return { agent: this.getAgent(id), apiKey };
  }

  getAgent(id: string): Agent {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
    if (!row) throw new WalletError("Agent not found.", 404);
    return rowToAgent(row);
  }

  agentByKey(apiKey: string): Agent | undefined {
    const row = this.db.prepare("SELECT * FROM agents WHERE key_hash = ?").get(hashKey(apiKey));
    return row ? rowToAgent(row) : undefined;
  }

  listAgents(): (Agent & { spentThisMonthCents: number })[] {
    return (this.db.prepare("SELECT * FROM agents ORDER BY created_at").all() as any[]).map((r) => {
      const agent = rowToAgent(r);
      return { ...agent, spentThisMonthCents: this.spentThisMonth(agent.id) };
    });
  }

  updateAgent(id: string, patch: Partial<Omit<NewAgentInput, "name">> & { name?: string; active?: boolean }): Agent {
    const current = this.getAgent(id);
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE agents SET name = ?, active = ?, monthly_budget_cents = ?, per_purchase_cap_cents = ?, auto_approve_under_cents = ?, allowed_categories = ?, blocked_merchants = ? WHERE id = ?`,
      )
      .run(
        next.name,
        next.active ? 1 : 0,
        next.monthlyBudgetCents,
        next.perPurchaseCapCents,
        next.autoApproveUnderCents,
        JSON.stringify(next.allowedCategories),
        JSON.stringify(next.blockedMerchants),
        id,
      );
    this.log("agent_updated", `Updated rules for "${next.name}".`, { agentId: id });
    return this.getAgent(id);
  }

  spentThisMonth(agentId: string, at = new Date()): number {
    const monthStart = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString();
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM purchase_requests
         WHERE agent_id = ? AND created_at >= ? AND status IN (${SPENT_STATUSES.map(() => "?").join(",")})`,
      )
      .get(agentId, monthStart, ...SPENT_STATUSES) as { total: number };
    return row.total;
  }

  /** Recent purchases that went through or are waiting, for risk checks. */
  private recentPurchases(agentId: string): PastPurchase[] {
    return (
      this.db
        .prepare(
          `SELECT amount_cents, merchant, created_at FROM purchase_requests
           WHERE agent_id = ? AND status IN ('pending', ${SPENT_STATUSES.map(() => "?").join(",")})
           ORDER BY created_at DESC LIMIT 50`,
        )
        .all(agentId, ...SPENT_STATUSES) as any[]
    ).map((r) => ({ amountCents: r.amount_cents, merchant: r.merchant, createdAt: r.created_at }));
  }

  // ---------- purchase requests ----------

  private expireStale(): void {
    const stale = this.db
      .prepare("SELECT id, agent_id FROM purchase_requests WHERE status = 'pending' AND expires_at < ?")
      .all(now()) as { id: string; agent_id: string }[];
    for (const r of stale) {
      this.db
        .prepare("UPDATE purchase_requests SET status = 'expired', decided_at = ?, decision_reason = ? WHERE id = ? AND status = 'pending'")
        .run(now(), "No answer before the request expired.", r.id);
      this.log("request_expired", "A purchase request expired without an answer.", { agentId: r.agent_id, requestId: r.id });
    }
  }

  getRequest(id: string): PurchaseRequest {
    this.expireStale();
    const row = this.db
      .prepare("SELECT r.*, a.name AS agent_name FROM purchase_requests r JOIN agents a ON a.id = r.agent_id WHERE r.id = ?")
      .get(id);
    if (!row) throw new WalletError("Purchase request not found.", 404);
    return rowToRequest(row);
  }

  listRequests(filter: { status?: RequestStatus; agentId?: string; limit?: number } = {}): PurchaseRequest[] {
    this.expireStale();
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.status) {
      where.push("r.status = ?");
      args.push(filter.status);
    }
    if (filter.agentId) {
      where.push("r.agent_id = ?");
      args.push(filter.agentId);
    }
    args.push(filter.limit ?? 100);
    return (
      this.db
        .prepare(
          `SELECT r.*, a.name AS agent_name FROM purchase_requests r JOIN agents a ON a.id = r.agent_id
           ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY r.created_at DESC LIMIT ?`,
        )
        .all(...args) as any[]
    ).map(rowToRequest);
  }

  cardForRequest(requestId: string): Card | undefined {
    const row = this.db.prepare("SELECT * FROM cards WHERE request_id = ?").get(requestId);
    return row ? rowToCard(row) : undefined;
  }

  async requestPurchase(
    agent: Agent,
    input: { amountCents: number; merchant: string; category?: string; reason: string },
  ): Promise<{ request: PurchaseRequest; card?: Card }> {
    const merchant = input.merchant.trim();
    const reason = input.reason.trim();
    if (!merchant) throw new WalletError("merchant is required.");
    if (!reason) throw new WalletError("reason is required.");

    let decision = evaluate(agent, { ...input, merchant }, this.spentThisMonth(agent.id));
    const risk = assessRisk({ amountCents: input.amountCents, merchant, reason }, this.recentPurchases(agent.id));
    // A risky purchase is never approved automatically, however small.
    if (decision.outcome === "auto_approve" && hasHighRisk(risk)) {
      decision = { outcome: "ask", reason: "Needs your approval: it was flagged as risky." };
    }
    const id = randomUUID();
    const created = now();
    const status: RequestStatus =
      decision.outcome === "block" ? "blocked" : decision.outcome === "auto_approve" ? "auto_approved" : "pending";
    const expiresAt =
      status === "pending" ? new Date(Date.now() + this.approvalTimeoutMinutes * 60_000).toISOString() : null;

    this.db
      .prepare(
        `INSERT INTO purchase_requests (id, agent_id, amount_cents, merchant, category, reason, status, decision_reason, created_at, decided_at, expires_at, risk_flags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        agent.id,
        input.amountCents,
        merchant,
        input.category?.trim() || null,
        reason,
        status,
        decision.reason,
        created,
        status === "pending" ? null : created,
        expiresAt,
        JSON.stringify(risk),
      );

    const what = `${agent.name} wants ${formatUsd(input.amountCents)} at ${merchant}`;
    if (status === "blocked") {
      this.log("request_blocked", `Blocked: ${what}. ${decision.reason}`, { agentId: agent.id, requestId: id });
      return { request: this.getRequest(id) };
    }
    if (status === "pending") {
      this.log("request_pending", `Approval needed: ${what}.`, { agentId: agent.id, requestId: id });
      const warning = risk.find((f) => f.level === "high");
      void this.notifier.push({
        title: warning ? "⚠️ Risky purchase request" : "Approve purchase?",
        body: warning ? `${what}. ${warning.message}` : `${what}: ${reason}`,
        requestId: id,
      });
      return { request: this.getRequest(id) };
    }
    this.log("request_auto_approved", `Auto-approved: ${what}.`, { agentId: agent.id, requestId: id });
    const card = await this.issueCard(id, agent.name, input.amountCents, merchant);
    return { request: this.getRequest(id), card };
  }

  private async issueCard(requestId: string, agentName: string, amountCents: number, merchant: string): Promise<Card> {
    const issued = await this.issuer.issueSingleUseCard({ amountCents, memo: `${agentName} @ ${merchant}` });
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO cards (id, request_id, provider, provider_card_id, pan, cvv, exp_month, exp_year, last4, spend_limit_cents, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      )
      .run(
        id,
        requestId,
        issued.provider,
        issued.providerCardId,
        issued.pan,
        issued.cvv,
        issued.expMonth,
        issued.expYear,
        issued.last4,
        amountCents,
        now(),
      );
    this.log("card_issued", `One-time card ending ${issued.last4} issued for ${formatUsd(amountCents)} at ${merchant}.`, { requestId });
    return this.cardForRequest(requestId)!;
  }

  async approve(requestId: string): Promise<{ request: PurchaseRequest; card?: Card }> {
    const request = this.getRequest(requestId);
    if (request.status !== "pending") throw new WalletError(`Request is already ${request.status}.`, 409);

    // Rules or spending may have changed since the request came in, so check again.
    const agent = this.getAgent(request.agentId);
    const recheck = evaluate(
      { ...agent, autoApproveUnderCents: 0 },
      { amountCents: request.amountCents, merchant: request.merchant, category: request.category ?? undefined },
      this.spentThisMonth(agent.id),
    );
    if (recheck.outcome === "block") {
      this.decide(requestId, "blocked", recheck.reason);
      this.log("request_blocked", `Blocked on approval: ${recheck.reason}`, { agentId: agent.id, requestId });
      return { request: this.getRequest(requestId) };
    }

    this.decide(requestId, "approved", "Approved by you.");
    this.log("request_approved", `You approved ${formatUsd(request.amountCents)} at ${request.merchant}.`, { agentId: agent.id, requestId });
    const card = await this.issueCard(requestId, agent.name, request.amountCents, request.merchant);
    return { request: this.getRequest(requestId), card };
  }

  deny(requestId: string, note?: string): PurchaseRequest {
    const request = this.getRequest(requestId);
    if (request.status !== "pending") throw new WalletError(`Request is already ${request.status}.`, 409);
    this.decide(requestId, "denied", note?.trim() || "Denied by you.");
    this.log("request_denied", `You denied ${formatUsd(request.amountCents)} at ${request.merchant}.`, { agentId: request.agentId, requestId });
    return this.getRequest(requestId);
  }

  private decide(requestId: string, status: RequestStatus, reason: string): void {
    const res = this.db
      .prepare("UPDATE purchase_requests SET status = ?, decision_reason = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
      .run(status, reason, now(), requestId);
    if (res.changes === 0) throw new WalletError("Request was already decided.", 409);
  }

  /**
   * Records a charge on a one-time card. With the mock issuer this stands in for
   * the store's payment; with Lithic it would be driven by transaction webhooks.
   */
  async recordCharge(cardId: string, amountCents: number, merchant: string): Promise<{ ok: boolean; reason: string }> {
    const row = this.db.prepare("SELECT * FROM cards WHERE id = ?").get(cardId) as any;
    if (!row) throw new WalletError("Card not found.", 404);
    const card = rowToCard(row);
    if (card.state !== "open") {
      this.log("charge_declined", `Declined a charge on card ending ${card.last4}: the card was already used.`, { requestId: row.request_id });
      return { ok: false, reason: "Card already used." };
    }
    if (amountCents > card.spendLimitCents) {
      this.log("charge_declined", `Declined ${formatUsd(amountCents)} on card ending ${card.last4}: over its ${formatUsd(card.spendLimitCents)} limit.`, { requestId: row.request_id });
      return { ok: false, reason: "Over the card's limit." };
    }
    this.db.prepare("UPDATE cards SET state = 'used' WHERE id = ?").run(cardId);
    this.db.prepare("UPDATE purchase_requests SET status = 'completed', amount_cents = ? WHERE id = ?").run(amountCents, row.request_id);
    await this.issuer.closeCard(row.provider_card_id);
    this.log("charge_completed", `Paid ${formatUsd(amountCents)} at ${merchant} with card ending ${card.last4}.`, { requestId: row.request_id });
    return { ok: true, reason: "Charged." };
  }
}
