"use client";

import { use, useCallback, useEffect, useState } from "react";
import type { CampaignDetail, MeasurementReport } from "@/components/types";
import { AnimatedBar, CountUp, Reveal, SplitText, TiltCard } from "@/components/motion";
import { apiCall, AuditTimeline, Banner, ErrorBanner, Icon, InitialLoad, KeyValue, percent, rupees, Stat, StatusPill } from "@/components/ui";

type OutcomeResponse = {
  campaign: CampaignDetail["campaign"];
  version: CampaignDetail["version"];
  proposal: CampaignDetail["proposal"];
  groups: { campaign: number; holdout: number };
  delivery: { summary: Record<string, number>; jobs: CampaignDetail["jobs"]; provider: { name: string } };
  report: MeasurementReport;
  setup_seconds: number | null;
  audit: CampaignDetail["audit"];
};

/** Emphasis chart: the campaign series in the accent hue, the holdout in the de-emphasis gray. */
function RateBar({ label, rate, returns, size, holdout }: { label: string; rate: number; returns: number; size: number; holdout?: boolean }) {
  return (
    <div className="bar-row">
      <span className="tiny" style={{ fontWeight: 650 }}>
        {label}
      </span>
      <div className="bar-track" title={`${label}: ${returns} of ${size} returned`}>
        <AnimatedBar fraction={rate} className={`bar-fill ${holdout ? "holdout" : ""}`} />
      </div>
      <span className="tiny" style={{ fontVariantNumeric: "tabular-nums" }}>
        {percent(rate)} ({returns}/{size})
      </span>
    </div>
  );
}

export default function OutcomePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<OutcomeResponse | null>(null);
  const [error, setError] = useState<{ message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await apiCall<OutcomeResponse>(`/api/campaigns/${id}/outcome`));
    } catch (caught) {
      setError(caught as Error);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runOutcome() {
    setBusy(true);
    setError(null);
    try {
      await apiCall(`/api/campaigns/${id}/demo/run-outcome`, { method: "POST", body: JSON.stringify({}) });
      await load();
    } catch (caught) {
      setError(caught as Error);
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <InitialLoad error={error} retry={() => void load()} />;

  const report = data.report;

  return (
    <Reveal ready refreshKey={`${report.has_outcomes}:${report.campaign.returns}`}>
      <div data-reveal>
        <div className="eyebrow">
          <span className="blink" /> Results
        </div>
        <div className="page-head">
          <h1>
            <SplitText text="How it went" accent="after seven days" />
          </h1>
          <StatusPill status={data.campaign.status} />
          <span className="pill neutral plain">version {data.version.version}</span>
        </div>
        <p className="lede">
          Compare the customers who received the offer with the customers kept aside. This gives you a clear view of what happened.
        </p>
      </div>

      <TiltCard className="card" data-reveal>
        <div className="actions">
          <span className={`radar${busy ? " on" : ""}`}>
            <button onClick={runOutcome} disabled={busy}>
              {busy ? <span className="spinner" /> : <Icon name="clock" size={16} />}
              {report.has_outcomes ? "Refresh results" : "Check results"}
            </button>
          </span>
          <a className="btn secondary" href={`/campaigns/${id}/status`}>
            Back to delivery
          </a>
          <span className="tiny muted">You can refresh these results any time.</span>
        </div>
        <div style={{ marginTop: 12 }}>
          <ErrorBanner error={error} />
        </div>
      </TiltCard>

      {!report.has_outcomes ? (
        <div className="card" data-reveal>
          <h2>Results are not ready yet</h2>
          <p className="muted" style={{ marginBottom: 0 }}>
            Send the offer first, then check back after seven days.
          </p>
        </div>
      ) : (
        <>
          <div className="grid four">
            <Stat value={percent(report.campaign.return_rate)} label="Offer group return rate" tone="ok" />
            <Stat value={percent(report.holdout.return_rate)} label="Kept aside return rate" />
            <Stat value={`${report.observed_lift_pp} pp`} label="Difference" tone="info" />
            <Stat value={report.expected_incremental_returns} label="Extra returns" />
          </div>

          <div className="grid two">
            <TiltCard className="card" data-reveal>
              <h3>Offer group versus kept aside</h3>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
                <span className="stat hero-number">
                  <CountUp value={`${report.observed_lift_pp} pp`} duration={1600} />
                </span>
                <span className="tiny muted">difference in return rate</span>
              </div>
              <RateBar label="Campaign" rate={report.campaign.return_rate} returns={report.campaign.returns} size={report.campaign.size} />
              <RateBar label="Holdout" rate={report.holdout.return_rate} returns={report.holdout.returns} size={report.holdout.size} holdout />
              <div className="legend">
                <span>Offer group</span>
                <span className="holdout">Kept aside</span>
              </div>
              <p className="tiny muted" style={{ marginBottom: 0 }}>
                {report.window_start} to {report.window_end}. A return means the customer paid at least once during this period.
              </p>
            </TiltCard>

            <TiltCard className="card" data-reveal>
              <h3>Money movement</h3>
              <KeyValue label="Offer group sales" value={rupees(report.campaign.return_volume_minor)} />
              <KeyValue
                label="Expected without offer"
                value={rupees(report.expected_campaign_baseline_volume_minor)}
              />
              <KeyValue label="Extra sales" value={rupees(report.incremental_payment_volume_minor)} />
              <KeyValue label="Reward cost" value={rupees(report.reward_cost_minor)} />
              <KeyValue label="After rewards" value={rupees(report.contribution_proxy_minor)} />
            </TiltCard>
          </div>

          <div className="grid three">
            <div className="card tight" data-reveal>
              <div className="stat small">
                <CountUp value={report.opt_outs} />
              </div>
              <div className="stat-label">Opt-outs</div>
            </div>
            <div className="card tight" data-reveal>
              <div className="stat small">
                <CountUp value={report.delivery_errors} />
              </div>
              <div className="stat-label">Delivery issues</div>
            </div>
            <div className="card tight" data-reveal>
              <div className="stat small">{data.setup_seconds === null ? "—" : <CountUp value={`${data.setup_seconds}s`} />}</div>
              <div className="stat-label">Time to prepare</div>
            </div>
          </div>

          <details className="card" data-reveal>
            <summary>Show calculation details</summary>
            <table style={{ marginTop: 14 }}>
              <tbody>
                {Object.entries(report.formulas).map(([name, formula]) => (
                  <tr key={name}>
                    <td style={{ width: "34%" }}><code>{name}</code></td>
                    <td className="muted">{formula}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>

          <div data-reveal>
            <Banner tone="warn" icon="alert">
              <strong>Keep this in mind.</strong>
              <ul>
                {report.caveats.map((caveat) => (
                  <li key={caveat}>{caveat}</li>
                ))}
              </ul>
            </Banner>
          </div>
        </>
      )}

      <div className="card" data-reveal>
        <h3>Activity</h3>
        <AuditTimeline events={data.audit} />
      </div>
    </Reveal>
  );
}
