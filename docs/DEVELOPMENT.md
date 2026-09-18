# Development handoff

## First vertical slice

Build the smallest complete workflow:

1. Load the deterministic synthetic CSV.
2. Show the repeat-customer retention signal and consent exclusions.
3. Generate a bounded AI or template proposal.
4. Validate the offer and budget with deterministic rules.
5. Let the merchant edit and approve one immutable version.
6. Persist idempotent mock delivery jobs.
7. Simulate the seven-day outcome window.
8. Report campaign versus holdout return behavior.

## Shared context

Claude and Codex use `paytm-saathi-docs` as shared working memory and a written conversation. Neither side is restricted to a permanent role. Research, architecture, implementation, review, and corrections can move in either direction; record material changes there.

## Non-negotiable checks

- No provider call before approval.
- Consent is checked during cohort construction and immediately before delivery.
- Changed plans invalidate approval.
- Provider timeouts check status before retrying.
- Every state transition writes an audit event.
- Synthetic results are labelled synthetic and descriptive.

