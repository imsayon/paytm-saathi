# Development handoff

## Current state

The P0 vertical slice is implemented and verified locally: import, signal, cohort, bounded draft, review/revision, approval, persisted mock delivery, and the fixed-seed seven-day holdout report. 63 unit and integration tests and 2 Playwright smoke tests pass, and `next build` succeeds.

Start here:

```bash
npm install && npm run db:seed && npm run dev
```

See [`README.md`](../README.md) for architecture, the responsibility boundary, and the API.

## Non-negotiable checks

These are enforced in code and covered by tests. Do not weaken one without recording the decision in `paytm-saathi-docs`.

- No provider call before approval. Preview and revision never reach a provider; approval creates jobs but calls nothing.
- The holdout group receives no delivery job at all. It is the control.
- Consent is checked during cohort construction, again at approval, and again immediately before the provider call.
- A changed plan creates a new immutable version, expires the approval, and cancels queued jobs.
- Approval requires an `Idempotency-Key`; replay returns the original approval, a different key against an approved version conflicts.
- A provider timeout queries status with the same idempotency key before any retry, and never blindly re-sends.
- Outcome simulation is idempotent.
- Every state transition writes an audit event in the same transaction as the change.
- The planner receives aggregate counts only, never a contact reference or customer identifier.
- Results are labelled synthetic and descriptive; payment volume is never called profit.

## Where the rules live

One implementation, four call sites. `src/server/domain/rules.ts` `validateProposal()` runs at preview, revision, approval and the worker's pre-send check. If you need a new guard, add it there rather than in a route handler.

`src/server/domain/signal.ts` owns who is eligible. `src/server/domain/campaign.ts` owns versions, approval and job creation. Nothing else may create a `delivery_job`.

## Testing

```bash
npm test          # unit + integration
npm run test:e2e  # Playwright, runs against a production build
```

The e2e suite uses a throwaway database (`data/e2e.db`) and asserts the documented demo numbers, so a change that quietly breaks the 24/20 signal or the 60/20 outcome fails the build.

## Shared context

Claude and Codex use `paytm-saathi-docs` as shared working memory and a written conversation. Neither side is restricted to a permanent role. Record material changes there — the current decision log is `Implementation-Status-and-Decisions`, which supersedes eight points in the blueprint, including the correction that approval queues 10 jobs (campaign group only), not 20.
