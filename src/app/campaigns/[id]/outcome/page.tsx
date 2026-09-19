"use client";

import { use, useCallback, useEffect, useState } from "react";
import type { CampaignDetail, MeasurementReport } from "@/components/types";
import { AnimatedBar, CountUp, Reveal, SplitText, TiltCard } from "@/components/motion";
import { apiCall, AuditTimeline, Banner, DemoBanner, ErrorBanner, Icon, InitialLoad, KeyValue, percent, rupees, Stat, StatusPill, Steps } from "@/components/ui";

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
      <DemoBanner />
      <Steps current="outcome" campaignId={id} />

      <div data-reveal>
        <div className="eyebrow">
          <span className="blink" /> Step 5 · holdout report
        </div>
        <div className="page-head">
          <h1>
            <SplitText text="Seven-day outcome," accent="against a control" />
          </h1>
          <StatusPill status={data.campaign.status} />
          <span className="pill neutral plain">version {data.version.version}</span>
        </div>
        <p className="lede">
          Compare campaign returns with an untouched holdout. The report is descriptive and shows how the measurement is calculated;
          it is not a causal estimate.
        </p>
      </div>

      <TiltCard className="card" data-reveal>
        <div className="actions">
          <span className={`radar${busy ? " on" : ""}`}>
            <button onClick={runOutcome} disabled={busy}>
              {busy ? <span className="spinner" /> : <Icon name="clock" size={16} />}
              {report.has_outcomes ? "Re-run outcome window" : "Advance outcome window seven days"}
            </button>
          </span>
          <a className="btn secondary" href={`/campaigns/${id}/status`}>
            Back to delivery
          </a>
          <span className="tiny muted">Re-running is idempotent: it does not create duplicate outcomes or change the numbers.</span>
        </div>
        <div style={{ marginTop: 12 }}>
          <ErrorBanner error={error} />
        </div>
      </TiltCard>

      {!report.has_outcomes ? (
        <div className="card" data-reveal>
          <h2>No outcome window yet</h2>
          <p className="muted" style={{ marginBottom: 0 }}>
            Run delivery, then advance the outcome window to materialize the seven-day report.
          </p>
        </div>
      ) : (
        <>
          <div className="grid four">
            <Stat value={percent(report.campaign.return_rate)} label="Campaign return rate" tone="ok" />
            <Stat value={percent(report.holdout.return_rate)} label="Holdout return rate" />
            <Stat value={`${report.observed_lift_pp} pp`} label="Descriptive difference" tone="info" hint="not a causal estimate" />
            <Stat value={report.expected_incremental_returns} label="Estimated incremental returns" hint="group size × difference" />
          </div>

          <div className="grid two">
            <TiltCard className="card" data-reveal>
              <h3>Campaign versus holdout</h3>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6, flexWrap: "wrap" }}>
                <span className="stat hero-number">
                  <CountUp value={`${report.observed_lift_pp} pp`} duration={1600} />
                </span>
                <span className="tiny muted">difference in return rate over the window</span>
              </div>
              <RateBar label="Campaign" rate={report.campaign.return_rate} returns={report.campaign.returns} size={report.campaign.size} />
              <RateBar label="Holdout" rate={report.holdout.return_rate} returns={report.holdout.returns} size={report.holdout.size} holdout />
              <div className="legend">
                <span>Campaign group (received the offer)</span>
                <span className="holdout">Holdout (received nothing)</span>
              </div>
              <p className="tiny muted" style={{ marginBottom: 0 }}>
                Window {report.window_start} to {report.window_end}. A return is at least one settled, non-refunded, non-duplicate payment
                inside the window.
              </p>
            </TiltCard>

            <TiltCard className="card" data-reveal>
              <h3>Commercial impact</h3>
              <KeyValue label="Campaign return volume" value={rupees(report.campaign.return_volume_minor)} />
              <KeyValue
                label="Expected baseline volume"
                value={rupees(report.expected_campaign_baseline_volume_minor)}
                hint="holdout rate × group size × avg return"
              />
              <KeyValue label="Incremental payment volume" value={rupees(report.incremental_payment_volume_minor)} />
              <KeyValue label="Reward cost" value={rupees(report.reward_cost_minor)} hint="redeemed rewards" />
              <KeyValue label="Contribution proxy after reward" value={rupees(report.contribution_proxy_minor)} hint="not profit" />
            </TiltCard>
          </div>

          <div className="grid three">
            <div className="card tight" data-reveal>
              <div className="stat small">
                <CountUp value={report.opt_outs} />
              </div>
              <div className="stat-label">Opt-outs recorded</div>
            </div>
            <div className="card tight" data-reveal>
              <div className="stat small">
                <CountUp value={report.delivery_errors} />
              </div>
              <div className="stat-label">Delivery errors (failed or unresolved)</div>
            </div>
            <div className="card tight" data-reveal>
              <div className="stat small">{data.setup_seconds === null ? "—" : <CountUp value={`${data.setup_seconds}s`} />}</div>
              <div className="stat-label">Setup time: import to approval</div>
            </div>
          </div>

          <div className="card" data-reveal>
            <h3>How each number is calculated</h3>
            <table>
              <tbody>
                {Object.entries(report.formulas).map(([name, formula]) => (
                  <tr key={name}>
                    <td style={{ width: "34%" }}>
                      <code>{name}</code>
                    </td>
                    <td className="muted">{formula}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div data-reveal>
            <Banner tone="warn" icon="alert">
              <strong>Read this before believing the numbers.</strong>
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
        <h3>Audit trail</h3>
        <AuditTimeline events={data.audit} />
      </div>
    </Reveal>
  );
}
