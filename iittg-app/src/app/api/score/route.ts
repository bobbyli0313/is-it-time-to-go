/**
 * Scoring route.
 *
 * Scoring moved server-side for three reasons, in order of importance:
 *
 *  1. API keys. Amadeus and any future paid source require a client secret, which
 *     must never reach the browser. The provider layer reads credentials from the
 *     environment, so it can only run here.
 *  2. Caching. One scored trip is 4-6 upstream calls. The cache is process-wide, so
 *     it only helps if requests are served from one place.
 *  3. The mock provider could run client-side, but the live one cannot, and having
 *     two code paths for the same call would be a standing source of drift.
 *
 * Validation lives here rather than only in the form because the route is a public
 * endpoint: the form's constraints are a convenience, not a security boundary.
 */

import { NextResponse } from "next/server";
import { resolveCityCode } from "@/lib/data/cities";
import { hasRoute } from "@/lib/data/routes";
import { buildScoreContext } from "@/lib/data";
import { scoreTrip } from "@/lib/scoring";
import { diffDays, isValidIsoDate, todayIn } from "@/lib/scoring/dates";
import { LIMITS, type ScoreRequest, type ScoreResponse } from "@/lib/api/contract";
import type { TripInput } from "@/lib/scoring/types";

export const runtime = "nodejs";

/**
 * Scoring must never be statically evaluated, because it depends on the current
 * time and on live upstreams.
 */
export const dynamic = "force-dynamic";

/**
 * How long this function may run.
 *
 * A scored trip is four to six upstream calls, and when the destination has no fresh
 * hotel prices it also makes one Hotelbeds request — which on a cold cache is a few
 * seconds on top. The platform default (10s on Hobby) is close enough to that total to
 * time out under a slow upstream, so the ceiling is raised explicitly rather than
 * discovered in production. The collector's own timeout is 8s, which fits inside it.
 */
export const maxDuration = 30;

function fail(error: string, status = 400) {
  return NextResponse.json<ScoreResponse>({ ok: false, error }, { status });
}

function isScoreRequest(value: unknown): value is ScoreRequest {
  if (typeof value !== "object" || value === null) return false;
  const body = value as Record<string, unknown>;
  return (
    typeof body.originCode === "string" &&
    typeof body.destinationCode === "string" &&
    typeof body.departDate === "string" &&
    typeof body.returnDate === "string" &&
    (body.travellers === undefined || typeof body.travellers === "number")
  );
}

export async function POST(request: Request): Promise<NextResponse<ScoreResponse>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("error.invalidRequest");
  }

  if (!isScoreRequest(body)) {
    return fail("error.invalidRequest");
  }

  /**
   * Resolve what the user typed. An unknown code is its own answer — "that city isn't
   * supported yet" — and is deliberately distinct from a malformed request or a
   * date-window problem, because the fix is different in each case.
   */
  const origin = resolveCityCode(body.originCode);
  const destination = resolveCityCode(body.destinationCode);

  if (!origin || !destination) {
    return fail("form.cityUnsupported");
  }
  if (origin.id === destination.id) {
    return fail("form.routeUnavailable");
  }
  if (!hasRoute(origin.id, destination.id)) {
    return fail("form.routeUnavailable");
  }
  if (!isValidIsoDate(body.departDate) || !isValidIsoDate(body.returnDate)) {
    return fail("form.dateRange");
  }

  // "Today" is the origin's calendar day: that is where the traveller is standing,
  // and using the server's UTC date would shift the whole window near midnight.
  const today = todayIn(origin.timezone);
  const leadDays = diffDays(today, body.departDate);

  if (leadDays < LIMITS.minLeadDays || leadDays > LIMITS.maxLeadDays) {
    return fail("form.dateRange");
  }
  if (body.returnDate < body.departDate) {
    return fail("form.returnBeforeDepart");
  }
  const tripDays = diffDays(body.departDate, body.returnDate) + 1;
  if (tripDays > LIMITS.maxTripDays) {
    return fail("form.returnBeforeDepart");
  }

  const trip: TripInput = {
    origin,
    destination,
    departDate: body.departDate,
    returnDate: body.returnDate,
    travellers: body.travellers ?? 1,
  };

  try {
    const { context, provenance, holidayCoverageComplete } =
      await buildScoreContext(trip);
    const result = scoreTrip(trip, context);

    const dataNotes: string[] = [];

    /**
     * A holiday coverage gap is indistinguishable from "no holidays" in the scored
     * output, so it is surfaced explicitly instead of silently improving the
     * crowding score.
     */
    const years = new Set([
      body.departDate.slice(0, 4),
      body.returnDate.slice(0, 4),
    ]);
    if (years.size > 1) dataNotes.push("warning.holidayCoverageSpanningYears");

    /**
     * An incomplete calendar means the crowding dimension is built on less than it
     * should be, so say so. Without this the degradation would be invisible: an
     * empty holiday list reads identically to a holiday-free week.
     */
    if (!holidayCoverageComplete) {
      dataNotes.push("warning.holidaySourceIncomplete");
    }

    /**
     * Two distinct hotel problems, and they need different messages: a collection
     * run that has never covered this city, versus one that covered it but not near
     * the requested date.
     */
    if (context.hotel.sampleSize === 0) {
      dataNotes.push(
        provenance.hotel === "collected-hotelbeds"
          ? "warning.hotelSamplesMissing"
          : "warning.hotelIsMockNoCity",
      );
    }

    /**
     * What the on-demand attempt did, when it made one.
     *
     * A city with no prices has three very different explanations — nobody has collected
     * it yet, today's request budget is spent, or the source refused — and only the last
     * is an incident. Saying which turns "the app has no data" into something the person
     * reading it can act on.
     */
    const collection = context.hotel.collection;
    if (collection) {
      if (collection.status === "collected") {
        dataNotes.push("warning.hotelJustCollected");
      } else if (collection.status === "skipped") {
        dataNotes.push("warning.hotelCollectionBudget");
      } else if (collection.status === "failed") {
        dataNotes.push("warning.hotelCollectionFailed");
      }
    }
    if (provenance.fx === "static-reference") {
      dataNotes.push("warning.fxFromStaticTable");
    }

    return NextResponse.json<ScoreResponse>({
      ok: true,
      result,
      provenance,
      dataNotes,
      trip: {
        originName: origin.name,
        destinationName: destination.name,
        departDate: body.departDate,
        returnDate: body.returnDate,
        originCurrency: origin.currency,
        destinationCurrency: destination.currency,
        airportPair: [
          origin.airports[0] ?? origin.iataCity,
          destination.airports[0] ?? destination.iataCity,
        ],
      },
    });
  } catch (error) {
    /**
     * Upstream failure. The alternative — returning a score with silently missing
     * dimensions — would be worse: the user would see a confident number built on
     * absent data.
     */
    console.error("[score] failed", {
      origin: origin.id,
      destination: destination.id,
      departDate: body.departDate,
      error: error instanceof Error ? error.message : String(error),
    });
    return fail("error.upstreamUnavailable", 502);
  }
}
