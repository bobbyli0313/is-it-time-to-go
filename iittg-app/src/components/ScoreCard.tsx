"use client";

import type { DimensionKey, ScoreResult } from "@/lib/scoring/types";
import type { DataProvenance } from "@/lib/data/types";
import type { Locale, Translator } from "@/lib/i18n";
import {
  BAND_STYLES,
  dimensionLabel,
  isCapped,
  scoreBand,
} from "@/lib/format";

/**
 * Provenance is keyed by *data source* while the cards are keyed by *dimension*,
 * and the two do not correspond one-to-one: the crowding dimension is derived from
 * the holiday calendar rather than fetched. The mapping is therefore explicit rather
 * than assumed, with `holidays` shown against the crowding row it feeds.
 * Each value resolves to an i18n key as `source.<field>.<value>`.
 */
const SOURCE_DIMENSION: Array<{
  source: keyof DataProvenance;
  dimension: DimensionKey;
}> = [
  { source: "weather", dimension: "weather" },
  { source: "hotel", dimension: "hotel" },
  { source: "flight", dimension: "flight" },
  { source: "holidays", dimension: "crowd" },
  { source: "fx", dimension: "fx" },
];

/** Circular gauge for the overall score. Pure SVG, no chart dependency. */
function Gauge({ value, label }: { value: number; label: string }) {
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const dash = (Math.max(0, Math.min(100, value)) / 100) * circumference;
  const band = BAND_STYLES[scoreBand(value)];

  return (
    <div className="relative h-36 w-36 shrink-0">
      <svg viewBox="0 0 128 128" className="h-full w-full -rotate-90">
        <circle
          cx="64"
          cy="64"
          r={radius}
          fill="none"
          strokeWidth="10"
          className="stroke-white/10"
        />
        <circle
          cx="64"
          cy="64"
          r={radius}
          fill="none"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference - dash}`}
          className={`${band.ring} transition-[stroke-dasharray] duration-700`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`text-4xl font-bold tabular-nums ${band.text}`}>
          {Math.round(value)}
        </span>
        <span className="text-[11px] text-slate-500">{label}</span>
      </div>
    </div>
  );
}

export function ScoreCard({
  result,
  routeLabel,
  dateLabel,
  dataNotes,
  provenance,
  locale,
  t,
  onReset,
}: {
  result: ScoreResult;
  routeLabel: string;
  dateLabel: string;
  dataNotes: string[];
  provenance: DataProvenance;
  locale: Locale;
  t: Translator;
  onReset: () => void;
}) {
  const band = BAND_STYLES[scoreBand(result.total)];
  const capped = isCapped(result);
  const dimensionsByKey = new Map(
    result.dimensions.map((d) => [d.key, d] as const),
  );

  return (
    <section
      aria-live="polite"
      className="rounded-2xl bg-white/[0.03] p-5 ring-1 ring-white/10 sm:p-6"
    >
      <div className="flex flex-wrap items-center gap-6">
        <Gauge value={result.total} label={t("result.outOf")} />

        <div className="min-w-56 flex-1">
          <h2 className="text-lg font-semibold text-white">{routeLabel}</h2>
          <p className="mt-0.5 text-sm text-slate-400">
            {dateLabel} · {t("result.days", { days: result.tripDays })}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${band.chip}`}
            >
              {result.attribution.length > 0
                ? `${dimensionLabel(result.attribution[0].key, t)} · ${t(
                    "result.pointsLost",
                    { points: result.attribution[0].pointsLost },
                  )}`
                : t("result.attributionNone")}
            </span>
            <button
              type="button"
              onClick={onReset}
              className="rounded-full bg-white/5 px-2.5 py-1 text-xs text-slate-300 ring-1 ring-white/10 transition hover:text-white"
            >
              {t("result.reset")}
            </button>
          </div>

          {capped ? (
            <p className="mt-3 rounded-lg bg-rose-400/10 px-3 py-2 text-xs text-rose-200 ring-1 ring-rose-400/20">
              {t("result.cappedBy", {
                cap: 60,
                dimension: dimensionLabel(result.cappedBy!, t),
              })}
            </p>
          ) : null}
        </div>
      </div>

      {/* Attribution */}
      <div className="mt-6 border-t border-white/10 pt-5">
        <h3 className="text-xs font-semibold tracking-wide text-slate-400 uppercase">
          {t("result.attributionHeading")}
        </h3>
        {result.attribution.length === 0 ? (
          <p className="mt-2 text-sm text-slate-400">
            {t("result.attributionNone")}
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {result.attribution.slice(0, 3).map((a) => {
              const dimension = dimensionsByKey.get(a.key);
              const width = Math.min(100, (a.pointsLost / 20) * 100);
              return (
                <li key={a.key} className="flex items-center gap-3">
                  <span className="w-28 shrink-0 text-sm text-slate-300">
                    {dimensionLabel(a.key, t)}
                  </span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/5">
                    <span
                      className={`block h-full rounded-full ${BAND_STYLES.poor.bar}`}
                      style={{ width: `${width}%` }}
                    />
                  </span>
                  <span className="w-16 shrink-0 text-right text-xs tabular-nums text-slate-400">
                    −{a.pointsLost}
                  </span>
                  <span className="hidden w-10 shrink-0 text-right text-xs tabular-nums text-slate-500 sm:block">
                    {dimension?.score === null || dimension?.score === undefined
                      ? "—"
                      : Math.round(dimension.score)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* The aggregation is not a plain average, so say so and show both. */}
      <details className="mt-5 rounded-lg bg-white/[0.02] px-3 py-2 ring-1 ring-white/5">
        <summary className="cursor-pointer text-xs text-slate-400 select-none">
          {t("result.arithmeticComparison")}: {result.arithmeticMean}
        </summary>
        <p className="mt-2 text-xs leading-relaxed text-slate-400">
          {t("result.bothAverages")}
        </p>
      </details>

      {/*
        Provenance. Stated per dimension rather than as one blanket claim, because
        a partially-integrated deployment is a normal state: weather, holidays and
        FX can be live while fare and hotel pricing are still sample data. A single
        "live data" badge would be actively misleading.
      */}
      <details className="mt-2 rounded-lg bg-white/[0.02] px-3 py-2 ring-1 ring-white/5">
        <summary className="cursor-pointer text-xs text-slate-400 select-none">
          {t("result.dataSources")}
        </summary>
        <dl className="mt-2 space-y-1">
          {SOURCE_DIMENSION.map(({ source: field, dimension }) => {
            const value = provenance[field];
            return (
              <div key={field} className="flex items-baseline justify-between gap-3">
                <dt className="text-xs text-slate-500">
                  {t(`dimension.${dimension}`)}
                </dt>
                <dd
                  className={`text-right text-xs font-medium ${
                    value.startsWith("live")
                      ? "text-emerald-300"
                      : value === "not-applicable"
                        ? "text-slate-500"
                        : "text-amber-300"
                  }`}
                >
                  {t(`source.${field}.${value}`)}
                </dd>
              </div>
            );
          })}
        </dl>
      </details>

      {[...result.warnings, ...dataNotes].length > 0 ? (
        <ul className="mt-4 space-y-1.5">
          {[...new Set([...result.warnings, ...dataNotes])].map((key) => (
            <li
              key={key}
              className="flex gap-2 text-xs leading-relaxed text-amber-200/80"
            >
              <span aria-hidden className="text-amber-400/70">
                ⚠
              </span>
              <span>{t(key)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
