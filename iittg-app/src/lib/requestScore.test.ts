/**
 * Integration check for the whole pipeline: URL-shaped request -> mock provider
 * -> scoring -> a result the UI can render.
 *
 * Unit tests prove the formulas behave; this proves the wiring does, including
 * the honesty rules (climate normals far out, unavailable fares, same-currency
 * FX) and the spec's 30-day departure window, which is what makes holiday
 * scenarios testable at all.
 */

import { describe, expect, it } from "vitest";
import { requestScore } from "@/lib/requestScore";
import { ROUTES } from "@/lib/data/routes";
import { CITIES } from "@/lib/data/cities";
import { addDays, todayForTrip } from "@/lib/scoring/dates";

/**
 * Dates are derived from the real clock rather than hardcoded.
 *
 * The spec only permits departures within today..today+30, so any literal date in
 * a test is a time bomb: it passes on the day it was written and fails a month
 * later. Every case below is expressed as an offset from the actual today, which
 * also means the 30-day window is exercised from wherever the clock happens to be.
 */
const NOW = new Date();

/**
 * "Today" is resolved in the origin city's own timezone, exactly as the product
 * does it — not from UTC. At 04:00 UTC it is already the next calendar day in
 * Shanghai, and using the UTC date here would push every derived date one day
 * outside the departure window.
 */
const SHANGHAI = CITIES.find((c) => c.id === "shanghai")!;
const TODAY = todayForTrip(SHANGHAI.timezone, SHANGHAI.timezone, NOW);

/** ISO date `days` after today, in the UTC calendar used by the wire format. */
function d(days: number): string {
  return addDays(TODAY, days);
}
const MAX_DEPART = d(30);

function request(
  originCityId: string,
  destinationCityId: string,
  departDate: string,
  returnDate: string,
) {
  return requestScore(
    { originCityId, destinationCityId, departDate, returnDate },
    NOW,
  );
}

describe("end-to-end scoring", () => {
  it("scores the spec's route with all five dimensions explained", async () => {
    const response = await request("shanghai", "tokyo", d(3), d(7));
    expect(response.ok).toBe(true);
    if (!response.ok) return;

    const { result, trip } = response;

    // Five dimensions, in the spec's a-e order.
    expect(result.dimensions.map((d) => d.key)).toEqual([
      "weather",
      "hotel",
      "flight",
      "crowd",
      "fx",
    ]);

    // Every dimension is explainable and carries provenance.
    for (const dimension of result.dimensions) {
      expect(dimension.drivers.length).toBeGreaterThan(0);
      expect(Object.keys(dimension.facts).length).toBeGreaterThan(0);
    }

    expect(result.total).toBeGreaterThan(0);
    expect(result.total).toBeLessThanOrEqual(100);
    expect(result.tripDays).toBe(5);

    // 3 days out, so weather must be a real forecast, not a climate normal.
    const weather = result.dimensions.find((d) => d.key === "weather")!;
    expect(weather.facts.basis).toBe("forecast");
    expect(weather.confidence).toBe("high");
    // Destination-local lead time can differ by a day from the origin's.
    expect(weather.debug?.daysOut as number).toBeGreaterThanOrEqual(2);
    expect(weather.debug?.daysOut as number).toBeLessThanOrEqual(4);

    // Hotels must be declared as an index, never a bookable rate.
    const hotel = result.dimensions.find((d) => d.key === "hotel")!;
    expect(hotel.facts.basis).toBe("hotel-price-index");

    // Flights must be a cached quote carrying a real timestamp for the freshness badge.
    const flight = result.dimensions.find((d) => d.key === "flight")!;
    expect(flight.facts.basis).toBe("cached-fare");
    expect(typeof flight.facts.fetchedAt).toBe("string");
    expect(flight.facts.percentile).toBeTypeOf("number");

    // Cross-currency trip, so FX applies.
    const fx = result.dimensions.find((d) => d.key === "fx")!;
    expect(fx.applicable).toBe(true);
    expect(fx.facts.from).toBe("CNY");
    expect(fx.facts.to).toBe("JPY");

    expect(trip.airportPair).toEqual(["PVG", "HND"]);
  });

  it("falls back to a climate normal beyond the forecast horizon", async () => {
    const response = await request("shanghai", "tokyo", MAX_DEPART, d(30 + 4));
    expect(response.ok).toBe(true);
    if (!response.ok) return;

    const weather = response.result.dimensions.find((d) => d.key === "weather")!;
    expect(weather.facts.basis).toBe("climate-normal");
    // A climate normal can never be high confidence, however pleasant it looks.
    expect(weather.confidence).not.toBe("high");
    expect(response.result.warnings).toContain("warning.weatherIsClimateNormal");
  });

  it("excludes FX for a same-currency trip instead of scoring it zero", async () => {
    const response = await request("shanghai", "beijing", d(3), d(6));
    expect(response.ok).toBe(true);
    if (!response.ok) return;

    const fx = response.result.dimensions.find((d) => d.key === "fx")!;
    expect(fx.applicable).toBe(false);
    expect(fx.score).toBeNull();
    expect(response.result.warnings).toContain("warning.sameCurrency");
    // The total must still be a real number, averaged over the four applicable dimensions.
    expect(response.result.total).toBeGreaterThan(0);
  });

  /**
   * The UI renders only applicable dimensions, which is what makes a
   * same-currency trip a full 2x2 grid rather than 3 + 2 with a dead fifth card.
   * If the scorer ever marked a null-scoring dimension as applicable, the grid
   * would silently go back to containing an unusable card.
   */
  it("reports exactly four applicable dimensions for a same-currency trip", async () => {
    const response = await request("shanghai", "beijing", d(3), d(6));
    expect(response.ok).toBe(true);
    if (!response.ok) return;

    expect(response.result.dimensions).toHaveLength(5);
    const applicable = response.result.dimensions.filter(
      (dim) => dim.applicable && dim.score !== null,
    );
    expect(applicable.map((dim) => dim.key)).toEqual([
      "weather",
      "hotel",
      "flight",
      "crowd",
    ]);
  });

  it("reports five applicable dimensions for a cross-currency trip", async () => {
    const response = await request("shanghai", "tokyo", d(3), d(6));
    expect(response.ok).toBe(true);
    if (!response.ok) return;

    const applicable = response.result.dimensions.filter(
      (dim) => dim.applicable && dim.score !== null,
    );
    expect(applicable.map((dim) => dim.key)).toEqual([
      "weather",
      "hotel",
      "flight",
      "crowd",
      "fx",
    ]);
  });

  it("rejects a same-city request", async () => {
    expect((await request("tokyo", "tokyo", d(3), d(6))).ok).toBe(false);
  });

  it("rejects dates outside the spec's departure window", async () => {
    // Earlier than today.
    expect((await request("shanghai", "tokyo", d(-5), d(-1))).ok).toBe(false);
    // Later than today + 30.
    expect((await request("shanghai", "tokyo", d(40), d(45))).ok).toBe(false);
    // Return before departure.
    expect((await request("shanghai", "tokyo", d(6), d(3))).ok).toBe(false);
    // Trip longer than the 30-day maximum.
    expect((await request("shanghai", "tokyo", d(3), d(40))).ok).toBe(false);
  });

  it("accepts the exact edges of the departure window", async () => {
    expect((await request("shanghai", "tokyo", TODAY, d(3))).ok).toBe(true);
    expect((await request("shanghai", "tokyo", MAX_DEPART, d(30 + 2))).ok).toBe(true);
  });

  it("rejects malformed dates rather than throwing", async () => {
    const bad = await requestScore(
      {
        originCityId: "shanghai",
        destinationCityId: "tokyo",
        departDate: "2026-02-30",
        returnDate: "not-a-date",
      },
      NOW,
    );
    expect(bad.ok).toBe(false);
  });

  it("rejects a city pair with no route data", async () => {
    expect((await request("sapporo", "bali", d(3), d(8))).ok).toBe(false);
  });

  it("scores every shipped route without NaN or an out-of-range total", async () => {
    const failures: string[] = [];

    for (const route of ROUTES) {
      const response = await requestScore(
        {
          originCityId: route.originCityId,
          destinationCityId: route.destinationCityId,
          departDate: d(7),
          returnDate: d(11),
        },
        NOW,
      );

      if (!response.ok) {
        failures.push(`${route.id}: ${response.error}`);
        continue;
      }

      const { total, arithmeticMean, dimensions } = response.result;
      if (!Number.isFinite(total) || total < 0 || total > 100) {
        failures.push(`${route.id}: total ${total}`);
      }
      if (!Number.isFinite(arithmeticMean)) {
        failures.push(`${route.id}: arithmeticMean ${arithmeticMean}`);
      }
      for (const dimension of dimensions) {
        if (dimension.score !== null && !Number.isFinite(dimension.score)) {
          failures.push(`${route.id}: ${dimension.key} score ${dimension.score}`);
        }
        if (dimension.applicable && dimension.score === null) {
          failures.push(`${route.id}: ${dimension.key} applicable but null`);
        }
      }
    }

    expect(failures).toEqual([]);
  });

  it("is deterministic for the same request", async () => {
    const a = await request("beijing", "bangkok", d(12), d(18));
    const b = await request("beijing", "bangkok", d(12), d(18));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  /**
   * Crowding and holiday pricing read the destination's holiday calendar, so
   * these cases assert *behaviour* — a peak period scores worse and prices
   * higher than an ordinary one — rather than hardcoded scores.
   *
   * Departure dates are found by scanning the legal, holiday-aware window rather
   * than hardcoded, so the assertions hold no matter what today's date is.
   */
  async function peakAndQuietDepartures(country: string) {
    const { holidaysForCountry } = await import("@/lib/data/holidays");
    const inWindow = holidaysForCountry(country).filter(
      (h) =>
        (h.weight === "peak" || h.weight === "normal") &&
        h.date >= TODAY &&
        h.date <= MAX_DEPART,
    );

    /** Holiday days falling within the hotel index's +/- 3 day window. */
    const nearby = (depart: string) =>
      inWindow.filter(
        (h) => h.date >= addDays(depart, -3) && h.date <= addDays(depart, 3),
      ).length;

    let peak: string | null = null;
    let quiet: string | null = null;
    let peakCount = 0;

    for (let offset = 0; offset <= 30; offset += 1) {
      const depart = d(offset);
      const count = nearby(depart);
      if (count > peakCount) {
        peakCount = count;
        peak = depart;
      }
      if (count === 0 && quiet === null && offset >= 5) quiet = depart;
    }

    return peak && peakCount > 0 && quiet
      ? { peak, quiet, peakCount }
      : null;
  }

  it("scores a holiday peak below an ordinary week on crowding", async () => {
    const pair = await peakAndQuietDepartures("CN");
    if (!pair) return; // No holiday in the legal window right now.

    const busy = await request("shanghai", "beijing", pair.peak, addDays(pair.peak, 3));
    const calm = await request("shanghai", "beijing", pair.quiet, addDays(pair.quiet, 3));
    expect(busy.ok && calm.ok).toBe(true);
    if (!busy.ok || !calm.ok) return;

    const busyCrowd = busy.result.dimensions.find((x) => x.key === "crowd")!;
    const calmCrowd = calm.result.dimensions.find((x) => x.key === "crowd")!;

    expect(busyCrowd.facts.holidayCount as number).toBeGreaterThan(0);
    expect(calmCrowd.facts.holidayCount).toBe(0);
    expect(busyCrowd.score as number).toBeLessThan(calmCrowd.score as number);
  });

  it("flags a consecutive peak run during a national holiday", async () => {
    const pair = await peakAndQuietDepartures("CN");
    if (!pair) return;

    const busy = await request("shanghai", "beijing", pair.peak, addDays(pair.peak, 3));
    expect(busy.ok).toBe(true);
    if (!busy.ok) return;

    const crowd = busy.result.dimensions.find((x) => x.key === "crowd")!;
    expect(crowd.facts.holidayCount as number).toBeGreaterThanOrEqual(3);
    expect(crowd.drivers).toContain("crowd.driver.peakRun");
    expect((crowd.facts.longestPeakRun as number)).toBeGreaterThanOrEqual(3);
  });

  it("raises the holiday price lift on peak dates and zeroes it on quiet ones", async () => {
    const pair = await peakAndQuietDepartures("TH");
    if (!pair) return;

    const busy = await request("shanghai", "bangkok", pair.peak, addDays(pair.peak, 3));
    const calm = await request("shanghai", "bangkok", pair.quiet, addDays(pair.quiet, 3));
    expect(busy.ok && calm.ok).toBe(true);
    if (!busy.ok || !calm.ok) return;

    const busyHotel = busy.result.dimensions.find((x) => x.key === "hotel")!;
    const calmHotel = calm.result.dimensions.find((x) => x.key === "hotel")!;

    // Assert on the disclosed holiday component rather than the composed index:
    // the index also carries seasonal and city-level movement, which would make
    // this comparison flaky for reasons unrelated to holidays.
    expect(busyHotel.facts.nearbyHolidayDays as number).toBeGreaterThan(
      calmHotel.facts.nearbyHolidayDays as number,
    );
    expect(busyHotel.facts.holidayLift as number).toBeGreaterThan(
      calmHotel.facts.holidayLift as number,
    );
    expect(calmHotel.facts.holidayLift).toBe(1);
  });

  it("scores the same dates differently for two destinations with different calendars", async () => {
    // Japan's calendar is quiet when China's is not, so one departure date can be
    // crowded for Beijing and calm for Tokyo.
    const pair = await peakAndQuietDepartures("CN");
    if (!pair) return;

    const toBeijing = await request("shanghai", "beijing", pair.peak, addDays(pair.peak, 3));
    expect(toBeijing.ok).toBe(true);
    if (!toBeijing.ok) return;

    const { holidaysForCountry } = await import("@/lib/data/holidays");
    const jpOnThoseDates = holidaysForCountry("JP").filter(
      (h) => h.date >= pair.peak && h.date <= addDays(pair.peak, 3),
    );
    if (jpOnThoseDates.length > 0) return; // Not a distinguishing date.

    const toTokyo = await request("shanghai", "tokyo", pair.peak, addDays(pair.peak, 3));
    expect(toTokyo.ok).toBe(true);
    if (!toTokyo.ok) return;

    const tokyoCrowd = toTokyo.result.dimensions.find((x) => x.key === "crowd")!;
    const beijingCrowd = toBeijing.result.dimensions.find((x) => x.key === "crowd")!;
    expect(tokyoCrowd.facts.holidayCount).toBe(0);
    expect(beijingCrowd.score as number).toBeLessThan(tokyoCrowd.score as number);
  });
});
