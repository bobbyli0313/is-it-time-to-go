# IITTG — Is It Time To Go?

Travel decision scoring. Answers one question: **is now a good time to go?** — with
a 1–100 score built from weather, hotel prices, flight prices, crowding and
exchange rates.

Three of the five dimensions run on **live data** with no API key. Flight and hotel
pricing run on Ignav (awaiting a key) and on a price index this app builds itself.
The UI states, per dimension, which is which — a partially-integrated deployment must
never look fully live.

## Run it

```bash
npm install
npm run dev          # http://localhost:3000
```

No configuration is required: weather, holidays and FX are live out of the box. To
enable flight pricing, copy `.env.example` to `.env.local` and add an Ignav key.

```bash
npm test             # 134 tests, offline (fixtures, no network)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run build        # production build
```

> If `npm install` fails with `EPERM` on `~/.npm/_cacache`, point npm at a local
> cache: `npm_config_cache=./.npm-cache npm install`.

## Data sources

| Dimension | Source | Key? | Status |
|---|---|---|---|
| Weather | [Open-Meteo](https://open-meteo.com) — 16-day forecast, monthly climate normal beyond | none | **live** |
| Crowding | [Nager.Date](https://date.nager.at) — public holidays, plus a curated peak-period table | none | **live** |
| Exchange rate | [Frankfurter](https://frankfurter.dev) — ECB daily reference rates, 12-month range from real observations | none | **live** |
| Flight | [Ignav](https://ignav.com) — self-serve fare search | required | adapter written, awaiting key |
| Hotel | **Our own price index** over samples this app collects | none | reader written, collector is a separate job |

### Why not Amadeus

Amadeus was the original plan for both flight and hotel pricing. Its **Self-Service
portal was decommissioned on 17 July 2026 and its API keys were disabled**; flight
access there now requires an enterprise sales contract. The adapter that targeted it
was deleted rather than left waiting for credentials that can no longer be obtained.

The knock-on effect is larger than one provider: flight pricing on the open market is
now either enterprise-gated or partnership-gated, so [Ignav](https://ignav.com) —
self-serve, 1,000 free requests then $2 per 1,000 — is the pragmatic choice.

### Why hotels are our own data, not an API

There is **no self-serve API for "the average nightly rate of central hotels"**. The
OTA APIs (Booking, Expedia, Agoda) are partnership-gated, and their terms forbid
redistributing prices regardless of access. Hotel pricing is therefore an index built
from samples this app collects and stores itself.

This is a deliberate design position rather than an unfinished integration:

- **It is a relative index, never a bookable rate.** The UI says so on every card.
  Publishing "Tokyo is 24% above its baseline" is original data; publishing "this room
  costs ¥2,882" would be redistribution.
- **Coverage is earned.** A city with no samples reports an unavailable dimension, not
  an invented number.
- **The basket is fixed per city.** An index is only comparable over time if its
  members do not change, so samples outside the declared basket are rejected.
- **Collection is an offline job, never a request path.** The product must not depend
  on a live scrape to render a score. That separation is structural: the collector
  does not live in the request-path module.

### Known limitations, disclosed in the UI

- **Flight pricing is unverified against a live response.** The request and response
  shapes come from Ignav's published OpenAPI document, but no fare has been observed,
  so parsing is defensive (an unexpected shape yields "unavailable" rather than a
  plausible-looking wrong number) and its confidence is capped at 0.55.
- **Hotel coverage depends on collection.** A city with no basket or no samples near
  the requested dates reports the dimension as unavailable, and the UI says which of
  the two it is. Collection is deliberately offline: the product must not depend on a
  live scrape to render a score.
- **A fare quoted in a currency other than the origin's is discarded**, not converted.
  The score compares fares against an origin-currency baseline, so a mismatched
  currency would not be imprecise — it would be meaningless.
- **TWD and VND are outside the ECB basket.** Rather than add an aggregator with
  unclear commercial terms, those pairs fall back to a curated static table and the
  UI says so.
- **Nager.Date reports every holiday as `Public`**, with no notion of intensity. A
  single bank holiday and Japan's Golden Week arrive identically. Peak periods are
  therefore curated, and the source is used for *coverage* — see the header comment
  in `src/lib/data/live/holidays.ts` for why clustering was rejected.

## What works

- English and Chinese, with the language in the URL so a scored trip is shareable in
  the recipient's language.
- 21 cities across China, Japan, Korea and South-East Asia; 60 route pairs.
- Departure dates from today to today + 30, trips of 1–30 days.
- A score with per-dimension breakdown, confidence badges, a "what is costing you
  points" attribution list, a data-source panel, and an expandable view of the raw
  data behind every dimension.

## Architecture

```
browser
  └── POST /api/score          src/app/api/score/route.ts
        validates, resolves providers, scores, returns provenance
          └── lib/data          provider composition (per-dimension live | mock)
                ├── live/       Open-Meteo · Nager.Date · Frankfurter · Ignav
                ├── hotel-index.ts  self-collected price index (read side)
                ├── mock-provider.ts
                ├── http.ts     timeouts, bounded retries, IPv4 preference
                └── cache.ts    TTL cache: memory + disk, single-flight
          └── lib/scoring       pure functions, no I/O
```

Scoring runs server-side for three reasons, in order of importance: **API keys**
(a client secret must never reach the browser), **caching** (one scored trip is 4–6
upstream calls, so the cache only helps if there is one place to keep it), and
**avoiding two code paths** for the same call.

### Measured behaviour

| Case | Latency |
|---|---|
| Cold cache, all sources | 1.7–3.0 s |
| Warm cache | ~10 ms |
| New process, disk cache present | ~0.3 s |

The disk cache is not an optimisation. Open-Meteo's archive endpoint takes 7–10
seconds per call, and climate normals are keyed **per city per month** rather than
per day — 30× fewer keys for a difference well inside the noise the model already
discloses.

### Resilience

Every upstream call has a per-attempt timeout and bounded retries, and a single
source failure degrades one dimension rather than failing the request.

One real problem worth recording: `date.nager.at` advertises unroutable IPv6
addresses, and Node's `fetch` prefers IPv6, which blackholed until the 10-second
connect timeout fired — while `curl` worked fine because it prefers IPv4. Measured
before: **10.5 s hard failure**. After preferring IPv4 and retrying: **1.6 s
success**. See `src/lib/data/http.ts`.

## Two design rules that shaped everything

**1. Provenance is part of the data, not a UI afterthought.**
A weather sample *is* a forecast or *is* a climate normal — a discriminated union, so
the compiler refuses to let a 45-day-out historical average be treated as a
prediction. Same for cached fares and hotel indices. Confidence is derived from
provenance, not from how pleasant the number looks. The API returns a `provenance`
record and the UI renders it, so "which of these numbers are real?" is always
answerable.

**2. The scoring layer never emits prose.**
It emits i18n keys. `src/lib/i18n/messages.test.ts` walks every scorer across every
branch and asserts each emitted key resolves in both locales, so a typo cannot
silently ship a raw key to a user.

## Tests

134 tests, all offline. No unit test touches the network — the live adapters are
tested against verbatim recorded fixtures in `src/lib/data/live/__fixtures__/`, and
the fetch stub fails loudly on an unstubbed URL, so a test that quietly reached the
internet would be a failure rather than a flake.

`vitest.config.mts` pins every source to `mock` deliberately. Next.js loads
`.env.local` but vitest does not, so without pinning, the suite would exercise mock
data while a developer's running app used live data — and the tests would silently
stop reflecting production.

## Next steps

- **An Ignav API key** (https://ignav.com/signup), then one session against a real
  fare response: the adapter's request and response shapes come from the published
  OpenAPI document, but no fare has been observed, so parsing is defensive and its
  confidence is capped at 0.55 until verified.
- **A hotel sample collector**, plus curated baskets for the launch cities. The reader
  and the index maths are done and tested; what is missing is the offline job that
  fills the sample file.
- **Real fare history** for the percentile path. The scorer currently falls back to
  the distance model when no history exists, which the UI labels. Building history is
  a batch job, not a request-path concern.
- **Redis** instead of the disk cache if this ever runs on more than one instance.
  The cache interface is already keyed and TTL-based, so the swap is contained.
- See `MODEL.md` for the scoring specification, the calibration of every constant, and
  what is still undecided.
