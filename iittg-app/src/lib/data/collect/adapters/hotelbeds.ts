/**
 * Hotelbeds APItude — the city-wide price source.
 *
 * ## Why this one
 *
 * A single hotel chain's own site cannot answer the question this app asks — a chain's
 * portfolio is not a city, and a business-hotel chain sits below the city's average.
 * Hotelbeds is an inventory aggregator: one request returns the hotels *with
 * availability around a point*, across every chain, which is the breadth a city median
 * needs.
 *
 * ## What is verified, and what is not
 *
 * Verified against Hotelbeds' own published material:
 *
 *  - authentication: `X-Signature` = SHA-256 hex of `apiKey + secret + unixSeconds`,
 *    sent with `Api-key` (developer.hotelbeds.com → Getting Started);
 *  - the request shape: `stay`, `occupancies`, `destination`/`geolocation`, `filter`
 *    and the `dailyRate` flag, from the OpenAPI spec the API Reference renders
 *    (`OpenAPI-Hotel-BookingAPI-3.0.yaml`);
 *  - the response shape: `hotels.hotels[]` → `rooms[]` → `rates[]` with `net`,
 *    `sellingRate`, `dailyRates[] = {offset, dailyNet, dailySellingRate}`, and the
 *    room-level `currency`;
 *  - the evaluation quota: 50 requests/day, HTTP 403 when exceeded.
 *
 * **Verified against a live response** on 2026-09-29 (evaluation key, Tokyo, 1 and 2
 * nights). Three things the published spec gets wrong or omits, all of which the
 * first version of this parser got wrong too:
 *
 *  1. **`currency` is on the *hotel*, not the room.** The spec's example shows it
 *     beside `minRate`/`maxRate` inside `rooms[]`; the live payload puts all three on
 *     the hotel object and leaves the room with only `code`, `name` and `rates`.
 *     Reading it from the room found nothing and would have failed every hotel.
 *  2. **`net` is the stay total**, equal to the sum of `dailyRates[].dailyNet`
 *     (measured: 2 nights → `net` 311.02 with two `dailyNet` entries of 155.51). So
 *     the `net / nights` fallback is right, and `dailyNet` is the only per-night
 *     figure.
 *  3. **`dailyRates[].offset` is 1-based**, not 0.
 *
 * The room-level `currency` is still accepted as a fallback so a contract that
 * returns it there keeps working.
 *
 * ## Currency
 *
 * APItude quotes in the currency of your contract (typically EUR), not the
 * destination's. The dataset stores every price in the city's own currency, so this
 * adapter converts with the same USD legs the FX dimension uses, and records the
 * conversion in the rate's audit note. No conversion available means no data, never
 * an unconverted number.
 */

import { createHash } from "node:crypto";
import type { City } from "../../../scoring/types";
import { findCity } from "../../cities";
import type {
  CollectOutcome,
  CollectorAdapter,
  CollectorContext,
  RateQuery,
  RawRate,
} from "../types";
import { collected, failed } from "../types";
import { refusalOf } from "../http";
import { usdRateTo } from "../../live/fx";

/**
 * Whether the field paths below have been checked against a live response.
 *
 * True as of 2026-09-29: the evaluation environment was queried for Tokyo and the
 * payload matched this parser (after the three corrections documented above). Set it
 * back to false if a future response stops matching, which downgrades every rate to
 * `inferred` and costs confidence rather than passing a bad number off as verified.
 */
export const SHAPE_OBSERVED = true;

export const HOTELBEDS_BASE = {
  test: "https://api.test.hotelbeds.com",
  production: "https://api.hotelbeds.com",
} as const;

/** Evaluation keys are limited to 50 requests/day (403 beyond that). */
export const EVALUATION_DAILY_QUOTA = 50;

export interface HotelbedsCredentials {
  apiKey: string;
  secret: string;
  environment: keyof typeof HOTELBEDS_BASE;
}

export interface HotelbedsOptions {
  /** Hotels to ask for per city. Enough for a stable median, small enough to read. */
  maxHotels?: number;
  /** Radius around the city centre, in km. */
  radiusKm?: number;
  /** Injectable for tests; defaults to the live FX conversion. */
  convert?: (amount: number, from: string, to: string) => Promise<number | null>;
}

export const DEFAULT_MAX_HOTELS = 200;
export const DEFAULT_RADIUS_KM = 15;

/* ---------------------------------------------------------- authentication */

/**
 * `X-Signature`, exactly as documented: SHA-256 in hex over the API key, the secret
 * and the current timestamp in seconds, concatenated with no separator.
 *
 * `timestampSeconds` is a parameter rather than a call to `Date.now()` so the scheme
 * is testable against Hotelbeds' own published example.
 */
export function sign(apiKey: string, secret: string, timestampSeconds: number): string {
  return createHash("sha256")
    .update(`${apiKey}${secret}${timestampSeconds}`)
    .digest("hex");
}

export function authHeaders(
  credentials: HotelbedsCredentials,
  now: Date,
): Record<string, string> {
  const timestamp = Math.floor(now.getTime() / 1000);
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "Api-key": credentials.apiKey,
    "X-Signature": sign(credentials.apiKey, credentials.secret, timestamp),
  };
}

/* --------------------------------------------------------------- requests */

export interface AvailabilityRequest {
  stay: { checkIn: string; checkOut: string };
  occupancies: Array<{ rooms: number; adults: number; children: number }>;
  /**
   * Search by coordinates rather than by destination code.
   *
   * The City model already carries the centre point, so this needs no per-city code
   * table that could silently point at the wrong city — and "hotels within 15 km of
   * the centre" is a defensible definition of "this city's hotels".
   */
  geolocation: { latitude: string; longitude: string; radius: string; unit: "km" };
  /** Ask for a per-night breakdown instead of only a stay total. */
  dailyRate: true;
  filter: { maxHotels: number; maxRooms: number };
}

/** Builds one availability query for a city and a single night. */
export function buildAvailabilityRequest(
  city: City,
  date: string,
  options: HotelbedsOptions = {},
): AvailabilityRequest {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const checkOut = next.toISOString().slice(0, 10);

  return {
    stay: { checkIn: date, checkOut },
    occupancies: [{ rooms: 1, adults: 2, children: 0 }],
    geolocation: {
      latitude: String(city.lat),
      longitude: String(city.lon),
      radius: String(options.radiusKm ?? DEFAULT_RADIUS_KM),
      unit: "km",
    },
    dailyRate: true,
    filter: {
      maxHotels: options.maxHotels ?? DEFAULT_MAX_HOTELS,
      maxRooms: 1,
    },
  };
}

/* -------------------------------------------------------------- responses */

export interface ParsedHotel {
  code: number;
  name: string;
  categoryName?: string;
  /** Cheapest nightly amount found for this hotel, and its currency. */
  nightly: number;
  currency: string;
  /** Which field the amount came from, for the audit trail. */
  source: "dailyNet" | "net";
  boardCode?: string;
  taxesIncluded?: boolean;
}

/**
 * Reads one hotel's cheapest available night.
 *
 * Cheapest rather than an average of its room types: every sample in the dataset
 * answers the same question ("the cheapest publicly bookable room"), so the median
 * compares like with like. `dailyRates[0].dailyNet` is preferred because it is the
 * per-night figure the `dailyRate` flag asks for; `net` is the stay total, divided by
 * the number of nights only when the per-night breakdown is absent.
 */
export function cheapestNightly(hotel: unknown, nights = 1): Omit<ParsedHotel, "code" | "name" | "categoryName"> | null {
  const rooms = (hotel as { rooms?: unknown }).rooms;
  if (!Array.isArray(rooms)) return null;

  /**
   * The live payload carries the currency on the hotel; the published spec's example
   * shows it on the room. Accept either, preferring the hotel, so the parser survives
   * both readings of an inconsistent spec.
   */
  const hotelCurrency = (hotel as { currency?: unknown }).currency;

  let best: Omit<ParsedHotel, "code" | "name" | "categoryName"> | null = null;

  for (const room of rooms) {
    const record = room as {
      currency?: unknown;
      rates?: unknown;
      minRate?: unknown;
    };
    const currency =
      typeof hotelCurrency === "string"
        ? hotelCurrency
        : typeof record.currency === "string"
          ? record.currency
          : null;
    if (!currency) continue;
    if (!Array.isArray(record.rates)) continue;

    for (const rate of record.rates) {
      const r = rate as {
        net?: unknown;
        dailyRates?: unknown;
        boardCode?: unknown;
        taxes?: { allIncluded?: unknown };
      };

      let amount: number | null = null;
      let source: "dailyNet" | "net" = "net";

      if (Array.isArray(r.dailyRates) && r.dailyRates.length > 0) {
        /**
         * We ask for one night, so there is exactly one entry — but `offset` is
         * 1-based and a longer stay would carry several, so order by it rather than
         * trusting array position.
         */
        const first = [...(r.dailyRates as Array<{ offset?: unknown; dailyNet?: unknown }>)].sort(
          (a, b) => Number(a.offset ?? 0) - Number(b.offset ?? 0),
        )[0];
        const daily = first?.dailyNet;
        const parsed = typeof daily === "string" ? Number.parseFloat(daily) : NaN;
        if (Number.isFinite(parsed) && parsed > 0) {
          amount = parsed;
          source = "dailyNet";
        }
      }

      if (amount === null) {
        const net = typeof r.net === "string" ? Number.parseFloat(r.net) : NaN;
        if (Number.isFinite(net) && net > 0) {
          amount = net / Math.max(1, nights);
          source = "net";
        }
      }

      if (amount === null) continue;
      if (best === null || amount < best.nightly) {
        best = {
          nightly: amount,
          currency,
          source,
          ...(typeof r.boardCode === "string" ? { boardCode: r.boardCode } : {}),
          ...(typeof r.taxes?.allIncluded === "boolean"
            ? { taxesIncluded: r.taxes.allIncluded }
            : {}),
        };
      }
    }
  }

  return best;
}

/** Pulls every hotel that carries a readable nightly amount out of a response. */
export function parseAvailability(payload: unknown, nights = 1): ParsedHotel[] {
  const hotels = (payload as { hotels?: { hotels?: unknown } })?.hotels?.hotels;
  if (!Array.isArray(hotels)) return [];

  const out: ParsedHotel[] = [];
  for (const hotel of hotels) {
    const record = hotel as {
      code?: unknown;
      name?: unknown;
      categoryName?: unknown;
    };
    if (typeof record.code !== "number" && typeof record.code !== "string") continue;
    const best = cheapestNightly(hotel, nights);
    if (!best) continue;

    out.push({
      code: Number(record.code),
      name: typeof record.name === "string" ? record.name : String(record.code),
      ...(typeof record.categoryName === "string"
        ? { categoryName: record.categoryName }
        : {}),
      ...best,
    });
  }
  return out;
}

/* ---------------------------------------------------------------- adapter */

export function createHotelbedsAdapter(
  credentials: HotelbedsCredentials,
  options: HotelbedsOptions = {},
): CollectorAdapter {
  const base = HOTELBEDS_BASE[credentials.environment];
  const convert =
    options.convert ??
    (async (amount: number, from: string, to: string) => {
      const [fromPerUsd, toPerUsd] = await Promise.all([
        usdRateTo(from),
        usdRateTo(to),
      ]);
      if (fromPerUsd === null || toPerUsd === null || fromPerUsd <= 0) return null;
      return (amount / fromPerUsd) * toPerUsd;
    });

  return {
    name: "hotelbeds",
    label: "Hotelbeds APItude",

    /**
     * A live rate carried no tax breakdown at all, and APItude only states one
     * (`taxes.allIncluded`) when taxes apply. So the dataset declares taxes *not*
     * included rather than claiming otherwise — the conservative reading, and the one
     * that does not quietly compare a tax-inclusive median with a tax-exclusive
     * baseline. When the source does state it, the sample note records it.
     */
    taxIncluded: false,

    /**
     * Rates are not republished by default.
     *
     * APItude's `net` is a wholesale cost under an agreement that governs what may be
     * shown and at what price, so the safe default is to publish the *distance from
     * the ¥500 anchor* and keep the amount internal. An operator whose agreement
     * allows displaying prices passes `--disclosure price`.
     */
    defaultDisclosure: "index",

    async fetchRates(
      queries: RateQuery[],
      ctx: CollectorContext,
    ): Promise<CollectOutcome<RawRate[]>> {
      /**
       * One request covers a whole city, so queries are grouped by city and date
       * rather than issued per property. On the evaluation quota of 50 requests/day
       * that difference is the whole feature: per-property would spend the day's
       * budget on one city.
       */
      const byCityDate = new Map<string, { city: City | null; date: string }>();
      for (const query of queries) {
        const key = `${query.cityId}|${query.date}`;
        if (byCityDate.has(key)) continue;
        // The search needs the city's centre point and currency, which the shipped
        // city list is the single source of.
        byCityDate.set(key, { city: findCity(query.cityId) ?? null, date: query.date });
      }

      const rates: RawRate[] = [];
      const problems: string[] = [];

      for (const { city, date } of byCityDate.values()) {
        if (!city) {
          problems.push(`unknown city id in the plan`);
          continue;
        }

        const url = `${base}/hotel-api/1.0/hotels`;
        const permission = await ctx.robots.check(url);
        if (!permission.allowed) {
          return failed({
            kind: "robots-disallowed",
            rule: permission.rule,
            path: new URL(url).pathname,
          });
        }

        const response = await ctx.fetchFn({
          url,
          method: "POST",
          headers: authHeaders(credentials, ctx.now),
          body: JSON.stringify(buildAvailabilityRequest(city, date, options)),
        });

        const refusal = refusalOf(response);
        if (refusal) {
          /**
           * The evaluation tier answers 403 once its 50 requests/day are spent, which
           * is a quota problem rather than a block and worth saying so: the operator's
           * fix is to wait or upgrade, not to change the request.
           */
          if (response.status === 403) {
            return failed({
              kind: "skipped",
              reason: `Hotelbeds refused the request (HTTP 403) — the evaluation quota is ${EVALUATION_DAILY_QUOTA} requests/day`,
            });
          }
          return failed(refusal);
        }

        let payload: unknown;
        try {
          payload = JSON.parse(response.body);
        } catch (error) {
          return failed({ kind: "parse-error", detail: `not JSON: ${String(error)}` });
        }

        const hotels = parseAvailability(payload, 1);
        if (hotels.length === 0) {
          /**
           * Two very different situations, and an operator needs to tell them apart:
           * no inventory for that city (nothing to fix here, the evaluation
           * environment is a small subset) versus a payload we could not read (a
           * parser bug, and the dates that did work say so by contrast).
           */
          const returned = Array.isArray(
            (payload as { hotels?: { hotels?: unknown } })?.hotels?.hotels,
          )
            ? ((payload as { hotels: { hotels: unknown[] } }).hotels.hotels.length)
            : 0;
          problems.push(
            returned === 0
              ? `${city.id} ${date}: no hotels returned availability (inventory, not a parse failure)`
              : `${city.id} ${date}: ${returned} hotels returned but none carried a readable amount`,
          );
          continue;
        }

        for (const hotel of hotels) {
          const amount =
            hotel.currency === city.currency
              ? hotel.nightly
              : await convert(hotel.nightly, hotel.currency, city.currency);

          if (amount === null || !Number.isFinite(amount) || amount <= 0) {
            problems.push(
              `${city.id} ${date}: no ${hotel.currency}→${city.currency} conversion`,
            );
            continue;
          }

          rates.push({
            propertyId: `hotelbeds:${hotel.code}`,
            cityId: city.id,
            date,
            priceLocal: Math.round(amount * 100) / 100,
            currency: city.currency,
            source: "hotelbeds",
            collectedAt: ctx.now.toISOString(),
            extraction: SHAPE_OBSERVED ? "verified" : "inferred",
            note: [
              hotel.categoryName,
              hotel.source === "dailyNet" ? "per-night net" : "stay net ÷ nights",
              hotel.currency === city.currency
                ? null
                : `converted from ${hotel.currency}`,
            ]
              .filter(Boolean)
              .join("; "),
          });
        }

        ctx.log(
          `  ${city.id} ${date}: ${hotels.length} hotels with availability (${hotels.filter((h) => h.currency !== city.currency).length} converted)`,
        );
      }

      if (rates.length === 0) {
        return failed({
          kind: "parse-error",
          detail:
            problems.slice(0, 5).join(" | ") || "no hotels returned any rate",
        });
      }

      for (const problem of problems.slice(0, 5)) ctx.log(`  ! ${problem}`);
      return collected(rates);
    },
  };
}
