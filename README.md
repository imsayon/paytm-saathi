# Paytm Saathi

Paytm Saathi is a merchant-retention workflow for the Paytm Build for India AI Hackathon - Bengaluru Edition.

It helps a small merchant identify repeat customers who stopped returning, filter the audience by consent, propose a budgeted offer, obtain merchant approval, simulate delivery, and measure the result against a holdout group.

> **This is a demo build.** The data is synthetic, the merchant session is a development-only stub, and the only delivery provider is a mock. There is no Paytm integration and no real customer is ever contacted.

## The one loop this product does

```
CSV import -> retention signal -> deterministic eligible cohort -> bounded Gemini copy draft + affordable offer comparison
  -> merchant review/edit -> approval -> persisted mock delivery -> seven-day holdout report
```

The boundary that matters: **no provider call exists until merchant approval succeeds.** Preview, drafting and revision never touch a provider. Approval is a single transaction that writes the approval, the delivery jobs and the audit event together — and still calls nothing.

## Quick start

The application stores everything in a Neon Postgres database. You need two connection strings from the Neon console: the **pooled** endpoint for the app and the **direct** endpoint for migrations.

The repository uses [pnpm](https://pnpm.io) (`npm install -g pnpm` or `corepack enable pnpm`) and Node 22 or newer.

```bash
pnpm install
cp .env.example .env      # paste DATABASE_URL (pooled) and DATABASE_URL_UNPOOLED (direct)
pnpm db:migrate           # applies db/migrations/*.sql over the direct connection
pnpm db:seed              # seeds the demo merchant, imports the fixture, prints the signal
pnpm dev
```

Open http://127.0.0.1:3000 and follow the five numbered steps in the header. The dev and production servers bind to the loopback address only, so nothing on the venue network can reach the demo controls. `GET /api/healthz` confirms the database is reachable; `GET /api/readyz` confirms every migration is applied.

`pnpm db:seed` is safe to re-run: the import is checksum-idempotent. The import screen also has a **Reset demo data** control that clears the demo merchant's campaigns, jobs and outcomes so the sequence can be rehearsed again on the same database.

Optional, for the model-backed planner:

```bash
# in .env
GEMINI_API_KEY=your-private-key
```

Without a key the planner uses a deterministic template and labels every proposal `template fallback`, in the UI and in the audit trail. The demo runs end to end with no model key.

The core app, worker, scripts and tests are TypeScript. Gemini uses the installed OpenAI SDK against Google's compatibility endpoint; requests do not go to OpenAI. The default verified model is `gemini-2.5-flash`; override it with `SAATHI_GEMINI_MODEL`.

Run `pnpm ai:check` to verify a real structured model response using synthetic aggregates only. It fails if the planner falls back. Browser tests deliberately disable the key for reproducible assertions. Google model availability and quota are external dependencies.

### Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Next.js app and API on port 3000 |
| `pnpm db:migrate` | Apply pending migrations from `db/migrations/` (direct connection) |
| `pnpm db:seed` | Seed merchant, import the fixture, print the signal |
| `pnpm worker` | Run the delivery worker as its own process |
| `pnpm test` | Unit and integration tests against a real Postgres (see below) |
| `pnpm test:e2e` | Playwright smoke test of the whole demo path on a production build |
| `pnpm ai:check` | Verify live Gemini drafting without database writes or customer contact |
| `pnpm typecheck` | TypeScript, no emit |
| `pnpm fixture:generate` | Regenerate the committed fixture CSV |

The UI has demo controls for delivery and the outcome clock, so a presenter never needs a second terminal. `pnpm worker` exists to show the same jobs being drained by a real background process.

### Tests need a test database

Set `TEST_DATABASE_URL` in `.env` to the Neon `test` branch (direct endpoint) or a local Postgres such as `postgresql://localhost:5432/saathi_test`. Unit and integration tests create an isolated schema per test and drop it afterwards; the e2e run resets the demo merchant's data on that database. The e2e suite refuses to start without `TEST_DATABASE_URL`, so it can never wipe the production branch by accident. A local Postgres runs the whole suite in a few seconds; the Neon branch takes about two minutes because every query crosses the network.

## Interface

Five screens, one per step, rendered client-side from the same API the tests use. The motion layer ([anime.js](https://animejs.com) 4) staggers cards into view, counts the headline numbers up, grows the campaign-versus-holdout bars, lights the workflow strip stage by stage, and pops delivery jobs into their final status; it steps aside under `prefers-reduced-motion`. A light/dark toggle in the header is remembered per browser and defaults to light so a projector never gets a dark screen by surprise. Layouts collapse to one column on phones and tables scroll inside their cards.

## Who owns what

This is the whole safety argument, so it is worth stating plainly.

**Rules own** CSV parsing, payment-state handling, refund and duplicate exclusion, repeat-customer detection, inactivity windows, consent and contactability, audience selection, campaign/holdout assignment, budget arithmetic, campaign versioning, approval authorization, campaign and delivery state, outcome calculation, and audit events.

**The model may** draft campaign copy, explain the proposed targeting, suggest a bounded offer, and suggest timing inside an allowed policy window.

**The model may not** select customers, override consent, change the budget cap, approve anything, change campaign state, call a provider, or compute any authoritative number. It has no tools, no network beyond the single completion call, and no provider credentials. Its cost estimate is advisory; rules recompute it and the rule figure wins.

What the planner receives is aggregate only: cohort counts, the inactivity window, the cap, the allowed offer shape, exclusion counts, policy version and timezone. No contact reference, customer identifier or payment row is ever sent. A test asserts this.

## Architecture

One TypeScript application. One Neon Postgres database. One optional worker process.

```
db/migrations/           Schema as numbered SQL files, applied by scripts/migrate.ts
src/app/                 Next.js 16 routes: 5 merchant screens + the API
src/server/
  config.ts              Environment configuration (pooled URL for the app, direct URL for migrations)
  auth/context.ts        Development-only merchant session (refuses outside demo mode)
  db/                    pg client, transaction helper, migration runner
  importer/              CSV parsing, validation, atomic checksum-idempotent import
  domain/
    signal.ts            Regular / absent / consent cohort rules
    rules.ts             The single validation path (preview, edit, approval, pre-send)
    campaign.ts          Versioning, revision, the approval transaction
    simulator.ts         Fixed-seed seven-day outcome window
    measurement.ts       Report formulas, computed only from stored rows
    views.ts             Response assembly and identifier masking
  ai/                    Planner adapter, strict output schema, template fallback
  providers/mock.ts      The only provider; sends nothing
  worker/runner.ts       Atomic job claims, leases, status checks, retries
  audit/events.ts        Append-only audit log
data/fixtures/           The frozen synthetic CSV
tests/                   Unit, integration, and the Playwright demo path
```

Postgres does three jobs here and nothing more. Approval takes a row lock on the campaign (`SELECT ... FOR UPDATE`) so two concurrent approvals cannot both queue jobs. The delivery queue is a table: a worker claims with `UPDATE ... FOR UPDATE SKIP LOCKED ... RETURNING`, so any number of workers can drain it without a broker. Migrations are plain SQL files recorded in a `schema_migration` table with checksums, applied over the direct connection while the app uses the pooled one. There is no Redis, no Kafka and no queue service.

## Reliability

- **Import** is idempotent on `(merchant_id, checksum)` and validates the entire file before publishing any row.
- **Approval** requires an `Idempotency-Key`. The same key replays the original approval; a different key against an approved version is a `409`; a stale version is a `409`.
- **Jobs** are unique per `(version_id, recipient_id)` and carry a stable provider idempotency key.
- **The worker** claims jobs with an atomic locked update and a lease. Two workers draining at once never process the same job; an expired lease is reclaimed after a crash and provider status is checked even if no attempt was recorded. If the mock has no status evidence, recovery stops in `NEEDS_REVIEW`. An attempt, its job status and its audit event commit in one transaction.
- **Consent and version are checked before processing each job.** A revoked consent cancels the job without contacting the provider.
- **A timeout never triggers a blind retry.** The worker asks the provider for status using the same idempotency key and re-sends only when status proves nothing was delivered. An unresolvable status becomes `NEEDS_REVIEW` and stops.
- **Outcome simulation** is idempotent on `(campaign_id, customer_id, window_start)`.
- Every material transition writes an audit event inside the same transaction as the state change.

## Compare affordable offers

On the review screen, choose among up to three rewards at 50%, 75% and 100% of the cap-safe maximum, floor-rounded to whole paise and bounded by the existing ₹1–₹100 reward policy. At least two eligible customers are needed for campaign and holdout groups.

For 20 eligible people and a ₹300 cap:

| Reward | Conservative whole-cohort exposure | Maximum for 10 contacted customers |
|---|---:|---:|
| ₹7.50 | ₹150 | ₹75 |
| ₹11.25 | ₹225 | ₹112.50 |
| ₹15.00 | ₹300 | ₹150 |

The cap still uses the conservative whole cohort for compatibility. The holdout gets no offer. These are cost comparisons, not predictions of conversion or profit. Gemini may explain the tradeoff; its text is advisory. A conservative wording filter falls back to a labelled rule-based explanation when it detects quantitative/performance claims; it is not a semantic guarantee.

Choosing an option only prepares edits. Save a new version, review the wording and generated offer sentence, then approve. New drafts separate the editable introduction from exact reward/validity terms. The worker appends those terms from the approved offer; amounts in the introduction are blocked. Legacy proposals remain readable and retain their mismatch checks. Merchant review is still required for freeform language.

Campaign detail responses add `offer_options` (reward, group sizes, conservative and campaign exposures in paise) and `reward_promise`. Versioned proposal JSON stores optional copy/explanation source metadata; no migration is required. Revision accepts `copy_format: "separate_reward"`; request fields are type-checked and unknown fields rejected.

The cohort contains absent regulars, not exclusively weekday regulars. A weekday-only offer limits redemption timing; it does not change audience membership.

## Measurement, stated honestly

The report shows campaign versus holdout return rates, the descriptive percentage-point difference, estimated incremental returns, return volume, reward cost, and a contribution proxy — each with its formula visible in the UI.

Three things it deliberately does not claim:

1. **It is not profit.** Payment volume does not reveal margin, messaging cost or support cost. The figure is labelled "contribution proxy after reward".
2. **It is not causal evidence.** The outcome comes from a fixed-seed simulator over synthetic data. It demonstrates the measurement shape and holdout discipline, nothing more.
3. **It is not statistically powered.** Ten customers per group is an illustration, not an experiment.

## Security and trust

Tenant-scoped reads and writes with cross-merchant authorization tests; a development-only merchant session that refuses to resolve outside demo mode; upload size and row limits; strict parsing of money, dates and states; neutralised spreadsheet formula content; masked identifiers in the UI and logs; redacted log fields; rate limits on import and preview; aggregate-only planner input; untrusted merchant intent delimited inside a fixed system instruction; no model tools; environment-based secrets.

The demo endpoints under `/api/demo/` and `/api/campaigns/{id}/demo/` are refused unless `SAATHI_DEMO_MODE=true`. Connection strings live only in `.env` (git-ignored) or deployment secrets; the health endpoint reports the database host, never credentials.

## API

| Endpoint | Purpose |
|---|---|
| `POST /api/imports` | Import the fixture or an uploaded CSV |
| `GET /api/overview` | Merchant, last import, signal, campaigns |
| `POST /api/campaigns/preview` | Draft a campaign from an intent (creates version 1) |
| `GET /api/campaigns/{id}` | Current version, rules, groups, jobs, audit |
| `POST /api/campaigns/{id}/revise` | Merchant edit; creates the next version |
| `POST /api/campaigns/{id}/approve` | Approve one version; requires `Idempotency-Key` |
| `GET /api/campaigns/{id}/outcome` | Delivery and seven-day outcome data |
| `POST /api/campaigns/{id}/demo/run-delivery` | Demo control: drain the mock queue |
| `POST /api/campaigns/{id}/demo/run-outcome` | Demo control: advance the fixed clock |
| `POST /api/demo/reset` | Demo control: clear the demo merchant's data for another rehearsal |
| `GET /api/healthz` | Liveness: database reachability, demo mode, planner, pending jobs (503 when the database is down) |
| `GET /api/readyz` | Readiness: every migration file applied (503 with the pending list otherwise) |

Errors share one shape: `{ "error": { "code", "message", "details", "request_id" } }`.

## Synthetic data

`data/fixtures/saathi-demo.csv` is committed and frozen: one synthetic Bengaluru merchant, 78 customers, 243 payment rows, including refunded and duplicate rows and a customer with three payments on a single date. At the fixed `as_of` date of 2026-09-01 it yields 24 absent regulars, of whom 20 have consent and a contact reference, 2 are consent-false and 2 are consent-unknown.

`payment_id` is an engineering extension: the PDF's minimum field list omits it, but reliable deduplication needs a stable identifier. A file without the column gets a derived hash and the batch is marked `derived_id`, which is **not** safe reconciliation for a real provider.

Names and contact references are visibly synthetic (`synthetic-sms:+91-5550-1001`).

## What this is not

No live Paytm integration or credentials. No real SMS, WhatsApp, email or customer contact. No autonomous transfers, lending, insurance or eligibility decisions. No inventory or profit inference. No generic CRM, chatbot or agent platform. No mobile app. No Kafka, Kubernetes or Redis.

## Limitations

- Authentication is a seeded demo session. Real merchant auth and tenant isolation must be chosen before any pilot.
- The database is shared by everyone who holds the connection string, and the demo reset clears the demo merchant for all of them. Tests use their own branch or a local server.
- The outcome window is simulated, not observed.
- The mock provider's behaviour is deterministic demo scaffolding, including one scripted timeout and one scripted failure so the reliability paths are visible during a demo.
- Event submission constraints beyond what the HackBriven page publishes are not verifiable from the available source.

## Local rehearsal

1. Set the three database URLs and optional Gemini key in ignored `.env`.
2. Run `pnpm install --frozen-lockfile`, `pnpm exec playwright install chromium`, `pnpm db:migrate`, `pnpm db:seed`, then `pnpm dev`.
3. The dev server binds to `127.0.0.1:3000`. Check health/readiness, load the CSV, inspect the audience and draft a campaign.
4. Compare offers, select ₹15, review generated terms, save and approve the new version.
5. Run mock delivery, then advance the simulated window. Pending delivery blocks simulation.
6. For the fixed ₹15 scenario, expect 10 jobs, 9 deliveries, 1 failure; 60% versus 20%; ₹90 reward cost and ₹630 contribution proxy.
7. Rehearse again after resetting the **disposable demo database**. Do not reset a shared presenting database without coordinating with its users.

Run `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm test:e2e` for essential checks. Tests require an explicit `TEST_DATABASE_URL`; browser tests reset that database's demo merchant. Do not run them alongside a demo using the same database. The SDK's inherited event-day version has an exact-version pnpm release-age exception; all other versions retain the age policy.

Additional limits: the CSV reader is line-oriented and does not support quoted multiline fields; imported payment conflicts are ignored, not reconciled as real refunds; demo consent comes from the first CSV row per customer. The mock executes manually rather than scheduling sends within proposed windows. These are pilot prerequisites, not production capabilities.

## Deploy to Render

[`render.yaml`](render.yaml) describes one web service (Node, Singapore region, `free` plan). In the Render dashboard choose **New → Blueprint**, pick this repository and branch `main`; Render reads the file and asks for the three secrets it does not carry: `DATABASE_URL` (pooled), `DATABASE_URL_UNPOOLED` (direct) and `GEMINI_API_KEY`. Paste them from your local `.env` or the Neon console.

What the Blueprint does differently from a local run:

- The start command binds to `0.0.0.0` (Render's port scan needs it); `pnpm start` keeps the loopback binding for local demos.
- `pnpm db:migrate` runs at the end of the build, because pre-deploy commands are paid-only on Render. It is idempotent and takes an advisory lock, so a rebuild against an already-migrated database is a no-op.
- The health check is `/api/readyz`, so a deploy never goes live until every migration is recorded.
- `SAATHI_DEMO_MODE=true` is required: the only session this build has is the seeded demo merchant. Anyone with the URL can use the demo controls, including **Reset demo data**. The data is synthetic and the provider is a mock, so nothing outside the database is touched.

Seed once after the first deploy if the database is empty: run `pnpm db:seed` locally against the same `DATABASE_URL`. The free plan sleeps after fifteen idle minutes and takes about a minute to wake; switch `plan` to `starter` for a live stage demo.

## License

No license has been selected yet. Do not assume this repository may be reused or redistributed until the project owner adds one.