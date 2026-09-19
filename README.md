# Paytm Saathi

Saathi is a merchant retention workspace designed to sit on top of the Paytm ecosystem. It turns payment activity into a reviewable retention campaign while keeping the merchant in control of the audience, offer and approval.

## Workflow

```text
CSV / canonical REST events
        ↓
validated source data in Neon
        ↓
retention rules
        ↓
merchant shortlist
        ↓
Gemini campaign draft
        ↓
merchant review and approval
        ↓
delivery provider
        ↓
holdout comparison and reporting
```

The model drafts the explanation, offer wording and message copy from aggregate cohort facts. Rules decide eligibility, consent, contactability, cohort size and budget. The merchant chooses important customers and approves every campaign before delivery.

## Stack

- Next.js 16, React 19 and TypeScript
- Neon Postgres and Neon Auth
- Gemini through the OpenAI-compatible API
- Twilio adapter for SMS or WhatsApp delivery
- n8n signed event outbox
- Cognee memory mirror, with Neon as the source of truth
- Render web service and database-backed worker queue

## Local development

```bash
cp .env.example .env
pnpm install
pnpm db:migrate
pnpm dev
```

The application reads the pooled Neon connection from `DATABASE_URL`. `DATABASE_URL_UNPOOLED` is used for migrations. Set `SAATHI_DEMO_MODE=false` for the authenticated workspace. The browser dataset builder can create a new payment file of up to 10,000 rows, or a merchant can upload a CSV directly.

## Environment

Required for an authenticated deployment:

```text
DATABASE_URL
DATABASE_URL_UNPOOLED
NEON_AUTH_BASE_URL
NEON_AUTH_COOKIE_SECRET
SAATHI_CONNECTOR_API_KEY
```

Optional integrations:

```text
GEMINI_API_KEY
SAATHI_GEMINI_MODEL
SAATHI_DELIVERY_PROVIDER=twilio
TWILIO_ACCOUNT_SID
TWILIO_AUTH_TOKEN
TWILIO_FROM
TWILIO_SEND_WAIT_MS
PUBLIC_BASE_URL
N8N_WEBHOOK_URL
N8N_WEBHOOK_SECRET
COGNEE_BASE_URL
COGNEE_API_KEY
```

Keep values in the local `.env` or the Render environment settings. Do not commit credentials.

## CSV contract

Required columns:

```text
merchant_id, customer_id, paid_at, amount_minor, status, consent
```

Useful optional columns include `customer_name`, `contact_ref`, `payment_id`, `consent_channel`, `consent_expires_at`, `customer_segment`, `loyalty_tier`, `preferred_channel`, `language`, `area`, `important` and `importance_note`. Additional columns are retained on the customer profile for downstream analysis.

Canonical integrations use the same normalized entities through the signed connector endpoint. CSV is one adapter; it is not the product boundary.

## Commands

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm worker
```

Render runs `pnpm install --frozen-lockfile --prod=false && pnpm build && pnpm db:migrate` and serves Next.js on `0.0.0.0`. Health checks use `/api/readyz`.

## Operational boundary

Neon is authoritative for merchant data, campaigns, delivery jobs, outcomes, audit events and memory. n8n and Cognee are integrations around that source of truth. Live delivery requires explicit Twilio credentials and the `twilio` provider setting; otherwise no external message provider is contacted.
