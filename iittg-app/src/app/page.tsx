import { Suspense } from "react";
import { ScoreApp } from "@/components/ScoreApp";
import { resolveCityCode } from "@/lib/data/cities";
import { MAX_TRIP_DAYS } from "@/lib/format";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/lib/i18n";
import { isValidIsoDate, todayForTrip } from "@/lib/scoring/dates";

export type InitialSearch = {
  locale: Locale;
  from: string;
  to: string;
  depart: string;
  returnDate: string;
  /** True when the URL carried a complete trip, which both selects and submits. */
  complete: boolean;
};

function parseSearch(params: Record<string, string | string[] | undefined>): InitialSearch {
  const one = (key: string): string => {
    const value = params[key];
    return typeof value === "string" ? value : "";
  };

  const rawLang = one("lang");
  const locale = isLocale(rawLang) ? rawLang : DEFAULT_LOCALE;

  /**
   * Share links carry IATA codes, matching what the form takes. A link with a code the
   * app does not know is dropped rather than passed through, so a stale or mistyped
   * URL lands on the empty form instead of a rejection message.
   */
  const fromCity = resolveCityCode(one("from"));
  const toCity = resolveCityCode(one("to"));
  const from = fromCity?.iataCity ?? "";
  const to = toCity?.iataCity ?? "";

  // Departure is only meaningful once we know the origin's timezone.
  const origin = fromCity;
  const depart = one("depart");
  const returnDate = one("return");

  const validDates =
    origin !== undefined &&
    isValidIsoDate(depart) &&
    isValidIsoDate(returnDate) &&
    returnDate >= depart;

  return {
    locale,
    from,
    to,
    depart: validDates ? depart : "",
    returnDate: validDates ? returnDate : "",
    complete:
      validDates &&
      from !== "" &&
      to !== "" &&
      from !== to &&
      todayForTrip(origin.timezone, origin.timezone) <= depart,
  };
}

/**
 * Server component: reads the query string so a shared link renders the right
 * locale and trip immediately, with no client-side effect to correct it after
 * hydration. All interactivity lives in `ScoreApp`.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = parseSearch(await searchParams);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
      <Suspense
        fallback={
          <div className="h-64 animate-pulse rounded-2xl bg-white/[0.03] ring-1 ring-white/10" />
        }
      >
        <ScoreApp initial={search} maxTripDays={MAX_TRIP_DAYS} />
      </Suspense>
    </main>
  );
}
