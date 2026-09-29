/**
 * Tests for the Hotelbeds adapter.
 *
 * Two things are being protected here.
 *
 * **The authentication scheme**, because it is the one part that fails in a way that
 * looks like something else: a wrong signature returns the same 403 the evaluation
 * quota returns, so a sign error would be diagnosed as "out of quota" forever. The
 * expected hashes below were produced independently with `sha256sum`, not by this code.
 *
 * **The response parsing**, because the published spec disagrees with the live payload
 * in three places (currency on the hotel rather than the room, `net` as a stay total,
 * 1-based `offset`). The primary fixtures below are the shape a live response actually
 * has; the spec-shaped variant is kept as a fallback, since a contract that returns it
 * must keep working.
 */

import { describe, expect, it } from "vitest";
import {
  authHeaders,
  buildAvailabilityRequest,
  cheapestNightly,
  createHotelbedsAdapter,
  DEFAULT_MAX_HOTELS,
  parseAvailability,
  SHAPE_OBSERVED,
  sign,
} from "@/lib/data/collect/adapters/hotelbeds";
import { findCity } from "@/lib/data/cities";
import type { City } from "@/lib/scoring/types";
import type {
  CollectorContext,
  FetchFn,
  FetchResponse,
  HotelPropertyRef,
} from "@/lib/data/collect/types";

const TOKYO = findCity("tokyo") as City;

/* ------------------------------------------------------------ fixtures */

/**
 * A hotel in the shape a **live** response actually has (captured 2026-09-29 from the
 * evaluation environment): `currency`, `minRate` and `maxRate` sit on the *hotel*, the
 * room carries only `code`/`name`/`rates`, and `dailyRates[].offset` is 1-based.
 */
const HOTEL = {
  code: 123223,
  name: "Axor Feria",
  categoryCode: "4EST",
  categoryName: "4 STARS",
  destinationCode: "MAD",
  minRate: "294.37",
  maxRate: "294.37",
  currency: "EUR",
  rooms: [
    {
      code: "DBL.ST",
      name: "DOUBLE STANDARD",
      rates: [
        {
          rateKey: "20190615|20190616|W|1|297|DBT.ST|NRF-SUMMERHB|HB||1~2~0||N@...",
          rateClass: "NRF",
          rateType: "BOOKABLE",
          net: "294.37",
          boardCode: "RO",
          boardName: "ROOM ONLY",
          rooms: 1,
          adults: 2,
          children: 0,
          dailyRates: [{ offset: 1, dailyNet: "294.37" }],
        },
      ],
    },
  ],
};

/** A second hotel with two room types, the dearer one listed first. */
const HOTEL_TWO_ROOMS = {
  code: 999,
  name: "Second Hotel",
  categoryName: "3 STARS",
  currency: "EUR",
  rooms: [
    {
      code: "SUI.ST",
      rates: [{ net: "900.00", dailyRates: [{ offset: 1, dailyNet: "900.00" }] }],
    },
    {
      code: "DBL.ST",
      rates: [{ net: "180.00", dailyRates: [{ offset: 1, dailyNet: "180.00" }] }],
    },
  ],
};

const RESPONSE = {
  auditData: { processTime: "158" },
  hotels: { hotels: [HOTEL, HOTEL_TWO_ROOMS] },
};

const PROPERTY: HotelPropertyRef = {
  id: "hotelbeds:123223",
  cityId: "tokyo",
  name: "Tokyo hotel",
  group: "hotelbeds",
};

function response(body: unknown, status = 200): FetchResponse {
  return {
    status,
    url: "https://api.test.hotelbeds.com/hotel-api/1.0/hotels",
    contentType: "application/json",
    headers: {},
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

function context(fetchFn: FetchFn): CollectorContext {
  return {
    fetchFn,
    robots: { check: async () => ({ allowed: true as const }) },
    now: new Date("2026-09-30T00:00:00Z"),
    log: () => {},
  };
}

const CREDENTIALS = {
  apiKey: "testApiKey",
  secret: "testSecret",
  environment: "test" as const,
};

/* ------------------------------------------------------- authentication */

describe("authentication", () => {
  it("signs with SHA-256 over key + secret + unix seconds", () => {
    // Independently produced: printf '%s' "testApiKeytestSecret1700000000" | sha256sum
    expect(sign("testApiKey", "testSecret", 1_700_000_000)).toBe(
      "cb4072873ecc658f984bc5534513882403092fde0d7c21931ea86b9d51ff42ee",
    );
    // And a different timestamp is a different signature, which is the point of it.
    expect(sign("testApiKey", "testSecret", 1_700_000_001)).not.toBe(
      sign("testApiKey", "testSecret", 1_700_000_000),
    );
  });

  it("sends both required headers, with the timestamp in seconds", () => {
    const headers = authHeaders(
      { apiKey: "acme123", secret: "s3cr3t", environment: "test" },
      new Date(1_750_000_000_000),
    );
    expect(headers["Api-key"]).toBe("acme123");
    expect(headers.Accept).toBe("application/json");
    // printf '%s' "acme123s3cr3t1750000000" | sha256sum
    expect(headers["X-Signature"]).toBe(
      "68b9dad4c4ca4690a70a75a9a1a433242eb8761319fb9ae3f493780ed4edcd5d",
    );
  });
});

/* ----------------------------------------------------------- requests */

describe("availability request", () => {
  it("asks for one night, two adults, around the city centre", () => {
    const request = buildAvailabilityRequest(TOKYO, "2026-10-20");
    expect(request.stay).toEqual({ checkIn: "2026-10-20", checkOut: "2026-10-21" });
    expect(request.occupancies).toEqual([{ rooms: 1, adults: 2, children: 0 }]);
    expect(request.geolocation.latitude).toBe(String(TOKYO.lat));
    expect(request.geolocation.longitude).toBe(String(TOKYO.lon));
    expect(request.geolocation.unit).toBe("km");
    expect(request.filter.maxHotels).toBe(DEFAULT_MAX_HOTELS);
  });

  it("asks for the per-night breakdown, without which there is no nightly price", () => {
    expect(buildAvailabilityRequest(TOKYO, "2026-10-20").dailyRate).toBe(true);
  });

  it("rolls the checkout date across a month boundary", () => {
    expect(buildAvailabilityRequest(TOKYO, "2026-10-31").stay.checkOut).toBe("2026-11-01");
  });
});

/* ---------------------------------------------------------- responses */

describe("response parsing", () => {
  it("reads the cheapest room's per-night net price and the hotel's currency", () => {
    const first = parseAvailability(RESPONSE).find((h) => h.code === 123223)!;
    expect(first).toMatchObject({
      name: "Axor Feria",
      categoryName: "4 STARS",
      nightly: 294.37,
      currency: "EUR",
      source: "dailyNet",
      boardCode: "RO",
    });
    // The live rate carried no `taxes` object at all, and an absent tax flag must
    // stay absent rather than defaulting to a claim either way.
    expect(first.taxesIncluded).toBeUndefined();
  });

  it("picks the cheapest room type, not the first one listed", () => {
    expect(parseAvailability(RESPONSE).find((h) => h.code === 999)!.nightly).toBe(180);
  });

  it("still reads a currency given on the room, as the spec example shows it", () => {
    // Belt and braces for an inconsistent spec: if a contract returns it room-side,
    // that reading must keep working.
    const roomLevelCurrency = {
      hotels: {
        hotels: [
          {
            code: 1,
            name: "Room-level currency",
            rooms: [
              {
                code: "DBL.ST",
                currency: "USD",
                rates: [{ net: "200.00", dailyRates: [{ offset: 1, dailyNet: "200.00" }] }],
              },
            ],
          },
        ],
      },
    };
    const hotel = parseAvailability(roomLevelCurrency)[0];
    expect(hotel.currency).toBe("USD");
    expect(hotel.nightly).toBe(200);
  });

  it("orders the per-night breakdown by its 1-based offset", () => {
    const outOfOrder = {
      hotels: {
        hotels: [
          {
            code: 1,
            name: "Two nights",
            currency: "EUR",
            rooms: [
              {
                code: "DBL.ST",
                rates: [
                  {
                    // A live 2-night stay returned net 311.02 as the sum of two
                    // nights, so the stay total is not a nightly price.
                    net: "311.02",
                    dailyRates: [
                      { offset: 2, dailyNet: "155.51" },
                      { offset: 1, dailyNet: "110.00" },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    expect(parseAvailability(outOfOrder, 2)[0].nightly).toBe(110);
  });

  it("divides a stay total when no per-night breakdown is present", () => {
    const noDaily = {
      hotels: {
        hotels: [
          {
            code: 1,
            name: "No breakdown",
            currency: "EUR",
            rooms: [{ currency: "EUR", rates: [{ net: "600.00" }] }],
          },
        ],
      },
    };
    const hotel = parseAvailability(noDaily, 3)[0];
    expect(hotel.nightly).toBe(200);
    expect(hotel.source).toBe("net");
  });

  it("skips hotels with no readable amount instead of inventing one", () => {
    const junk = {
      hotels: {
        hotels: [
          { code: 1, name: "No rooms" },
          { code: 2, name: "Empty rates", rooms: [{ currency: "EUR", rates: [] }] },
          {
            code: 3,
            name: "Call us",
            rooms: [{ currency: "EUR", rates: [{ net: "on request" }] }],
          },
        ],
      },
    };
    expect(parseAvailability(junk)).toEqual([]);
    expect(cheapestNightly({ rooms: [{ currency: "EUR", rates: [{ net: "0" }] }] })).toBeNull();
  });

  it("returns nothing for a response that is not an availability payload", () => {
    expect(parseAvailability({ error: { code: "INVALID_DATA" } })).toEqual([]);
    expect(parseAvailability(null)).toEqual([]);
  });
});

/* ------------------------------------------------------------ adapter */

describe("createHotelbedsAdapter", () => {
  const adapter = createHotelbedsAdapter(CREDENTIALS, {
    // Deterministic conversion: the test must not depend on the FX market.
    convert: async (amount: number, from: string, to: string) =>
      from === "EUR" && to === "JPY" ? amount * 160 : null,
  });

  it("describes itself, and publishes an index unless told otherwise", () => {
    expect(adapter.name).toBe("hotelbeds");
    expect(adapter.label).toContain("Hotelbeds");
    // A wholesale net rate is not a retail price, so the amount is withheld by default.
    expect(adapter.defaultDisclosure).toBe("index");
    // A live rate carried no tax breakdown, so taxes are not claimed as included.
    expect(adapter.taxIncluded).toBe(false);
    expect(adapter.listProperties).toBeUndefined();
  });

  it("turns one city request into a per-hotel nightly price in the city's currency", async () => {
    const outcome = await adapter.fetchRates!(
      [{ cityId: "tokyo", property: PROPERTY, date: "2026-10-20" }],
      context(async () => response(RESPONSE)),
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data).toHaveLength(2);

    const first = outcome.data.find((r) => r.propertyId === "hotelbeds:123223")!;
    expect(first.cityId).toBe("tokyo");
    expect(first.currency).toBe("JPY");
    expect(first.priceLocal).toBeCloseTo(294.37 * 160, 2);
    expect(first.note).toContain("converted from EUR");
    // The shape has been checked against a live response, so this counts as verified.
    expect(SHAPE_OBSERVED).toBe(true);
    expect(first.extraction).toBe("verified");
  });

  it("works in a city with no property list, because it is asked per city", async () => {
    // The bug this covers: the runner used to build its queries from a property list,
    // so a city-wide source was never called in a city that had not been enumerated —
    // and every sample silently disappeared.
    const outcome = await adapter.fetchRates!(
      [{ cityId: "tokyo", date: "2026-10-20" }],
      context(async () => response(RESPONSE)),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.data).toHaveLength(2);
  });

  it("spends one request per city and date, not one per property", async () => {
    let calls = 0;
    const outcome = await adapter.fetchRates!(
      [
        { cityId: "tokyo", property: PROPERTY, date: "2026-10-20" },
        { cityId: "tokyo", property: { ...PROPERTY, id: "hotelbeds:999" }, date: "2026-10-20" },
        { cityId: "tokyo", property: PROPERTY, date: "2026-10-21" },
      ],
      context(async () => {
        calls += 1;
        return response(RESPONSE);
      }),
    );
    // Three properties × two dates collapse to two city-date requests: on a 50/day
    // evaluation quota that difference is the whole feature.
    expect(calls).toBe(2);
    expect(outcome.ok).toBe(true);
  });

  it("says the quota is the problem when the evaluation limit is hit", async () => {
    const outcome = await adapter.fetchRates!(
      [{ cityId: "tokyo", property: PROPERTY, date: "2026-10-20" }],
      context(async () => response({ error: "quota" }, 403)),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.failure.kind === "skipped") {
      expect(outcome.failure.reason).toContain("50 requests/day");
    } else {
      throw new Error(`expected a quota skip, got ${JSON.stringify(outcome)}`);
    }
  });

  it("stops when robots.txt forbids the endpoint", async () => {
    const refused = await adapter.fetchRates!(
      [{ cityId: "tokyo", property: PROPERTY, date: "2026-10-20" }],
      {
        ...context(async () => response(RESPONSE)),
        robots: { check: async () => ({ allowed: false as const, rule: "Disallow: /" }) },
      },
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.failure.kind).toBe("robots-disallowed");
  });

  it("reports an unconvertible currency rather than storing a foreign amount", async () => {
    const noConversion = createHotelbedsAdapter(CREDENTIALS, {
      convert: async () => null,
    });
    const outcome = await noConversion.fetchRates!(
      [{ cityId: "tokyo", property: PROPERTY, date: "2026-10-20" }],
      context(async () => response(RESPONSE)),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.failure.kind === "parse-error") {
      expect(outcome.failure.detail).toContain("no EUR→JPY conversion");
    } else {
      throw new Error(`expected a parse-error, got ${JSON.stringify(outcome)}`);
    }
  });

  it("distinguishes an empty destination from an unreadable payload", async () => {
    // No inventory is not a parsing bug, and an operator needs to tell them apart.
    const empty = await adapter.fetchRates!(
      [{ cityId: "tokyo", property: PROPERTY, date: "2026-10-20" }],
      context(async () => response({ hotels: { hotels: [] } })),
    );
    expect(empty.ok).toBe(false);
    if (!empty.ok && empty.failure.kind === "parse-error") {
      expect(empty.failure.detail).toContain("no hotels returned availability");
    }

    const unreadable = await adapter.fetchRates!(
      [{ cityId: "tokyo", property: PROPERTY, date: "2026-10-20" }],
      context(async () =>
        response({ hotels: { hotels: [{ code: 1, name: "No rates" }] } }),
      ),
    );
    expect(unreadable.ok).toBe(false);
    if (!unreadable.ok && unreadable.failure.kind === "parse-error") {
      expect(unreadable.failure.detail).toContain("none carried a readable amount");
    }
  });

  it("fails loudly on a body that is not JSON", async () => {
    const outcome = await adapter.fetchRates!(
      [{ cityId: "tokyo", property: PROPERTY, date: "2026-10-20" }],
      context(async () => response("<html>gateway timeout</html>")),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.kind).toBe("parse-error");
  });
});
