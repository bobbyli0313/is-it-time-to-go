/**
 * Tests for the collected hotel reference price.
 *
 * These carry more weight than usual: the reference price is now the *only* input
 * to the hotel dimension, there is no third-party feed to cross-check it against,
 * and a silent bug here moves a user-visible score. So the behaviours pinned down
 * are the ones that make the number mean what it claims:
 *
 *   - one property, one vote (a well-covered hotel must not outweigh a poorly
 *     covered one),
 *   - an unavailable city rather than a cheap one,
 *   - coverage and age disclosed instead of assumed,
 *   - a malformed dataset that degrades rather than producing a confident wrong
 *     number.
 */

import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeCityReferencePrice,
  fetchSelfCollectedHotelPrice,
  internals,
  MAX_CONFIDENCE,
  MIN_PROPERTIES,
} from "@/lib/data/hotel-price";
import {
  reduceToPropertyMedians,
  validateDataset,
  type CityHotelCensus,
  type HotelPriceSample,
} from "@/lib/data/hotel-dataset";
import { createFileStore } from "@/lib/data/hotel-dataset-file";
import { clearMemoryCache } from "@/lib/data/cache";
import { findCity } from "@/lib/data/cities";
import type { City } from "@/lib/scoring/types";

const TOKYO = findCity("tokyo") as City;
const NOW = new Date("2026-10-01T00:00:00Z");

/** A census of `count` properties, with Tokyo's real baseline (~¥500 in JPY). */
function census(count: number, complete = true): CityHotelCensus {
  return {
    cityId: "tokyo",
    currency: "JPY",
    baselineLocal: 11_000,
    properties: Array.from({ length: count }, (_, i) => ({
      id: `acme:${String(i).padStart(5, "0")}`,
      name: `Property ${i}`,
      group: "acme",
    })),
    censusComplete: complete,
    censusSource: "test",
  };
}

function sample(
  propertyIndex: number,
  priceLocal: number,
  date = "2026-10-20",
  overrides: Partial<HotelPriceSample> = {},
): HotelPriceSample {
  return {
    date,
    propertyId: `acme:${String(propertyIndex).padStart(5, "0")}`,
    priceLocal,
    source: "test",
    collectedAt: "2026-09-28T00:00:00Z",
    extraction: "verified",
    ...overrides,
  };
}

/** `count` properties priced at 8,000 + 100·i yen. */
function prices(count: number, base = 8_000, step = 100): HotelPriceSample[] {
  return Array.from({ length: count }, (_, i) => sample(i, base + i * step));
}

describe("computeCityReferencePrice", () => {
  it("takes the median across properties, which is the middle hotel's price", () => {
    // 9 properties at 8000..8800: the middle one is 8400.
    const { quote, detail } = computeCityReferencePrice(
      census(9),
      prices(9),
      "2026-10-20",
      NOW,
    );
    expect(quote.perNightLocal).toBe(8_400);
    expect(quote.basis).toBe("collected-median");
    expect(quote.sampleSize).toBe(9);
    expect(detail?.medianLocal).toBe(8_400);
  });

  /**
   * The rule that makes "the median of all hotels" true: without it, the figure
   * would be a median over *samples*, weighted by how much collection effort each
   * hotel happened to receive.
   */
  it("gives each property one vote, however many nights it was sampled", () => {
    const samples = [
      // One cheap hotel sampled on twenty nights: five times the coverage of any
      // other property, which is exactly the bias this rule exists to remove.
      ...Array.from({ length: 20 }, (_, i) =>
        sample(0, 5_000, `2026-10-${String(11 + i).padStart(2, "0")}`),
      ),
      // Eight hotels sampled once, priced at 20,000.
      ...Array.from({ length: 8 }, (_, i) => sample(i + 1, 20_000 + i * 100)),
    ];

    const { quote } = computeCityReferencePrice(census(9), samples, "2026-10-20", NOW);

    // Per property the values are [5000, 20000..20700]: nine values, so the middle
    // one is 20,300. Pooling all 28 samples instead would put the median at 5,000 —
    // the single cheap hotel would have decided the city's reference price alone,
    // purely because it was sampled more often.
    const pooled = [...samples.map((s) => s.priceLocal)].sort((a, b) => a - b);
    expect(pooled[Math.floor(pooled.length / 2)]).toBe(5_000);
    expect(quote.perNightLocal).toBe(20_300);
    expect(quote.sampleSize).toBe(9);
  });

  it("is not dragged by a single luxury property, unlike a mean", () => {
    const samples = [
      ...prices(8, 8_000, 0),
      sample(8, 400_000),
    ];
    const { quote } = computeCityReferencePrice(census(9), samples, "2026-10-20", NOW);
    expect(quote.perNightLocal).toBe(8_000);
  });

  it("reports unavailable rather than cheap when too few properties are priced", () => {
    const { quote, detail } = computeCityReferencePrice(
      census(40),
      prices(MIN_PROPERTIES - 1),
      "2026-10-20",
      NOW,
    );
    // A zero-confidence quote with no price: the scorer turns this into an excluded
    // dimension. Returning a low price would inflate the hotel score.
    expect(quote.perNightLocal).toBe(0);
    expect(quote.sampleSize).toBe(0);
    expect(quote.confidence).toBe(0);
    expect(detail).toBeNull();
  });

  it("uses only samples within the disclosed window", () => {
    const far = [
      sample(0, 1_000, "2026-09-01"),
      sample(1, 1_000, "2026-11-15"),
      ...prices(8, 9_000, 0),
    ];
    const { quote, detail } = computeCityReferencePrice(census(10), far, "2026-10-20", NOW);
    expect(detail?.windowStart).toBe("2026-10-17");
    expect(detail?.windowEnd).toBe("2026-10-23");
    expect(quote.perNightLocal).toBe(9_000);
  });

  it("ignores prices for properties that are not in the city's census", () => {
    const samples = [
      ...prices(8, 9_000, 0),
      { ...sample(0, 100), propertyId: "unknown-hotel:1" },
      { ...sample(1, 100), propertyId: "other-city:1" },
    ];
    const { quote } = computeCityReferencePrice(census(8), samples, "2026-10-20", NOW);
    expect(quote.perNightLocal).toBe(9_000);
    expect(quote.sampleSize).toBe(8);
  });

  it("discloses coverage when the census is the city's whole inventory", () => {
    const { quote, detail } = computeCityReferencePrice(
      census(24),
      prices(12),
      "2026-10-20",
      NOW,
    );
    expect(quote.propertyUniverse).toBe(24);
    expect(detail?.coverage).toBeCloseTo(0.5, 6);
    expect(detail?.censusComplete).toBe(true);
  });

  it("claims no coverage at all when the census is only the priced set", () => {
    const { quote, detail } = computeCityReferencePrice(
      census(12, false),
      prices(12),
      "2026-10-20",
      NOW,
    );
    // An unknown denominator must not be reported as 100% — and it must not be
    // reported at all: "12 of 12 known" would read as full coverage of a city whose
    // hotels were never enumerated.
    expect(detail?.coverage).toBeNull();
    expect(detail?.censusComplete).toBe(false);
    expect(detail?.cityPropertyCount).toBe(12);
    expect(quote.propertyUniverse).toBeUndefined();
  });

  it("publishes the amount or the distance from the anchor, as the source allows", () => {
    const withPrice = computeCityReferencePrice(
      census(20),
      prices(12, 8_000, 0),
      "2026-10-20",
      NOW,
      "price",
    );
    expect(withPrice.quote.disclosure).toBe("price");
    expect(withPrice.quote.perNightLocal).toBe(8_000);

    const indexOnly = computeCityReferencePrice(
      census(20),
      prices(12, 8_000, 0),
      "2026-10-20",
      NOW,
      "index",
    );
    // The amount is still there for scoring — it is the *response* that withholds it.
    expect(indexOnly.quote.perNightLocal).toBe(8_000);
    expect(indexOnly.quote.disclosure).toBe("index");
  });

  it("keeps the disclosure out of the cached quote of a different mode", async () => {
    clearMemoryCache();
    const base = {
      version: 2 as const,
      basis: {
        adults: 2,
        rooms: 1,
        roomClass: "cheapest-available" as const,
        taxIncluded: true,
      },
      cities: [census(9)],
      samples: prices(9),
    };
    const asPrice = await fetchSelfCollectedHotelPrice(
      TOKYO,
      "2026-10-20",
      [],
      { load: async () => ({ ...base, disclosure: "price" as const }) },
      NOW,
    );
    const asIndex = await fetchSelfCollectedHotelPrice(
      TOKYO,
      "2026-10-20",
      [],
      { load: async () => ({ ...base, disclosure: "index" as const }) },
      NOW,
    );
    expect(asPrice.disclosure).toBe("price");
    expect(asIndex.disclosure).toBe("index");
  });

  it("prefers verified extractions and discloses when only inferences exist", () => {
    const samples = [
      sample(0, 9_000, "2026-10-20", { extraction: "inferred" }),
      sample(0, 11_000, "2026-10-20", { extraction: "verified" }),
      ...prices(8, 9_000, 0).slice(1),
    ];
    const { quote, detail } = computeCityReferencePrice(census(9), samples, "2026-10-20", NOW);
    expect(quote.perNightLocal).toBe(9_000);
    expect(detail?.inferredProperties).toBe(0);

    const allInferred = computeCityReferencePrice(
      census(9),
      prices(9).map((s) => ({ ...s, extraction: "inferred" as const })),
      "2026-10-20",
      NOW,
    );
    expect(allInferred.detail?.inferredProperties).toBe(9);
    // And it costs confidence rather than being silently trusted.
    expect(allInferred.quote.confidence).toBeLessThan(
      computeCityReferencePrice(census(9), prices(9), "2026-10-20", NOW).quote.confidence,
    );
  });

  it("flags prices that were collected months ago", () => {
    const fresh = computeCityReferencePrice(
      census(9),
      prices(9).map((s) => ({ ...s, collectedAt: "2026-09-29T00:00:00Z" })),
      "2026-10-20",
      NOW,
    );
    const stale = computeCityReferencePrice(
      census(9),
      prices(9).map((s) => ({ ...s, collectedAt: "2026-01-05T00:00:00Z" })),
      "2026-10-20",
      NOW,
    );

    expect(fresh.quote.stale).toBe(false);
    expect(stale.quote.stale).toBe(true);
    expect(stale.detail?.ageDays).toBeGreaterThan(internals.STALE_AFTER_DAYS);
    expect(stale.quote.confidence).toBeLessThan(fresh.quote.confidence);
  });

  it("never reports a confidence the scorer would call high", () => {
    const many = Array.from({ length: 60 }, (_, i) => sample(i, 8_000 + i * 10));
    const { quote } = computeCityReferencePrice(
      {
        ...census(60),
        properties: Array.from({ length: 60 }, (_, i) => ({
          id: `acme:${String(i).padStart(5, "0")}`,
          name: `P${i}`,
          group: "acme",
        })),
      },
      many,
      "2026-10-20",
      NOW,
    );
    // 0.66 is the scorer's "high" threshold: a collected median is a sample of one
    // room type per property, and the badge must not imply a survey.
    expect(quote.confidence).toBeLessThanOrEqual(MAX_CONFIDENCE);
    expect(quote.confidence).toBeLessThan(0.66);
  });

  it("carries the newest collection timestamp it used", () => {
    const samples = prices(9).map((s, i) => ({
      ...s,
      collectedAt: i === 4 ? "2026-09-30T12:00:00Z" : "2026-09-01T00:00:00Z",
    }));
    const { quote } = computeCityReferencePrice(census(9), samples, "2026-10-20", NOW);
    expect(quote.collectedAt).toBe("2026-09-30T12:00:00Z");
  });
});

describe("reduceToPropertyMedians", () => {
  it("collapses each property to its own median", () => {
    const result = reduceToPropertyMedians([
      sample(0, 1_000),
      sample(0, 2_000),
      sample(0, 3_000),
      sample(1, 5_000),
    ]);
    expect(result).toHaveLength(2);
    expect(result.find((p) => p.propertyId.endsWith("00000"))?.medianLocal).toBe(2_000);
    expect(result.find((p) => p.propertyId.endsWith("00001"))?.medianLocal).toBe(5_000);
  });
});

describe("fetchSelfCollectedHotelPrice", () => {
  const dataset = {
    version: 2 as const,
    basis: {
      adults: 2,
      rooms: 1,
      roomClass: "cheapest-available" as const,
      taxIncluded: true,
    },
    cities: [census(9)],
    samples: prices(9),
  };

  it("serves the median through the provider interface", async () => {
    const quote = await fetchSelfCollectedHotelPrice(
      TOKYO,
      "2026-10-20",
      [],
      { load: async () => dataset },
      NOW,
    );
    expect(quote.perNightLocal).toBe(8_400);
    expect(quote.basis).toBe("collected-median");
  });

  it("serves a newly collected dataset immediately, not the previous one", async () => {
    clearMemoryCache();
    // The dataset's identity is part of the cache key. Without that, a collection
    // run would write a new file and the app would keep serving the old median
    // until the TTL expired — a fresh collection invisible for hours.
    const first = await fetchSelfCollectedHotelPrice(
      TOKYO,
      "2026-10-20",
      [],
      {
        load: async () => ({
          ...dataset,
          generatedAt: "2026-09-01T00:00:00Z",
          samples: prices(9, 8_000, 0),
        }),
      },
      NOW,
    );
    expect(first.perNightLocal).toBe(8_000);

    const second = await fetchSelfCollectedHotelPrice(
      TOKYO,
      "2026-10-20",
      [],
      {
        load: async () => ({
          ...dataset,
          generatedAt: "2026-09-30T00:00:00Z",
          samples: prices(9, 13_000, 0),
        }),
      },
      NOW,
    );
    expect(second.perNightLocal).toBe(13_000);
  });

  it("returns unavailable for a city with no census", async () => {
    const osaka = findCity("osaka") as City;
    const quote = await fetchSelfCollectedHotelPrice(
      osaka,
      "2026-10-20",
      [],
      { load: async () => dataset },
      NOW,
    );
    expect(quote.sampleSize).toBe(0);
    expect(quote.confidence).toBe(0);
  });
});

describe("validateDataset", () => {
  const good = {
    version: 2,
    basis: { adults: 2, rooms: 1, roomClass: "cheapest-available", taxIncluded: true },
    cities: [census(3)],
    samples: [sample(0, 9_000)],
  };

  it("accepts a well-formed dataset", () => {
    expect(validateDataset(good).ok).toBe(true);
  });

  it("rejects the previous version instead of misreading it", () => {
    const old = { version: 1, baskets: [], samples: [] };
    const result = validateDataset(old);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("unsupported version");
  });

  it("rejects a price whose property is not in any census", () => {
    const result = validateDataset({
      ...good,
      samples: [{ ...sample(0, 9_000), propertyId: "ghost:1" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("not in any city census");
  });

  it("requires a census-completeness claim", () => {
    const { censusComplete, ...withoutFlag } = census(2);
    void censusComplete;
    const result = validateDataset({ ...good, cities: [withoutFlag] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("censusComplete");
  });

  it("rejects a non-positive price and a non-ISO date", () => {
    expect(validateDataset({ ...good, samples: [sample(0, 0)] }).ok).toBe(false);
    expect(validateDataset({ ...good, samples: [sample(0, 1, "20/10/2026")] }).ok).toBe(false);
  });

  it("collects every problem rather than stopping at the first", () => {
    const result = validateDataset({
      version: 9,
      basis: {},
      cities: [{ ...census(1), cityId: "atlantis", baselineLocal: -1 }],
      samples: [sample(0, -5)],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThanOrEqual(4);
  });
});

describe("createFileStore", () => {
  it("degrades to an empty dataset when the file is missing", async () => {
    const store = createFileStore(join(tmpdir(), "iittg-does-not-exist.json"));
    const dataset = await store.load();
    expect(dataset.cities).toHaveLength(0);
    expect(store.lastLoadWasFallback()).toBe(true);
  });

  it("degrades on invalid content, and throws in strict mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iittg-hotel-"));
    const path = join(dir, "bad.json");
    await writeFile(path, '{"version":2,"cities":"nope"}\n', "utf8");

    const lenient = createFileStore(path);
    await expect(lenient.load()).resolves.toMatchObject({ cities: [] });
    expect(lenient.lastErrors().length).toBeGreaterThan(0);

    const strict = createFileStore(path, { strict: true });
    await expect(strict.load()).rejects.toThrow(/Invalid hotel dataset/);
  });

  it("reads a valid file and picks up a change without a restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "iittg-hotel-"));
    const path = join(dir, "good.json");
    const dataset = {
      version: 2,
      basis: { adults: 2, rooms: 1, roomClass: "cheapest-available", taxIncluded: true },
      cities: [census(3)],
      samples: [sample(0, 9_000)],
    };
    await writeFile(path, JSON.stringify(dataset), "utf8");

    const store = createFileStore(path);
    expect((await store.load()).samples).toHaveLength(1);

    await writeFile(
      path,
      JSON.stringify({ ...dataset, samples: [...dataset.samples, sample(1, 8_000)] }),
      "utf8",
    );
    // mtime is compared, so a freshly written dataset is served without a restart.
    expect((await store.load()).samples).toHaveLength(2);
  });
});
