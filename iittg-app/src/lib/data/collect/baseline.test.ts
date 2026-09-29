/**
 * Tests for the ¥500 anchor conversion.
 *
 * This exists because the first version of this conversion was **inverted** and
 * nothing failed: it produced a Tokyo baseline of 21 JPY instead of ~10,550 JPY,
 * which made every hotel in the city look 460× the anchor and pinned the hotel
 * dimension to its floor score. A unit error in a conversion is invisible in a
 * running system — the number is simply wrong — so the direction is pinned here with
 * rates that cannot be confused for each other.
 */

import { describe, expect, it } from "vitest";
import { baselineForCurrency, type UsdRateLookup } from "@/lib/data/collect/baseline";
import { PARAMS } from "@/lib/scoring/dimensions";

const NOW = new Date("2026-09-30T00:00:00Z");

/**
 * `usdRateTo` answers "how many units of X does one USD buy": about 7.1 CNY and
 * about 150 JPY. Deliberately far apart, so an inverted ratio is unmissable.
 */
const RATES: Record<string, number> = { CNY: 7.1, JPY: 150, KRW: 1_330, HKD: 7.8, THB: 32.5 };
const lookup: UsdRateLookup = async (currency) => RATES[currency] ?? null;

describe("baselineForCurrency", () => {
  it("divides by the CNY rate rather than multiplying by it", () => {
    return baselineForCurrency("JPY", NOW, lookup).then((result) => {
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // 500 CNY × (150 JPY/USD ÷ 7.1 CNY/USD) ≈ 10,563 JPY. The inverted form
      // would give 500 × 7.1/150 ≈ 24 — the bug this test exists for.
      expect(result.data.baselineLocal).toBeCloseTo(10_563.38, 1);
      expect(result.data.baselineLocal).toBeGreaterThan(10_000);
      expect(result.data.source).toBe("ecb");
    });
  });

  it("leaves CNY at the anchor itself", async () => {
    const result = await baselineForCurrency("CNY", NOW, lookup);
    expect(result.ok && result.data.baselineLocal).toBe(PARAMS.hotel.baselineCny);
  });

  it("scales the anchor with the currency's own value", async () => {
    const jpy = await baselineForCurrency("JPY", NOW, lookup);
    const krw = await baselineForCurrency("KRW", NOW, lookup);
    const hkd = await baselineForCurrency("HKD", NOW, lookup);
    if (!jpy.ok || !krw.ok || !hkd.ok) throw new Error("all three should convert");

    // A weaker currency needs more units to express the same ¥500.
    expect(krw.data.baselineLocal).toBeGreaterThan(jpy.data.baselineLocal);
    // And a currency near parity with CNY stays near the anchor.
    expect(hkd.data.baselineLocal).toBeCloseTo(549.3, 1);
  });

  it("falls back to the curated table when the ECB cannot answer", async () => {
    const offline: UsdRateLookup = async () => null;
    const result = await baselineForCurrency("JPY", NOW, offline);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.source).toBe("static-reference");
    // The curated level for JPY is 23.51 per CNY.
    expect(result.data.baselineLocal).toBeCloseTo(PARAMS.hotel.baselineCny * 23.51, 1);
  });

  it("refuses to convert at all rather than inventing a rate", async () => {
    const result = await baselineForCurrency("XYZ", NOW, async () => null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("XYZ");
  });

  it("records when the conversion was taken, so a dataset can disclose its age", async () => {
    const result = await baselineForCurrency("JPY", NOW, lookup);
    expect(result.ok && result.data.asOf).toBe(NOW.toISOString());
  });
});
