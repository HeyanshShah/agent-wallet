import { randomInt, randomUUID } from "node:crypto";

export interface IssuedCard {
  provider: string;
  providerCardId: string;
  pan: string;
  cvv: string;
  expMonth: number;
  expYear: number;
  last4: string;
}

export interface CardIssuer {
  readonly name: string;
  /** Issues a card that can be charged once, for at most `amountCents`. */
  issueSingleUseCard(input: { amountCents: number; memo: string }): Promise<IssuedCard>;
  /** Closes a card so it can never be charged again. */
  closeCard(providerCardId: string): Promise<void>;
}

function luhnCheckDigit(digits: string): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

/** Fake cards for local development and demos. No money moves. */
export class MockIssuer implements CardIssuer {
  readonly name = "mock";

  async issueSingleUseCard(): Promise<IssuedCard> {
    // 4000 00 is a common test BIN; the rest is random but Luhn-valid.
    let body = "400000";
    while (body.length < 15) body += String(randomInt(10));
    const pan = body + luhnCheckDigit(body);
    const now = new Date();
    return {
      provider: this.name,
      providerCardId: `mock_${randomUUID()}`,
      pan,
      cvv: String(randomInt(100, 1000)),
      expMonth: now.getUTCMonth() + 1,
      expYear: now.getUTCFullYear() + 1,
      last4: pan.slice(-4),
    };
  }

  async closeCard(): Promise<void> {}
}

/**
 * Lithic (https://docs.lithic.com) issues real virtual cards. Use the sandbox
 * base URL while testing. SINGLE_USE cards close after their first charge, and
 * the TRANSACTION spend limit caps that charge at the approved amount.
 */
export class LithicIssuer implements CardIssuer {
  readonly name = "lithic";

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = "https://sandbox.lithic.com",
  ) {
    if (!apiKey) throw new Error("LITHIC_API_KEY is required when CARD_ISSUER=lithic");
  }

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: this.apiKey, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Lithic ${method} ${path} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async issueSingleUseCard(input: { amountCents: number; memo: string }): Promise<IssuedCard> {
    const card = await this.call("POST", "/v1/cards", {
      type: "SINGLE_USE",
      memo: input.memo.slice(0, 100),
      spend_limit: input.amountCents,
      spend_limit_duration: "TRANSACTION",
      state: "OPEN",
    });
    return {
      provider: this.name,
      providerCardId: card.token,
      pan: card.pan,
      cvv: card.cvv,
      expMonth: Number(card.exp_month),
      expYear: Number(card.exp_year),
      last4: card.last_four,
    };
  }

  async closeCard(providerCardId: string): Promise<void> {
    await this.call("PATCH", `/v1/cards/${providerCardId}`, { state: "CLOSED" });
  }
}

export function issuerFromEnv(env: NodeJS.ProcessEnv = process.env): CardIssuer {
  if ((env.CARD_ISSUER ?? "mock") === "lithic") {
    return new LithicIssuer(env.LITHIC_API_KEY ?? "", env.LITHIC_BASE_URL);
  }
  return new MockIssuer();
}
