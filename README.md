# Paytm Saathi

Paytm Saathi is a bounded merchant-retention workflow for the Paytm Build for India AI Hackathon - Bengaluru Edition. It helps a small merchant find repeat customers who appear to have stopped returning, filter them by consent, propose one measured offer, obtain merchant approval, simulate delivery, and compare campaign results with a holdout group.

The product source of truth is the private [`imsayon/paytm-saathi-docs`](https://github.com/imsayon/paytm-saathi-docs) repository. It contains the PDF specification, the implementation blueprint, hackathon context, decisions, and the shared Claude/Codex working notes.

## Claude and Codex working together

Claude and Codex are working together on the same product. We are not dividing the product into separate ownership silos. We use `paytm-saathi-docs` as shared working memory and a written conversation: either side can add research, challenge a decision, improve the plan, propose implementation changes, or review the result. The human project owner remains the final decision-maker.

This is the Codex end of that collaboration: the place where repository changes, implementation, tests, and local verification happen. “Codex end” does not mean a separate product direction or a permanent role boundary.

## Current status

The repository has been corrected and initialized for Paytm Saathi. The current milestone is the P0 demo vertical slice; the runtime implementation still needs to be built from the documented blueprint.

## Product boundary

The MVP is:

`CSV import -> retention signal -> deterministic eligible cohort -> bounded AI copy draft -> merchant review/edit -> approval -> persisted mock delivery -> seven-day holdout report`

Rules own eligibility, consent, budget, arithmetic, campaign state, authorization, and delivery state. The model drafts and explains. No provider call exists before merchant approval.

The MVP excludes live Paytm integration, real customer outreach, autonomous transfers, lending/insurance decisions, inventory/profit inference, generic CRM, and unrestricted agent behavior.

## Repository map

- [`docs/`](docs/README.md): implementation-facing notes.
- [`AGENTS.md`](AGENTS.md): project instructions for future agents.
- [`paytm-saathi-docs`](https://github.com/imsayon/paytm-saathi-docs): canonical product and research documents.

## Source status

The PDF and event page define the product and hackathon context. The event page does not publish Paytm APIs, technology requirements, a judging rubric, or authorization for real customer messaging. Those items remain unverified and are not assumed here.

## License

No license has been selected yet. Do not assume this repository may be reused or redistributed until the project owner adds one.

