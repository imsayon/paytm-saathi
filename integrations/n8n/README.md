# Saathi + n8n event bridge

This export gives the hackathon demo a safe automation story without moving the approval or delivery authority into n8n.

1. Import `paytm-saathi-event-router.json` into n8n.
2. Set the n8n environment variable `SAATHI_N8N_SECRET` to the same random value as the app's `N8N_WEBHOOK_SECRET`.
3. Activate the workflow and copy its production webhook URL into `N8N_WEBHOOK_URL` on the app.
4. Redeploy the app, or run the worker once, so pending events drain from Neon.
5. Attach Slack, Gmail, Teams or Notion nodes after `Acknowledge safe action` if you want operator notifications or a decision log. Keep those credentials in n8n, never in the app repository.

The app signs each JSON payload with HMAC-SHA256. The workflow verifies the signature and emits one of four safe routes:

- `operator_review` for delivery states that need a human decision;
- `report_ready` for a descriptive campaign/holdout report;
- `campaign_monitoring` for approval and queue events; and
- `audit` for the remaining retained domain events.

n8n must not approve campaigns, select recipients, override consent, change the budget, or call a provider. Those actions stay behind Saathi's deterministic rules and merchant approval. Payloads contain aggregate facts and opaque merchant/campaign event IDs; contact references and customer identifiers are never sent.

If `N8N_WEBHOOK_URL` or its secret is absent, events stay in Neon as `skipped` and the core workflow remains fully usable. If a webhook is flaky, the retained `integration_event` queue retries five times and then marks the event `failed` for inspection.
