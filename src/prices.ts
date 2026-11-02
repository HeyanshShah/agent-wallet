// Price checks: before the owner approves, look up what the same product costs elsewhere.

export interface Offer {
  merchant: string;
  priceCents: number;
  title: string;
  url?: string;
}

export interface PriceCheck {
  provider: string;
  checkedAt: string;
  /** The cheapest offer that beats the requested price by enough to matter, if any. */
  cheaper?: Offer & { savingsCents: number };
  /** Lowest-priced offers found, cheapest first. */
  offers: Offer[];
}

export interface PriceLookup {
  readonly name: string;
  /** `amountCents` is the requested price; real lookups ignore it. */
  search(product: string, amountCents: number): Promise<Offer[]>;
}

/** Savings smaller than this aren't worth interrupting the owner over. */
const MIN_SAVINGS_CENTS = 500;
const MIN_SAVINGS_RATIO = 0.05;

const norm = (s: string) => s.toLowerCase().replace(/^www\./, "").replace(/\.(com|net|org)$/, "").replace(/[^a-z0-9]/g, "");

export function comparePrices(provider: string, requested: { amountCents: number; merchant: string }, offers: Offer[]): PriceCheck {
  const sorted = offers.filter((o) => o.priceCents > 0).sort((a, b) => a.priceCents - b.priceCents);
  const elsewhere = sorted.filter((o) => norm(o.merchant) !== norm(requested.merchant));
  const best = elsewhere[0];
  const savings = best ? requested.amountCents - best.priceCents : 0;
  const worthIt = best && savings >= MIN_SAVINGS_CENTS && savings >= requested.amountCents * MIN_SAVINGS_RATIO;
  return {
    provider,
    checkedAt: new Date().toISOString(),
    cheaper: worthIt ? { ...best, savingsCents: savings } : undefined,
    offers: sorted.slice(0, 5),
  };
}

/** Google Shopping results through SerpApi (https://serpapi.com/google-shopping-api). Needs SERPAPI_KEY. */
export class SerpApiLookup implements PriceLookup {
  readonly name = "google_shopping";

  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async search(product: string, _amountCents: number): Promise<Offer[]> {
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google_shopping");
    url.searchParams.set("q", product);
    url.searchParams.set("gl", "us");
    url.searchParams.set("hl", "en");
    url.searchParams.set("api_key", this.apiKey);
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`SerpApi ${res.status}`);
    return parseSerpApiShopping(await res.json());
  }
}

export function parseSerpApiShopping(data: any): Offer[] {
  const results = [...(data?.shopping_results ?? []), ...(data?.inline_shopping_results ?? [])];
  return results
    .filter((r) => typeof r?.extracted_price === "number" && r?.source)
    .map((r) => ({
      merchant: String(r.source),
      priceCents: Math.round(r.extracted_price * 100),
      title: String(r.title ?? ""),
      url: r.product_link ?? r.link,
    }));
}

/**
 * Made-up prices (a little under and over the requested price) so the feature can be demoed without an API key.
 * Every offer is labeled as a demo in the app.
 */
export class DemoLookup implements PriceLookup {
  readonly name = "demo";

  async search(product: string, amountCents: number): Promise<Offer[]> {
    const base = amountCents;
    return [
      { merchant: "Target", priceCents: Math.round(base * 0.82), title: product },
      { merchant: "Walmart", priceCents: Math.round(base * 0.9), title: product },
      { merchant: "eBay", priceCents: Math.round(base * 1.05), title: product },
    ];
  }
}

export function priceLookupFromEnv(env: NodeJS.ProcessEnv = process.env): PriceLookup | undefined {
  if (env.PRICE_CHECK === "demo") return new DemoLookup();
  if (env.SERPAPI_KEY) return new SerpApiLookup(env.SERPAPI_KEY);
  return undefined;
}
