// The rules engine is a pure function so it is easy to test and reason about.

export interface AgentRules {
  active: boolean;
  monthlyBudgetCents: number;
  perPurchaseCapCents: number;
  autoApproveUnderCents: number;
  /** Empty means every category is allowed. */
  allowedCategories: string[];
  blockedMerchants: string[];
}

export interface PurchaseAttempt {
  amountCents: number;
  merchant: string;
  category?: string;
}

export type Decision =
  | { outcome: "block"; reason: string }
  | { outcome: "auto_approve"; reason: string }
  | { outcome: "ask"; reason: string };

const normalize = (s: string) => s.trim().toLowerCase();

export function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function evaluate(rules: AgentRules, attempt: PurchaseAttempt, spentThisMonthCents: number): Decision {
  if (!rules.active) {
    return { outcome: "block", reason: "This agent is paused." };
  }
  if (!Number.isInteger(attempt.amountCents) || attempt.amountCents <= 0) {
    return { outcome: "block", reason: "Amount must be a positive number of cents." };
  }

  const merchant = normalize(attempt.merchant);
  if (rules.blockedMerchants.some((m) => merchant.includes(normalize(m)))) {
    return { outcome: "block", reason: `${attempt.merchant} is on the blocked list.` };
  }

  if (rules.allowedCategories.length > 0) {
    const category = attempt.category ? normalize(attempt.category) : "";
    if (!rules.allowedCategories.map(normalize).includes(category)) {
      return {
        outcome: "block",
        reason: `Category "${attempt.category ?? "none"}" is not allowed. Allowed: ${rules.allowedCategories.join(", ")}.`,
      };
    }
  }

  if (attempt.amountCents > rules.perPurchaseCapCents) {
    return {
      outcome: "block",
      reason: `${formatUsd(attempt.amountCents)} is over the ${formatUsd(rules.perPurchaseCapCents)} per-purchase cap.`,
    };
  }

  const remaining = rules.monthlyBudgetCents - spentThisMonthCents;
  if (attempt.amountCents > remaining) {
    return {
      outcome: "block",
      reason: `Only ${formatUsd(Math.max(remaining, 0))} is left of the ${formatUsd(rules.monthlyBudgetCents)} monthly budget.`,
    };
  }

  if (attempt.amountCents <= rules.autoApproveUnderCents) {
    return { outcome: "auto_approve", reason: `Under the ${formatUsd(rules.autoApproveUnderCents)} auto-approve limit.` };
  }
  return { outcome: "ask", reason: "Needs your approval." };
}
