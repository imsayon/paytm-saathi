"use client";

import { use, useCallback, useEffect, useState } from "react";
import type { CampaignDetail } from "@/components/types";
import { apiCall, AuditTimeline, DemoBanner, ErrorBanner, Stat, StatusPill, Steps } from "@/components/ui";

export default function StatusPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [error, setError] = useState<{ message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(await apiCall<CampaignDetail>(`/api/campaigns/${id}`));
    } catch (caught) {
      setError(caught as Error);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runDelivery() {
    setBusy(true);
    setError(null);
    try {
      const result = await apiCall<{ campaign: CampaignDetail }>(`/api/campaigns/${id}/demo/run-delivery`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setDetail(result.campaign);
    } catch (caught) {
      setError(caught as Error);
    } finally {
      setBusy(false);
    }
  }

  if (!detail) {
    return (
      <div className="card">
        <div className="skeleton" style={{ width: "50%" }} />
      </div>
    );
  }

  const summary = detail.job_summary;
  const pending = (summary.QUEUED ?? 0) + (summary.PROCESSING ?? 0) + (summary.UNKNOWN ?? 0);
  const total = detail.jobs.length;

  return (
    <>
      <DemoBanner />
      <Steps current="delivery" />

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
        <h1 style={{ margin: 0 }}>Delivery</h1>
        <StatusPill status={detail.campaign.status} />
        <span className="pill neutral">version {detail.campaign.current_version}</span>
        <span className="pill warn">provider: {detail.provider.name} (no real messages)</span>
      </div>
      <p className="lede">
        Jobs exist because approval committed them — the preview never called a provider. Each job carries a stable
        provider idempotency key, and consent is checked once more immediately before the provider is invoked.
      </p>

      <div className="grid four">
        <Stat value={total} label="Jobs queued at approval" />
        <Stat value={summary.DELIVERED ?? 0} label="Delivered" tone="ok" />
        <Stat value={(summary.FAILED ?? 0) + (summary.NEEDS_REVIEW ?? 0)} label="Failed or needs review" tone="bad" />
        <Stat value={detail.groups.holdout.length} label="Holdout (never contacted)" />
      </div>

      <div className="card">
        <div className="actions">
          <button onClick={runDelivery} disabled={busy}>
            {busy ? <span className="spinner" /> : null}
            Run mock delivery
          </button>
          <a className="btn secondary" href={`/campaigns/${id}/outcome`}>
            Go to outcome report
          </a>
          <span className="tiny muted">
            {pending > 0 ? `${pending} job(s) still pending.` : "No pending jobs."} Re-running is safe: delivered jobs
            are terminal and are not re-sent.
          </span>
        </div>
        <div style={{ marginTop: 12 }}>
          <ErrorBanner error={error} />
        </div>
      </div>

      <div className="card">
        <h3>Delivery jobs</h3>
        {total === 0 ? (
          <p className="muted">
            No jobs yet. Jobs are created only by a successful approval — <a href={`/campaigns/${id}/review`}>review</a>{" "}
            the campaign first.
          </p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Status</th>
                  <th>Attempts</th>
                  <th>Provider idempotency key</th>
                  <th>Attempt log</th>
                </tr>
              </thead>
              <tbody>
                {detail.jobs.map((job) => (
                  <tr key={job.job_id}>
                    <td>
                      <code>{job.customer_ref}</code>
                    </td>
                    <td>
                      <StatusPill status={job.status} />
                      {job.cancel_reason ? <div className="tiny muted">{job.cancel_reason}</div> : null}
                    </td>
                    <td>{job.attempts}</td>
                    <td>
                      <code>{job.provider_key.slice(0, 18)}…</code>
                    </td>
                    <td className="tiny muted">
                      {job.attempt_log.map((attempt) => (
                        <div key={attempt.attempt_no}>
                          #{attempt.attempt_no} {attempt.outcome}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {(summary.UNKNOWN ?? 0) > 0 || (summary.NEEDS_REVIEW ?? 0) > 0 ? (
          <div className="banner warn" style={{ marginTop: 12 }}>
            A provider timeout never triggers a blind retry. The worker asks the provider for status using the same
            idempotency key and only re-sends when status proves nothing was delivered; otherwise the job stops for
            manual review.
          </div>
        ) : null}
      </div>

      <div className="card">
        <h3>Audit trail</h3>
        <AuditTimeline events={detail.audit} />
      </div>
    </>
  );
}
