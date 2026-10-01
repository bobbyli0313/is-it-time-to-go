/**
 * Tests for the collection side.
 *
 * The collector is the part of this app that talks to other people's servers, so
 * the behaviours worth pinning down are the ones about *conduct* as much as
 * correctness:
 *
 *   - robots.txt is obeyed, and a refusal is reported as the rule that caused it;
 *   - a bot wall is named rather than parsed as if it were data;
 *   - a group whose policy forbids its rate path is never asked for rates;
 *   - a failure never becomes a number, and never silently disappears — every
 *     discarded sample is reported with its reason.
 *
 * Transport, adapter and assembly are exercised together in the last block, from a
 * stub fetcher to a reference price the read side can serve — the same path a real
 * run takes, minus the network.
 */

import { describe, expect, it, vi } from "vitest";
import {
  isAllowed,
  parseRobots,
  selectGroup,
  RobotsCache,
} from "@/lib/data/collect/robots";
import { createPoliteFetch, detectBotWall, BudgetExhaustedError } from "@/lib/data/collect/http";
import { censusFromCsv, parseCsv, ratesFromCsv, ratesFromJson } from "@/lib/data/collect/import";
import {
  createHttpJsonAdapter,
  interpolate,
  parseSourceConfig,
  readAmount,
  readPath,
} from "@/lib/data/collect/adapters/http-json";
import { runCollection, describeFailure } from "@/lib/data/collect/run";
import { computeCityReferencePrice } from "@/lib/data/hotel-price";
import { findCity } from "@/lib/data/cities";
import type {
  CollectorContext,
  FetchFn,
  FetchRequest,
  FetchResponse,
  HotelPropertyRef,
  RawRate,
} from "@/lib/data/collect/types";
import type { CollectorAdapter } from "@/lib/data/collect/types";

const TOKYO = findCity("tokyo")!;
const OSAKA = findCity("osaka")!;

/**
 * A fixed ¥500 anchor. Injected into every run below: the real resolver calls the
 * ECB, and a unit test that reaches the network is a test that fails on a plane.
 */
const FIXED_BASELINE = async (currency: string) =>
  currency === "XXX"
    ? { ok: false as const, detail: `No CNY→${currency} rate available` }
    : {
        ok: true as const,
        data: {
          currency,
          baselineLocal: currency === "JPY" ? 11_000 : 500,
          source: "static-reference" as const,
          asOf: "2026-09-30T00:00:00Z",
        },
      };

/* --------------------------------------------------------------- fixtures */

function response(overrides: Partial<FetchResponse> = {}): FetchResponse {
  return {
    status: 200,
    url: "https://example.test/",
    contentType: "application/json",
    headers: {},
    body: "{}",
    ...overrides,
  };
}

function stubFetch(routes: Record<string, FetchResponse | (() => FetchResponse)>): FetchFn {
  return async (request: FetchRequest) => {
    const match = Object.keys(routes)
      .filter((key) => request.url.includes(key))
      .sort((a, b) => b.length - a.length)[0];
    if (!match) {
      return response({ status: 404, body: "not found", url: request.url });
    }
    const entry = routes[match];
    const value = typeof entry === "function" ? entry() : entry;
    return { ...value, url: request.url };
  };
}

/** A context whose robots.txt allows everything, for adapter-level tests. */
function context(fetchFn: FetchFn, overrides: Partial<CollectorContext> = {}): CollectorContext {
  return {
    fetchFn,
    robots: { check: async () => ({ allowed: true as const }) },
    now: new Date("2026-09-30T00:00:00Z"),
    log: () => {},
    ...overrides,
  };
}

/* ---------------------------------------------------------------- robots */

describe("robots.txt", () => {
  const FILE = `
# a comment
User-agent: *
Disallow: /search/
Allow: /search/hotels
Disallow: /booking
Crawl-delay: 5

User-agent: IITTG-hotel-collector
Disallow: /everything
`;

  it("selects the most specific matching group", () => {
    const groups = parseRobots(FILE);
    expect(selectGroup(groups, "IITTG-hotel-collector/0.1 (+x)")).toBe(groups[1]);
    expect(selectGroup(groups, "SomeOtherBot/1.0")).toBe(groups[0]);
  });

  it("applies longest-match-wins, with Allow breaking ties", () => {
    const group = selectGroup(parseRobots(FILE), "SomeOtherBot/1.0");
    expect(isAllowed(group, "/search/results")).toEqual({
      allowed: false,
      rule: "Disallow: /search/",
    });
    // The longer, more specific Allow wins even though it appears later.
    expect(isAllowed(group, "/search/hotels")).toEqual({ allowed: true });
    expect(isAllowed(group, "/hotels")).toEqual({ allowed: true });
  });

  it("treats a file with no rules as no restriction", () => {
    expect(isAllowed(null, "/anything")).toEqual({ allowed: true });
    expect(isAllowed(parseRobots("User-agent: *\nDisallow:\n")[0], "/x")).toEqual({
      allowed: true,
    });
  });

  it("honours the group that matches our own user agent, including its delay", async () => {
    const robots = stubFetch({
      "/robots.txt": response({ contentType: "text/plain", body: FILE }),
    });

    // A group aimed specifically at this collector replaces the wildcard group
    // entirely — the two are not merged, which is the rule most hand-rolled
    // robots checkers get wrong.
    const ours = new RobotsCache(robots, "IITTG-hotel-collector/0.1 (+https://example.test)");
    expect(await ours.gate().check("https://site.test/everything/else")).toEqual({
      allowed: false,
      rule: "Disallow: /everything",
    });
    // The wildcard group's /search/ rule does not apply to us: our own group says
    // nothing about /search/.
    expect(await ours.gate().check("https://site.test/search/results")).toEqual({
      allowed: true,
    });

    const other = new RobotsCache(robots, "SomeOtherBot/1.0");
    expect(await other.gate().crawlDelayMs("https://site.test/")).toBe(5_000);
    expect(await other.gate().check("https://site.test/search/results")).toEqual({
      allowed: false,
      rule: "Disallow: /search/",
    });
  });

  it("fails open when robots.txt cannot be read, as the spec requires", async () => {
    const cache = new RobotsCache(
      async () => {
        throw new Error("network down");
      },
      "IITTG-hotel-collector/0.1",
    );
    expect(await cache.gate().check("https://site.test/x")).toEqual({ allowed: true });
  });
});

/* ------------------------------------------------------------ transport */

describe("polite fetch", () => {
  it("names the product behind a browser challenge", () => {
    // A challenge served with status 200: a status check alone would call this a
    // successful page load and "parse" it into zero rates.
    expect(
      detectBotWall({
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<html><body><script>window.KPSDK={};</script></body></html>",
      }),
    ).toBe("Kasada");

    expect(
      detectBotWall({
        status: 403,
        headers: {},
        body: "<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY>Reference #18.5cd3d17</BODY>",
      }),
    ).toBe("Akamai");

    expect(detectBotWall({ status: 200, headers: {}, body: '{"rates":[]}' })).toBeNull();
  });

  it("never exceeds its request budget", async () => {
    const underlying = vi.fn(async () => new Response("{}", { status: 200 }));
    const polite = createPoliteFetch({
      underlying: underlying as unknown as typeof globalThis.fetch,
      minIntervalMs: 0,
      maxRequests: 2,
    });

    await polite.fetchFn({ url: "https://a.test/1" });
    await polite.fetchFn({ url: "https://b.test/1" });
    await expect(polite.fetchFn({ url: "https://c.test/1" })).rejects.toBeInstanceOf(
      BudgetExhaustedError,
    );
    expect(underlying).toHaveBeenCalledTimes(2);
  });

  it("identifies itself and spaces requests to the same host", async () => {
    const seen: Array<{ url: string; ua: string | undefined; at: number }> = [];
    const underlying = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        url: String(url),
        ua: (init?.headers as Record<string, string>)?.["User-Agent"],
        at: Date.now(),
      });
      return new Response("{}", { status: 200 });
    });

    const polite = createPoliteFetch({
      underlying: underlying as unknown as typeof globalThis.fetch,
      minIntervalMs: 40,
    });
    await Promise.all([
      polite.fetchFn({ url: "https://same.test/a" }),
      polite.fetchFn({ url: "https://same.test/b" }),
    ]);

    expect(seen[0].ua).toContain("IITTG-hotel-collector");
    // Serialised per host: a burst at one origin is what bot management exists to
    // stop, and what gets an operator blocked.
    expect(seen[1].at - seen[0].at).toBeGreaterThanOrEqual(30);
  });
});

/* -------------------------------------------------------------- imports */

describe("CSV import", () => {
  it("parses quoted fields, embedded commas and blank lines", () => {
    const table = parseCsv(
      'a,b\n"x,1","line\nbreak"\n\n"quote""d",2\n',
    );
    expect(table.header).toEqual(["a", "b"]);
    expect(table.rows).toEqual([
      { a: "x,1", b: "line\nbreak" },
      { a: 'quote"d', b: "2" },
    ]);
  });

  const RATES = `cityId,propertyId,propertyName,group,date,priceLocal,currency,source,collectedAt,extraction
tokyo,stub:00019,Minowa,stub,2026-10-20,9800,JPY,partner-x,2026-09-30T02:00:00Z,verified
tokyo,stub:00019,Minowa,stub,2026-10-21,10300,JPY,partner-x,2026-09-30T02:00:00Z,verified
`;

  it("builds samples and a census row per new property", () => {
    const result = ratesFromCsv(RATES);
    expect(result.errors).toEqual([]);
    expect(result.samples).toHaveLength(2);
    expect(result.samples[0].extraction).toBe("verified");
    expect(result.propertiesByCity.get("tokyo")).toEqual([
      { id: "stub:00019", name: "Minowa", group: "stub" },
    ]);
  });

  it("defaults to inferred, so an unvalidated price costs confidence", () => {
    const withoutColumn = `cityId,propertyId,date,priceLocal
tokyo,stub:00019,2026-10-20,9800
`;
    expect(ratesFromCsv(withoutColumn).samples[0].extraction).toBe("inferred");
  });

  it("rejects a price in the wrong currency for the city", () => {
    // A JPY price in a KRW city is a unit error, and a median is exactly the
    // statistic that would hide it.
    const result = ratesFromCsv(
      `cityId,propertyId,date,priceLocal,currency
seoul,lotte:1,2026-10-20,120000,JPY
`,
      "rates",
      { currencyByCity: new Map([["seoul", "KRW"]]) },
    );
    expect(result.samples).toHaveLength(0);
    expect(result.errors.join(" ")).toContain("does not match");
  });

  it("reports bad rows instead of dropping them silently", () => {
    const result = ratesFromCsv(`cityId,propertyId,date,priceLocal
tokyo,a,2026-10-20,not-a-number
tokyo,b,20/10/2026,9000
tokyo,c,2026-10-20,-5
`);
    expect(result.samples).toHaveLength(0);
    expect(result.errors).toHaveLength(3);
  });

  it("requires the census columns it depends on", () => {
    expect(censusFromCsv("cityId,name\ntokyo,x\n").errors.join(" ")).toContain(
      'missing column "propertyId"',
    );
  });

  it("reads a JSON export as well as CSV", () => {
    const result = ratesFromJson(
      JSON.stringify([{ cityId: "tokyo", propertyId: "a:1", date: "2026-10-20", price: 9800 }]),
    );
    expect(result.errors).toEqual([]);
    expect(result.samples[0].priceLocal).toBe(9800);
    expect(result.samples[0].extraction).toBe("inferred");
  });
});

/* ------------------------------------------------------------- adapters */

describe("configured JSON source adapter", () => {
  const CONFIG = {
    id: "acme",
    label: "ACME feed",
    extraction: "verified",
    request: {
      urlTemplate: "https://api.acme.test/rates?hotel={propertyCode}&date={date}&key=${ACME_KEY}",
      headers: { Authorization: "Bearer ${ACME_KEY}" },
    },
    response: {
      ratesPath: "data.rates",
      pricePath: "amount",
      currencyPath: "currency",
      propertyPath: "hotelCode",
      datePath: "date",
    },
  };

  const PROPERTY: HotelPropertyRef = {
    id: "acme:007",
    cityId: "tokyo",
    name: "ACME Tokyo",
    group: "stub",
  };

  it("validates the configuration and reports every problem", () => {
    const parsed = parseSourceConfig({ id: "", request: {}, response: {} });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors.join(" ")).toContain("id");
      expect(parsed.errors.join(" ")).toContain("urlTemplate");
      expect(parsed.errors.join(" ")).toContain("pricePath");
    }
    expect(parseSourceConfig(CONFIG).ok).toBe(true);
  });

  it("reads dot paths, including array indices", () => {
    expect(readPath({ a: { b: [{ c: 7 }] } }, "a.b.0.c")).toBe(7);
    expect(readPath({ a: 1 }, "a.b")).toBeUndefined();
    expect(readPath({ a: "128.50" }, "a")).toBe("128.50");
  });

  it("accepts a price as a number or a numeric string, and rejects nonsense", () => {
    expect(readAmount({ amount: 12_800 }, "amount")).toBe(12_800);
    expect(readAmount({ amount: "¥12,800" }, "amount")).toBe(12_800);
    expect(readAmount({ amount: 0 }, "amount")).toBeNull();
    expect(readAmount({ amount: "call us" }, "amount")).toBeNull();
  });

  it("substitutes placeholders and environment variables", () => {
    process.env.ACME_KEY = "s3cret";
    expect(
      interpolate("https://x/{propertyCode}?d={date}&k=${ACME_KEY}", {
        propertyCode: "007",
        date: "2026-10-20",
      }),
    ).toBe("https://x/007?d=2026-10-20&k=s3cret");
    delete process.env.ACME_KEY;
  });

  it("turns a configured response into rates", async () => {
    const parsed = parseSourceConfig(CONFIG);
    if (!parsed.ok) throw new Error("config should parse");
    const adapter = createHttpJsonAdapter(parsed.config);

    const outcome = await adapter.fetchRates!(
      [{ cityId: "tokyo", property: PROPERTY, date: "2026-10-20" }],
      context(
        stubFetch({
          "/rates": response({
            body: JSON.stringify({
              data: { rates: [{ hotelCode: "007", date: "2026-10-20", amount: 12_800, currency: "JPY" }] },
            }),
          }),
        }),
      ),
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data[0]).toMatchObject({
        // A bare code from the source is namespaced with its group, so ids stay
        // globally unique across sources.
        propertyId: "stub:007",
        priceLocal: 12_800,
        currency: "JPY",
        extraction: "verified",
      });
    }
  });

  it("refuses to run a session-gated source without a session", async () => {
    const parsed = parseSourceConfig({ ...CONFIG, request: { ...CONFIG.request, session: true } });
    if (!parsed.ok) throw new Error("config should parse");
    const adapter = createHttpJsonAdapter(parsed.config);

    const outcome = await adapter.fetchRates!(
      [{ cityId: "tokyo", property: PROPERTY, date: "2026-10-20" }],
      context(stubFetch({})),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.kind).toBe("skipped");
  });

  it("reports a bot wall rather than inventing a price", async () => {
    const parsed = parseSourceConfig(CONFIG);
    if (!parsed.ok) throw new Error("config should parse");
    const adapter = createHttpJsonAdapter(parsed.config);

    const outcome = await adapter.fetchRates!(
      [{ cityId: "tokyo", property: PROPERTY, date: "2026-10-20" }],
      context(
        stubFetch({
          "/rates": response({
            status: 403,
            body: "<HTML><TITLE>Access Denied</TITLE>Reference #18.5cd3d17",
          }),
        }),
      ),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.kind).toBe("blocked");
      if (outcome.failure.kind === "blocked") expect(outcome.failure.by).toBe("Akamai");
    }
  });
});

/* ------------------------------------------------------------------ run */

describe("runCollection", () => {
  /**
   * A stand-in adapter: a property list plus flat rates, with no network involved.
   *
   * `serveCities` matters for the tests about cities that produced nothing: a source
   * that answered for every city would make "no data here" untestable.
   */
  function stubAdapter(options: {
    properties: number;
    price?: number;
    rateFailure?: boolean;
    serveCities?: string[];
  }): CollectorAdapter {
    const serveCities = options.serveCities ?? ["tokyo"];
    const propertiesFor = (cityId: string): HotelPropertyRef[] =>
      Array.from({ length: options.properties }, (_, i) => ({
        id: `${cityId}-stub:${String(i).padStart(5, "0")}`,
        cityId,
        name: `${cityId} property ${i}`,
        group: "stub",
      }));

    return {
      name: "stub",
      label: "Stub source",
      async listProperties(city) {
        if (!serveCities.includes(city.id)) return { ok: true, data: [] };
        return { ok: true, data: propertiesFor(city.id) };
      },
      async fetchRates(queries): Promise<{ ok: true; data: RawRate[] } | { ok: false; failure: { kind: "blocked"; by: string; evidence: string } }> {
        if (options.rateFailure) {
          return { ok: false, failure: { kind: "blocked", by: "Akamai", evidence: "HTTP 403" } };
        }
        // A stub that answered for cities it does not serve would make "this city has
        // no data" untestable.
        const served = queries.filter((query) => serveCities.includes(query.cityId));
        return {
          ok: true,
          data: served.map(({ property, date, cityId }) => ({
            propertyId: property?.id ?? `${cityId}:any`,
            cityId: property?.cityId ?? cityId,
            date,
            priceLocal: options.price ?? 10_000,
            currency: "JPY",
            source: "stub",
            collectedAt: "2026-09-30T00:00:00Z",
            extraction: "verified" as const,
          })),
        };
      },
    };
  }

  it("collects a census and prices into a dataset the read side can serve", async () => {
    const report = await runCollection({
      cities: [TOKYO],
      dates: ["2026-10-20"],
      adapters: [stubAdapter({ properties: 12, price: 11_000 })],
      context: context(stubFetch({})),
      resolveBaseline: FIXED_BASELINE,
    });

    expect(report.cities[0]).toMatchObject({
      cityId: "tokyo",
      properties: 12,
      samples: 12,
      medianLocal: 11_000,
      censusComplete: true,
      sources: ["stub"],
    });

    const census = report.dataset.cities[0];
    const { quote } = computeCityReferencePrice(
      census,
      report.dataset.samples,
      "2026-10-20",
      new Date("2026-09-30T00:00:00Z"),
    );
    expect(quote.perNightLocal).toBe(11_000);
    expect(quote.sampleSize).toBe(12);
    expect(quote.basis).toBe("collected-median");
  });

  it("reports a refused rate fetch instead of shipping an empty city quietly", async () => {
    const report = await runCollection({
      cities: [TOKYO],
      dates: ["2026-10-20"],
      adapters: [stubAdapter({ properties: 12, rateFailure: true })],
      context: context(stubFetch({})),
      resolveBaseline: FIXED_BASELINE,
    });

    expect(report.cities[0].samples).toBe(0);
    expect(report.cities[0].medianLocal).toBeNull();
    expect(report.cities[0].failures.join(" ")).toContain("blocked by Akamai");
    // The census still lands: knowing the city's hotels is useful even with no prices.
    expect(report.dataset.cities[0].properties).toHaveLength(12);
  });

  it("prefers imported prices, and reports samples it cannot attribute", async () => {
    const report = await runCollection({
      cities: [TOKYO],
      dates: ["2026-10-20"],
      adapters: [],
      context: context(stubFetch({})),
      resolveBaseline: FIXED_BASELINE,
      imported: {
        samples: [
          { date: "2026-10-20", propertyId: "acme:1", priceLocal: 9_000, source: "feed.csv", collectedAt: "2026-09-30T00:00:00Z", extraction: "verified" },
          { date: "2026-10-20", propertyId: "acme:2", priceLocal: 19_000, source: "feed.csv", collectedAt: "2026-09-30T00:00:00Z", extraction: "verified" },
          { date: "2026-10-20", propertyId: "ghost:9", priceLocal: 1_000, source: "feed.csv", collectedAt: "2026-09-30T00:00:00Z", extraction: "verified" },
        ],
        propertiesByCity: new Map([
          [
            "tokyo",
            [
              { id: "acme:1", name: "ACME 1", group: "acme" },
              { id: "acme:2", name: "ACME 2", group: "acme" },
            ],
          ],
        ]),
        completeCities: new Set(["tokyo"]),
        sources: ["feed.csv"],
      },
    });

    expect(report.cities[0].samples).toBe(2);
    expect(report.cities[0].medianLocal).toBe(14_000);
    expect(report.cities[0].censusComplete).toBe(true);
    expect(report.dropped.join(" ")).toContain("ghost:9");
  });

  it("excludes a city it cannot anchor, rather than guessing the rate", async () => {
    const unknown = { ...TOKYO, id: "tokyo", currency: "XXX" };
    const report = await runCollection({
      cities: [unknown],
      dates: ["2026-10-20"],
      adapters: [],
      context: context(stubFetch({})),
      resolveBaseline: FIXED_BASELINE,
      imported: {
        samples: [],
        propertiesByCity: new Map([["tokyo", [{ id: "x:1", name: "X", group: "x" }]]]),
        completeCities: new Set(["tokyo"]),
        sources: [],
      },
    });

    expect(report.dataset.cities).toHaveLength(0);
    expect(report.cities[0].failures.join(" ")).toContain("no CNY conversion");
    expect(report.dropped.join(" ")).toContain("baseline for XXX");
  });

  it("publishes an index when any contributing source may not be republished", async () => {
    const indexOnly: CollectorAdapter = {
      ...stubAdapter({ properties: 10 }),
      defaultDisclosure: "index",
    };

    const restricted = await runCollection({
      cities: [TOKYO],
      dates: ["2026-10-20"],
      adapters: [indexOnly],
      context: context(stubFetch({})),
      resolveBaseline: FIXED_BASELINE,
    });
    expect(restricted.disclosure).toBe("index");
    expect(restricted.dataset.disclosure).toBe("index");

    // A source the operator is entitled to republish keeps the amount.
    const open = await runCollection({
      cities: [TOKYO],
      dates: ["2026-10-20"],
      adapters: [stubAdapter({ properties: 10 })],
      context: context(stubFetch({})),
      resolveBaseline: FIXED_BASELINE,
    });
    expect(open.disclosure).toBe("price");

    // And the operator's explicit choice wins over both defaults, because they are
    // the one who knows what their agreement allows.
    const overridden = await runCollection({
      cities: [TOKYO],
      dates: ["2026-10-20"],
      adapters: [indexOnly],
      context: context(stubFetch({})),
      resolveBaseline: FIXED_BASELINE,
      disclosure: "price",
    });
    expect(overridden.disclosure).toBe("price");
  });

  it("declares taxes excluded when a source cannot say they are included", async () => {
    const taxUnknown: CollectorAdapter = {
      ...stubAdapter({ properties: 10 }),
      taxIncluded: false,
    };
    const report = await runCollection({
      cities: [TOKYO],
      dates: ["2026-10-20"],
      adapters: [taxUnknown],
      context: context(stubFetch({})),
      resolveBaseline: FIXED_BASELINE,
    });
    // One basis covers the whole dataset, so the conservative reading wins.
    expect(report.dataset.basis.taxIncluded).toBe(false);

    const known = await runCollection({
      cities: [TOKYO],
      dates: ["2026-10-20"],
      adapters: [stubAdapter({ properties: 10 })],
      context: context(stubFetch({})),
      resolveBaseline: FIXED_BASELINE,
    });
    expect(known.dataset.basis.taxIncluded).toBe(true);
  });

  it("keeps every city in the report, including the ones that produced nothing", async () => {
    const report = await runCollection({
      cities: [TOKYO, OSAKA],
      dates: ["2026-10-20"],
      adapters: [stubAdapter({ properties: 10 })],
      context: context(stubFetch({})),
      resolveBaseline: FIXED_BASELINE,
    });
    // The stub only knows Tokyo properties; Osaka must still be reported, with its
    // reason, rather than vanishing from the summary.
    expect(report.cities.map((c) => c.cityId)).toEqual(["tokyo", "osaka"]);
    expect(report.cities[1].properties).toBe(0);
    expect(report.cities[1].failures.join(" ")).toContain("no properties or prices");
  });
});

/**
 * Retry policy for the collector's transport.
 *
 * Motivated by an observed failure rather than by theory: a POST to a live availability
 * API returned `TypeError: fetch failed` (`ECONNRESET`) while the same host answered a GET
 * moments earlier and curl answered the identical POST with 200 — a pooled connection
 * that had gone away. Collection runs on the request path, so letting that through costs
 * a visitor the whole dimension.
 */
describe("polite fetch retries", () => {
  /** The shape `createPoliteFetch` expects from its underlying fetch. */
  function reply(status: number, body = "{}"): Response {
    return {
      status,
      url: "https://example.test/api",
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => body,
    } as unknown as Response;
  }

  function socketError(): TypeError {
    const error = new TypeError("fetch failed");
    (error as { cause?: unknown }).cause = { code: "ECONNRESET" };
    return error;
  }

  function transport(underlying: () => Promise<Response>) {
    return createPoliteFetch({
      underlying: underlying as never,
      minIntervalMs: 0,
      timeoutMs: 1_000,
    });
  }

  it("retries a dropped connection once, and returns the second answer", async () => {
    let calls = 0;
    const polite = transport(async () => {
      calls += 1;
      if (calls === 1) throw socketError();
      return reply(200);
    });

    const response = await polite.fetchFn({ url: "https://example.test/api" });
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
  });

  it("does not retry a status that says the request itself was wrong", async () => {
    let calls = 0;
    const polite = transport(async () => {
      calls += 1;
      return reply(403, "forbidden");
    });

    // A 403 is a refusal — a wrong key, an exhausted quota — and repeating it spends
    // another request out of the same budget while hiding the reason.
    const response = await polite.fetchFn({ url: "https://example.test/api" });
    expect(response.status).toBe(403);
    expect(calls).toBe(1);
  });

  it("gives up after the second attempt rather than looping", async () => {
    let calls = 0;
    const polite = transport(async () => {
      calls += 1;
      throw socketError();
    });

    await expect(polite.fetchFn({ url: "https://example.test/api" })).rejects.toThrow(
      /fetch failed/,
    );
    expect(calls).toBe(2);
  });
});
