/**
 * Amadeus adapters for flight and hotel pricing.
 *
 * ## Verification status — read this before trusting the hotel path
 *
 * The **flight** adapter follows the documented `GET /v2/shopping/flight-offers`
 * contract: OAuth2 client-credentials token, IATA codes, ISO dates, adults, currency,
 * and a `data[].price.grandTotal` price. That shape is stable and widely used.
 *
 * The **hotel** adapter is written from the documented shape of
 * `GET /v3/shopping/hotel-offers`, but it has never been run against a real
 * response, because no credentials were available. Its parsing is therefore
 * deliberately defensive: anything unexpected makes it report the hotel dimension
 * as unavailable rather than produce a plausible-looking wrong number. Treat it as
 * a scaffold that needs one session against real credentials before it is trusted.
 *
 * ## Two constraints that shape this file
 *
 * 1. **The test environment has sparse city coverage.** Amadeus's free test tier
 *    serves a limited set of city pairs, and the launch scope (China, Japan, Korea,
 *    South-east Asia) is largely outside it. The adapter must therefore treat "no
 *    offers returned" as an expected, normal outcome — not an error — and report the
 *    flight dimension as unavailable with a reason the UI can show.
 *
 * 2. **Hotel pricing is per *offer*, not per city.** There is no "average nightly
 *    rate for central hotels" endpoint. The price index therefore has to be built
 *    from a fixed basket of property IDs per city, sampled per night. This adapter
 *    returns the raw per-night price for whatever basket it is given; composing the
 *    basket is a separate, curated task (see MODEL.md).
 */

import type {
  City,
  FlightQuote,
  FlightScorerInput,
  Holiday,
  HotelQuote,
} from "../../scoring/types";
import { findRoute } from "../routes";
import { addDays } from "../../scoring/dates";
import { amadeusBaseUrl, type AmadeusCredentials } from "../config";
import type { DataProvider, HolidayResult } from "../types";
import { TTL, remember } from "../cache";

const HTTP_TIMEOUT_MS = 25_000;

const USER_AGENT =
  "iittg-prototype/0.1 (+https://github.com/bobbyli0313/is-it-time-to-go)";

export class AmadeusError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "AmadeusError";
  }
}

/* ----------------------------------------------------------- OAuth tokens */

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

/**
 * Token cache, keyed by credentials. Amadeus tokens last ~30 minutes; re-requesting
 * one per API call would double the request count against a per-call quota.
 */
const tokenCache = new Map<string, CachedToken>();

async function getAccessToken(
  credentials: AmadeusCredentials,
): Promise<string> {
  const cacheKey = `${credentials.environment}:${credentials.clientId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 60_000) {
    return cached.accessToken;
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${amadeusBaseUrl(credentials.environment)}/v1/security/oauth2/token`,
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": USER_AGENT,
        },
        body,
        cache: "no-store",
      },
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new AmadeusError(
        `Amadeus token request failed`,
        response.status,
        detail.slice(0, 300),
      );
    }

    const json = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!json.access_token) {
      throw new AmadeusError("Amadeus token response had no access_token");
    }

    tokenCache.set(cacheKey, {
      accessToken: json.access_token,
      expiresAt: Date.now() + (json.expires_in ?? 1800) * 1000,
    });
    return json.access_token;
  } catch (error) {
    if (error instanceof AmadeusError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new AmadeusError("Amadeus token request timed out");
    }
    throw new AmadeusError(
      error instanceof Error ? error.message : "Amadeus token request failed",
    );
  } finally {
    clearTimeout(timer);
  }
}

async function amadeusGet<T>(
  credentials: AmadeusCredentials,
  path: string,
  params: Record<string, string>,
): Promise<T> {
  const token = await getAccessToken(credentials);
  const url = new URL(`${amadeusBaseUrl(credentials.environment)}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
      cache: "no-store",
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new AmadeusError(
        `Amadeus ${path} responded ${response.status}`,
        response.status,
        detail.slice(0, 300),
      );
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof AmadeusError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new AmadeusError(`Amadeus ${path} timed out`);
    }
    throw new AmadeusError(
      error instanceof Error ? error.message : `Amadeus ${path} failed`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------- flights */

interface AmadeusFlightOffers {
  data?: Array<{
    price?: { grandTotal?: string; total?: string; currency?: string };
    itineraries?: unknown[];
    numberOfBookableSeats?: number;
  }>;
  dictionaries?: unknown;
}

/** Airlines generally open bookings ~330 days ahead. */
const BOOKING_WINDOW_DAYS = 330;

function isBookingWindowError(error: unknown): boolean {
  if (!(error instanceof AmadeusError)) return false;
  if (error.status === 400 && /date|range|invalid/i.test(error.detail ?? "")) {
    return true;
  }
  return false;
}

/**
 * Lowest round-trip fare in the origin's currency.
 *
 * History is deliberately not populated. The scorer's percentile path needs a
 * distribution of fares for the route over ~90 days, which would mean ~90 API calls
 * per route; instead this returns a quote with no history and the scorer falls back
 * to the distance model, which the UI already labels as such. Building real history
 * is a batch-job concern, not a request-path one.
 */
export function createAmadeusProvider(
  credentials: AmadeusCredentials,
): DataProvider & { name: string } {
  async function searchFlights(
    origin: City,
    destination: City,
    departDate: string,
    returnDate: string,
  ): Promise<FlightScorerInput> {
    const route = findRoute(origin.id, destination.id);
    if (!route) {
      return { kind: "unavailable", reason: "no-quote" };
    }

    const [originCode, destinationCode] = route.airportPair;
    const cacheKey = `amadeus:flight:${originCode}:${destinationCode}:${departDate}:${returnDate}:${origin.currency}`;

    const cached = await remember(
      cacheKey,
      async () => {
        const body = await amadeusGet<AmadeusFlightOffers>(
          credentials,
          "/v2/shopping/flight-offers",
          {
            originLocationCode: originCode,
            destinationLocationCode: destinationCode,
            departureDate: departDate,
            returnDate,
            adults: "1",
            currencyCode: origin.currency,
            max: "10",
          },
        );

        const prices = (body.data ?? [])
          .map((offer) => Number(offer.price?.grandTotal ?? offer.price?.total))
          .filter((value) => Number.isFinite(value) && value > 0);

        if (prices.length === 0) {
          // Expected on the free test tier for most Asian city pairs. Not an error.
          return null;
        }
        return Math.min(...prices);
      },
      { ttlMs: TTL.flightQuote, staleOnError: true },
    );

    if (cached === null) {
      return { kind: "unavailable", reason: "no-quote" };
    }

    const theoreticalUsd = route.roundTripMiles * 0.1;
    const quote: FlightQuote = {
      basis: "cached-fare",
      fareLocal: cached,
      // No history: see the note above. The scorer will use the distance fallback.
      fetchedAt: new Date().toISOString(),
      confidence: 0.62,
      distanceModel: {
        roundTripMiles: route.roundTripMiles,
        dollarsPerMile: 0.1,
        theoreticalUsd: Math.round(theoreticalUsd * 10) / 10,
      },
    };
    return { kind: "quote", quote };
  }

  /**
   * Per-night price from a fixed basket of hotel property IDs.
   *
   * `hotelIds` is a parameter rather than something resolved here: the basket is a
   * curated, per-city asset (same 20 properties every sample, so the index is
   * comparable over time), and resolving it needs Amadeus's hotel reference data.
   *
   * Not yet exercised against a live response — see the file header. Anything that
   * does not match the documented shape yields a null price, which the caller turns
   * into an unavailable hotel dimension rather than a wrong number.
   */
  async function fetchHotelBasketPrice(
    city: City,
    checkIn: string,
    hotelIds: string[],
  ): Promise<number | null> {
    if (hotelIds.length === 0) return null;

    const checkOut = addDays(checkIn, 1);
    const cacheKey = `amadeus:hotel:${city.id}:${checkIn}:${hotelIds.length}`;

    return remember(
      cacheKey,
      async () => {
        const body = await amadeusGet<{
          data?: Array<{
            offers?: Array<{
              price?: { total?: string; currency?: string };
            }>;
          }>;
        }>(credentials, "/v3/shopping/hotel-offers", {
          hotelIds: hotelIds.slice(0, 20).join(","),
          checkInDate: checkIn,
          checkOutDate: checkOut,
          adults: "1",
          currency: city.currency,
          bestRateOnly: "true",
        });

        const totals = (body.data ?? [])
          .flatMap((hotel) => hotel.offers ?? [])
          .map((offer) => Number(offer.price?.total))
          .filter((value) => Number.isFinite(value) && value > 0);

        if (totals.length === 0) return null;
        // One night was requested, so the total is already the nightly rate.
        const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
        return Math.round(mean);
      },
      { ttlMs: TTL.hotelIndex, staleOnError: true },
    );
  }

  return {
    name: "amadeus",

    async fetchWeather(_destination: City, _date: string): Promise<never> {
      throw new AmadeusError("Amadeus does not provide weather");
    },

    async fetchHolidays(
      _country: string,
      _from: string,
      _to: string,
    ): Promise<HolidayResult> {
      throw new AmadeusError("Amadeus does not provide holidays");
    },

    async fetchFx(_origin: City, _destination: City): Promise<never> {
      throw new AmadeusError("Amadeus does not provide exchange rates");
    },

    async fetchFlightQuote(
      origin: City,
      destination: City,
      departDate: string,
      returnDate: string,
      _now: Date = new Date(),
    ): Promise<FlightScorerInput> {
      try {
        return await searchFlights(origin, destination, departDate, returnDate);
      } catch (error) {
        if (isBookingWindowError(error)) {
          return {
            kind: "unavailable",
            reason: "outside-booking-window",
            bookingOpensOn: addDays(departDate, -BOOKING_WINDOW_DAYS),
          };
        }
        // Any other upstream failure is reported as "no quote" rather than
        // propagated: a missing fare must never be scored as a zero fare, and the
        // UI already discloses that the dimension was excluded.
        return { kind: "unavailable", reason: "no-quote" };
      }
    },

    /**
     * Hotel index. Returns a quote relative to the destination's baseline so the
     * scorer's index maths is unchanged; `sampleSize` reports the real basket size
     * so the confidence badge reflects the true sample.
     */
    async fetchHotelIndex(
      destination: City,
      departDate: string,
      _holidays: Holiday[],
    ): Promise<HotelQuote> {
      const hotelIds = hotelBasketFor(destination);
      const perNightLocal = await fetchHotelBasketPrice(
        destination,
        departDate,
        hotelIds,
      );

      const baselineLocal = hotelBaselineFor(destination);

      if (perNightLocal === null || baselineLocal === null) {
        // Signal "no data" through a zero-confidence quote rather than throwing, so
        // the caller can disclose it as an unavailable dimension.
        return {
          perNightLocal: 0,
          baselineLocal: baselineLocal ?? 0,
          confidence: 0,
          basis: "hotel-price-index",
          sampleSize: 0,
        };
      }

      return {
        perNightLocal,
        baselineLocal,
        confidence: Math.min(0.8, 0.4 + hotelIds.length / 50),
        basis: "hotel-price-index",
        sampleSize: hotelIds.length,
        components: {
          holidayLift: 1,
          seasonal: 1,
          cityLevel: 1,
          nearbyHolidayDays: 0,
        },
      };
    },
  };
}

/* ------------------------------------------------------------- hotel basket */

/**
 * Curated hotel property IDs per city.
 *
 * Intentionally empty. Populating it requires Amadeus's hotel reference data and a
 * deliberate choice of basket — same property class, central location, fixed
 * membership — because the index is only meaningful if the basket does not change
 * between samples. Filling this in from code would produce an arbitrary basket; it
 * is a data-curation task, documented in MODEL.md.
 */
const HOTEL_BASKETS: Record<string, string[]> = {};

export function hotelBasketFor(city: City): string[] {
  return HOTEL_BASKETS[city.id] ?? [];
}

/**
 * Baseline nightly rate in the destination's currency, converted from the CNY
 * anchor at a rough rate. Replaced by real FX once the hotel index is live.
 */
const BASELINE_CNY = 500;
const CNY_PER_LOCAL_APPROX: Record<string, number> = {
  CNY: 1, HKD: 1.1, JPY: 23.4, KRW: 197, THB: 4.6, SGD: 0.185,
  MYR: 0.62, IDR: 2255, VND: 3560, PHP: 8.05, TWD: 4.42,
};

function hotelBaselineFor(city: City): number | null {
  const rate = CNY_PER_LOCAL_APPROX[city.currency];
  if (!rate) return null;
  return Math.round(BASELINE_CNY * rate);
}

export const internals = {
  getAccessToken,
  HOTEL_BASKETS,
};
