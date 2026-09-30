"use client";

import { useMemo } from "react";
import { CITY_BY_CODE, SUPPORTED_CODES, resolveCityCode } from "@/lib/data/cities";
import type { Locale, Translator } from "@/lib/i18n";
import { cityName, dateWindow, shortDate } from "@/lib/format";
import { addDays, diffDays } from "@/lib/scoring/dates";

export interface FormState {
  /** IATA airport or city code, as typed. Upper-cased on input. */
  originCode: string;
  destinationCode: string;
  departDate: string;
  returnDate: string;
  travellers: number;
}

/**
 * What was typed, and whether the app knows it.
 *
 * `city` is `undefined` for an unknown code, which is the state the form has to be
 * able to show — "that city isn't supported yet" — rather than silently substituting
 * something adjacent.
 */
export interface CodeLookup {
  code: string;
  city: ReturnType<typeof resolveCityCode>;
}

export function lookupCode(code: string): CodeLookup {
  return { code, city: resolveCityCode(code) };
}

function Field({
  label,
  hint,
  hintTone = "neutral",
  children,
}: {
  label: string;
  hint?: string;
  /** `warn` marks a code the app does not know; the form still submits. */
  hintTone?: "neutral" | "warn";
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-xs font-medium tracking-wide text-slate-400 uppercase">
        {label}
      </span>
      {children}
      {hint ? (
        <span
          className={`text-xs leading-relaxed ${
            hintTone === "warn" ? "text-amber-300/90" : "text-slate-500"
          }`}
        >
          {hint}
        </span>
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

/** The code field: monospaced and tracked out, so three letters read as a code. */
const codeClass = `${inputClass} text-center font-mono text-base tracking-[0.3em] uppercase placeholder:tracking-normal placeholder:font-sans`;

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
  const originLookup = useMemo(() => lookupCode(value.originCode), [value.originCode]);
  const destinationLookup = useMemo(
    () => lookupCode(value.destinationCode),
    [value.destinationCode],
  );

  /** The date window follows the origin's own calendar, so it needs its timezone. */
  const { min, max } = dateWindow(originLookup.city?.timezone ?? "UTC");

  const tripDays =
    value.departDate && value.returnDate && value.returnDate >= value.departDate
      ? diffDays(value.departDate, value.returnDate) + 1
      : 0;

  /**
   * What the field says under itself: the resolved city, or the reason there isn't
   * one. A complete-but-unknown code is an answer, not an error while typing, so it
   * is styled as a hint rather than a failure.
   */
  function codeHint(lookup: CodeLookup, label: string): string | undefined {
    if (lookup.code.length === 0) return t("form.codeHint");
    if (lookup.code.length < 3) return undefined;
    if (!lookup.city) return `${t("form.cityUnsupported")} · ${label}`;
    return `${cityName(lookup.city, locale)} · ${lookup.city.iataCity}`;
  }

  function setCode(which: "origin" | "destination", raw: string) {
    // Uppercase as they type: the API takes either case, but seeing "PVG" confirms
    // the field understood it, and a lowercase "pvg" looks like free text.
    const code = raw.replace(/[^a-zA-Z]/g, "").slice(0, 3).toUpperCase();
    onChange({
      ...value,
      ...(which === "origin" ? { originCode: code } : { destinationCode: code }),
    });
  }

  function swap() {
    if (!value.destinationCode) return;
    onChange({
      ...value,
      originCode: value.destinationCode,
      destinationCode: value.originCode,
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
        <Field
          label={t("form.origin")}
          hint={codeHint(originLookup, t("form.origin"))}
          hintTone={originLookup.city ? "neutral" : "warn"}
        >
          <input
            className={codeClass}
            value={value.originCode}
            onChange={(e) => setCode("origin", e.target.value)}
            placeholder="PVG"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            maxLength={3}
            list="iittg-city-codes"
            aria-label={t("form.origin")}
          />
        </Field>

        <Field
          label={t("form.destination")}
          hint={codeHint(destinationLookup, t("form.destination"))}
          hintTone={destinationLookup.city ? "neutral" : "warn"}
        >
          <input
            className={codeClass}
            value={value.destinationCode}
            onChange={(e) => setCode("destination", e.target.value)}
            placeholder="HND"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            maxLength={3}
            list="iittg-city-codes"
            aria-label={t("form.destination")}
          />
        </Field>

        {/*
          A suggestion list, not a picker: typing stays the primary interaction, but
          someone who does not know that Osaka is KIX or ITM can find out without
          leaving the form.
        */}
        <datalist id="iittg-city-codes">
          {SUPPORTED_CODES.map((code) => {
            const city = CITY_BY_CODE.get(code);
            return (
              <option key={code} value={code}>
                {city ? cityName(city, locale) : ""}
              </option>
            );
          })}
        </datalist>
      </div>

      <div className="mt-4 flex justify-center">
        <button
          type="button"
          onClick={swap}
          disabled={!value.destinationCode}
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
          disabled={
            busy || !originLookup.city || !destinationLookup.city
          }
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
