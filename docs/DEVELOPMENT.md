# Development handoff

## Current state

The P0 vertical slice is implemented and verified against Neon Postgres: import, signal, cohort, bounded draft, review/revision, approval, persisted mock delivery, and the fixed-seed seven-day holdout report. 68 unit and integration tests pass on both a local Postgres and the Neon `test` branch; 5 Playwright tests pass against a production build; the full browser path was walked by hand on the Neon `production` branch.

Start here:

```bash
npm install
cp .env.example .env     # paste the Neon pooled, direct and test connection strings
npm run db:migrate && npm run db:seed && npm run dev
```

See [`README.md`](../README.md) for architecture, the responsibility boundary, and the API.

## Database

- **Neon project** `paytm-saathi` (`sweet-silence-04926894`, region `aws-ap-southeast-1`, Postgres 17). Branch `production` is the default and holds demo data; branch `test` is disposable and is what `TEST_DATABASE_URL` should point to.
- **Two URLs.** `DATABASE_URL` is the pooled endpoint (host contains `-pooler`) and serves the app and worker. `DATABASE_URL_UNPOOLED` is the direct endpoint and serves `npm run db:migrate`. The pooler runs in transaction mode, so nothing in the app relies on session state; every multi-statement unit of work is an explicit transaction on one checked-out client (`Db.transaction`).
- **Migrations are files.** `db/migrations/NNNN_name.sql`, applied in order by `scripts/migrate.ts`, recorded with a checksum in `schema_migration`. An applied file whose checksum changed fails the run — add a new file instead. `GET /api/readyz` reports pending migrations.
- **Types.** Money is `INTEGER` paise. Calendar dates are `DATE` and come back as `YYYY-MM-DD` strings. Timestamps are `TIMESTAMPTZ` and come back as ISO strings. JSON documents (`proposal`, `rule_result`, audit `details`) are `JSONB` and come back parsed. `seq BIGSERIAL` columns preserve insertion order where the domain depends on it (consent history, audit order, job claim order).
- **Concurrency.** Approval, revision and simulation lock the campaign row with `FOR UPDATE`. The worker claims with `FOR UPDATE SKIP LOCKED`. Both are covered by tests that run the operations concurrently.
- **Secrets.** Connection strings live only in `.env` (git-ignored) or deployment secrets. Do not paste them into docs, issues, logs or commits. Rotate the role password from the Neon console if one leaks.

## Non-negotiable checks

These are enforced in code and covered by tests. Do not weaken one without recording the decision in `paytm-saathi-docs`.

- No provider call before approval. Preview and revision never reach a provider; approval creates jobs but calls nothing.
- The holdout group receives no delivery job at all. It is the control.
- Consent is checked during cohort construction, again at approval, and again immediately before the provider call.
- A changed plan creates a new immutable version, expires the approval, and cancels queued jobs.
- Approval requires an `Idempotency-Key`; replay returns the original approval, a different key against an approved version conflicts, and concurrent approvals with different keys produce exactly one approval.
- A provider timeout queries status with the same idempotency key before any retry, and never blindly re-sends.
- Outcome simulation is idempotent and refused before approval.
- Every state transition writes an audit event in the same transaction as the change.
- The planner receives aggregate counts only, never a contact reference or customer identifier.
- Results are labelled synthetic and descriptive; payment volume is never called profit.

## Where the rules live

One implementation, four call sites. `src/server/domain/rules.ts` `validateProposal()` runs at preview, revision, approval and the worker's pre-send check. If you need a new guard, add it there rather than in a route handler.

`src/server/domain/signal.ts` owns who is eligible. `src/server/domain/campaign.ts` owns versions, approval and job creation. Nothing else may create a `delivery_job`.

Inside `Db.transaction(async (tx) => ...)` every query must go through `tx`. Using the outer pool handle inside the callback would run outside the transaction; the helper cannot detect that for you.

## Testing

```bash
npm test          # unit + integration; needs TEST_DATABASE_URL
npm run test:e2e  # Playwright against a production build; needs TEST_DATABASE_URL
```

`tests/helpers.ts` creates one schema per `tempDb()` call (`saathi_test_<random>`), runs the migrations into it, and drops it after the test. Against a local Postgres the suite takes a few seconds; against the Neon `test` branch about two minutes, because the worker tests make a hundred-odd sequential round trips each.

The e2e suite asserts the documented demo numbers (78 customers, 24/20 signal, ₹500 rejection, ₹300 approval, 9/1 delivery, 60%/20% outcome), so a change that quietly breaks them fails the build. It resets the demo merchant on the test database before it starts.

## Shared context

Claude and Codex use `paytm-saathi-docs` as shared working memory and a written conversation. Neither side is restricted to a permanent role. Record material changes there — the current decision log is `Implementation-Status-and-Decisions`, and the Neon migration is recorded in `Neon-Migration-and-Verification`.
