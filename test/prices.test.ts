import { describe, expect, it } from "vitest";
import { SerpApiLookup, comparePrices, parseSerpApiShopping } from "../src/prices.js";

const offer = (merchant: string, priceCents: number) => ({ merchant, priceCents, title: "Sony WH-1000XM5" });

describe("comparePrices", () => {
  it("finds a meaningfully cheaper store", () => {
    const check = comparePrices("test", { amountCents: 39_999, merchant: "Best Buy" }, [offer("Walmart", 34_800), offer("Target", 32_999), offer("eBay", 41_000)]);
    expect(check.cheaper).toMatchObject({ merchant: "Target", priceCents: 32_999, savingsCents: 7_000 });
    expect(check.offers.map((o) => o.merchant)).toEqual(["Target", "Walmart", "eBay"]);
  });

  it("ignores tiny savings and the same store", () => {
    expect(comparePrices("t", { amountCents: 10_000, merchant: "Amazon" }, [offer("Target", 9_700)]).cheaper).toBeUndefined(); // $3 off
    expect(comparePrices("t", { amountCents: 2_000, merchant: "Amazon" }, [offer("Target", 1_400)]).cheaper).toBeDefined(); // $6, 30% off
    expect(comparePrices("t", { amountCents: 10_000, merchant: "amazon.com" }, [offer("Amazon", 5_000)]).cheaper).toBeUndefined();
  });

  it("handles no results", () => {
    expect(comparePrices("t", { amountCents: 10_000, merchant: "A" }, [])).toMatchObject({ offers: [] });
  });
});

describe("SerpApi Google Shopping", () => {
  const fixture = {
    shopping_results: [
      { title: "Sony WH-1000XM5", source: "Target", price: "$329.99", extracted_price: 329.99, product_link: "https://google.com/p/1" },
      { title: "Sony WH-1000XM5 (Renewed)", source: "eBay", price: "$249.00", extracted_price: 249, link: "https://ebay.com/x" },
      { title: "No price", source: "Mystery" },
    ],
    inline_shopping_results: [{ title: "Sony XM5", source: "Walmart", extracted_price: 318 }],
  };

  it("parses results", () => {
    expect(parseSerpApiShopping(fixture)).toEqual([
      { merchant: "Target", priceCents: 32_999, title: "Sony WH-1000XM5", url: "https://google.com/p/1" },
      { merchant: "eBay", priceCents: 24_900, title: "Sony WH-1000XM5 (Renewed)", url: "https://ebay.com/x" },
      { merchant: "Walmart", priceCents: 31_800, title: "Sony XM5", url: undefined },
    ]);
    expect(parseSerpApiShopping({})).toEqual([]);
  });

  it("calls the API with the product as the query", async () => {
    let called: URL | undefined;
    const fakeFetch = (async (url: URL) => {
      called = url;
      return new Response(JSON.stringify(fixture));
    }) as unknown as typeof fetch;
    const offers = await new SerpApiLookup("key123", fakeFetch).search("Sony WH-1000XM5", 0);
    expect(called?.searchParams.get("engine")).toBe("google_shopping");
    expect(called?.searchParams.get("q")).toBe("Sony WH-1000XM5");
    expect(called?.searchParams.get("api_key")).toBe("key123");
    expect(offers).toHaveLength(3);
  });
});
