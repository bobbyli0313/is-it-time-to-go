/**
 * Presentation-only formatting helpers.
 *
 * Kept separate from `scoring/dates.ts`, which is about *calendar arithmetic* and
 * must stay free of locale concerns.
 */

import type { DimensionKey, ScoreResult } from "./scoring/types";
import { addDays } from "./scoring/dates";
import { formatNumber, type Locale, type Translator } from "./i18n";

/** Localised city name. */
export function cityName(
  city: { name: { en: string; zh: string } },
  locale: Locale,
): string {
  return city.name[locale];
}

/** "Sep 25, Fri" / "9月25日 周五" */
export function shortDate(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
    weekday: "short",
    timeZone: "UTC",
  }).format(new Date(`${iso}T00:00:00Z`));
}

/** "Sep 25 – Sep 30, 2026" / "2026年9月25日 – 9月30日" */
export function dateRange(
  from: string,
  to: string,
  locale: Locale,
): string {
  const tag = locale === "zh" ? "zh-CN" : "en-US";
  const fmt = new Intl.DateTimeFormat(tag, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  const yearFmt = new Intl.DateTimeFormat(tag, {
    year: "numeric",
    timeZone: "UTC",
  });
  const fromDate = new Date(`${from}T00:00:00Z`);
  const toDate = new Date(`${to}T00:00:00Z`);
  return `${fmt.format(fromDate)} – ${fmt.format(toDate)}, ${yearFmt.format(toDate)}`;
}

/** Money with the right currency symbol and sensible rounding. */
export function money(
  amount: number,
  currency: string,
  locale: Locale,
): string {
  const zeroDecimal = ["JPY", "KRW", "IDR", "VND", "TWD"].includes(currency);
  try {
    return new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: zeroDecimal ? 0 : 2,
      minimumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${formatNumber(amount, locale)} ${currency}`;
  }
}

/** "3h ago" / "3 小时前" from an ISO timestamp. */
export function relativeAge(iso: string, t: Translator): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 60) return t("time.justNow");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("time.hoursAgo", { hours });
  return t("time.daysAgo", { days: Math.round(hours / 24) });
}

export function percent(value: number, locale: Locale, digits = 0): string {
  return `${formatNumber(value, locale, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  })}%`;
}

/** Score band, used for colour and copy. */
export type ScoreBand = "great" | "good" | "fair" | "poor";

export function scoreBand(score: number): ScoreBand {
  if (score >= 80) return "great";
  if (score >= 65) return "good";
  if (score >= 45) return "fair";
  return "poor";
}

export const BAND_STYLES: Record<
  ScoreBand,
  { ring: string; text: string; chip: string; bar: string }
> = {
  great: {
    ring: "stroke-emerald-400",
    text: "text-emerald-300",
    chip: "bg-emerald-400/10 text-emerald-300 ring-emerald-400/30",
    bar: "bg-emerald-400",
  },
  good: {
    ring: "stroke-sky-400",
    text: "text-sky-300",
    chip: "bg-sky-400/10 text-sky-300 ring-sky-400/30",
    bar: "bg-sky-400",
  },
  fair: {
    ring: "stroke-amber-400",
    text: "text-amber-300",
    chip: "bg-amber-400/10 text-amber-300 ring-amber-400/30",
    bar: "bg-amber-400",
  },
  poor: {
    ring: "stroke-rose-400",
    text: "text-rose-300",
    chip: "bg-rose-400/10 text-rose-300 ring-rose-400/30",
    bar: "bg-rose-400",
  },
};

/** Ordered dimension list, matching the spec's a–e. */
export const DIMENSION_ORDER: DimensionKey[] = [
  "weather",
  "hotel",
  "flight",
  "crowd",
  "fx",
];

export function dimensionLabel(key: DimensionKey, t: Translator): string {
  return t(`dimension.${key}`);
}

/**
 * The date inputs' legal window: today through today + 30 days, per spec.
 * Computed in the *origin* timezone, since that is where the traveller is.
 */
export function dateWindow(
  originTimezone: string,
  now: Date = new Date(),
): { min: string; max: string } {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: originTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return { min: today, max: addDays(today, 30) };
}

export const MAX_TRIP_DAYS = 30;

/** True when the total was limited by the weak-dimension cap. */
export function isCapped(result: ScoreResult): boolean {
  return result.cappedBy !== null && result.total < result.arithmeticMean;
}
