/**
 * Tests for the self-collected hotel price index.
 *
 * This module replaced a third-party integration, so the tests carry more weight than
 * usual: the index is now the only source for the hotel dimension, and a silent bug
 * here would move a score with nothing to cross-check against.
 *
 * The behaviours worth protecting are the ones that keep the index *meaningful*
 * rather than merely non-zero: a fixed basket, a median rather than a mean, a sample
 * window that is disclosed, and "unavailable" instead of "cheap" when there is no
 * data.
 */

import { describe, expect, it } from "vitest";
import {
  computeHotelIndex,
  validateDataset,
  internals,
  type CityHotelBasket,
  type HotelPriceSample,
} from "@/lib/data/hotel-index";

const basket: CityHotelBasket = {
  cityId: "tokyo",
  currency: "JPY",
  propertyIds: ["h1", "h2", "h3", "h4", "h5"],
  baselineLocal: 11_700,
};

function sample(
  propertyId: string,
  date: string,
  priceLocal: number,
): HotelPriceSample {
  return {
    propertyId,
    date,
    priceLocal,
    source: "test",
    collectedAt: `${date}T00:00:00Z`,
  };
}

describe("computeHotelIndex", () => {
  it("uses the median, not the mean, so one suite cannot drag the index", () => {
    const samples = [
      sample("h1", "2026-10-01", 10_000),
      sample("h2", "2026-10-01", 11_000),
      sample("h3", "2026-10-01", 12_000),
      // A single luxury property an order of magnitude above the rest.
      sample("h4", "2026-10-01", 400_000),
    ];

    const { quote } = computeHotelIndex(basket, samples, "2026-10-01");

    // Median of [10000, 11000, 12000, 400000] is 11500; the mean would be 108250.
    expect(quote.perNightLocal).toBe(11_500);
  });

  it("reports unavailable rather than cheap when there are too few samples", () => {
    const { quote, detail } = computeHotelIndex(
      basket,
      [sample("h1", "2026-10-01", 9000)],
      "2026-10-01",
    );

    // A zero-confidence quote with no price is what the scorer turns into an excluded
    // dimension. Returning a low price here would inflate the hotel score.
    expect(quote.sampleSize).toBe(0);
    expect(quote.confidence).toBe(0);
    expect(detail).toBeNull();
    expect(quote.perNightLocal).toBe(0);
  });

  it("ignores samples outside the +/- window around the requested date", () => {
    const inside = [
      sample("h1", "2026-10-02", 10_000),
      sample("h2", "2026-10-03", 10_500),
      sample("h3", "2026-10-04", 11_000),
    ];
    const farOutside = [
      sample("h1", "2026-09-01", 1_000),
      sample("h2", "2026-11-01", 1_000),
      sample("h3", "2026-12-01", 1_000),
    ];

    const withOnlyFar = computeHotelIndex(basket, farOutside, "2026-10-03");
    expect(withOnlyFar.quote.sampleSize).toBe(0);

    const withBoth = computeHotelIndex(
      basket,
      [...farOutside, ...inside],
      "2026-10-03",
    );
    // The cheap out-of-window samples must not pull the index down.
    expect(withBoth.quote.sampleSize).toBe(3);
    expect(withBoth.quote.perNightLocal).toBe(10_500);
  });

  it("discloses the window it actually used", () => {
    const samples = [
      sample("h1", "2026-10-01", 10_000),
      sample("h2", "2026-10-02", 10_000),
      sample("h3", "2026-10-03", 10_000),
    ];
    const { detail } = computeHotelIndex(basket, samples, "2026-10-03");
    expect(detail).not.toBeNull();
    expect(detail?.windowStart).toBe("2026-09-30");
    expect(detail?.windowEnd).toBe("2026-10-06");
    expect(detail?.sampleCount).toBe(3);
  });

  /**
   * An index is only comparable over time if its membership is stable, so a sample
   * for a property outside the declared basket must not enter the calculation.
   */
  it("ignores samples for properties outside the declared basket", () => {
    const samples = [
      sample("h1", "2026-10-01", 10_000),
      sample("h2", "2026-10-01", 10_000),
      sample("h3", "2026-10-01", 10_000),
      // Not in the basket; a cheap outlier that would otherwise win.
      sample("outsider", "2026-10-01", 1),
    ];
    const { quote } = computeHotelIndex(basket, samples, "2026-10-01");
    expect(quote.sampleSize).toBe(3);
    expect(quote.perNightLocal).toBe(10_000);
  });

  it("reports a wider spread for less consistent prices", () => {
    const tight = [
      sample("h1", "2026-10-01", 10_000),
      sample("h2", "2026-10-01", 10_100),
      sample("h3", "2026-10-01", 10_200),
    ];
    const loose = [
      sample("h1", "2026-10-01", 5_000),
      sample("h2", "2026-10-01", 10_000),
      sample("h3", "2026-10-01", 20_000),
    ];

    const a = computeHotelIndex(basket, tight, "2026-10-01");
    const b = computeHotelIndex(basket, loose, "2026-10-01");

    expect(a.detail!.spread).toBeLessThan(b.detail!.spread);
    // And the noisier basket is trusted less.
    expect(a.quote.confidence).toBeGreaterThan(b.quote.confidence);
  });

  it("never reports high confidence, however well sampled", () => {
    // A handful of properties stands in for a whole city; the badge must not imply a
    // survey.
    const many = Array.from({ length: 40 }, (_, i) =>
      sample(`h${i}`, "2026-10-01", 10_000 + i * 10),
    );
    const { quote } = computeHotelIndex(
      { ...basket, propertyIds: many.map((s) => s.propertyId) },
      many,
      "2026-10-01",
    );
    expect(quote.confidence).toBeLessThanOrEqual(0.75);
  });

  it("keeps the declared baseline rather than deriving one from the samples", () => {
    // The baseline is the reference the index is measured against. Deriving it from
    // the same samples would make every city score ~100 by construction.
    const samples = [
      sample("h1", "2026-10-01", 50_000),
      sample("h2", "2026-10-01", 50_000),
      sample("h3", "2026-10-01", 50_000),
    ];
    const { quote } = computeHotelIndex(basket, samples, "2026-10-01");
    expect(quote.baselineLocal).toBe(basket.baselineLocal);
    expect(quote.perNightLocal).toBe(50_000);
  });

  it("exposes a configurable window and minimum sample count", () => {
    expect(internals.SAMPLE_WINDOW_DAYS).toBeGreaterThan(0);
    expect(internals.MIN_SAMPLES).toBeGreaterThanOrEqual(3);
  });
});

describe("validateDataset", () => {
  const good = {
    version: 1,
    baskets: [basket],
    samples: [sample("h1", "2026-10-01", 10_000)],
  };

  it("accepts a well-formed dataset", () => {
    const result = validateDataset(good);
    expect(result.ok).toBe(true);
  });

  it("rejects a wrong or missing version", () => {
    expect(validateDataset({ ...good, version: 2 }).ok).toBe(false);
    expect(validateDataset({ baskets: [], samples: [] }).ok).toBe(false);
  });

  it("rejects a non-object", () => {
    expect(validateDataset(null).ok).toBe(false);
    expect(validateDataset("nope").ok).toBe(false);
    expect(validateDataset([]).ok).toBe(false);
  });

  it("rejects an unknown city in a basket", () => {
    const result = validateDataset({
      ...good,
      baskets: [{ ...basket, cityId: "atlantis" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("unknown city");
    }
  });

  it("rejects a basket with no properties or a non-positive baseline", () => {
    expect(
      validateDataset({ ...good, baskets: [{ ...basket, propertyIds: [] }] }).ok,
    ).toBe(false);
    expect(
      validateDataset({ ...good, baskets: [{ ...basket, baselineLocal: 0 }] }).ok,
    ).toBe(false);
  });

  it("rejects a non-positive sample price", () => {
    const result = validateDataset({
      ...good,
      samples: [sample("h1", "2026-10-01", 0)],
    });
    expect(result.ok).toBe(false);
  });

  it("collects every problem rather than stopping at the first", () => {
    const result = validateDataset({
      version: 9,
      baskets: [{ ...basket, cityId: "atlantis", baselineLocal: -1 }],
      samples: [sample("h1", "2026-10-01", -5)],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    }
  });
});
