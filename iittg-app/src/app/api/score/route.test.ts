/**
 * Integration coverage for the scoring route.
 *
 * The prototype's version of this coverage called `requestScore` in-process.
 * Scoring has since moved server-side (API keys, a process-wide cache, upstream
 * calls), so these tests drive the route handler directly. Going through the handler
 * rather than raw HTTP keeps the suite hermetic while still exercising the real
 * validation, provider resolution and scoring path.
 *
 * What this file really protects is the set of *honesty rules* the model depends on:
 * a climate normal must not be presented as a forecast, a missing fare must be
 * excluded rather than scored as zero, and an unavailable dimension must not quietly
 * dilute the total.
 */

import { describe, expect, it } from "vitest";
import { callScoreRoute, d, scoreTripViaRoute } from "@/test/fixtures";
import { ROUTES } from "@/lib/data/routes";

describe("scoring route", () => {
  it("scores the spec's route with all five dimensions explained", async () => {
    const body = await scoreTripViaRoute("shanghai", "tokyo", d(3), d(7));

    // Five dimensions, in the spec's a-e order.
    expect(body.result.dimensions.map((dim) => dim.key)).toEqual([
      "weather",
      "hotel",
      "flight",
      "crowd",
      "fx",
    ]);

    // Every dimension is explainable and carries provenance.
    for (const dimension of body.result.dimensions) {
      expect(dimension.drivers.length).toBeGreaterThan(0);
      expect(Object.keys(dimension.facts).length).toBeGreaterThan(0);
    }

    expect(body.result.total).toBeGreaterThan(0);
    expect(body.result.total).toBeLessThanOrEqual(100);
    expect(body.result.tripDays).toBe(5);
    expect(body.trip.airportPair).toEqual(["PVG", "HND"]);
  });

  it("discloses the source of every dimension", async () => {
    const body = await scoreTripViaRoute("shanghai", "tokyo", d(3), d(7));

    // The suite pins every source to mock, so provenance must say so. A dimension
    // claiming to be live while serving fixtures would be the worst possible bug in
    // this area, which is why the claim is asserted rather than assumed.
    expect(body.provenance).toEqual({
      weather: "mock",
      holidays: "mock",
      fx: "mock",
      flight: "mock",
      hotel: "mock",
    });
  });

  it("uses a real forecast inside the horizon and a climate normal beyond it", async () => {
    const near = await scoreTripViaRoute("shanghai", "tokyo", d(3), d(7));
    const nearWeather = near.result.dimensions.find((x) => x.key === "weather")!;
    expect(nearWeather.facts.basis).toBe("forecast");
    expect(nearWeather.confidence).toBe("high");

    // The far edge of the legal window is outside any numerical forecast.
    const far = await scoreTripViaRoute("shanghai", "tokyo", d(30), d(30));
    const farWeather = far.result.dimensions.find((x) => x.key === "weather")!;
    expect(farWeather.facts.basis).toBe("climate-normal");
    expect(farWeather.confidence).not.toBe("high");
    expect(far.result.warnings).toContain("warning.weatherIsClimateNormal");
  });

  it("declares hotels as a price index, never a bookable rate", async () => {
    const body = await scoreTripViaRoute("shanghai", "tokyo", d(3), d(7));
    const hotel = body.result.dimensions.find((x) => x.key === "hotel")!;
    expect(hotel.facts.basis).toBe("hotel-price-index");
    expect(hotel.facts.disclaimer).toBe("hotel.fact.indexNotBookable");
  });

  it("carries a real timestamp on cached fares", async () => {
    const body = await scoreTripViaRoute("shanghai", "tokyo", d(3), d(7));
    const flight = body.result.dimensions.find((x) => x.key === "flight")!;
    expect(flight.facts.basis).toBe("cached-fare");
    expect(typeof flight.facts.fetchedAt).toBe("string");
    expect(Number.isFinite(Date.parse(String(flight.facts.fetchedAt)))).toBe(true);
  });

  it("excludes FX for a same-currency trip instead of scoring it zero", async () => {
    const body = await scoreTripViaRoute("shanghai", "beijing", d(3), d(6));

    const fx = body.result.dimensions.find((x) => x.key === "fx")!;
    expect(fx.applicable).toBe(false);
    expect(fx.score).toBeNull();
    expect(body.result.warnings).toContain("warning.sameCurrency");
    expect(body.provenance.fx).toBe("not-applicable");
    expect(body.result.total).toBeGreaterThan(0);
  });

  it("reports exactly four applicable dimensions for a same-currency trip", async () => {
    const body = await scoreTripViaRoute("shanghai", "beijing", d(3), d(6));

    expect(body.result.dimensions).toHaveLength(5);
    const applicable = body.result.dimensions.filter(
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
    const body = await scoreTripViaRoute("shanghai", "tokyo", d(3), d(6));
    const applicable = body.result.dimensions.filter(
      (dim) => dim.applicable && dim.score !== null,
    );
    expect(applicable).toHaveLength(5);
  });
});

describe("scoring route validation", () => {
  it("rejects a same-city request", async () => {
    const { body } = await callScoreRoute({
      originCityId: "tokyo",
      destinationCityId: "tokyo",
      departDate: d(3),
      returnDate: d(6),
    });
    expect(body.ok).toBe(false);
  });

  it("rejects a city pair with no route data", async () => {
    const { body } = await callScoreRoute({
      originCityId: "sapporo",
      destinationCityId: "bali",
      departDate: d(3),
      returnDate: d(8),
    });
    expect(body.ok).toBe(false);
  });

  it("rejects an unknown city id", async () => {
    const { body } = await callScoreRoute({
      originCityId: "atlantis",
      destinationCityId: "tokyo",
      departDate: d(3),
      returnDate: d(6),
    });
    expect(body.ok).toBe(false);
  });

  it("rejects dates outside the departure window", async () => {
    expect(
      (
        await callScoreRoute({
          originCityId: "shanghai",
          destinationCityId: "tokyo",
          departDate: d(-5),
          returnDate: d(-1),
        })
      ).body.ok,
    ).toBe(false);

    expect(
      (
        await callScoreRoute({
          originCityId: "shanghai",
          destinationCityId: "tokyo",
          departDate: d(40),
          returnDate: d(45),
        })
      ).body.ok,
    ).toBe(false);
  });

  it("accepts the exact edges of the departure window", async () => {
    const earliest = await callScoreRoute({
      originCityId: "shanghai",
      destinationCityId: "tokyo",
      departDate: d(0),
      returnDate: d(3),
    });
    expect(earliest.body.ok).toBe(true);

    const latest = await callScoreRoute({
      originCityId: "shanghai",
      destinationCityId: "tokyo",
      departDate: d(30),
      returnDate: d(30),
    });
    expect(latest.body.ok).toBe(true);
  });

  it("rejects a return before departure and an over-long trip", async () => {
    expect(
      (
        await callScoreRoute({
          originCityId: "shanghai",
          destinationCityId: "tokyo",
          departDate: d(6),
          returnDate: d(3),
        })
      ).body.ok,
    ).toBe(false);

    expect(
      (
        await callScoreRoute({
          originCityId: "shanghai",
          destinationCityId: "tokyo",
          departDate: d(3),
          returnDate: d(40),
        })
      ).body.ok,
    ).toBe(false);
  });

  it("rejects malformed dates rather than throwing", async () => {
    for (const bad of ["2026-02-30", "not-a-date", "", "2026-13-01"]) {
      const { status, body } = await callScoreRoute({
        originCityId: "shanghai",
        destinationCityId: "tokyo",
        departDate: bad,
        returnDate: d(6),
      });
      expect(body.ok).toBe(false);
      expect(status).toBeGreaterThanOrEqual(400);
    }
  });

  it("rejects a malformed body and non-JSON input without crashing", async () => {
    expect((await callScoreRoute({ nope: true })).status).toBe(400);
    expect((await callScoreRoute("{ not json")).status).toBe(400);
    expect((await callScoreRoute("[]")).status).toBe(400);
  });
});

describe("scoring route robustness", () => {
  it("scores every shipped route without NaN or an out-of-range total", async () => {
    const failures: string[] = [];

    for (const route of ROUTES) {
      const { body } = await callScoreRoute({
        originCityId: route.originCityId,
        destinationCityId: route.destinationCityId,
        departDate: d(7),
        returnDate: d(11),
      });

      if (!body.ok) {
        failures.push(`${route.id}: ${body.error}`);
        continue;
      }

      const { total, arithmeticMean, dimensions } = body.result;
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

  /**
   * The *scores* must be deterministic. Quote ages are deliberately excluded: a
   * cached fare's `fetchedAt` is derived from the request clock, so two calls a
   * millisecond apart legitimately disagree on it, and asserting otherwise would be
   * asserting that the freshness badge is broken.
   */
  it("is deterministic in its scores for the same request", async () => {
    const payload = {
      originCityId: "beijing",
      destinationCityId: "bangkok",
      departDate: d(12),
      returnDate: d(18),
    };
    const a = await callScoreRoute(payload);
    const b = await callScoreRoute(payload);
    expect(a.body.ok && b.body.ok).toBe(true);
    if (!a.body.ok || !b.body.ok) return;

    const stable = (body: typeof a.body) =>
      JSON.stringify({
        total: body.ok ? body.result.total : null,
        arithmeticMean: body.ok ? body.result.arithmeticMean : null,
        dimensions: body.ok
          ? body.result.dimensions.map((dim) => ({
              key: dim.key,
              score: dim.score,
              facts: Object.fromEntries(
                Object.entries(dim.facts).filter(
                  ([k]) => k !== "fetchedAt" && k !== "ageHours",
                ),
              ),
            }))
          : null,
        provenance: body.ok ? body.provenance : null,
      });

    expect(stable(a.body)).toBe(stable(b.body));
  });
});
