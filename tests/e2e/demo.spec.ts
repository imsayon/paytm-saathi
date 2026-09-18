import { expect, test } from "@playwright/test";

test.beforeAll(async ({ request }) => {
  // Start from an empty demo merchant so the run asserts the documented numbers,
  // not leftovers from a previous run. The web server points at the test database.
  const ready = await request.get("/api/readyz");
  expect(ready.ok(), "migrations must be applied before the smoke test").toBeTruthy();
  const reset = await request.post("/api/demo/reset", { data: {} });
  expect(reset.ok()).toBeTruthy();
});

test("the full demo path runs from import to holdout report", async ({ page }) => {
  await page.goto("/");

  // 1. Import the frozen fixture.
  await page.getByRole("button", { name: "Load demo CSV" }).click();
  await expect(page.getByText("Regulars now absent 21+ days")).toBeVisible();

  // 2. The documented signal.
  await expect(page.locator(".card", { hasText: "Customers imported" }).locator(".stat")).toHaveText("78");
  await expect(page.locator(".card", { hasText: "Regulars now absent 21+ days" }).locator(".stat")).toHaveText("24");
  await expect(page.locator(".card", { hasText: "Eligible after consent" }).locator(".stat")).toHaveText("20");

  // 3. Inspect the audience and its exclusions.
  await page.getByRole("link", { name: "Inspect the audience" }).click();
  await expect(page.getByRole("heading", { name: "Why these customers?" })).toBeVisible();
  await expect(page.getByText("Eligible cohort (20)")).toBeVisible();
  await expect(page.getByText("Excluded from the audience (4)")).toBeVisible();
  await expect(page.locator(".split-label")).toContainText("Campaign 10");
  await expect(page.locator(".split-label")).toContainText("Holdout 10");

  // 4. Submit the merchant intent.
  await expect(page.locator("#intent")).toHaveValue(/weekday regulars/);
  await page.getByRole("button", { name: "Draft a campaign" }).click();

  // 5. The intentional rule boundary: ₹25 x 20 = ₹500 against a ₹300 cap.
  await expect(page.getByText("Rules blocked this plan.")).toBeVisible();
  await expect(page.getByText(/exceeds the ₹300.00 cap/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^Approve version/ })).toBeDisabled();

  // 6. Revise to a cap-safe offer with matching copy.
  await page.locator("#reward").fill("15");
  await page
    .locator("#body")
    .fill("It has been a while. Come by on a weekday this week and enjoy ₹15 off your order.");
  await page.getByRole("button", { name: "Save as version 2" }).click();

  await expect(page.getByText("All deterministic checks pass.")).toBeVisible();
  await expect(page.getByText("₹300.00").first()).toBeVisible();

  // 7. Approve exactly one version.
  await page.getByRole("button", { name: "Approve version 2" }).click();
  await expect(page).toHaveURL(/\/status$/);
  await expect(page.locator(".card", { hasText: "Jobs queued at approval" }).locator(".stat")).toHaveText("10");
  await expect(page.locator(".card", { hasText: "Holdout (never contacted)" }).locator(".stat")).toHaveText("10");

  // 8. Run the mock delivery, including the timeout that recovers via a status check.
  await page.getByRole("button", { name: "Run mock delivery" }).click();
  await expect(page.locator(".card", { hasText: "Delivered" }).locator(".stat")).toHaveText("9", { timeout: 30_000 });
  await expect(page.locator(".card", { hasText: "Failed or needs review" }).locator(".stat")).toHaveText("1");
  await expect(page.getByText("status_check_not_delivered")).toBeVisible();

  // 9. Advance the demo clock seven days.
  await page.getByRole("link", { name: "Go to outcome report" }).click();
  await page.getByRole("button", { name: "Advance demo clock seven days" }).click();

  // 10. Campaign versus holdout, with the caveats visible.
  await expect(page.locator(".card", { hasText: "Campaign return rate" }).locator(".stat")).toHaveText("60%", {
    timeout: 30_000,
  });
  await expect(page.locator(".card", { hasText: "Holdout return rate" }).locator(".stat")).toHaveText("20%");
  await expect(page.locator(".card", { hasText: "Descriptive difference" }).locator(".stat")).toHaveText("40 pp");
  await expect(page.getByText(/not proven causal impact/)).toBeVisible();

  // 11. The audit trail covers the whole path.
  const audit = page.locator(".timeline");
  await expect(audit).toContainText("campaign.created");
  await expect(audit).toContainText("campaign.version_changed");
  await expect(audit).toContainText("campaign.approved");
  await expect(audit).toContainText("jobs.queued");
  await expect(audit).toContainText("report.generated");
});

test("health and readiness report the Postgres backend", async ({ request }) => {
  const health = await (await request.get("/api/healthz")).json();
  expect(health.status).toBe("ok");
  expect(health.database).toBe("ready");
  expect(health.database_backend).toBe("postgres");
  expect(health.live_provider_integrations).toBe(0);

  const ready = await (await request.get("/api/readyz")).json();
  expect(ready.ready).toBe(true);
  expect(ready.pending_migrations).toEqual([]);
});

test("a malformed CSV upload is rejected with the offending row", async ({ request }) => {
  const csv = [
    "merchant_id,customer_id,paid_at,amount_minor,status,consent",
    "mch_demo_bengaluru,C1,2026-07-14T10:30:00+05:30,20000,settled,true",
    "mch_demo_bengaluru,C2,not-a-date,20000,settled,true",
  ].join("\n");
  const response = await request.post("/api/imports", { data: { csv, source_name: "broken.csv" } });
  expect(response.status()).toBe(400);
  const body = await response.json();
  expect(body.error.code).toBe("BAD_REQUEST");
  expect(body.error.message).toContain("Row 3");
});

test("approval without an Idempotency-Key is refused and demo controls stay gated", async ({ request }) => {
  const overview = await (await request.get("/api/overview")).json();
  const campaignId = overview.campaigns[0]?.id;
  expect(campaignId).toBeTruthy();

  const missingKey = await request.post(`/api/campaigns/${campaignId}/approve`, { data: { version: 2 } });
  expect(missingKey.status()).toBe(400);

  const stale = await request.post(`/api/campaigns/${campaignId}/approve`, {
    data: { version: 1 },
    headers: { "idempotency-key": "e2e-stale" },
  });
  expect(stale.status()).toBe(409);
});

test("the outcome simulation stays idempotent when re-run", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Open" }).first().click();
  await expect(page).toHaveURL(/\/review$/);

  const campaignUrl = page.url().replace("/review", "/outcome");
  await page.goto(campaignUrl);

  await page.getByRole("button", { name: "Re-run seven-day simulation" }).click();
  await expect(page.locator(".card", { hasText: "Campaign return rate" }).locator(".stat")).toHaveText("60%");
  await expect(page.locator(".card", { hasText: "Holdout return rate" }).locator(".stat")).toHaveText("20%");
});
