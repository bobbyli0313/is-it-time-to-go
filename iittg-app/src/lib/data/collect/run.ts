/**
 * The collection run.
 *
 * One job: turn a set of sources, cities and dates into a dataset the read side
 * can serve, plus a report an operator can act on. The report matters as much as
 * the dataset — a run that produced six of twenty cities has to say which fourteen
 * failed and why, or the next person will assume the data is simply missing.
 *
 * ## Order of operations, and why
 *
 *  1. **Census first.** Property lists are per city, not per date, and they are
 *     the denominator the median's coverage claim needs. They also bound the work:
 *     rates are only fetched for properties the census knows about.
 *  2. **Rates second**, one request per property per date, paced by the transport.
 *  3. **The anchor third**, once per currency rather than once per city — the ¥500
 *     conversion is a property of the currency, not of the city.
 *  4. **Assemble last**, so a run that fails halfway still yields a valid dataset
 *     for the cities it did cover. Partial success is normal here; a crawler that
 *     discards everything because one city failed is a crawler nobody runs twice.
 *
 * Nothing here decides to ignore a failure. Every refused request ends up in
 * `report.cities[].failures`, and every discarded sample in `report.dropped`.
 */

import type { City } from "../../scoring/types";
import {
  DEFAULT_BASIS,
  median,
  reduceToPropertyMedians,
  toDataset,
  type CityHotelCensus,
  type HotelDataset,
  type HotelDisclosure,
  type HotelPriceSample,
  type HotelProperty,
} from "../hotel-dataset";
import { BudgetExhaustedError } from "./http";
import { baselineForCurrency, type BaselineResult } from "./baseline";
import type {
  CollectFailure,
  CollectOutcome,
  CollectorAdapter,
  CollectorContext,
  HotelPropertyRef,
  RateQuery,
  RawRate,
  SourceInfo,
} from "./types";

export interface ImportedInput {
  samples: HotelPriceSample[];
  propertiesByCity: Map<string, HotelProperty[]>;
  /** Cities whose imported property list is asserted to be exhaustive. */
  completeCities: Set<string>;
  /** Labels of the files or feeds the samples came from. */
  sources: string[];
}

export interface CollectPlan {
  cities: City[];
  /** Check-in dates to price, ISO. One night each. */
  dates: string[];
  adapters: CollectorAdapter[];
  context: CollectorContext;
  /** Prices from files, merged with whatever the adapters return. */
  imported?: ImportedInput;
  /** Cap on properties priced per city, for a deliberately cheap first run. */
  maxPropertiesPerCity?: number;
  /**
   * How the ¥500 anchor is converted into a city's currency.
   *
   * Injectable because it is the one part of a run that needs live FX: a test — or
   * an operator collecting against a fixed historical rate — must be able to supply
   * it rather than reaching for the network from inside the runner.
   */
  resolveBaseline?: (currency: string, now: Date) => Promise<BaselineResult>;
  /**
   * What the resulting dataset may publish. Defaults to the most restrictive setting
   * among the rate sources — a wholesale net rate is not a retail price, and one
   * source that may not be republished makes the whole dataset an index.
   */
  disclosure?: HotelDisclosure;
}

export interface CityReport {
  cityId: string;
  properties: number;
  censusComplete: boolean;
  censusSource: string | null;
  samples: number;
  /** Median of the medians this run collected, before the read side's window. */
  medianLocal: number | null;
  sources: string[];
  failures: string[];
}

export interface CollectReport {
  dataset: HotelDataset;
  /** What the dataset may publish: the amount, or only its distance from the anchor. */
  disclosure: HotelDisclosure;
  cities: CityReport[];
  requestsMade: number;
  /** Samples that were discarded, each with the reason. */
  dropped: string[];
  sources: SourceInfo[];
  generatedAt: string;
}

/** Renders any failure as one line an operator can act on. */
export function describeFailure(failure: CollectFailure): string {
  switch (failure.kind) {
    case "blocked":
      return `blocked by ${failure.by} (${failure.evidence})`;
    case "robots-disallowed":
      return `refused by robots.txt: ${failure.rule}`;
    case "no-endpoint":
      return `no usable endpoint: ${failure.detail}`;
    case "http-error":
      return `HTTP ${failure.status} (${failure.detail})`;
    case "parse-error":
      return `unparseable response: ${failure.detail}`;
    case "unverified-shape":
      return `response shape unverified: ${failure.detail}`;
    case "skipped":
      return `skipped: ${failure.reason}`;
  }
}

/** Reads a city's census from every adapter that publishes one. */
async function collectCensus(
  city: City,
  adapters: CollectorAdapter[],
  ctx: CollectorContext,
  failures: string[],
): Promise<{ properties: HotelPropertyRef[]; source: string | null }> {
  const properties: HotelPropertyRef[] = [];
  const seen = new Set<string>();
  let source: string | null = null;

  for (const adapter of adapters) {
    if (!adapter.listProperties) continue;

    let outcome: CollectOutcome<HotelPropertyRef[]>;
    try {
      outcome = await adapter.listProperties(city, ctx);
    } catch (error) {
      if (error instanceof BudgetExhaustedError) throw error;
      failures.push(`${adapter.name}: ${String(error)}`);
      continue;
    }

    if (!outcome.ok) {
      failures.push(`${adapter.name}: ${describeFailure(outcome.failure)}`);
      continue;
    }

    for (const property of outcome.data) {
      if (seen.has(property.id)) continue;
      seen.add(property.id);
      properties.push(property);
    }
    source = source ? `${source}+${adapter.name}` : adapter.name;
  }

  return { properties, source };
}

/**
 * Fetches rates for every property/date pair the adapters support.
 *
 * An adapter without `fetchRates` is a census-only source, and is simply not asked:
 * implementing the method is the whole opt-in.
 */
async function collectRates(
  city: City,
  properties: HotelPropertyRef[],
  dates: string[],
  adapters: CollectorAdapter[],
  ctx: CollectorContext,
  failures: string[],
): Promise<RawRate[]> {
  const sources = adapters.filter((adapter) => adapter.fetchRates);
  if (sources.length === 0 || dates.length === 0) {
    return [];
  }

  /**
   * A property list is not a prerequisite for asking. A city-wide source is asked once
   * per city and date and answers with the hotels it found; a source configured against
   * named properties gets one query per property. Requiring properties here is what
   * silently skipped a source that does not need them.
   */
  const queries: RateQuery[] =
    properties.length > 0
      ? properties.flatMap((property) =>
          dates.map((date) => ({ cityId: city.id, date, property })),
        )
      : dates.map((date) => ({ cityId: city.id, date }));
  const rates: RawRate[] = [];

  for (const adapter of sources) {
    const fetchRates = adapter.fetchRates;
    if (!fetchRates) continue;
    try {
      const outcome = await fetchRates.call(adapter, queries, ctx);
      if (outcome.ok) rates.push(...outcome.data);
      else {
        failures.push(
          `${adapter.name}: ${describeFailure(outcome.failure)}`,
        );
      }
    } catch (error) {
      if (error instanceof BudgetExhaustedError) throw error;
      failures.push(`${adapter.name}: ${String(error)}`);
    }
  }

  return rates;
}

/**
 * Runs a collection.
 *
 * Throws only when the transport's request budget is exhausted, which is a
 * deliberate stop rather than an error; everything else is reported. The dataset
 * returned covers whatever succeeded.
 */
export async function runCollection(plan: CollectPlan): Promise<CollectReport> {
  const { context } = plan;
  const log = context.log;
  const failuresByCity = new Map<string, string[]>();
  const censusByCity = new Map<
    string,
    { properties: HotelPropertyRef[]; source: string | null }
  >();
  const ratesByCity = new Map<string, RawRate[]>();
  const dropped: string[] = [];
  const generatedAt = context.now.toISOString();

  for (const city of plan.cities) {
    const failures: string[] = [];
    failuresByCity.set(city.id, failures);
    log(`\n${city.name.en} (${city.id})`);

    const census = await collectCensus(city, plan.adapters, context, failures);
    censusByCity.set(city.id, census);

    const properties = plan.maxPropertiesPerCity
      ? census.properties.slice(0, plan.maxPropertiesPerCity)
      : census.properties;

    const rates = await collectRates(
      city,
      properties,
      plan.dates,
      plan.adapters,
      context,
      failures,
    );
    ratesByCity.set(city.id, rates);
  }

  /* ------------------------------------------------- assemble the dataset */

  const imported = plan.imported;

  /**
   * Which city each property belongs to, from every source.
   *
   * Built once, before the per-city loop, so an imported price is attributed by
   * the property it names rather than by which city happens to be under
   * consideration — otherwise every city would report every other city's rows as
   * "not in this city's census".
   */
  const propertyCity = new Map<string, string>();
  for (const [cityId, census] of censusByCity) {
    for (const property of census.properties) propertyCity.set(property.id, cityId);
  }
  for (const [cityId, properties] of imported?.propertiesByCity ?? []) {
    for (const property of properties) {
      if (!propertyCity.has(property.id)) propertyCity.set(property.id, cityId);
    }
  }
  /**
   * And from the rates themselves.
   *
   * A source can price hotels it never enumerated — an aggregator returns every
   * hotel with availability around a city centre and no property list at all. Those
   * hotels are the ones the median is *about*, so they have to enter the city's
   * property set; without this they were attributed to no city and every sample was
   * discarded in silence (101 of them on the first live Hotelbeds run).
   */
  const rateProperties = new Map<string, HotelProperty[]>();
  for (const rate of plan.cities.flatMap((city) => ratesByCity.get(city.id) ?? [])) {
    if (propertyCity.has(rate.propertyId)) continue;
    propertyCity.set(rate.propertyId, rate.cityId);
    const list = rateProperties.get(rate.cityId) ?? [];
    list.push({
      id: rate.propertyId,
      name: rate.propertyId,
      group: rate.source,
    });
    rateProperties.set(rate.cityId, list);
  }

  const currencies = new Set<string>();
  for (const city of plan.cities) currencies.add(city.currency);

  const resolveBaseline = plan.resolveBaseline ?? baselineForCurrency;
  const baselines = new Map<
    string,
    { baselineLocal: number; asOf: string; source: string }
  >();
  for (const currency of currencies) {
    const result = await resolveBaseline(currency, context.now);
    if (result.ok) {
      baselines.set(currency, {
        baselineLocal: result.data.baselineLocal,
        asOf: result.data.asOf,
        source: result.data.source,
      });
    } else {
      dropped.push(`baseline for ${currency}: ${result.detail}`);
    }
  }

  /* Imported samples, attributed once and reported once when unattributable. */
  const importedSamples: HotelPriceSample[] = [];
  for (const sample of imported?.samples ?? []) {
    const cityId = propertyCity.get(sample.propertyId);
    if (!cityId) {
      dropped.push(
        `${sample.propertyId} on ${sample.date}: matches no known property`,
      );
      continue;
    }
    importedSamples.push(sample);
  }

  const cities: CityHotelCensus[] = [];
  const samples: HotelPriceSample[] = [];
  const cityReports: CityReport[] = [];
  const adapterRates = plan.cities.flatMap((city) => ratesByCity.get(city.id) ?? []);

  for (const city of plan.cities) {
    const failures = failuresByCity.get(city.id) ?? [];
    const baseline = baselines.get(city.currency);
    const census = censusByCity.get(city.id) ?? { properties: [], source: null };

    const properties: HotelProperty[] = census.properties.map((property) => ({
      id: property.id,
      name: property.name,
      group: property.group,
      ...(property.starRating !== undefined ? { starRating: property.starRating } : {}),
    }));
    const propertyIds = new Set(properties.map((p) => p.id));

    for (const property of imported?.propertiesByCity.get(city.id) ?? []) {
      if (propertyIds.has(property.id)) continue;
      propertyIds.add(property.id);
      properties.push(property);
    }

    // Hotels that only ever appeared in a price: known by their source's identifier,
    // which is enough to attribute a sample and to count one vote in the median.
    for (const property of rateProperties.get(city.id) ?? []) {
      if (propertyIds.has(property.id)) continue;
      propertyIds.add(property.id);
      properties.push(property);
    }

    const importedComplete = imported?.completeCities.has(city.id) ?? false;
    const censusSource =
      [census.source, importedComplete ? "import" : null].filter(Boolean).join("+") ||
      null;

    /**
     * Coverage is only claimed when a property list really enumerates a universe: a
     * supplied census file, or an adapter that publishes one. Hotelbeds does not — it
     * returns the hotels with availability, not the city's inventory — so its cities
     * report the priced count without claiming what fraction of the city that is.
     */
    const censusComplete = census.properties.length > 0 || importedComplete;

    const usable = Boolean(baseline) && properties.length > 0;
    if (!baseline) {
      failures.push("no CNY conversion for this currency; city excluded");
    } else if (properties.length === 0) {
      failures.push("no properties or prices collected for this city; city excluded");
    } else {
      cities.push({
        cityId: city.id,
        currency: city.currency,
        baselineLocal: baseline!.baselineLocal,
        baselineAsOf: baseline!.asOf,
        properties: [...properties].sort((a, b) => a.id.localeCompare(b.id)),
        censusComplete,
        censusSource: censusSource ?? undefined,
        notes: `anchor ¥500 via ${baseline!.source}`,
      });
    }

    /** Adapter rates, attributed by census membership and checked for currency. */
    const citySamples: HotelPriceSample[] = [];
    for (const rate of adapterRates) {
      if (propertyCity.get(rate.propertyId) !== city.id) continue;
      if (!propertyIds.has(rate.propertyId)) {
        dropped.push(`${rate.propertyId} on ${rate.date}: not in ${city.id}'s census`);
        continue;
      }
      if (rate.currency !== city.currency) {
        dropped.push(
          `${rate.propertyId} on ${rate.date}: price in ${rate.currency}, city uses ${city.currency}`,
        );
        continue;
      }
      citySamples.push({
        date: rate.date,
        propertyId: rate.propertyId,
        priceLocal: rate.priceLocal,
        source: rate.source,
        collectedAt: rate.collectedAt,
        extraction: rate.extraction,
        ...(rate.note ? { note: rate.note } : {}),
      });
    }

    for (const sample of importedSamples) {
      if (propertyCity.get(sample.propertyId) !== city.id) continue;
      if (!propertyIds.has(sample.propertyId)) continue;
      citySamples.push(sample);
    }

    if (usable) samples.push(...citySamples);

    const propertyMedians = reduceToPropertyMedians(citySamples);
    cityReports.push({
      cityId: city.id,
      properties: properties.length,
      censusComplete,
      censusSource,
      samples: citySamples.length,
      medianLocal:
        propertyMedians.length > 0
          ? Math.round(median(propertyMedians.map((p) => p.medianLocal)))
          : null,
      sources: [...new Set(citySamples.map((s) => s.source))].sort(),
      failures,
    });
  }

  /**
   * The most restrictive disclosure any contributing source asked for. An explicit
   * `disclosure` on the plan wins, because the operator is the one who knows what
   * their agreement allows.
   */
  const disclosure: HotelDisclosure =
    plan.disclosure ??
    (plan.adapters.some((adapter) => adapter.defaultDisclosure === "index")
      ? "index"
      : "price");

  /**
   * One basis for the whole dataset, and the conservative reading of it: if any
   * contributing source cannot say its amounts include taxes, the dataset says they
   * do not.
   */
  const taxIncluded = !plan.adapters.some(
    (adapter) => adapter.fetchRates && adapter.taxIncluded === false,
  );

  return {
    dataset: toDataset({
      cities,
      samples,
      generatedAt,
      disclosure,
      basis: { ...DEFAULT_BASIS, taxIncluded },
    }),
    disclosure,
    cities: cityReports,
    requestsMade: context.requestsMade?.() ?? 0,
    dropped,
    sources: plan.adapters.map((a) => ({ name: a.name, label: a.label })),
    generatedAt,
  };
}
