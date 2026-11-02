// Risk checks run on every purchase request. Like the rules engine, this is a
// pure function: it gets the request plus the agent's history and returns flags.

export type RiskLevel = "high" | "medium" | "info";

export interface RiskFlag {
  level: RiskLevel;
  code: "lookalike_merchant" | "scam_pattern" | "duplicate" | "unusual_amount" | "new_merchant";
  message: string;
}

export interface PastPurchase {
  amountCents: number;
  merchant: string;
  createdAt: string;
}

/** Brands scammers like to imitate. Matching is on the normalized name. */
const BRANDS = [
  "amazon", "apple", "google", "microsoft", "paypal", "netflix", "spotify", "walmart", "target", "bestbuy",
  "ebay", "costco", "uber", "lyft", "doordash", "airbnb", "booking", "expedia", "delta", "united",
  "southwest", "americanairlines", "steam", "playstation", "xbox", "nike", "adobe", "chase", "venmo", "instacart",
];

const SCAM_WORDS = ["gift card", "giftcard", "bitcoin", "crypto", "wire transfer", "western union", "moneygram", "prepaid card"];

/** Lowercases, strips the TLD and joining punctuation, and undoes common look-alike swaps (0→o, 1→l, rn→m…). */
export function normalizeMerchant(name: string): string {
  return name
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\.(com|net|org|co|io|shop|store|app|xyz|top|info|biz|us|uk)(\/.*)?$/, "")
    .replace(/0/g, "o")
    .replace(/[1|]/g, "l")
    .replace(/3/g, "e")
    .replace(/4/g, "a")
    .replace(/5/g, "s")
    .replace(/7/g, "t")
    .replace(/rn/g, "m")
    .replace(/vv/g, "w")
    .replace(/[^a-z]/g, "");
}

function plainName(name: string): string {
  return name.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\.(com|net|org)$/, "").replace(/[^a-z]/g, "");
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/** Returns the brand a merchant seems to imitate, or undefined if it looks genuine. */
export function lookalikeOf(merchant: string): string | undefined {
  const plain = plainName(merchant);
  const norm = normalizeMerchant(merchant);
  // Genuine: the plain name is exactly a brand (e.g. "Amazon", "amazon.com", "Best Buy").
  if (BRANDS.includes(plain)) return undefined;
  for (const brand of BRANDS) {
    // Character swaps that only match after normalizing: "amaz0n", "paypa1".
    if (norm === brand) return brand;
    // Brand plus bait words: "amazon-login-secure", "apple-support".
    if (norm.includes(brand) && /(login|secure|verify|support|account|refund|billing|update|gift|deal|promo|official)/.test(norm)) {
      return brand;
    }
    // One or two typos away from a longer brand: "amazom", "netfliks". Requiring the same
    // first two letters keeps real names like "cooking" from matching "booking".
    if (brand.length >= 6 && norm.slice(0, 2) === brand.slice(0, 2) && editDistance(norm, brand) <= (brand.length >= 7 ? 2 : 1)) {
      return brand;
    }
  }
  return undefined;
}

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function assessRisk(
  attempt: { amountCents: number; merchant: string; reason: string },
  history: PastPurchase[],
  now = new Date(),
): RiskFlag[] {
  const flags: RiskFlag[] = [];

  const brand = lookalikeOf(attempt.merchant);
  if (brand) {
    flags.push({
      level: "high",
      code: "lookalike_merchant",
      message: `"${attempt.merchant}" looks like an imitation of ${brand[0].toUpperCase()}${brand.slice(1)}. This is a common scam pattern.`,
    });
  }

  const text = `${attempt.merchant} ${attempt.reason}`.toLowerCase();
  const scamWord = SCAM_WORDS.find((w) => text.includes(w));
  if (scamWord) {
    flags.push({
      level: "high",
      code: "scam_pattern",
      message: `Mentions "${scamWord}". Scammers ask for payment this way because it can't be reversed.`,
    });
  }

  const dayAgo = now.getTime() - 24 * 3600_000;
  const norm = normalizeMerchant(attempt.merchant);
  const dup = history.find(
    (p) => p.amountCents === attempt.amountCents && normalizeMerchant(p.merchant) === norm && Date.parse(p.createdAt) >= dayAgo,
  );
  if (dup) {
    flags.push({
      level: "medium",
      code: "duplicate",
      message: `Same amount at the same store in the last 24 hours. This might be a double purchase.`,
    });
  }

  const amounts = history.map((p) => p.amountCents);
  if (amounts.length >= 3) {
    const typical = median(amounts);
    if (attempt.amountCents >= typical * 3 && attempt.amountCents - typical >= 2_000) {
      flags.push({
        level: "medium",
        code: "unusual_amount",
        message: `${usd(attempt.amountCents)} is much more than this agent usually spends (typically ${usd(Math.round(typical))}).`,
      });
    }
  }

  if (history.length > 0 && !history.some((p) => normalizeMerchant(p.merchant) === norm)) {
    flags.push({ level: "info", code: "new_merchant", message: `First purchase at ${attempt.merchant}.` });
  }

  return flags;
}

export const hasHighRisk = (flags: RiskFlag[]) => flags.some((f) => f.level === "high");
