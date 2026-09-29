/**
 * File ingest: prices and property lists from CSV.
 *
 * ## Why an importer is a first-class part of the crawler
 *
 * Hotelbeds covers the normal case, but a collector that can *only* call one API is
 * one outage away from having no data at all. Every other legitimate route to real
 * prices — a second partner API, a licensed feed, a manual collection the operator
 * performs under their own account — ends in a file. This module turns that file into
 * the same dataset the adapter writes, so the median, the disclosure and the scoring
 * model do not care where a price came from.
 *
 * ## Format
 *
 * Rates (`--import rates.csv`):
 *
 * ```csv
 * cityId,propertyId,propertyName,group,date,priceLocal,currency,source,collectedAt,extraction,note
 * tokyo,acme:00019,Example Hotel Tokyo,tokyo-hoteliers,2026-10-20,9800,JPY,acme-feed,2026-09-30T02:00:00Z,verified,
 * ```
 *
 * - `propertyName` and `group` are only used to create a census row the first
 *   time a property is seen, so a rates file alone is enough to start.
 * - `extraction` defaults to `inferred`. That is not pedantry: an imported price
 *   whose shape nobody validated should cost confidence in the median, exactly
 *   like an unverified scrape.
 *
 * Census (`--census census.csv`), optional but recommended:
 *
 * ```csv
 * cityId,propertyId,propertyName,group,starRating
 * tokyo,acme:00019,Example Hotel Tokyo,tokyo-hoteliers,3
 * ```
 *
 * Supplying a census asserts that it is the city's **complete** inventory, which
 * is what makes a coverage percentage meaningful. Without one, the collector
 * records the properties it has prices for and marks the census incomplete — the
 * reference price then declines to claim how much of the city it saw.
 */

import type { HotelPriceSample, HotelProperty } from "../hotel-dataset";

export interface CsvTable {
  header: string[];
  rows: Array<Record<string, string>>;
}

/**
 * A small RFC 4180 reader: quoted fields, embedded commas and newlines, CRLF.
 *
 * Written rather than imported because the shape needed here is one table with a
 * header — and because the alternative was a dependency for eighty lines of code.
 */
export function parseCsv(text: string): CsvTable {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const header = (rows.shift() ?? []).map((h) => h.trim());
  const out: Array<Record<string, string>> = [];
  for (const values of rows) {
    // Skip blank lines rather than inventing a row of empty strings.
    if (values.every((v) => v.trim() === "")) continue;
    const record: Record<string, string> = {};
    header.forEach((key, index) => {
      record[key] = (values[index] ?? "").trim();
    });
    out.push(record);
  }

  return { header, rows: out };
}

export interface ImportedRates {
  samples: HotelPriceSample[];
  /** Property rows discovered in the rates file, keyed by city. */
  propertiesByCity: Map<string, HotelProperty[]>;
  /** Rows that could not be used, with the reason. Never silently dropped. */
  errors: string[];
}

function requiredColumns(
  table: CsvTable,
  required: string[],
  where: string,
): string[] {
  const missing = required.filter((column) => !table.header.includes(column));
  return missing.map((column) => `${where}: missing column "${column}"`);
}

/**
 * Converts a rates table into samples.
 *
 * `currencyByCity` is the check that earns its keep: a JPY price in a KRW city is
 * a unit error, and a *median* is precisely the statistic that would hide it — the
 * number would look plausible and be wrong by a factor of forty.
 */
export function ratesFromCsv(
  text: string,
  where = "rates",
  options: { currencyByCity?: Map<string, string> } = {},
): ImportedRates {
  const table = parseCsv(text);
  const errors = requiredColumns(
    table,
    ["cityId", "propertyId", "date", "priceLocal"],
    where,
  );
  const samples: HotelPriceSample[] = [];
  const propertiesByCity = new Map<string, HotelProperty[]>();
  const seen = new Set<string>();

  if (errors.length > 0) return { samples, propertiesByCity, errors };

  table.rows.forEach((row, index) => {
    const line = `${where} row ${index + 2}`;
    const price = Number.parseFloat(row.priceLocal);
    if (!Number.isFinite(price) || price <= 0) {
      errors.push(`${line}: priceLocal "${row.priceLocal}" is not a positive number`);
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
      errors.push(`${line}: date "${row.date}" is not ISO (YYYY-MM-DD)`);
      return;
    }
    if (!row.propertyId) {
      errors.push(`${line}: propertyId is empty`);
      return;
    }
    if (!row.cityId) {
      errors.push(`${line}: cityId is empty`);
      return;
    }

    const expected = options.currencyByCity?.get(row.cityId);
    if (row.currency && expected && row.currency !== expected) {
      errors.push(
        `${line}: currency "${row.currency}" does not match ${row.cityId}'s ${expected}`,
      );
      return;
    }

    const extraction = row.extraction === "verified" ? "verified" : "inferred";
    if (row.extraction && row.extraction !== "verified" && row.extraction !== "inferred") {
      errors.push(`${line}: extraction "${row.extraction}" is not verified|inferred`);
      return;
    }

    samples.push({
      date: row.date,
      propertyId: row.propertyId,
      priceLocal: price,
      source: row.source || where,
      collectedAt: row.collectedAt || new Date().toISOString(),
      extraction,
      ...(row.note ? { note: row.note } : {}),
    });

    const key = `${row.cityId}|${row.propertyId}`;
    if (!seen.has(key)) {
      seen.add(key);
      const list = propertiesByCity.get(row.cityId) ?? [];
      list.push({
        id: row.propertyId,
        name: row.propertyName || row.propertyId,
        group: row.group || row.propertyId.split(":")[0] || "unknown",
      });
      propertiesByCity.set(row.cityId, list);
    }
  });

  return { samples, propertiesByCity, errors };
}

export interface ImportedCensus {
  propertiesByCity: Map<string, HotelProperty[]>;
  errors: string[];
}

/** Reads a complete property list. Supplying one asserts it is exhaustive. */
export function censusFromCsv(text: string, where = "census"): ImportedCensus {
  const table = parseCsv(text);
  const errors = requiredColumns(table, ["cityId", "propertyId"], where);
  const propertiesByCity = new Map<string, HotelProperty[]>();
  const seen = new Set<string>();

  if (errors.length > 0) return { propertiesByCity, errors };

  table.rows.forEach((row, index) => {
    const line = `${where} row ${index + 2}`;
    if (!row.propertyId) {
      errors.push(`${line}: propertyId is empty`);
      return;
    }
    const key = `${row.cityId}|${row.propertyId}`;
    if (seen.has(key)) return;
    seen.add(key);

    const star = Number.parseInt(row.starRating ?? "", 10);
    const list = propertiesByCity.get(row.cityId) ?? [];
    list.push({
      id: row.propertyId,
      name: row.propertyName || row.propertyId,
      group: row.group || row.propertyId.split(":")[0] || "unknown",
      // An absent rating stays absent: zero stars is a different claim.
      ...(Number.isFinite(star) && star > 0 ? { starRating: star } : {}),
    });
    propertiesByCity.set(row.cityId, list);
  });

  return { propertiesByCity, errors };
}

/** Parses a JSON array of rate objects, for sources that export JSON. */
export function ratesFromJson(text: string, where = "rates.json"): ImportedRates {
  const errors: string[] = [];
  const samples: HotelPriceSample[] = [];
  const propertiesByCity = new Map<string, HotelProperty[]>();

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { samples, propertiesByCity, errors: [`${where}: not JSON (${String(error)})`] };
  }
  if (!Array.isArray(parsed)) {
    return { samples, propertiesByCity, errors: [`${where}: expected an array of rates`] };
  }

  parsed.forEach((entry, index) => {
    const line = `${where}[${index}]`;
    if (typeof entry !== "object" || entry === null) {
      errors.push(`${line}: not an object`);
      return;
    }
    const row = entry as Record<string, unknown>;
    const price = Number(row.priceLocal ?? row.price);
    if (!Number.isFinite(price) || price <= 0) {
      errors.push(`${line}: priceLocal must be a positive number`);
      return;
    }
    const date = String(row.date ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      errors.push(`${line}: date must be ISO (YYYY-MM-DD)`);
      return;
    }
    const cityId = String(row.cityId ?? "");
    const propertyId = String(row.propertyId ?? "");
    if (!cityId || !propertyId) {
      errors.push(`${line}: cityId and propertyId are required`);
      return;
    }

    samples.push({
      date,
      propertyId,
      priceLocal: price,
      source: String(row.source ?? where),
      collectedAt: String(row.collectedAt ?? new Date().toISOString()),
      extraction: row.extraction === "verified" ? "verified" : "inferred",
      ...(row.note ? { note: String(row.note) } : {}),
    });

    const list = propertiesByCity.get(cityId) ?? [];
    if (!list.some((p) => p.id === propertyId)) {
      list.push({
        id: propertyId,
        name: String(row.propertyName ?? propertyId),
        group: String(row.group ?? propertyId.split(":")[0] ?? "unknown"),
      });
      propertiesByCity.set(cityId, list);
    }
  });

  return { samples, propertiesByCity, errors };
}
