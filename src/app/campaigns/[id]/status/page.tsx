"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import type { CampaignDetail, JobView } from "@/components/types";
import { popIn, Reveal, SplitText, TiltCard } from "@/components/motion";
import { apiCall, AuditTimeline, Banner, DemoBanner, ErrorBanner, Icon, InitialLoad, Stat, StatusPill, Steps } from "@/components/ui";

const OUTCOME_LABEL: Record<string, string> = {
  delivered: "delivered",
  failed: "failed",
  timeout: "timed out",
  status_check_not_delivered: "status check: not delivered",
  status_check_delivered: "status check: delivered",
  status_check_unavailable: "status check: unavailable",
};

function JobStrip({ jobs, busy }: { jobs: JobView[]; busy: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const signature = jobs.map((job) => job.status).join(",");

  useEffect(() => {
    const host = root.current;
    if (!host) return;
    const timeline = popIn(Array.from(host.querySelectorAll<HTMLElement>(".job-chip")), 45);
    return () => {
      timeline?.cancel();
    };
  }, [signature]);

  return (
    <div ref={root} className="job-strip" aria-label="Delivery jobs by status">
      {jobs.map((job) => (
        <div key={job.job_id} className={`job-chip ${job.status}${busy && !["DELIVERED", "FAILED", "CANCELLED", "NEEDS_REVIEW"].includes(job.status) ? " busy" : ""}`}>
          <span className="dot" />
          <code>{job.customer_ref}</code>
          <span>{job.status.replaceAll("_", " ").toLowerCase()}</span>
        </div>
      ))}
    </div>
  );
}

export default function StatusPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [error, setError] = useState<{ message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastRun, setLastRun] = useState<{ processed: number; delivered: number; failed: number; unknown: number; needsReview: number; cancelled: number } | null>(null);

  const load = useCallback(async () => {
    setError(null);
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
      const result = await apiCall<{ campaign: CampaignDetail; worker: { processed: number; delivered: number; failed: number; unknown: number; needsReview: number; cancelled: number } }>(
        `/api/campaigns/${id}/demo/run-delivery`,
        { method: "POST", body: JSON.stringify({}) },
      );
      setDetail(result.campaign);
      setLastRun(result.worker);
    } catch (caught) {
      setError(caught as Error);
    } finally {
      setBusy(false);
    }
  }

  if (!detail) return <InitialLoad error={error} retry={() => void load()} />;

  const summary = detail.job_summary;
  const pending = (summary.QUEUED ?? 0) + (summary.PROCESSING ?? 0) + (summary.UNKNOWN ?? 0);
  const total = detail.jobs.length;
  const recovered = detail.jobs.some((job) => job.attempt_log.some((attempt) => attempt.outcome === "status_check_not_delivered"));

  return (
    <Reveal ready refreshKey={`${total}:${pending}`}>
      <DemoBanner />
      <Steps current="delivery" campaignId={id} />

      <div data-reveal>
        <div className="eyebrow">
          <span className="blink" /> Step 4 · mock delivery
        </div>
        <div className="page-head">
          <h1>
            <SplitText text="Delivery," accent="one idempotent job at a time" />
          </h1>
          <StatusPill status={detail.campaign.status} />
          <span className="pill neutral plain">version {detail.campaign.current_version}</span>
          {detail.provider.live ? (
            <span className="pill bad">provider: {detail.provider.name} · live messages</span>
          ) : (
            <span className="pill warn plain">provider: {detail.provider.name} (no real messages)</span>
          )}
        </div>
        <p className="lede">
          Jobs exist because approval committed them — the preview never called a provider. Each job carries a stable provider
          idempotency key, and consent is checked once more immediately before the provider is invoked.
        </p>
      </div>

      <div className="grid four">
        <Stat value={total} label="Jobs queued at approval" tone="info" />
        <Stat value={summary.DELIVERED ?? 0} label="Delivered" tone="ok" />
        <Stat value={(summary.FAILED ?? 0) + (summary.NEEDS_REVIEW ?? 0)} label="Failed or needs review" tone="bad" />
        <Stat value={detail.groups.holdout.length} label="Holdout (never contacted)" />
      </div>

      <TiltCard className="card" data-reveal>
        <div className="actions">
          <span className={`radar${busy ? " on" : ""}`}>
            <button onClick={runDelivery} disabled={busy}>
              {busy ? <span className="spinner" /> : <Icon name="send" size={16} />}
              Run mock delivery
            </button>
          </span>
          <a className="btn secondary" href={`/campaigns/${id}/outcome`}>
            Go to outcome report <Icon name="arrow" size={15} />
          </a>
          <span className="tiny muted">
            {pending > 0 ? `${pending} job(s) still pending.` : "No pending jobs."} Re-running is safe: delivered jobs are terminal and
            are not re-sent.
          </span>
        </div>
        {total > 0 ? <JobStrip jobs={detail.jobs} busy={busy} /> : null}
        {lastRun ? (
          <p className="note">
            Last run processed {lastRun.processed} job step(s): {lastRun.delivered} delivered, {lastRun.failed} failed, {lastRun.unknown} timed out,{" "}
            {lastRun.needsReview} for review, {lastRun.cancelled} cancelled before any provider call.
          </p>
        ) : null}
        <div style={{ marginTop: 12 }}>
          <ErrorBanner error={error} />
        </div>
      </TiltCard>

      <div className="card" data-reveal>
        <h3>Delivery jobs</h3>
        {total === 0 ? (
          <p className="muted">
            No jobs yet. Jobs are created only by a successful approval — <a href={`/campaigns/${id}/review`}>review</a> the campaign
            first.
          </p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Status</th>
                  <th className="num">Attempts</th>
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
                    <td className="num">{job.attempts}</td>
                    <td>
                      <code>{job.provider_key.slice(0, 18)}…</code>
                    </td>
                    <td className="tiny muted">
                      {job.attempt_log.map((attempt) => (
                        <div key={attempt.attempt_no}>
                          #{attempt.attempt_no} {attempt.outcome}
                          {OUTCOME_LABEL[attempt.outcome] && OUTCOME_LABEL[attempt.outcome] !== attempt.outcome ? (
                            <span className="muted"> · {OUTCOME_LABEL[attempt.outcome]}</span>
                          ) : null}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {recovered ? (
          <div style={{ marginTop: 12 }}>
            <Banner tone="info" icon="shield">
              One job timed out. The worker asked the provider for status with the same idempotency key, got proof that nothing was
              delivered, and only then sent again. A blind retry never happens.
            </Banner>
          </div>
        ) : null}
        {(summary.UNKNOWN ?? 0) > 0 || (summary.NEEDS_REVIEW ?? 0) > 0 ? (
          <div style={{ marginTop: 12 }}>
            <Banner tone="warn" icon="alert">
              A provider timeout never triggers a blind retry. The worker asks the provider for status using the same idempotency key
              and only re-sends when status proves nothing was delivered; otherwise the job stops for manual review.
            </Banner>
          </div>
        ) : null}
      </div>

      <div className="card" data-reveal>
        <h3>Audit trail</h3>
        <AuditTimeline events={detail.audit} />
      </div>
    </Reveal>
  );
}
