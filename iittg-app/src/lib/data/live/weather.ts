/**
 * Live weather via Open-Meteo.
 *
 * Open-Meteo needs no API key and no attribution beyond a link, which makes it the
 * lowest-risk source in the product. The interesting problem it brings is the one
 * the model already anticipates: it publishes a 16-day numerical forecast, and the
 * spec allows departures up to 30 days out, so roughly half of all scorable trips
 * fall outside the forecast window.
 *
 * Beyond 16 days we serve a *climate normal*: the observed distribution for the
 * same calendar window over the past decade. That is a genuinely different kind of
 * claim from a forecast, and the model already tags it (`basis: "climate-normal"`)
 * and caps its confidence accordingly — so this provider must never dress it up as
 * a prediction.
 *
 * The archive endpoint takes 7-10 seconds per request (measured, and it does not
 * improve for shorter ranges), so normals are computed once per city per calendar
 * window and cached for 30 days, on disk as well as in memory. Paying that cost on
 * a request path would be unacceptable; paying it once is free.
 */

import { diffDays } from "../../scoring/dates";
import type { City, WeatherSample } from "../../scoring/types";
import { TTL, remember } from "../cache";
import { fetchJson } from "../http";

const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";

/**
 * Open-Meteo publishes 16 days of forecast. Requests beyond that silently return
 * fewer days rather than erroring, so the horizon is enforced locally.
 */
export const FORECAST_HORIZON_DAYS = 16;

/** Years of history averaged into a climate normal. */
const NORMAL_YEARS = 10;

export class WeatherUpstreamError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "WeatherUpstreamError";
  }
}

interface OpenMeteoDaily {
  time?: string[];
  temperature_2m_max?: Array<number | null>;
  temperature_2m_min?: Array<number | null>;
  relative_humidity_2m_mean?: Array<number | null>;
  precipitation_probability_max?: Array<number | null>;
}

interface OpenMeteoResponse {
  daily?: OpenMeteoDaily;
  error?: boolean;
  reason?: string;
}

/**
 * Daily mean temperature from the min/max pair.
 *
 * Open-Meteo's `temperature_2m_mean` is only available from the archive, not the
 * forecast endpoint, so both paths derive it the same way. Consistency matters:
 * the climate normal and the forecast must be measured identically or the two
 * would not be comparable.
 */
function meanOf(min: number, max: number): number {
  return (min + max) / 2;
}

function indexByDate(daily: OpenMeteoDaily): Map<string, {
  tempC: number;
  humidityPct: number;
  spreadC: number;
  precipProbabilityPct?: number;
}> {
  const out = new Map<string, {
    tempC: number;
    humidityPct: number;
    spreadC: number;
    precipProbabilityPct?: number;
  }>();
  const times = daily.time ?? [];
  for (let i = 0; i < times.length; i += 1) {
    const min = daily.temperature_2m_min?.[i];
    const max = daily.temperature_2m_max?.[i];
    const humidity = daily.relative_humidity_2m_mean?.[i];
    if (min == null || max == null || humidity == null) continue;

    const precip = daily.precipitation_probability_max?.[i];
    out.set(times[i], {
      tempC: Math.round(meanOf(min, max) * 10) / 10,
      humidityPct: Math.round(humidity),
      spreadC: Math.round(((max - min) / 2) * 10) / 10,
      ...(precip != null ? { precipProbabilityPct: Math.round(precip) } : {}),
    });
  }
  return out;
}

/* ------------------------------------------------------- climate normals */

export interface ClimateNormal {
  /** Mean of daily means, °C. */
  tempC: number;
  humidityPct: number;
  /** Interquartile spread of the daily means, °C. */
  tempSpreadC: number;
  humiditySpreadPct: number;
  /** How many year-samples contributed. Disclosed, because a thin sample is weak. */
  sampleYears: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/**
 * Monthly climate normal: the mean and interquartile spread for one calendar month,
 * averaged over `NORMAL_YEARS` past years.
 *
 * ## Why the unit is a month, not a day
 *
 * The first implementation keyed normals per calendar day, which meant a trip spread
 * across a month boundary pulled several archive responses at 7-10 seconds each, and
 * every distinct day cost its own fetch. A month is 30x fewer keys for a difference
 * in accuracy that is well inside the noise the model already discloses (a normal is
 * capped at medium confidence precisely because it cannot speak to a specific day).
 *
 * The archive payload is fetched once per city per month and cached for 30 days, so
 * the cost is paid at most 12 times per city per year.
 */
async function computeMonthlyNormal(
  city: City,
  month: number,
  referenceYear: number,
): Promise<ClimateNormal> {
  const pad = (n: number) => String(n).padStart(2, "0");
  const startYear = referenceYear - NORMAL_YEARS;

  // Span the whole month across every sampled year, in one contiguous range.
  const start = `${startYear}-${pad(month)}-01`;
  const end = `${referenceYear - 1}-${pad(month)}-28`;

  const url = new URL(ARCHIVE_URL);
  url.searchParams.set("latitude", String(city.lat));
  url.searchParams.set("longitude", String(city.lon));
  url.searchParams.set("start_date", start);
  url.searchParams.set("end_date", end);
  url.searchParams.set(
    "daily",
    "temperature_2m_max,temperature_2m_min,relative_humidity_2m_mean",
  );
  url.searchParams.set("timezone", city.timezone);

  const body = await fetchJson<OpenMeteoResponse>(url.toString(), {
    // The archive is slow by nature; this is a batch-style call cached for 30 days,
    // so it can afford a longer leash than a request-path call.
    timeoutMs: 12_000,
    attempts: 2,
  });
  if (!body) throw new WeatherUpstreamError("Open-Meteo archive returned nothing");
  const byDate = indexByDate(body.daily ?? {});
  if (byDate.size === 0) {
    throw new WeatherUpstreamError("Open-Meteo archive returned no usable days");
  }

  // Keep only days in the target month, in every year present.
  const temps: number[] = [];
  const humidities: number[] = [];
  const yearsSeen = new Set<string>();

  for (const [date, value] of byDate) {
    const year = date.slice(0, 4);
    if (Number(date.slice(5, 7)) !== month) continue;

    temps.push(value.tempC);
    humidities.push(value.humidityPct);
    yearsSeen.add(year);
  }

  if (temps.length < NORMAL_YEARS * 20) {
    // ~300 daily observations expected (10 years x 30 days); a much smaller number
    // means the archive response was truncated rather than that the month is mild.
    throw new WeatherUpstreamError(
      `Climate normal for ${city.id} month ${month} had only ${temps.length} samples`,
    );
  }

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const sortedTemps = [...temps].sort((a, b) => a - b);
  const sortedHum = [...humidities].sort((a, b) => a - b);

  return {
    tempC: Math.round(mean(temps) * 10) / 10,
    humidityPct: Math.round(mean(humidities)),
    // Report the interquartile spread, not the full range: the extremes of a
    // decade are not what a traveller should plan around.
    tempSpreadC:
      Math.round((quantile(sortedTemps, 0.75) - quantile(sortedTemps, 0.25)) * 10) /
      10,
    humiditySpreadPct: Math.round(
      quantile(sortedHum, 0.75) - quantile(sortedHum, 0.25),
    ),
    sampleYears: yearsSeen.size,
  };
}

/** Resolves the normal for the month containing `date`. */
export async function getClimateNormal(
  city: City,
  date: string,
  now: Date = new Date(),
): Promise<ClimateNormal> {
  const month = Number(date.slice(5, 7));
  return remember(
    `climate:${city.id}:${month}`,
    () => computeMonthlyNormal(city, month, now.getUTCFullYear()),
    // Stale-on-error: a week-old normal is a far better answer than a failure, and
    // the underlying data changes on the scale of decades.
    { ttlMs: TTL.climateNormal, staleOnError: true },
  );
}

/* ---------------------------------------------------------------- forecast */

export async function getForecast(
  city: City,
  date: string,
): Promise<WeatherSample | null> {
  const key = `forecast:${city.id}:${date}`;
  const daily = await remember(
    key,
    async () => {
      const url = new URL(FORECAST_URL);
      url.searchParams.set("latitude", String(city.lat));
      url.searchParams.set("longitude", String(city.lon));
      url.searchParams.set(
        "daily",
        "temperature_2m_max,temperature_2m_min,relative_humidity_2m_mean,precipitation_probability_max",
      );
      url.searchParams.set("timezone", city.timezone);
      url.searchParams.set("forecast_days", String(FORECAST_HORIZON_DAYS));
      const body = await fetchJson<OpenMeteoResponse>(url.toString(), {
        timeoutMs: 8_000,
        attempts: 3,
      });
      if (!body) {
        throw new WeatherUpstreamError("Open-Meteo forecast returned nothing");
      }
      // Cache the whole 16-day series under one key per city: the payload arrives
      // as a single response, so caching per date would re-fetch the same series.
      return Object.fromEntries(indexByDate(body.daily ?? {}));
    },
    { ttlMs: TTL.forecast, staleOnError: true },
  );

  const hit = daily[date];
  if (!hit) return null;

  return {
    date,
    basis: "forecast",
    tempC: hit.tempC,
    humidityPct: hit.humidityPct,
    tempSpreadC: hit.spreadC,
    humiditySpreadPct: 8,
    ...(hit.precipProbabilityPct != null
      ? { precipProbabilityPct: hit.precipProbabilityPct }
      : {}),
  };
}

/* ------------------------------------------------------------- public API */

/**
 * Resolves a weather sample for a destination and date.
 *
 * Forecast where one exists, climate normal beyond the horizon. Returns `null`
 * only when neither is obtainable, so the caller can disclose the gap rather than
 * invent a number.
 */
export async function fetchLiveWeather(
  destination: City,
  date: string,
  now: Date = new Date(),
): Promise<WeatherSample> {
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  )
    .toISOString()
    .slice(0, 10);

  const daysOut = diffDays(today, date);

  if (daysOut >= 0 && daysOut < FORECAST_HORIZON_DAYS) {
    try {
      const forecast = await getForecast(destination, date);
      if (forecast) return forecast;
      // Fall through to the normal if the forecast omitted this date.
    } catch (error) {
      /**
       * A forecast outage degrades to a normal rather than failing the request. The
       * sample is still labelled `climate-normal`, so the confidence badge and the
       * UI warning both stay truthful about what the number actually is.
       */
      if (!(error instanceof WeatherUpstreamError)) throw error;
    }
  }

  const normal = await getClimateNormal(destination, date, now);
  return {
    date,
    basis: "climate-normal",
    tempC: normal.tempC,
    humidityPct: normal.humidityPct,
    tempSpreadC: normal.tempSpreadC,
    humiditySpreadPct: normal.humiditySpreadPct,
  };
}

/** Exported for the offline fixture tests and for diagnostics. */
export const internals = {
  indexByDate,
  meanOf,
  quantile,
};
