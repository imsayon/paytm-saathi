# Paytm Saathi engineering instructions

Read the canonical blueprint in `imsayon/paytm-saathi-docs` before changing product scope or architecture. The PDF specification is the primary product source; the HackBriven page supplies event facts only.

Keep the product focused on one merchant-retention workflow: signal, plan, review, approval, mock delivery, and outcome measurement. Do not turn it into a generic CRM, chatbot, autonomous-agent platform, payment system, or live Paytm integration.

Rules own eligibility, consent, budget, arithmetic, authorization, campaign state, delivery state, and metrics. The model drafts and explains. No provider call may occur before merchant approval. Preserve versioning, idempotency, consent rechecks, provider status checks, and audit events.

The database is Neon Postgres. Application traffic uses the pooled `DATABASE_URL`; migrations use the direct `DATABASE_URL_UNPOOLED`. Schema changes are new files in `db/migrations/` (never edit an applied migration). Tests need `TEST_DATABASE_URL` pointing at the Neon `test` branch or a local Postgres. Connection strings live only in `.env` and deployment secrets; never in code, docs, logs or commits.

Claude and Codex are working together through the shared docs repository. Do not treat them as separate product owners. Either side may challenge or improve a decision; record meaningful decisions and unresolved questions in the docs repository so both sides can continue from the same context.

Inspect status before editing, preserve unrelated work, validate the actual final state, and do not commit secrets or real customer data.

