"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import type { CampaignDetail, JobView } from "@/components/types";
import { popIn, Reveal, SplitText, TiltCard } from "@/components/motion";
import { apiCall, AuditTimeline, Banner, ErrorBanner, Icon, InitialLoad, Stat, StatusPill } from "@/components/ui";

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
      <div data-reveal>
        <div className="eyebrow">
          <span className="blink" /> Delivery
        </div>
        <div className="page-head">
          <h1>
            <SplitText text="Send your offer" accent="when you're ready" />
          </h1>
          <StatusPill status={detail.campaign.status} />
          <span className="pill neutral plain">version {detail.campaign.current_version}</span>
        </div>
        <p className="lede">
          Your approved offer is ready. Check the list below, then send it when it feels right.
        </p>
      </div>

      <div className="grid four">
        <Stat value={total} label="Customers in offer" tone="info" />
        <Stat value={summary.DELIVERED ?? 0} label="Sent" tone="ok" />
        <Stat value={(summary.FAILED ?? 0) + (summary.NEEDS_REVIEW ?? 0)} label="Needs attention" tone="bad" />
        <Stat value={detail.groups.holdout.length} label="Kept aside" />
      </div>

      <TiltCard className="card" data-reveal>
        <div className="actions">
          <span className={`radar${busy ? " on" : ""}`}>
            <button onClick={runDelivery} disabled={busy}>
              {busy ? <span className="spinner" /> : <Icon name="send" size={16} />}
              Send offer
            </button>
          </span>
          <a className="btn secondary" href={`/campaigns/${id}/outcome`}>
            See results <Icon name="arrow" size={15} />
          </a>
          <span className="tiny muted">
            {pending > 0 ? `${pending} message(s) are still being processed.` : "Nothing is waiting to be sent."}
          </span>
        </div>
        {total > 0 ? <JobStrip jobs={detail.jobs} busy={busy} /> : null}
        {lastRun ? (
          <p className="note">
            Last run: {lastRun.delivered} sent, {lastRun.failed} failed, {lastRun.unknown} timed out, {lastRun.needsReview} need review, {lastRun.cancelled} cancelled.
          </p>
        ) : null}
        <div style={{ marginTop: 12 }}>
          <ErrorBanner error={error} />
        </div>
      </TiltCard>

      <div className="card" data-reveal>
        <h3>Message status</h3>
        {total === 0 ? (
          <p className="muted">
            Nothing is ready yet. <a href={`/campaigns/${id}/review`}>Review the offer</a> first.
          </p>
        ) : (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Status</th>
                  <th className="num">Attempts</th>
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {recovered ? (
          <div style={{ marginTop: 12 }}>
            <Banner tone="info" icon="shield">
              One message took longer than expected and was checked before anything was sent again.
            </Banner>
          </div>
        ) : null}
        {(summary.UNKNOWN ?? 0) > 0 || (summary.NEEDS_REVIEW ?? 0) > 0 ? (
          <div style={{ marginTop: 12 }}>
            <Banner tone="warn" icon="alert">
              Some messages need your attention before we try them again.
            </Banner>
          </div>
        ) : null}
      </div>

      <div className="card" data-reveal>
        <h3>Activity</h3>
        <AuditTimeline events={detail.audit} />
      </div>
    </Reveal>
  );
}
