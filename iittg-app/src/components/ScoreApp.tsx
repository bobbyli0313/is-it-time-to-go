"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { CITIES } from "@/lib/data/cities";
import { ROUTES, destinationsFrom } from "@/lib/data/routes";
import { createTranslator, type Locale } from "@/lib/i18n";
import { addDays, diffDays, todayForTrip } from "@/lib/scoring/dates";
import { cityName, dateRange } from "@/lib/format";
import { requestScore, type ScoreResponse } from "@/lib/requestScore";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { TripForm, type FormState } from "@/components/TripForm";
import { ScoreCard } from "@/components/ScoreCard";
import { DimensionCard } from "@/components/DimensionCard";
import { DimensionGrid } from "@/components/DimensionGrid";
import type { InitialSearch } from "@/app/page";

/** The spec's own example route, used as the default selection. */
const DEFAULT_ORIGIN = "shanghai";
const DEFAULT_DESTINATION = "tokyo";
const DEFAULT_LEAD_DAYS = 3;
const DEFAULT_TRIP_DAYS = 5;

function defaultForm(now: Date): FormState {
  const origin =
    CITIES.find((c) => c.id === DEFAULT_ORIGIN) ?? CITIES[0];
  const today = todayForTrip(origin.timezone, origin.timezone, now);
  const depart = addDays(today, DEFAULT_LEAD_DAYS);
  return {
    originCityId: origin.id,
    destinationCityId: DEFAULT_DESTINATION,
    departDate: depart,
    returnDate: addDays(depart, DEFAULT_TRIP_DAYS - 1),
    travellers: 1,
  };
}

function formFromSearch(initial: InitialSearch, fallback: FormState): FormState {
  if (!initial.from || !initial.to) return fallback;
  return {
    originCityId: initial.from,
    destinationCityId: initial.to,
    departDate: initial.depart || fallback.departDate,
    returnDate: initial.returnDate || fallback.returnDate,
    travellers: fallback.travellers,
  };
}

export function ScoreApp({
  initial,
  maxTripDays,
}: {
  initial: InitialSearch;
  maxTripDays: number;
}) {
  // A single reference instant for the whole session, so scores do not shift
  // underneath the user as the clock advances between renders.
  const [now] = useState(() => new Date());

  const [locale, setLocale] = useState<Locale>(initial.locale);
  const [form, setForm] = useState<FormState>(() =>
    formFromSearch(initial, defaultForm(now)),
  );
  const [response, setResponse] = useState<ScoreResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const router = useRouter();
  const pathname = usePathname();
  const autoRan = useRef(false);

  const t = useMemo(() => createTranslator(locale), [locale]);

  const score = useCallback(
    async (candidate: FormState) => {
      setBusy(true);
      setError(null);
      try {
        const scored = await requestScore(
          {
            originCityId: candidate.originCityId,
            destinationCityId: candidate.destinationCityId,
            departDate: candidate.departDate,
            returnDate: candidate.returnDate,
            travellers: candidate.travellers,
          },
          now,
        );
        if (scored.ok) {
          setResponse(scored);
        } else {
          setError(scored.error);
          setResponse(null);
        }
      } catch (cause) {
        setError("form.routeUnavailable");
        setResponse(null);
        console.error(cause);
      } finally {
        setBusy(false);
      }
    },
    [now],
  );

  /**
   * A shared link should arrive already scored. This runs once, guarded by a
   * ref, and only when the URL carried a complete trip — it is a one-shot
   * auto-submit, not a state-synchronisation effect.
   */
  useEffect(() => {
    if (autoRan.current || !initial.complete) return;
    autoRan.current = true;
    void score(form);
    // Intentionally run once on mount: `form` and `score` are stable here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Keep the URL shareable. `replace` avoids polluting browser history. */
  const syncUrl = useCallback(
    (nextLocale: Locale, nextForm: FormState | null) => {
      const params = new URLSearchParams();
      params.set("lang", nextLocale);
      if (nextForm?.originCityId && nextForm.destinationCityId) {
        params.set("from", nextForm.originCityId);
        params.set("to", nextForm.destinationCityId);
        if (nextForm.departDate) params.set("depart", nextForm.departDate);
        if (nextForm.returnDate) params.set("return", nextForm.returnDate);
      }
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router],
  );

  function changeLocale(next: Locale) {
    setLocale(next);
    syncUrl(next, response?.ok ? form : null);
  }

  function submit() {
    syncUrl(locale, form);
    void score(form);
  }

  const reset = useCallback(() => {
    const fresh = defaultForm(new Date());
    setForm(fresh);
    setResponse(null);
    setError(null);
    syncUrl(locale, null);
  }, [locale, syncUrl]);

  const result = response?.ok ? response : null;

  /**
   * Dimensions that do not apply to this trip are dropped rather than shown with
   * a placeholder. A same-currency trip has no exchange rate to score, so showing
   * a fifth card reading "not applicable" is noise: it makes the section look
   * like something failed, and it leaves the grid with an odd card count.
   *
   * The exclusion is still disclosed — `result.warnings` carries
   * `warning.sameCurrency`, and the total's weight redistribution is explained in
   * the aggregation note.
   */
  const shownDimensions = useMemo(
    () =>
      (result?.result.dimensions ?? []).filter(
        (dimension) => dimension.applicable && dimension.score !== null,
      ),
    [result],
  );

  const routeLabel = result
    ? `${result.trip.originName[locale]} → ${result.trip.destinationName[locale]}`
    : "";

  const dateLabel = result
    ? dateRange(result.trip.departDate, result.trip.returnDate, locale)
    : "";

  const tripDays =
    form.departDate && form.returnDate && form.returnDate >= form.departDate
      ? diffDays(form.departDate, form.returnDate) + 1
      : 0;

  return (
    <>
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-2xl">
          <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
            {t("app.title")}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-400">
            {t("app.tagline")}
          </p>
        </div>
        <LanguageSwitcher locale={locale} onChange={changeLocale} t={t} />
      </header>

      <div className="space-y-6">
        <TripForm
          value={form}
          onChange={setForm}
          onSubmit={submit}
          busy={busy}
          error={error}
          locale={locale}
          t={t}
          maxTripDays={maxTripDays}
        />

        {busy && !result ? (
          <div className="h-56 animate-pulse rounded-2xl bg-white/[0.03] ring-1 ring-white/10" />
        ) : null}

        {result ? (
          <>
            <ScoreCard
              result={result.result}
              routeLabel={routeLabel}
              dateLabel={dateLabel}
              dataNotes={result.dataNotes}
              provenance={result.provenance}
              locale={locale}
              t={t}
              onReset={reset}
            />

            <section>
              <h2 className="mb-4 text-xs font-semibold tracking-wide text-slate-400 uppercase">
                {t("result.detailsHeading")}
              </h2>
              <DimensionGrid count={shownDimensions.length}>
                {shownDimensions.map((dimension) => (
                  <DimensionCard
                    key={dimension.key}
                    dimension={dimension}
                    locale={locale}
                    t={t}
                  />
                ))}
              </DimensionGrid>
            </section>
          </>
        ) : (
          <section className="rounded-2xl bg-white/[0.02] p-5 ring-1 ring-white/5">
            <dl className="grid gap-3 text-xs sm:grid-cols-3">
              <div>
                <dt className="text-slate-500">{t("form.heading")}</dt>
                <dd className="mt-1 text-slate-300">
                  {ROUTES.length} routes
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">{t("form.origin")}</dt>
                <dd className="mt-1 text-slate-300">
                  {
                    CITIES.filter((c) => destinationsFrom(c.id).length > 0)
                      .length
                  }{" "}
                  cities
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">{t("form.returnDate")}</dt>
                <dd className="mt-1 text-slate-300">
                  {tripDays > 0
                    ? t("form.tripLength", { days: tripDays })
                    : `1–${maxTripDays} days`}
                </dd>
              </div>
            </dl>
          </section>
        )}

        <footer className="border-t border-white/10 pt-5">
          <p className="text-xs leading-relaxed text-slate-500">
            {t("footer.disclaimer")}
          </p>
          <p className="mt-1 text-xs text-slate-600">
            {result
              ? `${result.trip.airportPair[0]} → ${result.trip.airportPair[1]}`
              : CITIES.map((c) => cityName(c, locale)).slice(0, 3).join(" · ")}
          </p>
        </footer>
      </div>
    </>
  );
}
