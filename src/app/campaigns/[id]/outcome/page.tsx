"use client";

import { use, useCallback, useEffect, useState } from "react";
import type { CampaignDetail, MeasurementReport } from "@/components/types";
import { InitialLoad, apiCall, AuditTimeline, DemoBanner, ErrorBanner, KeyValue, percent, rupees, Stat, StatusPill, Steps } from "@/components/ui";

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

function RateBar({ label, rate, returns, size, holdout }: { label: string; rate: number; returns: number; size: number; holdout?: boolean }) {
  return (
    <div className="bar-row">
      <span className="tiny" style={{ fontWeight: 600 }}>
        {label}
      </span>
      <div className="bar-track">
        <div className={`bar-fill ${holdout ? "holdout" : ""}`} style={{ width: `${Math.max(rate * 100, 2)}%` }} />
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
    <>
      <DemoBanner />
      <Steps current="outcome" />

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
        <h1 style={{ margin: 0 }}>Seven-day outcome</h1>
        <StatusPill status={data.campaign.status} />
        <span className="pill neutral">version {data.version.version}</span>
      </div>
      <p className="lede">
        Compare campaign returns with an untouched holdout. These synthetic results demonstrate the calculation;
        they do not establish how many real customers an offer would bring back.
      </p>

      <div className="card">
        <div className="actions">
          <button onClick={runOutcome} disabled={busy}>
            {busy ? <span className="spinner" /> : null}
            {report.has_outcomes ? "Re-run seven-day simulation" : "Advance demo clock seven days"}
          </button>
          <a className="btn secondary" href={`/campaigns/${id}/status`}>
            Back to delivery
          </a>
          <span className="tiny muted">
            Simulation is idempotent: re-running does not create duplicate outcomes or change the numbers.
          </span>
        </div>
        <div style={{ marginTop: 12 }}>
          <ErrorBanner error={error} />
        </div>
      </div>

      {!report.has_outcomes ? (
        <div className="card">
          <h2>No outcome window yet</h2>
          <p className="muted" style={{ marginBottom: 0 }}>
            Run mock delivery, then advance the demo clock to materialize the seven-day window.
          </p>
        </div>
      ) : (
        <>
          <div className="grid four">
            <Stat value={percent(report.campaign.return_rate)} label="Campaign return rate" tone="ok" />
            <Stat value={percent(report.holdout.return_rate)} label="Holdout return rate" />
            <Stat value={`${report.observed_lift_pp} pp`} label="Descriptive difference" tone="ok" />
            <Stat value={report.expected_incremental_returns} label="Estimated incremental returns" />
          </div>

          <div className="grid two">
            <div className="card">
              <h3>Campaign versus holdout</h3>
              <RateBar
                label="Campaign"
                rate={report.campaign.return_rate}
                returns={report.campaign.returns}
                size={report.campaign.size}
              />
              <RateBar
                label="Holdout"
                rate={report.holdout.return_rate}
                returns={report.holdout.returns}
                size={report.holdout.size}
                holdout
              />
              <p className="tiny muted" style={{ marginBottom: 0 }}>
                Window {report.window_start} to {report.window_end}. A return is at least one settled, non-refunded,
                non-duplicate payment inside the window.
              </p>
            </div>

            <div className="card">
              <h3>Money (synthetic)</h3>
              <KeyValue label="Campaign return volume" value={rupees(report.campaign.return_volume_minor)} />
              <KeyValue
                label="Expected baseline volume"
                value={rupees(report.expected_campaign_baseline_volume_minor)}
                hint="holdout rate × group size × avg return"
              />
              <KeyValue
                label="Incremental payment volume"
                value={rupees(report.incremental_payment_volume_minor)}
              />
              <KeyValue label="Reward cost" value={rupees(report.reward_cost_minor)} hint="redeemed rewards" />
              <KeyValue
                label="Contribution proxy after reward"
                value={rupees(report.contribution_proxy_minor)}
                hint="not profit"
              />
            </div>
          </div>

          <div className="grid three">
            <div className="card tight">
              <div className="stat small">{report.opt_outs}</div>
              <div className="stat-label">Opt-outs recorded</div>
            </div>
            <div className="card tight">
              <div className="stat small">{report.delivery_errors}</div>
              <div className="stat-label">Delivery errors (failed or unresolved)</div>
            </div>
            <div className="card tight">
              <div className="stat small">{data.setup_seconds === null ? "—" : `${data.setup_seconds}s`}</div>
              <div className="stat-label">Setup time: import to approval</div>
            </div>
          </div>

          <div className="card">
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

          <div className="banner warn">
            <strong>Read this before believing the numbers.</strong>
            <ul>
              {report.caveats.map((caveat) => (
                <li key={caveat}>{caveat}</li>
              ))}
            </ul>
          </div>
        </>
      )}

      <div className="card">
        <h3>Audit trail</h3>
        <AuditTimeline events={data.audit} />
      </div>
    </>
  );
}
