/**
 * A configurable JSON rate adapter.
 *
 * ## Why this exists instead of ten hand-written scrapers
 *
 * Hotelbeds covers the price collection. This adapter is the escape hatch for a
 * *second* source the operator is entitled to call — another partner API, a licensed
 * feed, or an export from an account they hold — without writing an adapter for it.
 * The work such a source needs is mapping its response, not building a crawler, so
 * the mapping is configuration and the collector keeps doing everything around it:
 * robots, pacing, budget, validation, dedup and the median.
 *
 * ## Configuration
 *
 * ```jsonc
 * {
 *   "id": "acme-rates",
 *   "label": "ACME partner rate feed",
 *   "extraction": "verified",          // "inferred" if you have not validated it
 *   "request": {
 *     "urlTemplate": "https://api.acme.test/rates?hotel={propertyId}&date={date}&adults={adults}&rooms={rooms}",
 *     "method": "GET",
 *     "headers": { "Authorization": "Bearer ${ACME_TOKEN}" },
 *     "session": true                  // forward the operator's browser cookies
 *   },
 *   "response": {
 *     "ratesPath": "data.rates",       // dot path to the array of rate objects
 *     "pricePath": "amount",
 *     "currencyPath": "currency",
 *     "propertyPath": "hotelId",
 *     "datePath": "date",
 *     "taxIncludedPath": "taxesIncluded"
 *   },
 *   "notes": "Contracted 2026-10; two-night minimum on weekends."
 * }
 * ```
 *
 * `${VAR}` is read from the environment, so a token never has to sit in the
 * config file. A `custom:` source is trusted exactly as far as the operator's
 * `extraction` claim: `verified` samples count as verified, and `inferred` ones
 * cost confidence in the reference price the same way an unverified scrape does.
 */

import type {
  CollectFailure,
  CollectOutcome,
  CollectorAdapter,
  CollectorContext,
  HotelPropertyRef,
  RateQuery,
  RawRate,
} from "../types";
import { collected, failed } from "../types";
import { refusalOf } from "../http";

export interface HttpJsonSourceConfig {
  id: string;
  label: string;
  extraction: "verified" | "inferred";
  request: {
    urlTemplate: string;
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    /** Forward the operator-supplied browser session's cookies. */
    session?: boolean;
    /** Body for POST sources; supports the same placeholders as the URL. */
    bodyTemplate?: string;
  };
  response: {
    /** Dot path to the array of rate objects. Empty means the root is the array. */
    ratesPath?: string;
    pricePath: string;
    currencyPath?: string;
    propertyPath?: string;
    datePath?: string;
    taxIncludedPath?: string;
  };
  notes?: string;
}

export type ConfigParseResult =
  | { ok: true; config: HttpJsonSourceConfig }
  | { ok: false; errors: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Validates a source config, collecting every problem.
 *
 * A misconfigured source is the most likely failure an operator will hit, and
 * "pricePath is required" beats a runtime `undefined` from deep inside a
 * traversal.
 */
export function parseSourceConfig(value: unknown, where = "source"): ConfigParseResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: [`${where}: not an object`] };

  const id = value.id;
  const label = value.label;
  if (typeof id !== "string" || id.trim() === "") {
    errors.push(`${where}.id: required, non-empty string`);
  }
  if (typeof label !== "string" || label.trim() === "") {
    errors.push(`${where}.label: required, non-empty string`);
  }

  const extraction = value.extraction ?? "inferred";
  if (extraction !== "verified" && extraction !== "inferred") {
    errors.push(`${where}.extraction: must be "verified" or "inferred"`);
  }

  const request = value.request;
  if (!isRecord(request)) {
    errors.push(`${where}.request: required object`);
  } else {
    if (typeof request.urlTemplate !== "string" || request.urlTemplate === "") {
      errors.push(`${where}.request.urlTemplate: required`);
    }
    if (request.method !== undefined && request.method !== "GET" && request.method !== "POST") {
      errors.push(`${where}.request.method: must be "GET" or "POST"`);
    }
    if (request.headers !== undefined && !isRecord(request.headers)) {
      errors.push(`${where}.request.headers: must be an object of strings`);
    }
  }

  const response = value.response;
  if (!isRecord(response)) {
    errors.push(`${where}.response: required object`);
  } else if (typeof response.pricePath !== "string" || response.pricePath === "") {
    errors.push(`${where}.response.pricePath: required (dot path to the amount)`);
  }

  if (errors.length > 0) return { ok: false, errors };

  const req = request as Record<string, unknown>;
  const res = response as Record<string, unknown>;
  return {
    ok: true,
    config: {
      id: id as string,
      label: label as string,
      extraction: extraction as "verified" | "inferred",
      request: {
        urlTemplate: req.urlTemplate as string,
        method: (req.method as "GET" | "POST" | undefined) ?? "GET",
        headers: (req.headers as Record<string, string> | undefined) ?? {},
        session: req.session === true,
        bodyTemplate: req.bodyTemplate as string | undefined,
      },
      response: {
        ratesPath: res.ratesPath as string | undefined,
        pricePath: res.pricePath as string,
        currencyPath: res.currencyPath as string | undefined,
        propertyPath: res.propertyPath as string | undefined,
        datePath: res.datePath as string | undefined,
        taxIncludedPath: res.taxIncludedPath as string | undefined,
      },
      notes: value.notes as string | undefined,
    },
  };
}

/**
 * Reads a dot path out of a parsed JSON value.
 *
 * Numbers in the path index arrays (`data.rates.0.amount`). Deliberately tiny:
 * a full JSONPath implementation would be more configuration than the sources
 * need, and every feature added here is a feature that has to be documented
 * before an operator can use it.
 */
export function readPath(value: unknown, path: string): unknown {
  if (path === "") return value;
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
    } else if (isRecord(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

/** Substitutes `{placeholders}` and `${ENV_VARS}`; env vars may be absent. */
export function interpolate(
  template: string,
  values: Record<string, string>,
): string {
  return template
    .replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => process.env[name] ?? "")
    .replace(/\{([a-zA-Z]+)\}/g, (match, name: string) =>
      values[name] !== undefined ? encodeURIComponent(values[name]) : match,
    );
}

/**
 * Pulls a positive amount out of one rate record.
 *
 * Accepts a number or a numeric string — partner APIs are inconsistent about
 * this, and `"128.50"` is a price. Anything else is a failure, not a zero.
 */
export function readAmount(record: unknown, pricePath: string): number | null {
  const raw = readPath(record, pricePath);
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : null;
  if (typeof raw === "string") {
    const parsed = Number.parseFloat(raw.replace(/[^0-9.]/g, ""));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

export function createHttpJsonAdapter(config: HttpJsonSourceConfig): CollectorAdapter {
  return {
    name: `custom:${config.id}`,
    label: config.label,

    async fetchRates(
      queries: RateQuery[],
      ctx: CollectorContext,
    ): Promise<CollectOutcome<RawRate[]>> {
      if (config.request.session && !ctx.session) {
        return failed({
          kind: "skipped",
          reason: `${config.label} is configured to use a browser session, but none was supplied`,
        });
      }

      /**
       * This adapter asks a source about *named* properties, so a query without one
       * cannot be turned into a request. That happens when a city has no property list
       * at all, which is a configuration problem rather than a source failure, and is
       * reported as such on the first query.
       */
      const missingProperty = queries.find((query) => !query.property);
      if (missingProperty) {
        return failed({
          kind: "skipped",
          reason: `${config.label} is configured per property, but ${missingProperty.cityId} has no property list to ask about`,
        });
      }

      const rates: RawRate[] = [];
      const failures: string[] = [];
      /**
       * Typed failures are kept alongside the strings so the *classification*
       * survives: "Akamai blocked us" and "your pricePath is wrong" call for
       * completely different responses from an operator, and collapsing both into
       * a parse error would hide which one happened.
       */
      const refusals: CollectFailure[] = [];

      for (const query of queries) {
        const property = query.property as HotelPropertyRef;
        const values = {
          propertyId: property.id,
          propertyCode: property.id.split(":").pop() ?? property.id,
          cityId: query.cityId,
          date: query.date,
          adults: "2",
          rooms: "1",
        };
        const url = interpolate(config.request.urlTemplate, values);

        const permission = await ctx.robots.check(url);
        if (!permission.allowed) {
          const failure: CollectFailure = {
            kind: "robots-disallowed",
            rule: permission.rule,
            path: new URL(url).pathname,
          };
          refusals.push(failure);
          failures.push(`${url}: ${permission.rule}`);
          continue;
        }

        const headers: Record<string, string> = {
          Accept: "application/json",
          ...Object.fromEntries(
            Object.entries(config.request.headers ?? {}).map(([k, v]) => [
              k,
              interpolate(v, values),
            ]),
          ),
          ...(config.request.session && ctx.session
            ? { Cookie: ctx.session.cookies, ...(ctx.session.headers ?? {}) }
            : {}),
        };

        const response = await ctx.fetchFn({
          url,
          method: config.request.method ?? "GET",
          headers,
          body: config.request.bodyTemplate
            ? interpolate(config.request.bodyTemplate, values)
            : undefined,
        });

        const refusal = refusalOf(response);
        if (refusal) {
          refusals.push(refusal);
          failures.push(
            `${url}: ${refusal.kind === "blocked" ? `blocked by ${refusal.by}` : JSON.stringify(refusal)}`,
          );
          continue;
        }

        let payload: unknown;
        try {
          payload = JSON.parse(response.body);
        } catch (error) {
          failures.push(`${url}: not JSON (${String(error)})`);
          continue;
        }

        const rows = readPath(payload, config.response.ratesPath ?? "");
        if (!Array.isArray(rows)) {
          failures.push(
            `${url}: no array at response.ratesPath "${config.response.ratesPath ?? "<root>"}"`,
          );
          continue;
        }

        for (const row of rows) {
          const amount = readAmount(row, config.response.pricePath);
          if (amount === null) continue;
          const propertyId =
            (readPath(row, config.response.propertyPath ?? "") as string | undefined) ??
            property.id;
          const date =
            (readPath(row, config.response.datePath ?? "") as string | undefined) ??
            query.date;
          rates.push({
            propertyId: propertyId.includes(":")
              ? propertyId
              : `${property.group}:${propertyId}`,
            cityId: query.cityId,
            date: String(date).slice(0, 10),
            priceLocal: amount,
            currency:
              (readPath(row, config.response.currencyPath ?? "") as string | undefined) ??
              "XXX",
            source: `custom:${config.id}`,
            collectedAt: ctx.now.toISOString(),
            extraction: config.extraction,
            note: config.notes,
          });
        }
      }

      if (rates.length === 0) {
        // Prefer the structured refusal: it names the cause. Only when every query
        // reached the source and still yielded nothing is this a mapping problem.
        const firstRefusal = refusals[0];
        if (firstRefusal) return failed(firstRefusal);
        return failed({
          kind: "parse-error",
          detail:
            failures.length > 0
              ? failures.slice(0, 5).join(" | ")
              : "no rate rows matched the configured paths",
        });
      }

      ctx.log(
        `  ${config.label}: ${rates.length} rates${failures.length > 0 ? `, ${failures.length} queries failed` : ""}`,
      );
      return collected(rates);
    },
  };
}
