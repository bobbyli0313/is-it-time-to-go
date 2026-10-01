# IITTG — Is It Time To Go?

Travel decision scoring. Answers one question: **is now a good time to go?** — with
a 1–100 score built from weather, hotel prices, flight prices, crowding and
exchange rates.

Three of the five dimensions run on **live data** with no API key. Flight pricing
runs on Ignav (awaiting a key), and hotel pricing runs on a median this app collects
itself with an offline collector. The UI states, per dimension, which is which — a
partially-integrated deployment must never look fully live.

## Run it

```bash
npm install
npm run dev          # http://localhost:3000
```

No configuration is required: weather, holidays and FX are live out of the box. Flight
pricing needs an Ignav key and hotel prices need a collection run — copy
`.env.example` to `.env.local` for the first, and run the collector for the second:

```bash
npm run crawl:hotels -- --cities tokyo,osaka --dates 2026-10-20   # optional: bulk warm-up
```

That command is optional. With `IITTG_HOTELBEDS_API_KEY` set, a request for a city with
no fresh prices collects them itself and says so in the response
(`warning.hotelJustCollected`); the CLI is for bulk collection and backfill. Both write
through the same merge, so neither can erase the other's cities.

Until a city has prices its hotel dimension reports as **unavailable** (excluded from the
total rather than scored as cheap). `IITTG_HOTEL_SOURCE=mock` swaps in a synthetic index
for demos, labelled as sample data throughout.

```bash
npm test             # 255 tests, offline (fixtures, no network)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run build        # production build
```

> If `npm install` fails with `EPERM` on `~/.npm/_cacache`, point npm at a local
> cache: `npm_config_cache=./.npm-cache npm install`.

## Entering a trip

Origin and destination are **IATA codes**, airport or city: `PVG` and `SHA` both mean
Shanghai, `HND`, `NRT` and `TYO` all mean Tokyo. Either case works, the resolved city
appears under the field as you type, and the field's suggestion list offers every code
the app knows.

Routes are derived from city coordinates rather than a curated pair list, so any two
supported cities can be scored — a long-haul pair the demand model never enumerated
gets a great-circle distance and a default demand factor instead of an error. A code
the app does not know is rejected with **"that city isn't supported yet"** (暂不支持该城市);
it is never resolved to a nearby city, because that is how someone ends up reading a
score for a trip they did not ask about.

## Deploy

One Next.js app, no database, no cron. Deployed from `iittg-app/` (set that as the
project's **Root Directory**, or run the CLI from inside it):

```bash
cd iittg-app
npx vercel deploy --prod
```

Three environment variables are worth setting in the dashboard. Without them the app
still runs — weather, holidays, FX and crowding are live, and the flight and hotel
dimensions report as unavailable rather than guessing:

| Variable | What it enables |
|---|---|
| `IITTG_FLIGHT_API_KEY` + `IITTG_SOURCE_FLIGHT=live` | Flight pricing (Ignav) |
| `IITTG_HOTELBEDS_API_KEY` + `IITTG_HOTELBEDS_SECRET` | Hotel prices, collected on demand |
| `IITTG_CACHE_DISK=0` | Memory-only cache — **set this on Vercel** |

### What a serverless host changes

**The filesystem is read-only apart from `/tmp`, which is per-instance and ephemeral.**
That matters because hotel prices are a *collected* dataset rather than an API call:

- The dataset and the daily request counter cannot be written. Both therefore fall back
  to process memory (`src/lib/data/collect/on-demand.ts`), so a warm instance behaves like
  the single-machine case: a city it collected is not collected again, and its spending is
  counted.
- The consequence is that the budget is **per instance**: N instances can each spend the
  daily allowance, and a cold start forgets everything. Set `IITTG_HOTEL_DAILY_QUOTA`
  with that in mind, and put the dataset in a durable store (Vercel KV, Redis, Postgres)
  before the traffic justifies a key upgrade.
- `IITTG_CACHE_DISK=0` avoids the disk cache trying to write where it cannot.

`maxDuration` is set to 30s on the scoring route: a request that has to collect hotel
prices makes one extra upstream call, which is more than the platform default leaves room
for.

## Data sources

| Dimension | Source | Key? | Status |
|---|---|---|---|
| Weather | [Open-Meteo](https://open-meteo.com) — 16-day forecast, monthly climate normal beyond | none | **live** |
| Crowding | [Nager.Date](https://date.nager.at) — public holidays, plus a curated peak-period table | none | **live** |
| Exchange rate | [Frankfurter](https://frankfurter.dev) — ECB daily reference rates, 12-month range from real observations | none | **live** |
| Flight | [Ignav](https://ignav.com) — self-serve fare search | required | adapter written, awaiting key |
| Hotel | **Our own collection**: the median nightly rate across a city's priced hotels | none | collector + reader written and tested; needs a source (see below) |

### Why not Amadeus

Amadeus was the original plan for both flight and hotel pricing. Its **Self-Service
portal was decommissioned on 17 July 2026 and its API keys were disabled**; flight
access there now requires an enterprise sales contract. The adapter that targeted it
was deleted rather than left waiting for credentials that can no longer be obtained.

The knock-on effect is larger than one provider: flight pricing on the open market is
now either enterprise-gated or partnership-gated, so [Ignav](https://ignav.com) —
self-serve, 1,000 free requests then $2 per 1,000 — is the pragmatic choice.

### Why hotels are collected, not scraped

There is **no self-serve API from a hotel chain for "the median cost of a night in
this city"** — and a single chain could not answer the question anyway, since its
portfolio is not a city. Rates come from **Hotelbeds**, an inventory aggregator whose
availability search returns every hotel around a point. The reference price is built
from what it returns, stored locally, and served as a median.

This is a deliberate design position rather than an unfinished integration:

- **It is a collected median, never a bookable quote.** The UI says so on every card.
- **One property, one vote.** Each property is reduced to its own median before the
  city median is taken, so a hotel sampled on twenty nights cannot outweigh one
  sampled once. A pooled median would be a median over *collection effort*.
- **Coverage is disclosed only when it is known.** "12 of 57 hotels" is meaningful
  only when that 57 really is the city's inventory — which a supplied census file can
  assert and an availability search cannot. Otherwise the quote reports the count
  behind the median and claims no fraction of the city.
- **Age is disclosed.** Samples older than 45 days mark the quote stale.
- **A thin city is excluded, not guessed.** Below eight priced properties the
  dimension reports as unavailable, exactly as a missing fare does.
- **Collection can run on the request path, within a budget.** A city with no fresh
  prices is collected by the request that needs it — the first person to search a city
  is the person who should cause it to be collected. It is bounded so that cannot get
  out of hand: a per-day request counter that survives restarts, a freshness window
  (a city collected today is not collected again), one request per city-night, and a
  rule that nothing in the collection path can fail a score. See
  `src/lib/data/collect/on-demand.ts`.

### Collecting hotel prices

```bash
npm run crawl:hotels -- --cities tokyo,osaka --dates 2026-10-20,2026-10-27
npm run crawl:hotels -- --cities tokyo --census census.csv --import rates.csv
npm run crawl:hotels -- --no-write          # report only; validates the inputs
```

**Hotelbeds is the built-in price source.** One availability request returns every
hotel with availability around a city centre — the city-wide breadth a median needs,
and something no single chain's own site can provide. It needs a free self-serve
evaluation key (50 requests/day) in `IITTG_HOTELBEDS_API_KEY` / `IITTG_HOTELBEDS_SECRET`.

**A source may publish the amount or only the distance from the anchor.** APItude's
`net` is a wholesale cost, so it defaults to `--disclosure index`: the app then shows
"16% below the ¥500 anchor" instead of a price. The switch is enforced in the scorer,
so an amount the source forbids never reaches the browser. `--disclosure price` opts
in when an agreement allows it.

The collector obeys robots.txt before every path, paces its requests per host,
honours `Crawl-delay`, caps each run's request budget, and reports every failure as a
named reason (`blocked by Akamai`, `refused by robots.txt: Disallow: /search/result/`)
rather than inventing a number. Where a site refuses anonymous clients it will use a
session the operator supplies, and will never obtain one itself.

### Known limitations, disclosed in the UI

- **Flight pricing is unverified against a live response.** The request and response
  shapes come from Ignav's published OpenAPI document, but no fare has been observed,
  so parsing is defensive (an unexpected shape yields "unavailable" rather than a
  plausible-looking wrong number) and its confidence is capped at 0.55.
- **Hotel coverage depends on collection.** With a source configured, a city with no
  fresh prices is collected on demand; without one it reports the dimension as
  unavailable, and the UI distinguishes "never collected" from "out of today's budget"
  from "the source refused". The daily budget (49 requests by default, against a
  50/day evaluation limit) is shared by every city, so a busy day degrades to
  "collect it tomorrow" rather than to an upstream 403.
- **The collected median can only be as broad as its sources.** A chain's own site
  enumerates that chain, not the city, so today's data is chain-scoped until a
  city-wide inventory source (a partner API such as Hotelbeds, or a paid aggregator)
  is wired in. The model labels this rather than hiding it.
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
- **35 cities / 57 codes**, entered by IATA code: the launch scope (China, Japan,
  Korea, South-East Asia) plus the major long-haul hubs — London, Paris, Frankfurt,
  Amsterdam, Madrid, Rome, Istanbul, New York, Los Angeles, San Francisco, Toronto,
  Dubai, Delhi, Sydney. A code the app does not know is answered with "that city isn't
  supported yet" rather than a nearest match.
- Departure dates from today to today + 30, trips of 1–30 days.
- A score with per-dimension breakdown, a "what is costing you points" attribution
  list, a data-source panel, and an expandable view of the raw data behind every
  dimension. Provenance is stated per dimension rather than as one blanket claim, and
  at most one data caveat is surfaced at the top — the rest live on the card they
  affect, where they cannot bury the one that matters.

## Architecture

```
browser
  └── POST /api/score          src/app/api/score/route.ts
        validates, resolves providers, scores, returns provenance
          └── lib/data          provider composition (per-dimension live | mock)
                ├── live/       Open-Meteo · Nager.Date · Frankfurter · Ignav
                ├── hotel-price.ts  collected median (read side)
                ├── hotel-dataset.ts / hotel-dataset-file.ts   schema, validation, store
                ├── collect/    the offline collector: robots, pacing, adapters, CLI
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
prediction. Same for cached fares, collected medians and synthetic sample data: the
mock no longer claims the collected basis, because a prototype that cannot be told
apart from production is the thing these rules exist to prevent. Confidence is derived
from provenance, coverage and age, not from how pleasant the number looks. The API
returns a `provenance` record and the UI renders it, so "which of these numbers are
real?" is always answerable.

**2. The scoring layer never emits prose.**
It emits i18n keys. `src/lib/i18n/messages.test.ts` walks every scorer across every
branch and asserts each emitted key — drivers *and* fact labels — resolves in both
locales, so a typo cannot silently ship a raw key to a user. It caught seven such
labels when the fact-key check was added.

## Tests

225 tests, all offline. No unit test touches the network — the live adapters are
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
- **Wider city coverage.** The collector, the dataset schema, the median and the
  disclosure rules are done and tested, and Hotelbeds is wired in. What limits coverage
  now is the evaluation key's inventory: it has data for Tokyo, Osaka and Sapporo and
  none for the other Asian cities in scope, so those report "no hotels returned
  availability" until a production key (or a second source via `--source`) is added.
- **Real fare history** for the percentile path. The scorer currently falls back to
  the distance model when no history exists, which the UI labels. Building history is
  a batch job, not a request-path concern.
- **Redis** instead of the disk cache if this ever runs on more than one instance.
  The cache interface is already keyed and TTL-based, so the swap is contained.
- See `MODEL.md` for the scoring specification, the calibration of every constant, and
  what is still undecided.
