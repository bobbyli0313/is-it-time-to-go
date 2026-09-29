"use client";

import type {
  Confidence,
  DimensionKey,
  DimensionScore,
} from "@/lib/scoring/types";
import type { Locale, Translator } from "@/lib/i18n";
import {
  BAND_STYLES,
  dimensionLabel,
  percent,
  relativeAge,
  scoreBand,
} from "@/lib/format";

const CONFIDENCE_STYLE: Record<Confidence, string> = {
  high: "bg-emerald-400/10 text-emerald-300 ring-emerald-400/25",
  medium: "bg-amber-400/10 text-amber-300 ring-amber-400/25",
  low: "bg-rose-400/10 text-rose-300 ring-rose-400/25",
};

/** Facts whose value is a count/percentage/amount needing locale formatting. */
const NUMERIC_FACTS = new Set([
  "tempC",
  "humidityPct",
  "precipProbabilityPct",
  "tempSpreadC",
  "humiditySpreadPct",
  "perNight",
  "baseline",
  "index",
  "sampleSize",
  "propertyUniverse",
  "percentile",
  "lookbackDays",
  "fareLocal",
  "theoreticalUsd",
  "ageHours",
  "fareToTheoreticalRatio",
  "historyMin",
  "historyMedian",
  "historyMax",
  "holidayPressureDays",
  "tripDays",
  "weekendDays",
  "holidayCount",
  "longestPeakRun",
  "nearbyHolidayDays",
  "yearLow",
  "yearHigh",
  "rangePct",
  "positionInRange",
  "indexPctVsBaseline",
]);

/**
 * Facts whose value is an ISO timestamp.
 *
 * The row label is `t("fact." + key)`, so every key a scorer emits must exist in
 * both dictionaries; `messages.test.ts` asserts exactly that by walking the facts.
 */
const TIME_FACTS = new Set(["fetchedAt", "asOf", "collectedAt"]);

/** Multiplier facts, rendered as "1.44x" rather than a bare number. */
const MULTIPLIER_FACTS = new Set(["holidayLift", "seasonalFactor"]);

function FactRow({
  factKey,
  value,
  locale,
  t,
}: {
  factKey: string;
  value: string | number;
  locale: Locale;
  t: Translator;
}) {
  let rendered: string;

  if (TIME_FACTS.has(factKey)) {
    rendered = relativeAge(String(value), t);
  } else if (MULTIPLIER_FACTS.has(factKey) && typeof value === "number") {
    rendered = `${new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US", {
      maximumFractionDigits: 2,
    }).format(value)}x`;
  } else if (factKey === "holidayDates") {
    // Already a comma-joined ISO list; keep it terse.
    rendered = String(value).split(",").join(" · ");
  } else if (NUMERIC_FACTS.has(factKey)) {
    rendered =
      typeof value === "number"
        ? new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US", {
            maximumFractionDigits: 2,
          }).format(value)
        : String(value);
  } else {
    rendered = String(value);
  }

  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="shrink-0 text-xs text-slate-500">{t(`fact.${factKey}`)}</dt>
      <dd className="text-right text-xs font-medium tabular-nums text-slate-200">
        {rendered}
      </dd>
    </div>
  );
}

/** Maps a raw fact value onto an i18n key, e.g. `forecast` -> `weather.basis.forecast`. */
function basisKey(dimension: DimensionKey, value: string): string | null {
  if (dimension === "weather") return `weather.basis.${value}`;
  if (dimension === "hotel") return `hotel.basis.${value}`;
  if (dimension === "flight") return `flight.basis.${value}`;
  return null;
}

function formatFactValue(
  dimension: DimensionKey,
  factKey: string,
  value: string | number,
  locale: Locale,
  t: Translator,
): string | number {
  if (factKey === "basis" && typeof value === "string") {
    const key = basisKey(dimension, value);
    if (key) return t(key);
  }
  if (factKey === "percentile" && typeof value === "number") {
    return percent(value, locale);
  }
  if (factKey === "disclaimer" && typeof value === "string") {
    return t(value);
  }
  if (factKey === "disclosure" && typeof value === "string") {
    return t(`hotel.disclosure.${value}`);
  }
  /**
   * The index-only figure is a signed distance from the anchor, not a level: "+64%"
   * reads correctly where "64" would look like a price.
   */
  if (factKey === "indexPctVsBaseline" && typeof value === "number") {
    return `${value > 0 ? "+" : ""}${new Intl.NumberFormat("en-US", {
      maximumFractionDigits: 1,
    }).format(value)}%`;
  }
  if (factKey === "unavailable" || factKey === "reason") {
    return typeof value === "string" ? value : String(value);
  }
  return value;
}

export function DimensionCard({
  dimension,
  locale,
  t,
}: {
  dimension: DimensionScore;
  locale: Locale;
  t: Translator;
}) {
  const notApplicable = !dimension.applicable || dimension.score === null;
  const band = notApplicable ? null : BAND_STYLES[scoreBand(dimension.score!)];
  const confidenceStyle = notApplicable
    ? "bg-white/5 text-slate-400 ring-white/10"
    : CONFIDENCE_STYLE[dimension.confidence];

  // Order matters: show provenance before numbers.
  const factEntries = Object.entries(dimension.facts);

  return (
    <article className="flex flex-col rounded-xl bg-white/[0.03] p-4 ring-1 ring-white/10">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-white">
            {dimensionLabel(dimension.key, t)}
          </h3>
          <span
            className={`mt-1.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ${confidenceStyle}`}
          >
            {notApplicable
              ? t("confidence.notApplicable")
              : t(`confidence.${dimension.confidence}`)}
          </span>
        </div>

        <div className="text-right">
          {notApplicable ? (
            <span className="text-2xl font-bold text-slate-600">—</span>
          ) : (
            <span className={`text-3xl font-bold tabular-nums ${band!.text}`}>
              {Math.round(dimension.score!)}
            </span>
          )}
        </div>
      </header>

      {!notApplicable ? (
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/5">
          <div
            className={`h-full rounded-full ${band!.bar} transition-[width] duration-700`}
            style={{ width: `${Math.max(0, Math.min(100, dimension.score!))}%` }}
          />
        </div>
      ) : null}

      <ul className="mt-3.5 flex-1 space-y-1.5">
        {dimension.drivers.map((key) => (
          <li key={key} className="flex gap-2 text-xs leading-relaxed text-slate-300">
            <span aria-hidden className="mt-0.5 text-slate-600">
              •
            </span>
            <span>{t(key)}</span>
          </li>
        ))}
      </ul>

      {factEntries.length > 0 ? (
        <details className="mt-3 border-t border-white/10 pt-2.5">
          <summary className="cursor-pointer text-[11px] text-slate-500 select-none hover:text-slate-300">
            {t("result.factDetails")}
          </summary>
          <dl className="mt-2">
            {factEntries.map(([key, value]) => (
              <FactRow
                key={key}
                factKey={key}
                value={formatFactValue(dimension.key, key, value, locale, t)}
                locale={locale}
                t={t}
              />
            ))}
          </dl>
        </details>
      ) : null}
    </article>
  );
}
