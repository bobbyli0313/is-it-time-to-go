/**
 * Tests for request-path collection.
 *
 * This module spends a real, small, shared resource — 50 Hotelbeds requests a day — on
 * behalf of whoever happens to be searching, so the tests are mostly about restraint:
 *
 *   - a city whose prices are still fresh costs nothing;
 *   - the day's budget stops collection rather than discovering the limit as a 403;
 *   - a failure never fails the score, and never destroys the dataset that already
 *     existed;
 *   - concurrent searches for one city share a single request;
 *   - a collection merges into the dataset instead of replacing it.
 *
 * The transport is stubbed throughout: no test here touches the network.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectCityOnDemand, internals } from "@/lib/data/collect/on-demand";
import { mergeDataset, writeDatasetAtomic } from "@/lib/data/collect/dataset-io";
import { emptyDataset, validateDataset, type HotelDataset } from "@/lib/data/hotel-dataset";
import { findCity } from "@/lib/data/cities";
import { createHotelbedsAdapter } from "@/lib/data/collect/adapters/hotelbeds";
import type { City } from "@/lib/scoring/types";
import type { CollectorAdapter, FetchResponse } from "@/lib/data/collect/types";

const TOKYO = findCity("tokyo") as City;
const NOW = new Date("2026-09-30T12:00:00Z");

/* ------------------------------------------------------------- fixtures */

/** A Hotelbeds availability payload with `count` hotels. */
function availability(count: number, checkIn = "2026-10-20"): FetchResponse {
  const hotels = Array.from({ length: count }, (_, i) => ({
    code: 1000 + i,
    name: `Hotel ${i}`,
    categoryName: "4 STARS",
    currency: "EUR",
    rooms: [
      {
        code: "DBL.ST",
        rates: [
          {
            net: String(100 + i),
            boardCode: "RO",
            dailyRates: [{ offset: 1, dailyNet: String(100 + i) }],
          },
        ],
      },
    ],
  }));
  return {
    status: 200,
    url: "https://api.test.hotelbeds.com/hotel-api/1.0/hotels",
    contentType: "application/json",
    headers: {},
    body: JSON.stringify({
      hotels: { hotels, checkIn, checkOut: checkIn, total: count },
    }),
  };
}

/**
 * A one-city dataset.
 *
 * Property ids are offset per city because ids are globally unique by schema — two
 * cities sharing `hotelbeds:1000` is exactly the kind of collision the dataset
 * validation exists to catch, and a fixture that trips it would be testing the fixture.
 */
function datasetWith(cityId: string, properties: number, collectedAt: string): HotelDataset {
  const base = cityId === "tokyo" ? 1000 : 5000;
  return {
    ...emptyDataset(),
    generatedAt: collectedAt,
    cities: [
      {
        cityId,
        currency: "JPY",
        baselineLocal: 11_000,
        properties: Array.from({ length: properties }, (_, i) => ({
          id: `hotelbeds:${base + i}`,
          name: `Hotel ${i}`,
          group: "hotelbeds",
        })),
        censusComplete: false,
      },
    ],
    samples: Array.from({ length: properties }, (_, i) => ({
      date: "2026-10-20",
      propertyId: `hotelbeds:${base + i}`,
      priceLocal: 15_000 + i * 100,
      source: "hotelbeds",
      collectedAt,
      extraction: "verified" as const,
    })),
  };
}

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "iittg-ondemand-"));
}

/** An adapter that answers with a fixed payload, counting its calls. */
function stubAdapter(calls: { count: number }, payload: FetchResponse = availability(12)): CollectorAdapter {
  const adapter = createHotelbedsAdapter(
    { apiKey: "k", secret: "s", environment: "test" },
    { convert: async (amount: number) => amount * 160 },
  );
  return {
    ...adapter,
    fetchRates: async (queries, ctx) => {
      calls.count += 1;
      return adapter.fetchRates!.call(adapter, queries, {
        ...ctx,
        fetchFn: async () => payload,
      });
    },
  };
}

function options(dir: string, calls: { count: number }, overrides: Record<string, unknown> = {}) {
  return {
    datasetPath: join(dir, "hotel-prices.json"),
    adapter: stubAdapter(calls),
    dailyQuota: 49,
    freshHours: 24,
    now: NOW,
    log: () => {},
    // The adapter is injected above, but the transport still needs to be stubbed so no
    // stray call could ever reach the network.
    fetchImpl: (async () => {
      throw new Error("the network must not be reached in this test");
    }) as unknown as typeof globalThis.fetch,
    // The ¥500 anchor, without asking the ECB.
    resolveBaseline: async (currency: string) => ({
      ok: true as const,
      data: {
        currency,
        baselineLocal: 11_000,
        source: "static-reference" as const,
        asOf: "2026-09-30T00:00:00Z",
      },
    }),
    ...overrides,
  };
}

/* ---------------------------------------------------------------- tests */

describe("collectCityOnDemand", () => {
  // The in-process overlay exists so a read-only filesystem does not forget what it
  // collected; between tests it has to be cleared or one case would answer for another.
  beforeEach(() => internals.resetMemory());

  it("collects a city that has no prices, and saves them", async () => {
    const dir = await workspace();
    const calls = { count: 0 };
    const result = await collectCityOnDemand(TOKYO, "2026-10-20", emptyDataset(), options(dir, calls));

    expect(result.outcome).toEqual({ status: "collected", properties: 12 });
    expect(calls.count).toBe(1);

    const saved = JSON.parse(await readFile(join(dir, "hotel-prices.json"), "utf8"));
    const validation = validateDataset(saved);
    expect(validation.ok).toBe(true);
    expect(saved.cities[0].cityId).toBe("tokyo");
    expect(saved.samples).toHaveLength(12);
    // The anchor is the ¥500 one, not a number derived from these very samples.
    expect(saved.cities[0].baselineLocal).toBeGreaterThan(10_000);
  });

  it("spends nothing when the city's prices are still fresh", async () => {
    const dir = await workspace();
    const calls = { count: 0 };
    const dataset = datasetWith("tokyo", 12, "2026-09-30T06:00:00Z");

    const result = await collectCityOnDemand(TOKYO, "2026-10-20", dataset, options(dir, calls));

    expect(result.outcome).toEqual({ status: "fresh" });
    expect(calls.count).toBe(0);
  });

  it("re-collects once the samples age past the freshness window", async () => {
    const dir = await workspace();
    const calls = { count: 0 };
    const stale = datasetWith("tokyo", 12, "2026-09-28T00:00:00Z");

    const result = await collectCityOnDemand(TOKYO, "2026-10-20", stale, options(dir, calls));

    expect(result.outcome.status).toBe("collected");
    expect(calls.count).toBe(1);
  });

  it("stops at the day's budget instead of discovering it as a 403", async () => {
    const dir = await workspace();
    const calls = { count: 0 };
    const quotaPath = join(dir, "quota.json");
    await writeFile(quotaPath, JSON.stringify({ day: "2026-09-30", used: 49 }), "utf8");

    const result = await collectCityOnDemand(
      TOKYO,
      "2026-10-20",
      emptyDataset(),
      options(dir, calls, { quotaPath }),
    );

    expect(result.outcome.status).toBe("skipped");
    if (result.outcome.status === "skipped") {
      expect(result.outcome.reason).toContain("49");
    }
    expect(calls.count).toBe(0);
  });

  it("counts what it spends, so the budget is shared across cities", async () => {
    const dir = await workspace();
    const calls = { count: 0 };
    const quotaPath = join(dir, "quota.json");
    const opts = options(dir, calls, { quotaPath, dailyQuota: 2 });

    /**
     * Dates months apart, deliberately. One collection covers the ±3-day window around
     * it, so asking for consecutive nights is a *cache hit* — correct behaviour, and it
     * would make this test count one request and assert nothing about the budget.
     */
    await collectCityOnDemand(TOKYO, "2026-10-20", emptyDataset(), opts);
    await collectCityOnDemand(TOKYO, "2026-11-20", emptyDataset(), opts);
    const third = await collectCityOnDemand(TOKYO, "2026-12-20", emptyDataset(), opts);

    expect(calls.count).toBe(2);
    expect(third.outcome.status).toBe("skipped");
  });

  it("resets the counter on a new day", async () => {
    const dir = await workspace();
    const calls = { count: 0 };
    const quotaPath = join(dir, "quota.json");
    await writeFile(quotaPath, JSON.stringify({ day: "2026-09-29", used: 49 }), "utf8");

    const result = await collectCityOnDemand(
      TOKYO,
      "2026-10-20",
      emptyDataset(),
      options(dir, calls, { quotaPath }),
    );
    expect(result.outcome.status).toBe("collected");
  });

  it("shares one request between concurrent searches for the same city", async () => {
    const dir = await workspace();
    const calls = { count: 0 };
    const opts = options(dir, calls);

    const results = await Promise.all([
      collectCityOnDemand(TOKYO, "2026-10-20", emptyDataset(), opts),
      collectCityOnDemand(TOKYO, "2026-10-20", emptyDataset(), opts),
      collectCityOnDemand(TOKYO, "2026-10-20", emptyDataset(), opts),
    ]);

    expect(calls.count).toBe(1);
    expect(results.every((r) => r.outcome.status === "collected")).toBe(true);
  });

  it("reports a refusal as a reason, and leaves the caller's dataset untouched", async () => {
    const dir = await workspace();
    const calls = { count: 0 };
    const existing = datasetWith("osaka", 12, "2026-09-30T06:00:00Z");
    const blocked = stubAdapter(calls, {
      status: 403,
      url: "https://api.test.hotelbeds.com/hotel-api/1.0/hotels",
      contentType: "application/json",
      headers: {},
      body: JSON.stringify({ error: { code: "quota" } }),
    });

    const result = await collectCityOnDemand(
      TOKYO,
      "2026-10-20",
      existing,
      options(dir, calls, { adapter: blocked }),
    );

    expect(result.outcome.status).toBe("failed");
    // Osaka's data survives a failed Tokyo collection: the dataset is the caller's.
    expect(result.dataset).toBe(existing);
    expect(result.dataset.cities.map((c) => c.cityId)).toEqual(["osaka"]);
  });

  /**
   * The serverless case. Vercel gives a function only `/tmp`, which is per-instance and
   * ephemeral, so the dataset and the quota counter cannot be written at all. Without
   * the in-memory fallback the app would re-collect the same city on every request and
   * the counter would fail open — the two ways this feature costs real money.
   */
  describe("on a filesystem it cannot write to", () => {
    /** A writable-looking directory that rejects every write. */
    async function readOnlyDir(): Promise<string> {
      return join(await workspace(), "read-only");
    }

    it("serves the prices it collected, and remembers them for the next request", async () => {
      const dir = await readOnlyDir();
      const calls = { count: 0 };
      const opts = {
        ...options(dir, calls),
        // No directory is ever created, so mkdir/writeFile fail exactly as they do on a
        // read-only filesystem.
        datasetPath: join(dir, "missing", "hotel-prices.json"),
      };

      const first = await collectCityOnDemand(TOKYO, "2026-10-20", emptyDataset(), opts);
      expect(first.outcome.status).toBe("collected");
      expect(first.dataset.cities[0].cityId).toBe("tokyo");
      expect(calls.count).toBe(1);

      // Second request, same process: the overlay answers, so no second request.
      const second = await collectCityOnDemand(
        TOKYO,
        "2026-10-20",
        emptyDataset(),
        opts,
      );
      expect(second.outcome).toEqual({ status: "fresh" });
      expect(calls.count).toBe(1);
      expect(second.dataset.samples.length).toBe(first.dataset.samples.length);
    });

    it("still counts what it spends, so the budget cannot fail open", async () => {
      const dir = await readOnlyDir();
      const calls = { count: 0 };
      const opts = {
        ...options(dir, calls, { dailyQuota: 2 }),
        datasetPath: join(dir, "missing", "hotel-prices.json"),
        quotaPath: join(dir, "missing", "quota.json"),
      };

      // Months apart, for the same reason as the budget test above: neighbouring
      // nights share a collection window.
      await collectCityOnDemand(TOKYO, "2026-10-20", emptyDataset(), opts);
      await collectCityOnDemand(TOKYO, "2026-11-20", emptyDataset(), opts);
      const third = await collectCityOnDemand(TOKYO, "2026-12-20", emptyDataset(), opts);

      expect(calls.count).toBe(2);
      expect(third.outcome.status).toBe("skipped");
    });
  });

  it("never throws when the source itself explodes", async () => {
    const dir = await workspace();
    const calls = { count: 0 };
    const exploding: CollectorAdapter = {
      name: "boom",
      label: "Boom",
      fetchRates: async () => {
        throw new Error("socket hang up");
      },
    };

    const result = await collectCityOnDemand(
      TOKYO,
      "2026-10-20",
      emptyDataset(),
      options(dir, calls, { adapter: exploding }),
    );

    expect(result.outcome.status).toBe("failed");
    if (result.outcome.status === "failed") {
      expect(result.outcome.reason).toContain("socket hang up");
    }
  });

  it("says so when no source is configured, rather than failing", async () => {
    const dir = await workspace();
    const calls = { count: 0 };
    const result = await collectCityOnDemand(
      TOKYO,
      "2026-10-20",
      emptyDataset(),
      options(dir, calls, { adapter: null }),
    );
    expect(result.outcome.status).toBe("skipped");
  });

  it("fails before spending a request when the anchor cannot be resolved", async () => {
    const dir = await workspace();
    const calls = { count: 0 };

    const result = await collectCityOnDemand(
      TOKYO,
      "2026-10-20",
      emptyDataset(),
      options(dir, calls, {
        // A currency the FX module cannot convert.
        resolveBaseline: async (currency: string) => ({
          ok: false as const,
          detail: `no ¥500 anchor for ${currency}`,
        }),
      }),
    );

    expect(result.outcome.status).toBe("failed");
    if (result.outcome.status === "failed") {
      expect(result.outcome.reason).toContain("¥500 anchor");
    }
    /**
     * Without an anchor there is no dataset row to write — the schema requires a
     * positive baseline, and deriving one from the very samples being collected would
     * make every city score ~100 by construction. The request is therefore not spent.
     */
    expect(calls.count).toBe(0);
  });
});

/* ------------------------------------------------------------ dataset io */

describe("mergeDataset", () => {
  it("adds a city without disturbing the ones already there", () => {
    const existing = datasetWith("osaka", 3, "2026-09-30T00:00:00Z");
    const incoming = datasetWith("tokyo", 3, "2026-09-30T01:00:00Z");

    const merged = mergeDataset(existing, {
      cities: incoming.cities,
      samples: incoming.samples,
      generatedAt: "2026-09-30T01:00:00Z",
    });

    expect(merged.cities.map((c) => c.cityId)).toEqual(["osaka", "tokyo"]);
    expect(merged.samples).toHaveLength(6);
  });

  it("refreshes a sample instead of stacking a second copy of it", () => {
    const existing = datasetWith("tokyo", 2, "2026-09-01T00:00:00Z");
    const refreshed: HotelDataset = {
      ...existing,
      samples: existing.samples.map((s) => ({
        ...s,
        priceLocal: 99_999,
        collectedAt: "2026-09-30T00:00:00Z",
      })),
    };

    const merged = mergeDataset(existing, {
      cities: refreshed.cities,
      samples: refreshed.samples,
    });

    // Two properties, still two samples: a city collected twice must not weigh twice in
    // the median.
    expect(merged.samples).toHaveLength(2);
    expect(merged.samples.every((s) => s.priceLocal === 99_999)).toBe(true);
  });

  it("keeps the most restrictive disclosure", () => {
    const existing = { ...emptyDataset(), disclosure: "index" as const };
    const merged = mergeDataset(existing, { cities: [], samples: [], disclosure: "price" });
    expect(merged.disclosure).toBe("index");
  });

  it("writes atomically, leaving no temporary file behind", async () => {
    const dir = await workspace();
    const path = join(dir, "nested", "hotel-prices.json");
    await writeDatasetAtomic(path, datasetWith("tokyo", 2, "2026-09-30T00:00:00Z"));

    const written = JSON.parse(await readFile(path, "utf8"));
    expect(written.cities).toHaveLength(1);

    const { readdir } = await import("node:fs/promises");
    expect(await readdir(join(dir, "nested"))).toEqual(["hotel-prices.json"]);
  });
});
