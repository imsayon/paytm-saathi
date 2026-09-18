# Paytm Saathi

Paytm Saathi is a bounded merchant-retention workflow for the Paytm Build for India AI Hackathon - Bengaluru Edition. It helps a small merchant find repeat customers who appear to have stopped returning, filter them by consent, propose one measured offer, obtain merchant approval, simulate delivery, and compare campaign results with a holdout group.

The product source of truth is the private [`imsayon/paytm-saathi-docs`](https://github.com/imsayon/paytm-saathi-docs) repository. It contains the PDF specification, the implementation blueprint, hackathon context, decisions, and the shared Claude/Codex working notes.

> **This is a demo build.** The data is synthetic, the merchant session is a development-only stub, and the only delivery provider is a mock. There is no Paytm integration and no real customer is ever contacted.

## The one loop this product does

```
CSV import -> retention signal -> deterministic eligible cohort -> bounded AI copy draft
  -> merchant review/edit -> approval -> persisted mock delivery -> seven-day holdout report
```

The boundary that matters: **no provider call exists until merchant approval succeeds.** Preview, drafting and revision never touch a provider. Approval is a single transaction that writes the approval, the delivery jobs and the audit event together — and still calls nothing.

## Quick start

```bash
npm install
npm run db:seed
npm run dev
```

Open http://localhost:3000 and follow the five numbered steps in the header.

`npm run db:seed` creates the SQLite schema, seeds the demo merchant, imports the frozen fixture and prints the resulting signal. It is safe to re-run: the import is checksum-idempotent.

Optional, for the model-backed planner:

```bash
cp .env.example .env
# set OPENAI_API_KEY=sk-...
```

Without a key the planner uses a deterministic template and labels every proposal `template fallback`, in the UI and in the audit trail. The demo runs end to end with no key, no network and no account.

### Commands

| Command | What it does |
|---|---|
| `npm run dev` | Next.js app and API on port 3000 |
| `npm run db:migrate` | Create/verify the SQLite schema |
| `npm run db:seed` | Seed merchant, import the fixture, print the signal |
| `npm run worker` | Run the delivery worker as its own process |
| `npm test` | Unit and integration tests (Node's test runner) |
| `npm run test:e2e` | Playwright smoke test of the whole demo path |
| `npm run typecheck` | TypeScript, no emit |
| `npx tsx scripts/generate-fixture.ts` | Regenerate the committed fixture CSV |

The UI has demo controls for delivery and the outcome clock, so a presenter never needs a second terminal. `npm run worker` exists to show the same jobs being drained by a real background process.

## Who owns what

This is the whole safety argument, so it is worth stating plainly.

**Rules own** CSV parsing, payment-state handling, refund and duplicate exclusion, repeat-customer detection, inactivity windows, consent and contactability, audience selection, campaign/holdout assignment, budget arithmetic, campaign versioning, approval authorization, campaign and delivery state, outcome calculation, and audit events.

**The model may** draft campaign copy, explain the proposed targeting, suggest a bounded offer, and suggest timing inside an allowed policy window.

**The model may not** select customers, override consent, change the budget cap, approve anything, change campaign state, call a provider, or compute any authoritative number. It has no tools, no network beyond the single completion call, and no provider credentials. Its cost estimate is advisory; rules recompute it and the rule figure wins.

What the planner receives is aggregate only: cohort counts, the inactivity window, the cap, the allowed offer shape, exclusion counts, policy version and timezone. No contact reference, customer identifier or payment row is ever sent. A test asserts this.

## Architecture

One TypeScript application. One SQLite database. One optional worker process.

```
src/app/                 Next.js routes: 5 merchant screens + the API
src/server/
  config.ts              Environment configuration
  auth/context.ts        Development-only merchant session (refuses outside demo mode)
  db/                    SQLite client (WAL), schema, write transactions
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

SQLite with WAL and `BEGIN IMMEDIATE` around approval is deliberate: one host, one writer, recoverable, and no infrastructure that exists only to look distributed. Move to Postgres and a managed queue when concurrent merchants, high availability or multi-host workers become real requirements — not before.

## Reliability

- **Import** is idempotent on `(merchant_id, checksum)` and validates the entire file before publishing any row.
- **Approval** requires an `Idempotency-Key`. The same key replays the original approval; a different key against an approved version is a `409`; a stale version is a `409`.
- **Jobs** are unique per `(version_id, recipient_id)` and carry a stable provider idempotency key.
- **The worker** claims jobs with a conditional update and a lease. A second worker cannot take a live lease; an expired lease is reclaimed after a crash.
- **Consent and version are re-checked immediately before every provider call.** A revoked consent cancels the job without contacting the provider.
- **A timeout never triggers a blind retry.** The worker asks the provider for status using the same idempotency key and re-sends only when status proves nothing was delivered. An unresolvable status becomes `NEEDS_REVIEW` and stops.
- **Outcome simulation** is idempotent on `(campaign_id, customer_id, window_start)`.
- Every material transition writes an audit event inside the same transaction as the state change.

## Measurement, stated honestly

The report shows campaign versus holdout return rates, the descriptive percentage-point difference, estimated incremental returns, return volume, reward cost, and a contribution proxy — each with its formula visible in the UI.

Three things it deliberately does not claim:

1. **It is not profit.** Payment volume does not reveal margin, messaging cost or support cost. The figure is labelled "contribution proxy after reward".
2. **It is not causal evidence.** The outcome comes from a fixed-seed simulator over synthetic data. It demonstrates the measurement shape and holdout discipline, nothing more.
3. **It is not statistically powered.** Ten customers per group is an illustration, not an experiment.

## Security and trust

Tenant-scoped reads and writes with cross-merchant authorization tests; a development-only merchant session that refuses to resolve outside demo mode; upload size and row limits; strict parsing of money, dates and states; neutralised spreadsheet formula content; masked identifiers in the UI and logs; redacted log fields; rate limits on import and preview; aggregate-only planner input; untrusted merchant intent delimited inside a fixed system instruction; no model tools; environment-based secrets.

The demo endpoints under `/api/campaigns/{id}/demo/` are refused unless `SAATHI_DEMO_MODE=true`.

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
| `GET /api/healthz` | Database, demo mode, planner, pending jobs |

Errors share one shape: `{ "error": { "code", "message", "details", "request_id" } }`.

## Synthetic data

`data/fixtures/saathi-demo.csv` is committed and frozen: one synthetic Bengaluru merchant, 78 customers, 243 payment rows, including refunded and duplicate rows and a customer with three payments on a single date. At the fixed `as_of` date of 2026-09-01 it yields 24 absent regulars, of whom 20 have consent and a contact reference, 2 are consent-false and 2 are consent-unknown.

`payment_id` is an engineering extension: the PDF's minimum field list omits it, but reliable deduplication needs a stable identifier. A file without the column gets a derived hash and the batch is marked `derived_id`, which is **not** safe reconciliation for a real provider.

Names and contact references are visibly synthetic (`synthetic-sms:+91-5550-1001`).

## What this is not

No live Paytm integration or credentials. No real SMS, WhatsApp, email or customer contact. No autonomous transfers, lending, insurance or eligibility decisions. No inventory or profit inference. No generic CRM, chatbot or agent platform. No mobile app. No Kafka, Kubernetes or Redis.

## Limitations

- Authentication is a seeded demo session. Real merchant auth and tenant isolation must be chosen before any pilot.
- SQLite is single-writer and single-host by design here.
- The outcome window is simulated, not observed.
- The mock provider's behaviour is deterministic demo scaffolding, including one scripted timeout and one scripted failure so the reliability paths are visible during a demo.
- Event submission constraints beyond what the HackBriven page publishes are not verifiable from the available source.

## License

No license has been selected yet. Do not assume this repository may be reused or redistributed until the project owner adds one.
