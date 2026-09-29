/**
 * Data source selection and credentials.
 *
 * Server-only. Nothing in this module may be imported from a client component: it
 * reads API keys. The scoring route handler is the only intended consumer, and
 * `requestScore` on the client talks to that route over HTTP instead.
 *
 * Source selection is per-dimension rather than global, because the sources have very
 * different readiness: weather, holidays and FX need no credentials and run live
 * immediately, while pricing needs a key that may not exist yet. A single
 * all-or-nothing switch would block the three working sources behind the two that are
 * not ready.
 *
 * ## A note on flight pricing, so this is not re-litigated
 *
 * Amadeus was the original plan. Its Self-Service portal was decommissioned on
 * 17 July 2026 and the keys were disabled; flight access now requires an enterprise
 * contract. The adapter that targeted it was removed rather than left in place
 * waiting for credentials that can no longer be obtained. See `live/flights.ts`.
 */

export type SourceMode = "mock" | "live";

export interface DataSources {
  weather: SourceMode;
  holidays: SourceMode;
  fx: SourceMode;
  flight: SourceMode;
  hotel: SourceMode;
}

/** How the hotel reference price is sourced. */
export type HotelSource =
  /** Nothing collected yet; the mock index is used. */
  | "mock"
  /** Median across hotels collected by `scripts/crawl-hotel-prices.ts`. */
  | "self-collected";

export interface PricingCredentials {
  apiKey: string;
  /** Provider name, for logging and provenance. */
  provider: string;
}

function readMode(value: string | undefined, fallback: SourceMode): SourceMode {
  if (value === "live") return "live";
  if (value === "mock") return "mock";
  return fallback;
}

/**
 * Defaults are chosen so `npm run dev` works with no configuration at all: the
 * credential-free sources come up live, and the credential-gated ones stay on mock
 * data until a key is supplied.
 */
export function getDataSources(): DataSources {
  return {
    weather: readMode(process.env.IITTG_SOURCE_WEATHER, "live"),
    holidays: readMode(process.env.IITTG_SOURCE_HOLIDAYS, "live"),
    fx: readMode(process.env.IITTG_SOURCE_FX, "live"),
    // Still mock by default: a key is required, and an unauthenticated call would
    // simply fail on every request.
    flight: readMode(process.env.IITTG_SOURCE_FLIGHT, "mock"),
    hotel: readMode(process.env.IITTG_SOURCE_HOTEL, "mock"),
  };
}

/**
 * Flight pricing credentials.
 *
 * Provider-agnostic on purpose. Only Ignav is implemented, because it is the one
 * genuinely self-serve option after the Amadeus shutdown, but the shape is kept narrow
 * so a partnership provider can be added without touching callers.
 */
export function getFlightCredentials(): PricingCredentials | null {
  const apiKey = process.env.IITTG_FLIGHT_API_KEY;
  if (!apiKey) return null;
  return { apiKey, provider: process.env.IITTG_FLIGHT_PROVIDER ?? "ignav" };
}

/** Where hotel price samples come from. Defaults to the mock index. */
export function getHotelSource(): HotelSource {
  return process.env.IITTG_HOTEL_SOURCE === "self-collected"
    ? "self-collected"
    : "mock";
}

/**
 * The collected dataset the read side serves.
 *
 * A path rather than credentials: the collector writes a JSON file (see
 * `scripts/crawl-hotel-prices.ts`), and this is where the app picks it up. Kept
 * outside `.next/` so a rebuild never discards a collection run.
 */
export function getHotelDatasetPath(): string {
  return process.env.IITTG_HOTEL_DATASET ?? "data/hotel-prices.json";
}

/**
 * Hotelbeds credentials for the city-wide hotel price collection.
 *
 * Optional on purpose: the collector runs without them (`--import`), and the app never needs them —
 * only `scripts/crawl-hotel-prices.ts` does. Evaluation keys are self-serve and limited to 50 requests/day.
 */
export function getHotelbedsCredentials(): {
  apiKey: string;
  secret: string;
  environment: "test" | "production";
} | null {
  const apiKey = process.env.IITTG_HOTELBEDS_API_KEY;
  const secret = process.env.IITTG_HOTELBEDS_SECRET;
  if (!apiKey || !secret) return null;
  return {
    apiKey,
    secret,
    environment:
      process.env.IITTG_HOTELBEDS_ENV === "production" ? "production" : "test",
  };
}

/**
 * Whether real flight pricing is configured. Surfaced to the UI so the "sample data"
 * disclosure stays accurate instead of silently claiming live data.
 */
export function pricingIsLive(): boolean {
  return getDataSources().flight === "live" && getFlightCredentials() !== null;
}

/** Thrown when a live source is requested but cannot be used. */
export class MissingCredentialsError extends Error {
  /**
   * Declared rather than written as a parameter property: the collector CLI imports
   * this module and runs it through Node's strip-only TypeScript support, which
   * rejects that syntax. See `scripts/ts-loader.mjs`.
   */
  readonly provider: string;

  constructor(provider: string) {
    super(`Source "${provider}" is set to live but no credentials are configured.`);
    this.name = "MissingCredentialsError";
    this.provider = provider;
  }
}
