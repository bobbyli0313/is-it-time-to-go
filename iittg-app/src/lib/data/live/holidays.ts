/**
 * Live public holidays via Nager.Date (date.nager.at), which needs no API key.
 *
 * ## Why this file has a hand-maintained table in it
 *
 * Nager.Date returns one class per holiday — `Public` — for every country. That is
 * enough to know *whether* a day is a holiday, but not *how disruptive* it is. A
 * single bank holiday Monday and Japan's Golden Week both arrive as a run of
 * `Public` entries, and the crowding model weights them very differently
 * (`peak` 1.5 vs `normal` 1.0) because their effect on prices and crowds differs
 * by far more than 50%.
 *
 * Inferring intensity from clustering was considered and rejected: it works for
 * Golden Week (four consecutive holidays) but is wrong for Chinese New Year and
 * Obon, which are the two biggest travel periods in the launch markets and are
 * poorly represented in the source data at all (Obon is not a statutory holiday in
 * Japan, so Nager.Date does not list it).
 *
 * So: the live API is the source of truth for *coverage* — it knows every country
 * and every year without maintenance — and a small curated table promotes the known
 * peak periods. The table is deliberately narrow, and anything it misses degrades
 * to `normal`, which understates crowding rather than inventing it.
 */

import type { CountryCode, Holiday, HolidayWeight } from "../../scoring/types";
import { TTL, remember } from "../cache";
import { fetchJson } from "../http";

const BASE_URL = "https://date.nager.at/api/v3/PublicHolidays";

export class HolidayUpstreamError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "HolidayUpstreamError";
  }
}

interface NagerHoliday {
  date: string;
  localName: string;
  name: string;
  countryCode: string;
  global?: boolean;
  counties?: string[] | null;
  types?: string[];
}

/* --------------------------------------------------------- peak periods */

interface PeakPeriod {
  /** Inclusive ISO date range, month/day matching is by prefix. */
  from: string;
  to: string;
  name: { en: string; zh: string };
  /**
   * True when the period is a travel peak in this country even though the days are
   * not statutory holidays, so the entry must be *added* rather than only used to
   * re-weight existing days.
   */
  additive?: boolean;
  /** Country whose calendar the period belongs to. */
  country: CountryCode;
}

/**
 * Curated peak travel periods for the launch scope. Each entry is a documented,
 * recurring high-demand window in its market.
 *
 * Only the years actually reachable through the app's 30-day departure window need
 * to be covered; entries are matched by month/day so a single row per year is
 * enough. Extending coverage means adding rows, and a missing row degrades to
 * `normal` rather than breaking.
 */
const PEAK_PERIODS: PeakPeriod[] = [
  // China — Spring Festival (statutory days plus the travel shoulders).
  { country: "CN", from: "2026-02-15", to: "2026-02-23", name: { en: "Spring Festival travel period", zh: "春节假期" } },
  // China — Labour Day.
  { country: "CN", from: "2026-05-01", to: "2026-05-05", name: { en: "Labour Day holiday", zh: "劳动节假期" } },
  // China — National Day / Golden Week.
  { country: "CN", from: "2026-10-01", to: "2026-10-07", name: { en: "National Day Golden Week", zh: "国庆黄金周" } },
  /**
   * Japan — Golden Week. Split deliberately into two rows.
   *
   * The statutory days (Shōwa Day, Greenery Day, Children's Day, and the substitute
   * holiday when one is needed) are re-weighted here, and the source supplies them.
   * No date is *invented*: in 2026, 3 May falls on a Sunday and the observed
   * substitute is 6 May, which is what Nager.Date reports. Hardcoding 1-6 May as
   * holidays would have fabricated 1, 2 and 3 May.
   */
  { country: "JP", from: "2026-04-29", to: "2026-05-06", name: { en: "Golden Week", zh: "黄金周" } },
  /**
   * ...and the travel shoulder, which is not statutory but is when most of the
   * country actually travels, so it is added rather than only re-weighted.
   */
  { country: "JP", from: "2026-05-01", to: "2026-05-03", name: { en: "Golden Week travel period", zh: "黄金周出行期" }, additive: true },
  /**
   * Japan — Obon. Not a statutory holiday, so Nager.Date does not list it, yet it
   * is one of the two busiest domestic travel periods of the year. Marked additive
   * so those days are counted at all.
   */
  { country: "JP", from: "2026-08-13", to: "2026-08-16", name: { en: "Obon", zh: "盂兰盆节" }, additive: true },
  // Korea — Seollal and Chuseok, the two multi-day travel peaks.
  { country: "KR", from: "2026-02-16", to: "2026-02-18", name: { en: "Seollal", zh: "春节" } },
  { country: "KR", from: "2026-09-24", to: "2026-09-26", name: { en: "Chuseok", zh: "秋收节" } },
  // Thailand — Songkran is the largest domestic travel period of the year.
  { country: "TH", from: "2026-04-13", to: "2026-04-15", name: { en: "Songkran", zh: "泼水节" } },
  { country: "TH", from: "2026-12-31", to: "2027-01-02", name: { en: "New Year period", zh: "跨年假期" } },
  // Taiwan — Lunar New Year.
  { country: "TW", from: "2026-02-16", to: "2026-02-21", name: { en: "Lunar New Year", zh: "农历新年" } },
  // Vietnam — Tet.
  { country: "VN", from: "2026-02-16", to: "2026-02-20", name: { en: "Tet", zh: "春节" } },
  // Indonesia / Malaysia / Singapore — shared Lunar New Year peak.
  { country: "SG", from: "2026-02-17", to: "2026-02-18", name: { en: "Chinese New Year", zh: "农历新年" } },
  { country: "MY", from: "2026-02-17", to: "2026-02-18", name: { en: "Chinese New Year", zh: "农历新年" } },
  { country: "ID", from: "2026-03-19", to: "2026-03-22", name: { en: "Nyepi period", zh: "静居日假期" } },
  // Philippines — Holy Week is the main domestic travel peak.
  { country: "PH", from: "2026-04-02", to: "2026-04-05", name: { en: "Holy Week", zh: "圣周" } },
  { country: "PH", from: "2026-12-24", to: "2026-12-31", name: { en: "Christmas season", zh: "圣诞假期" } },
  // Hong Kong.
  { country: "HK", from: "2026-02-17", to: "2026-02-19", name: { en: "Lunar New Year", zh: "农历新年" } },
];

function inPeriod(date: string, period: PeakPeriod): boolean {
  return date >= period.from && date <= period.to;
}

function periodsFor(country: CountryCode, date: string): PeakPeriod[] {
  return PEAK_PERIODS.filter((p) => p.country === country && inPeriod(date, p));
}

/** Public holidays are `normal`; a covering peak period promotes them. */
export function classifyWeight(
  country: CountryCode,
  date: string,
): HolidayWeight {
  return periodsFor(country, date).length > 0 ? "peak" : "normal";
}

/* ------------------------------------------------------------ fetching */

/** Which Nager `types` count as a day most people have off. */
const CLOSED_TYPES = new Set(["Public", "Bank", "Authorities", "School"]);

function normalize(
  entries: NagerHoliday[],
  country: CountryCode,
): Holiday[] {
  const out: Holiday[] = [];

  for (const entry of entries) {
    // Regional holidays (e.g. a single state's founding day) are not national
    // crowding events, so they are excluded rather than over-counted.
    if (entry.global === false) continue;

    const types: string[] = entry.types ?? ["Public"];
    const isClosed = types.some((t) => CLOSED_TYPES.has(t));
    // Observance-only entries are commemorations, not days off.
    if (!isClosed) continue;

    out.push({
      date: entry.date,
      country,
      name: { en: entry.name, zh: entry.localName },
      weight: classifyWeight(country, entry.date),
    });
  }

  /**
   * Additive peak periods: days inside a known travel peak that the source does not
   * list as holidays, most importantly Japan's Obon. Without these the model would
   * report zero crowding during one of the busiest weeks of the Japanese year.
   */
  const covered = new Set(out.map((h) => h.date));
  const years = new Set(entries.map((h) => h.date.slice(0, 4)));
  for (const year of years) {
    for (const period of PEAK_PERIODS) {
      if (period.country !== country || !period.additive) continue;
      const from = period.from.replace(/^\d{4}/, year);
      const to = period.to.replace(/^\d{4}/, year);
      for (let d = from; d <= to; d = nextDay(d)) {
        if (covered.has(d)) continue;
        out.push({
          date: d,
          country,
          name: period.name,
          weight: "peak",
        });
      }
    }
  }

  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

function nextDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function fetchYear(
  country: CountryCode,
  year: number,
): Promise<Holiday[]> {
  const url = `${BASE_URL}/${year}/${encodeURIComponent(country)}`;

  /**
   * `emptyOnStatus: 404` because Nager.Date answers 404 for a country/year it does
   * not cover. That is a coverage gap rather than a failure, and conflating the two
   * would either crash scoring or silently report "no holidays".
   */
  const body = await fetchJson<NagerHoliday[]>(url, {
    timeoutMs: 8_000,
    attempts: 3,
    emptyOnStatus: 404,
  });

  if (body === null) return [];
  return Array.isArray(body) ? normalize(body, country) : [];
}

/**
 * Holidays for a country across the inclusive date range, spanning year boundaries
 * as needed.
 */
export async function fetchLiveHolidays(
  country: CountryCode,
  from: string,
  to: string,
): Promise<{ holidays: Holiday[]; coverageComplete: boolean }> {
  const firstYear = Number(from.slice(0, 4));
  const lastYear = Number(to.slice(0, 4));
  const years: number[] = [];
  for (let y = firstYear; y <= lastYear; y += 1) years.push(y);

  /**
   * A holiday outage degrades to an empty calendar flagged as incomplete, rather
   * than failing the request. The crowding dimension is a proxy built on this data,
   * so losing it should cost one dimension's accuracy — not the whole score. The
   * `coverageComplete: false` flag is what stops the gap from being mistaken for
   * "no holidays", which would silently *improve* the crowding score.
   */
  let perYear: Holiday[][];
  try {
    perYear = await Promise.all(
      years.map((year) =>
        remember(`holidays:${country}:${year}`, () => fetchYear(country, year), {
          ttlMs: TTL.holidays,
          staleOnError: true,
        }),
      ),
    );
  } catch {
    return { holidays: [], coverageComplete: false };
  }

  const all = perYear.flat();
  const holidays = all.filter((h) => h.date >= from && h.date <= to);

  /**
   * Coverage is only complete if every requested year actually returned data. An
   * empty year is ambiguous — it could mean "no holidays" or "no data" — and
   * treating it as covered would let a source gap silently *improve* the crowding
   * score. No real country in scope has zero public holidays in a year, so an empty
   * result is always a gap.
   */
  const coverageComplete = perYear.every((yearHolidays) => yearHolidays.length > 0);

  return { holidays, coverageComplete };
}

/** Exported for tests. */
export const internals = {
  normalize,
  classifyWeight,
  inPeriod,
  PEAK_PERIODS,
};
