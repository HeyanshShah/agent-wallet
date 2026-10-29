import { describe, expect, it } from "vitest";
import { type AgentRules, evaluate } from "../src/rules.js";

const rules: AgentRules = {
  active: true,
  monthlyBudgetCents: 50_000,
  perPurchaseCapCents: 40_000,
  autoApproveUnderCents: 2_500,
  allowedCategories: [],
  blockedMerchants: ["casino"],
};

describe("evaluate", () => {
  it("auto-approves small purchases", () => {
    expect(evaluate(rules, { amountCents: 2_000, merchant: "Amazon" }, 0).outcome).toBe("auto_approve");
    expect(evaluate(rules, { amountCents: 2_500, merchant: "Amazon" }, 0).outcome).toBe("auto_approve");
  });

  it("asks for anything above the auto-approve limit", () => {
    expect(evaluate(rules, { amountCents: 2_501, merchant: "Amazon" }, 0).outcome).toBe("ask");
  });

  it("blocks purchases over the per-purchase cap", () => {
    const d = evaluate(rules, { amountCents: 40_001, merchant: "Amazon" }, 0);
    expect(d.outcome).toBe("block");
    expect(d.reason).toContain("per-purchase cap");
  });

  it("blocks purchases that would exceed the monthly budget", () => {
    const d = evaluate(rules, { amountCents: 10_000, merchant: "Amazon" }, 45_000);
    expect(d.outcome).toBe("block");
    expect(d.reason).toContain("$50.00 is left");
  });

  it("blocks merchants on the blocked list, ignoring case", () => {
    expect(evaluate(rules, { amountCents: 100, merchant: "Lucky CASINO Online" }, 0).outcome).toBe("block");
  });

  it("enforces allowed categories when set", () => {
    const travelOnly = { ...rules, allowedCategories: ["Travel"] };
    expect(evaluate(travelOnly, { amountCents: 100, merchant: "United", category: "travel" }, 0).outcome).toBe("auto_approve");
    expect(evaluate(travelOnly, { amountCents: 100, merchant: "Amazon", category: "electronics" }, 0).outcome).toBe("block");
    expect(evaluate(travelOnly, { amountCents: 100, merchant: "Amazon" }, 0).outcome).toBe("block");
  });

  it("blocks paused agents and bad amounts", () => {
    expect(evaluate({ ...rules, active: false }, { amountCents: 100, merchant: "Amazon" }, 0).outcome).toBe("block");
    expect(evaluate(rules, { amountCents: 0, merchant: "Amazon" }, 0).outcome).toBe("block");
    expect(evaluate(rules, { amountCents: 10.5, merchant: "Amazon" }, 0).outcome).toBe("block");
  });
});
