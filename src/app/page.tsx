"use client";

import { useCallback, useEffect, useState } from "react";
import { apiCall, DemoBanner, ErrorBanner, Stat, StatusPill, Steps } from "@/components/ui";

type Overview = {
  merchant: { id: string; name: string; timezone: string; demo_session: boolean };
  demo: {
    as_of: string;
    suggested_intent: string;
    suggested_budget_cap_minor: number;
    demo_mode: boolean;
    planner: string;
  };
  last_import: { id: string; source_name: string; row_count: number; imported_at: string; id_strategy: string } | null;
  signal: {
    total_customers: number;
    regular_customers: number;
    absent_regulars: number;
    eligible_count: number;
    excluded: { consent_false: number; consent_unknown: number; no_contact_ref: number; over_cohort_cap: number };
  } | null;
  campaigns: { id: string; intent: string; status: string; current_version: number; created_at: string }[];
};

export default function ImportPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<{ message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOverview(await apiCall<Overview>("/api/overview"));
      setError(null);
    } catch (caught) {
      setError(caught as Error);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function importFixture() {
    setBusy(true);
    setUploadError(null);
    try {
      await apiCall("/api/imports", { method: "POST", body: JSON.stringify({ use_fixture: true }) });
      await load();
    } catch (caught) {
      setUploadError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function uploadCsv(file: File) {
    setBusy(true);
    setUploadError(null);
    try {
      const csv = await file.text();
      await apiCall("/api/imports", {
        method: "POST",
        body: JSON.stringify({ csv, source_name: file.name }),
      });
      await load();
    } catch (caught) {
      setUploadError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorBanner error={error} />;

  if (!overview) {
    return (
      <div className="card">
        <div className="skeleton" style={{ width: "40%", marginBottom: 10 }} />
        <div className="skeleton" style={{ width: "70%" }} />
      </div>
    );
  }

  const signal = overview.signal;

  return (
    <>
      <DemoBanner planner={overview.demo.planner} />
      <Steps current="import" />

      <h1>Bring back regulars who stopped coming</h1>
      <p className="lede">
        Saathi reads settled payment history, finds customers who used to be regulars and have gone quiet, and takes
        one measured offer through merchant approval before anything is sent.
      </p>

      <div className="grid two">
        <div className="card">
          <h3>Merchant</h3>
          <h2>{overview.merchant.name}</h2>
          <p className="tiny muted">
            {overview.merchant.timezone} · demo session <code>{overview.merchant.id}</code>
          </p>
          <div className="kv">
            <span className="key">Fixed demo date (as of)</span>
            <span className="value">{overview.demo.as_of}</span>
          </div>
          <div className="kv">
            <span className="key">Last import</span>
            <span className="value">
              {overview.last_import
                ? `${overview.last_import.source_name} · ${overview.last_import.row_count} rows`
                : "None yet"}
            </span>
          </div>
          {overview.last_import ? (
            <p className="tiny muted" style={{ marginTop: 6 }}>
              Payment identity: <code>{overview.last_import.id_strategy}</code>
            </p>
          ) : null}
        </div>

        <div className="card">
          <h3>Step 1 — load payment data</h3>
          <p className="tiny muted" style={{ marginTop: 0 }}>
            The fixture is a frozen synthetic CSV for one Bengaluru merchant: 243 payment rows including refunded and
            duplicate rows. Re-importing the same file is safe: the checksum makes it idempotent.
          </p>
          <div className="actions" style={{ marginTop: 12 }}>
            <button onClick={importFixture} disabled={busy}>
              {busy ? <span className="spinner" /> : null}
              Load demo CSV
            </button>
            <label
              className="btn secondary"
              style={{ marginBottom: 0, cursor: "pointer", fontWeight: 600, fontSize: 15 }}
            >
              Upload CSV
              <input
                type="file"
                accept=".csv,text/csv"
                style={{ display: "none" }}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void uploadCsv(file);
                }}
              />
            </label>
          </div>
          {uploadError ? (
            <div className="banner bad" style={{ marginTop: 12 }}>
              {uploadError}
            </div>
          ) : null}
        </div>
      </div>

      {signal ? (
        <>
          <h3 style={{ marginTop: 26 }}>Retention signal at {overview.demo.as_of}</h3>
          <div className="grid four">
            <Stat value={signal.total_customers} label="Customers imported" />
            <Stat value={signal.regular_customers} label="Regulars in last 60 days" />
            <Stat value={signal.absent_regulars} label="Regulars now absent 21+ days" />
            <Stat value={signal.eligible_count} label="Eligible after consent" tone="ok" />
          </div>
          <div className="card">
            <div className="actions">
              <a className="btn" href="/signals">
                Inspect the audience
              </a>
              <span className="tiny muted">
                {signal.excluded.consent_false} consent false · {signal.excluded.consent_unknown} consent unknown ·{" "}
                {signal.excluded.no_contact_ref} without contact reference are excluded.
              </span>
            </div>
          </div>
        </>
      ) : (
        <div className="card" style={{ marginTop: 20 }}>
          <h2>No payment data yet</h2>
          <p className="muted" style={{ margin: 0 }}>
            Load the demo CSV to compute the retention signal.
          </p>
        </div>
      )}

      {overview.campaigns.length > 0 ? (
        <div className="card">
          <h3>Campaigns</h3>
          <table>
            <thead>
              <tr>
                <th>Intent</th>
                <th>Version</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {overview.campaigns.map((campaign) => (
                <tr key={campaign.id}>
                  <td>{campaign.intent}</td>
                  <td>v{campaign.current_version}</td>
                  <td>
                    <StatusPill status={campaign.status} />
                  </td>
                  <td>
                    <a href={`/campaigns/${campaign.id}/review`}>Open</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
