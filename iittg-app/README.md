# IITTG — Is It Time To Go?

Travel decision scoring. Answers one question: **is now a good time to go?** — with
a 1–100 score built from weather, hotel prices, flight prices, crowding and
exchange rates.

Three of the five dimensions run on **live data** with no API key. Flight and hotel
pricing are wired for Amadeus and stay on sample data until credentials exist. The
UI states, per dimension, which is which — a partially-integrated deployment must
never look fully live.

## Run it

```bash
npm install
npm run dev          # http://localhost:3000
```

No configuration is required: weather, holidays and FX are live out of the box. To
enable flight and hotel pricing, copy `.env.example` to `.env.local` and add Amadeus
keys.

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
| Weather | [Open-Meteo](https://open-meteo.com) — 16-day forecast, plus a monthly climate normal beyond that | none | **live** |
| Crowding | [Nager.Date](https://date.nager.at) — public holidays, plus a curated table of peak travel periods | none | **live** |
| Exchange rate | [Frankfurter](https://frankfurter.dev) — ECB daily reference rates, 12-month range measured from real observations | none | **live** |
| Flight | Amadeus `GET /v2/shopping/flight-offers` | required | adapter written, awaiting keys |
| Hotel | Amadeus hotel offers, reduced to a price index | required | scaffold — see below |

### Known limitations, disclosed in the UI

- **Amadeus's free test tier has sparse city coverage.** Most China/Japan/Korea
  routes return no offers there. The adapter treats that as a normal "no quote" and
  excludes the dimension rather than scoring it zero.
- **The hotel adapter has never run against a live response**, because no
  credentials were available. Its parsing is deliberately defensive: anything that
  does not match the documented shape yields "unavailable" rather than a
  plausible-looking wrong number. Treat it as a scaffold needing one session against
  real credentials. There is also no "average nightly rate for central hotels"
  endpoint anywhere — the index must be built from a curated basket of fixed
  property IDs, which is a data-curation task (see `MODEL.md`).
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
                ├── live/       Open-Meteo · Nager.Date · Frankfurter · Amadeus
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

- **Amadeus credentials**, then one session against a real hotel response to make the
  hotel adapter trustworthy. Its basket of property IDs also needs curating.
- **Real fare history** for the percentile path. The scorer currently falls back to
  the distance model when no history exists, which the UI labels. Building history is
  a batch job, not a request-path concern.
- **Redis** instead of the disk cache if this ever runs on more than one instance.
  The cache interface is already keyed and TTL-based, so the swap is contained.
- See `MODEL.md` for the scoring specification, the calibration of every constant, and
  what is still undecided.
