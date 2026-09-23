"use client";

import { useMemo } from "react";
import { CITIES } from "@/lib/data/cities";
import { destinationsFrom } from "@/lib/data/routes";
import type { City } from "@/lib/scoring/types";
import type { Locale, Translator } from "@/lib/i18n";
import { cityName, dateWindow, shortDate } from "@/lib/format";
import { addDays, diffDays } from "@/lib/scoring/dates";

export interface FormState {
  originCityId: string;
  destinationCityId: string;
  departDate: string;
  returnDate: string;
  travellers: number;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-xs font-medium tracking-wide text-slate-400 uppercase">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="text-xs leading-relaxed text-slate-500">{hint}</span>
      ) : null}
    </label>
  );
}

/** Small muted heading that separates the form's groups. */
function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-3 text-[11px] font-medium tracking-wider text-slate-500 uppercase">
      {children}
    </p>
  );
}

const inputClass =
  "w-full min-w-0 rounded-lg bg-white/[0.06] px-3.5 py-2.5 text-sm text-slate-100 ring-1 ring-white/10 outline-none transition focus:bg-white/[0.09] focus:ring-2 focus:ring-amber-400/60 disabled:opacity-50";

/** Native selects are unstyled on dark backgrounds, so add our own chevron. */
const selectClass = `${inputClass} cursor-pointer appearance-none bg-[length:1rem] bg-[right_0.75rem_center] bg-no-repeat pr-10`;
const selectStyle: React.CSSProperties = {
  backgroundImage:
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2.5' stroke-linecap='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E\")",
};

export function TripForm({
  value,
  onChange,
  onSubmit,
  busy,
  error,
  locale,
  t,
  maxTripDays,
}: {
  value: FormState;
  onChange: (next: FormState) => void;
  onSubmit: () => void;
  busy: boolean;
  error: string | null;
  locale: Locale;
  t: Translator;
  maxTripDays: number;
}) {
  const origins = useMemo(
    () =>
      CITIES.filter((c) => destinationsFrom(c.id).length > 0).sort((a, b) =>
        cityName(a, locale).localeCompare(cityName(b, locale)),
      ),
    [locale],
  );

  const destinations = useMemo(() => {
    const list = destinationsFrom(value.originCityId);
    // Include the current selection even if the origin changed, so the select
    // never renders blank while the user is mid-edit.
    const current = CITIES.find((c) => c.id === value.destinationCityId);
    const merged =
      current && !list.some((c) => c.id === current.id)
        ? [...list, current]
        : list;
    return merged.sort((a, b) =>
      cityName(a, locale).localeCompare(cityName(b, locale)),
    );
  }, [value.originCityId, value.destinationCityId, locale]);

  const originCity = CITIES.find((c) => c.id === value.originCityId);
  const { min, max } = dateWindow(originCity?.timezone ?? "UTC");

  const tripDays =
    value.departDate && value.returnDate && value.returnDate >= value.departDate
      ? diffDays(value.departDate, value.returnDate) + 1
      : 0;

  function setOrigin(originCityId: string) {
    // If the new origin cannot reach the current destination, clear it rather
    // than silently scoring a route the data does not cover.
    const reachable = destinationsFrom(originCityId).some(
      (c) => c.id === value.destinationCityId,
    );
    onChange({
      ...value,
      originCityId,
      destinationCityId: reachable ? value.destinationCityId : "",
    });
  }

  function swap() {
    if (!value.destinationCityId) return;
    onChange({
      ...value,
      originCityId: value.destinationCityId,
      destinationCityId: value.originCityId,
    });
  }

  function setDepart(departDate: string) {
    // Keep the return date valid when the departure moves past it.
    const returnDate =
      value.returnDate && value.returnDate >= departDate
        ? value.returnDate
        : departDate;
    onChange({ ...value, departDate, returnDate });
  }

  return (
    <form
      className="rounded-2xl bg-white/[0.03] p-6 ring-1 ring-white/10 sm:p-8"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <h2 className="mb-6 text-sm font-semibold tracking-wide text-slate-300 uppercase">
        {t("form.heading")}
      </h2>

      {/* Group 1: where. Two fields plus an explicit swap control between them. */}
      <GroupLabel>{t("form.routeGroup")}</GroupLabel>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label={t("form.origin")}>
          <select
            className={selectClass}
            style={selectStyle}
            value={value.originCityId}
            onChange={(e) => setOrigin(e.target.value)}
          >
            <option value="">{t("form.selectCity")}</option>
            {origins.map((c: City) => (
              <option key={c.id} value={c.id}>
                {cityName(c, locale)} · {c.iataCity}
              </option>
            ))}
          </select>
        </Field>

        <Field label={t("form.destination")}>
          <select
            className={selectClass}
            style={selectStyle}
            value={value.destinationCityId}
            onChange={(e) =>
              onChange({ ...value, destinationCityId: e.target.value })
            }
          >
            <option value="">{t("form.selectCity")}</option>
            {destinations.map((c: City) => (
              <option key={c.id} value={c.id}>
                {cityName(c, locale)} · {c.iataCity}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="mt-4 flex justify-center">
        <button
          type="button"
          onClick={swap}
          disabled={!value.destinationCityId}
          aria-label={t("form.swap")}
          className="inline-flex items-center gap-2 rounded-full bg-white/5 px-3.5 py-1.5 text-xs font-medium text-slate-300 ring-1 ring-white/10 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
        >
          {/* Points across on mobile (fields stack), down-up on desktop (fields sit side by side). */}
          <span aria-hidden className="text-sm sm:rotate-90">
            ⇅
          </span>
          {t("form.swapShort")}
        </button>
      </div>

      {/* Group 2: when. */}
      <div className="mt-7 border-t border-white/10 pt-6">
        <GroupLabel>{t("form.datesGroup")}</GroupLabel>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label={t("form.departDate")}
            hint={t("form.departHint", {
              from: shortDate(min, locale),
              to: shortDate(max, locale),
            })}
          >
            <input
              type="date"
              className={inputClass}
              value={value.departDate}
              min={min}
              max={max}
              onChange={(e) => setDepart(e.target.value)}
            />
          </Field>

          <Field
            label={t("form.returnDate")}
            hint={
              tripDays > 0
                ? t("form.tripLength", { days: tripDays })
                : undefined
            }
          >
            <input
              type="date"
              className={inputClass}
              value={value.returnDate}
              min={value.departDate || min}
              max={
                value.departDate
                  ? addDays(value.departDate, maxTripDays - 1)
                  : max
              }
              onChange={(e) =>
                onChange({ ...value, returnDate: e.target.value })
              }
            />
          </Field>
        </div>
      </div>

      <div className="mt-7 flex flex-wrap items-center gap-4 border-t border-white/10 pt-6">
        <button
          type="submit"
          disabled={busy || !value.originCityId || !value.destinationCityId}
          className="rounded-lg bg-amber-400 px-5 py-2.5 text-sm font-semibold text-ink-950 transition hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? t("form.scoring") : t("form.submit")}
        </button>

        {error ? (
          <p role="alert" className="text-sm text-rose-300">
            {t(error)}
          </p>
        ) : null}
      </div>
    </form>
  );
}
