/**
 * Timezone-explicit date helpers.
 *
 * Every date in this app is a *calendar date in a named timezone*, never a
 * local-time instant. Getting this wrong is the classic bug where a Japanese
 * public holiday is scored against the user's laptop date in another country.
 *
 * ISO dates (YYYY-MM-DD) are the wire and database format. Internally we pin
 * them to UTC midnight so arithmetic is exact and DST-proof.
 */

const MS_PER_DAY = 86_400_000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = dateFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateFormatters.set(timeZone, fmt);
  }
  return fmt;
}

/**
 * Structural validation. Returns false rather than throwing, because this is the
 * guard for untrusted input (URL parameters, API payloads) — a malformed date
 * must produce a validation error the UI can show, not an uncaught exception.
 */
export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

/** Parse YYYY-MM-DD to a UTC-midnight Date. Throws on malformed input. */
export function parseIsoDate(iso: string): Date {
  if (!ISO_DATE.test(iso)) {
    throw new Error(`Not an ISO date: ${iso}`);
  }
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  // Reject rolled-over dates such as 2026-02-30.
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    throw new Error(`Not a real calendar date: ${iso}`);
  }
  return date;
}

export function formatIsoDate(date: Date): string {
  const y = date.getUTCFullYear().toString().padStart(4, "0");
  const m = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const d = date.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDays(iso: string, days: number): string {
  const d = parseIsoDate(iso);
  return formatIsoDate(new Date(d.getTime() + days * MS_PER_DAY));
}

/** Whole days from `from` to `to`. Negative when `to` is earlier. */
export function diffDays(from: string, to: string): number {
  return Math.round(
    (parseIsoDate(to).getTime() - parseIsoDate(from).getTime()) / MS_PER_DAY,
  );
}

/**
 * The calendar date *right now* as seen in `timeZone`.
 * This is the only correct way to ask "what is today" for a given city.
 */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return formatterFor(timeZone).format(now);
}

/**
 * Today's date for a whole trip. Departure and destination may sit on opposite
 * sides of the date line, so we take whichever city is already furthest ahead.
 * Returns the later of the two "today"s — the conservative choice, because it
 * never lets us claim a date is in the future when one city is already past it.
 */
export function todayForTrip(
  originTimezone: string,
  destinationTimezone: string,
  now: Date = new Date(),
): string {
  const o = todayIn(originTimezone, now);
  const d = todayIn(destinationTimezone, now);
  return o >= d ? o : d;
}

/** Inclusive list of dates from `from` to `to`. Empty when `to` < `from`. */
export function enumerateDates(from: string, to: string): string[] {
  const out: string[] = [];
  const total = diffDays(from, to);
  for (let i = 0; i <= total; i += 1) {
    out.push(addDays(from, i));
  }
  return out;
}

export function isWeekend(iso: string): boolean {
  const day = parseIsoDate(iso).getUTCDay();
  return day === 0 || day === 6;
}

/** Inclusive trip length. A same-day return counts as 1 day. */
export function tripLengthDays(departDate: string, returnDate: string): number {
  return diffDays(departDate, returnDate) + 1;
}

/** Formats an ISO date for display in the active UI locale. */
export function formatDisplayDate(
  iso: string,
  locale: string,
  options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    weekday: "short",
  },
): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(
    parseIsoDate(iso),
  );
}
