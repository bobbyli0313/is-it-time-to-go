/**
 * Data source selection and credentials.
 *
 * Server-only. Nothing in this module may be imported from a client component:
 * it reads API keys. The scoring route handler is the only intended consumer, and
 * `requestScore` on the client talks to that route over HTTP instead.
 *
 * Source selection is per-dimension rather than global, because the sources have
 * very different readiness: weather, holidays and FX need no credentials and can
 * go live immediately, while flight and hotel prices need Amadeus keys that may
 * not exist yet. Making that a single all-or-nothing switch would block the three
 * working sources behind the two that are not.
 */

export type SourceMode = "mock" | "live";

export interface DataSources {
  weather: SourceMode;
  holidays: SourceMode;
  fx: SourceMode;
  flight: SourceMode;
  hotel: SourceMode;
}

export interface AmadeusCredentials {
  clientId: string;
  clientSecret: string;
  /**
   * Amadeus runs two independent environments with separate credentials. The test
   * environment is free and returns cached, non-bookable data; production is
   * billed per call and returns live availability. Never confuse the two: a test
   * key against the production host will simply 401.
   */
  environment: "test" | "production";
}

function readMode(value: string | undefined, fallback: SourceMode): SourceMode {
  if (value === "live") return "live";
  if (value === "mock") return "mock";
  return fallback;
}

/**
 * Defaults are chosen so `npm run dev` works with no configuration at all:
 * the credential-free sources come up live, and the credential-gated ones stay
 * on mock data until keys are supplied.
 */
export function getDataSources(): DataSources {
  return {
    weather: readMode(process.env.IITTG_SOURCE_WEATHER, "live"),
    holidays: readMode(process.env.IITTG_SOURCE_HOLIDAYS, "live"),
    fx: readMode(process.env.IITTG_SOURCE_FX, "live"),
    flight: readMode(process.env.IITTG_SOURCE_FLIGHT, "mock"),
    hotel: readMode(process.env.IITTG_SOURCE_HOTEL, "mock"),
  };
}

export function getAmadeusCredentials(): AmadeusCredentials | null {
  const clientId = process.env.AMADEUS_CLIENT_ID;
  const clientSecret = process.env.AMADEUS_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  return {
    clientId,
    clientSecret,
    environment:
      process.env.AMADEUS_ENVIRONMENT === "production"
        ? "production"
        : "test",
  };
}

export function amadeusBaseUrl(environment: "test" | "production"): string {
  return environment === "production"
    ? "https://api.amadeus.com"
    : "https://test.api.amadeus.com";
}

/**
 * Whether real flight/hotel pricing is configured. Surfaced to the UI so the
 * "sample data" disclosure stays accurate instead of silently claiming live data.
 */
export function pricingIsLive(): boolean {
  const sources = getDataSources();
  return (
    sources.flight === "live" &&
    sources.hotel === "live" &&
    getAmadeusCredentials() !== null
  );
}

/** Thrown when a live source is requested but cannot be used. */
export class MissingCredentialsError extends Error {
  constructor(public readonly provider: string) {
    super(
      `Source "${provider}" is set to live but no credentials are configured.`,
    );
    this.name = "MissingCredentialsError";
  }
}
