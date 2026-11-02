import { describe, expect, it } from "vitest";
import { assessRisk, lookalikeOf } from "../src/risk.js";

const now = new Date("2026-11-02T12:00:00Z");
const past = (amountCents: number, merchant: string, hoursAgo: number) => ({
  amountCents,
  merchant,
  createdAt: new Date(now.getTime() - hoursAgo * 3600_000).toISOString(),
});

describe("lookalikeOf", () => {
  it("leaves real stores alone", () => {
    for (const m of ["Amazon", "amazon.com", "www.amazon.com", "Best Buy", "PayPal", "Uber Eats", "United", "Trader Joe's", "Etsy", "cooking.com", "Unity", "Targeted Ads Co", "Walgreens"]) {
      expect(lookalikeOf(m), m).toBeUndefined();
    }
  });

  it("catches imitations", () => {
    expect(lookalikeOf("amaz0n.com")).toBe("amazon");
    expect(lookalikeOf("paypa1.com")).toBe("paypal");
    expect(lookalikeOf("amazon-login-secure.net")).toBe("amazon");
    expect(lookalikeOf("apple-support.xyz")).toBe("apple");
    expect(lookalikeOf("netfliks.com")).toBe("netflix");
    expect(lookalikeOf("arnazon.com")).toBe("amazon");
  });
});

describe("assessRisk", () => {
  it("flags scam payment methods", () => {
    const flags = assessRisk({ amountCents: 50_000, merchant: "Target", reason: "Buy gift cards for the IRS" }, [], now);
    expect(flags.map((f) => f.code)).toContain("scam_pattern");
  });

  it("flags duplicates within 24 hours only", () => {
    const history = [past(2_999, "Amazon", 2)];
    expect(assessRisk({ amountCents: 2_999, merchant: "amazon.com", reason: "x" }, history, now).map((f) => f.code)).toContain("duplicate");
    const old = [past(2_999, "Amazon", 30)];
    expect(assessRisk({ amountCents: 2_999, merchant: "Amazon", reason: "x" }, old, now).map((f) => f.code)).not.toContain("duplicate");
  });

  it("flags amounts far above the agent's usual", () => {
    const history = [past(1_500, "A", 50), past(2_000, "B", 60), past(1_800, "C", 70)];
    expect(assessRisk({ amountCents: 9_000, merchant: "A", reason: "x" }, history, now).map((f) => f.code)).toContain("unusual_amount");
    expect(assessRisk({ amountCents: 3_000, merchant: "A", reason: "x" }, history, now).map((f) => f.code)).not.toContain("unusual_amount");
  });

  it("notes new stores, but not on the very first purchase", () => {
    expect(assessRisk({ amountCents: 100, merchant: "Etsy", reason: "x" }, [], now)).toEqual([]);
    expect(assessRisk({ amountCents: 100, merchant: "Etsy", reason: "x" }, [past(100, "Amazon", 5)], now)[0].code).toBe("new_merchant");
  });
});
