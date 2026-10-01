#!/usr/bin/env node
/**
 * Checks a deployment by asking it the questions a user would.
 *
 * A successful `vercel deploy` says the build worked. It says nothing about whether the
 * thing runs: whether the environment variables arrived, whether the live sources answer
 * from Vercel's network, whether an on-demand collection happens where the filesystem is
 * read-only, or — the one that matters most — whether the response publishes only what
 * its source permits. Those are all answerable with one scored trip, so this does exactly
 * that and asserts the answers.
 *
 * Usage:
 *   node scripts/verify-deploy.mjs [url] [originCode] [destinationCode]
 *
 * Defaults to the production URL and PVG -> HND. Exit code is 0 only if every check
 * passes, so it is usable as a post-deploy gate.
 */

const url = (process.argv[2] ?? "https://is-it-time-to-go.vercel.app").replace(/\/$/, "");
const originCode = (process.argv[3] ?? "PVG").toUpperCase();
const destinationCode = (process.argv[4] ?? "HND").toUpperCase();

const departDate = new Date(Date.now() + 21 * 86_400_000).toISOString().slice(0, 10);
const returnDate = new Date(Date.now() + 25 * 86_400_000).toISOString().slice(0, 10);

const problems = [];
const notes = [];

function check(condition, ok, bad) {
  if (condition) {
    console.log(`  ✓ ${ok}`);
  } else {
    console.log(`  ✗ ${bad}`);
    problems.push(bad);
  }
  return condition;
}

async function withTimeout(label, timeoutMs, run) {
  try {
    return await run(AbortSignal.timeout(timeoutMs));
  } catch (error) {
    const reason =
      error?.name === "TimeoutError"
        ? `timed out after ${timeoutMs / 1000}s`
        : `${error?.cause?.code ?? error?.name}: ${error?.cause?.message ?? error?.message}`;
    console.log(`  ✗ ${label} — ${reason}`);
    problems.push(`${label} (${reason})`);
    return null;
  }
}

console.log(`\nVerifying ${url}\n  trip: ${originCode} -> ${destinationCode}, ${departDate} to ${returnDate}\n`);

/* ------------------------------------------------------------- the page */

console.log("Page");
const page = await withTimeout("GET /", 30_000, (signal) => fetch(url, { signal }));
if (page) {
  const html = await page.text();
  check(page.status === 200, `HTTP ${page.status}`, `HTTP ${page.status}, expected 200`);
  const protectedByAuth = /Vercel Authentication|_vercel_sso_nonce|login\?next=/.test(html);
  check(
    !protectedByAuth,
    "not behind Vercel Authentication",
    "the response looks like the Vercel login page — Deployment Protection is still on",
  );
  check(
    /用真实数据|One score for when/.test(html),
    "serves the app shell",
    "the tagline is missing from the HTML — is this the right deployment?",
  );
}

/* -------------------------------------------------------------- the API */

console.log("\nScore API");
const started = Date.now();
const response = await withTimeout("POST /api/score", 90_000, (signal) =>
  fetch(`${url}/api/score`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ originCode, destinationCode, departDate, returnDate }),
    signal,
  }),
);
const elapsed = ((Date.now() - started) / 1000).toFixed(1);

if (response) {
  const raw = await response.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    check(false, "", `the response is not JSON (HTTP ${response.status}): ${raw.slice(0, 200)}`);
  }

  if (body) {
    if (!body.ok) {
      check(false, "", `the API refused the trip: ${JSON.stringify(body.error)}`);
    } else {
      const { result, provenance, dataNotes } = body;
      console.log(`  HTTP ${response.status} in ${elapsed}s — total ${result.total} (${result.tripDays} days)`);

      console.log("\nDimensions");
      for (const dimension of result.dimensions) {
        const label = dimension.applicable ? String(Math.round(dimension.score)) : "excluded";
        console.log(`  · ${dimension.key.padEnd(8)} ${label.padStart(8)}  ${dimension.drivers[0] ?? ""}`);
      }
      /**
       * A cold serverless instance has no cache at all, and asks every source at once
       * plus a collection if the city is new. That is the slowest this ever gets, and it
       * is the case a function timeout truncates — so say so while there is still room
       * to act on it.
       */
      if (elapsed > 25) {
        notes.push(
          `the first request took ${elapsed}s — close to the route's maxDuration; raise it before adding sources`,
        );
      }

      const scored = result.dimensions.filter((d) => d.applicable).length;
      check(scored >= 4, `${scored} of ${result.dimensions.length} dimensions scored`, `only ${scored} dimensions scored`);

      console.log("\nProvenance");
      for (const [field, value] of Object.entries(provenance)) {
        console.log(`  · ${field.padEnd(9)} ${value}`);
      }
      const live = Object.values(provenance).filter((v) => String(v).startsWith("live")).length;
      check(live >= 3, `${live} sources live`, `only ${live} sources are live — check the environment variables`);

      console.log("\nHotel disclosure");
      const hotel = result.dimensions.find((d) => d.key === "hotel");
      if (!hotel?.applicable) {
        notes.push(
          "the hotel dimension is excluded: either the collection failed or the day's Hotelbeds budget is spent",
        );
        console.log("  · excluded — see the notes below");
      } else {
        const disclosure = hotel.facts?.disclosure;
        console.log(`  · disclosure: ${disclosure}, samples: ${hotel.facts?.sampleSize}`);
        if (disclosure === "index") {
          /**
           * The whole point of index mode. A ratio would be enough to recover the
           * amount from the ¥500 anchor, so all three fields have to be absent — from
           * the entire payload, not just this dimension.
           */
          // Field *names*, with the colon: `"index"` on its own also matches the
          // disclosure value that says index mode is on.
          const leaked = ["perNight", "baseline", "index"].filter((key) =>
            raw.includes(`"${key}":`),
          );
          check(
            leaked.length === 0,
            "publishes an index only — no amount, baseline or ratio anywhere",
            `index mode is on but the response contains: ${leaked.join(", ")}`,
          );
        } else {
          notes.push(`the hotel dimension reports disclosure "${disclosure}" rather than "index"`);
        }
      }

      if (dataNotes?.length) {
        console.log("\nData notes");
        for (const note of dataNotes) console.log(`  · ${note}`);
      }

      if (result.cappedBy) console.log(`\nTotal capped by: ${result.cappedBy}`);
    }
  }
}

/* ------------------------------------------------------------- verdict */

console.log("");
if (problems.length === 0) {
  console.log("PASS — the deployment answers, scores, and discloses what it should.");
} else {
  console.log(`FAIL — ${problems.length} problem(s):`);
  for (const problem of problems) console.log(`  - ${problem}`);
}
if (notes.length > 0) {
  console.log("\nWorth knowing (not failures):");
  for (const note of notes) console.log(`  - ${note}`);
}
process.exit(problems.length === 0 ? 0 : 1);
