"use client";

import { useCallback, useEffect, useState } from "react";
import { Pipeline, Reveal, type PipelineStage } from "@/components/motion";
import { apiCall, DemoBanner, Icon, InitialLoad, Stat, StatusPill, Steps } from "@/components/ui";

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

const STAGES: PipelineStage[] = [
  { key: "import", title: "Import", detail: "Settled payments, validated whole-file", icon: <Icon name="upload" /> },
  { key: "signal", title: "Signal", detail: "Regulars who went quiet, by rule", icon: <Icon name="users" /> },
  { key: "plan", title: "Draft", detail: "Bounded copy from aggregates only", icon: <Icon name="pen" /> },
  { key: "review", title: "Review", detail: "Rules verify budget and promise", icon: <Icon name="shield" /> },
  { key: "approve", title: "Approve", detail: "One immutable version, one lock", icon: <Icon name="stamp" />, gate: true },
  { key: "deliver", title: "Mock delivery", detail: "Idempotent jobs, status before retry", icon: <Icon name="send" /> },
  { key: "report", title: "Holdout report", detail: "Campaign vs control, formulas shown", icon: <Icon name="chart" /> },
];

export default function ImportPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<{ message: string } | null>(null);
  const [busy, setBusy] = useState<"import" | "upload" | "reset" | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setOverview(await apiCall<Overview>("/api/overview"));
    } catch (caught) {
      setError(caught as Error);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function importFixture() {
    setBusy("import");
    setUploadError(null);
    setFlash(null);
    try {
      const result = await apiCall<{ import: { already_imported: boolean; row_count: number; customer_count: number } }>(
        "/api/imports",
        { method: "POST", body: JSON.stringify({ use_fixture: true }) },
      );
      setFlash(
        result.import.already_imported
          ? `Already imported: the checksum matched, so nothing was written twice.`
          : `Imported ${result.import.row_count} rows for ${result.import.customer_count} customers.`,
      );
      await load();
    } catch (caught) {
      setUploadError((caught as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function resetDemo() {
    if (!window.confirm("Clear the demo merchant's imports, campaigns, jobs and outcomes so the demo can start again?")) {
      return;
    }
    setBusy("reset");
    setUploadError(null);
    setFlash(null);
    try {
      await apiCall("/api/demo/reset", { method: "POST", body: "{}" });
      setFlash("Demo data cleared. Load the demo CSV to start again.");
      await load();
    } catch (caught) {
      setUploadError((caught as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function uploadCsv(file: File) {
    setBusy("upload");
    setUploadError(null);
    setFlash(null);
    try {
      const csv = await file.text();
      const result = await apiCall<{ import: { row_count: number; customer_count: number } }>("/api/imports", {
        method: "POST",
        body: JSON.stringify({ csv, source_name: file.name }),
      });
      setFlash(`Imported ${result.import.row_count} rows for ${result.import.customer_count} customers from ${file.name}.`);
      await load();
    } catch (caught) {
      setUploadError((caught as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!overview) return <InitialLoad error={error} retry={() => void load()} />;

  const signal = overview.signal;
  const excludedForConsent = signal ? signal.excluded.consent_false + signal.excluded.consent_unknown : 0;

  return (
    <Reveal ready refreshKey={`${overview.last_import?.id ?? "none"}:${overview.campaigns.length}`}>
      <DemoBanner planner={overview.demo.planner} />
      <Steps current="import" />

      <div data-reveal>
        <div className="eyebrow">Merchant Growth AI · retention</div>
        <h1>
          Bring back the regulars <span className="accent">who stopped coming</span>
        </h1>
        <p className="lede">
          Saathi reads settled payment history, finds customers who used to be regulars and have gone quiet, and takes one
          measured offer through merchant approval before anything is sent.
        </p>
      </div>

      <div className="card" data-reveal style={{ marginBottom: 16 }}>
        <h3>One loop, in order</h3>
        <Pipeline stages={STAGES} />
        <p className="note">
          Nothing reaches a provider before the approval gate. The holdout never receives a message, so the report can compare
          rather than guess.
        </p>
      </div>

      <div className="grid two">
        <div className="card hero" data-reveal>
          <h3>Merchant</h3>
          <h2 style={{ fontSize: 20 }}>{overview.merchant.name}</h2>
          <p className="tiny" style={{ margin: "4px 0 12px" }}>
            {overview.merchant.timezone} · demo session <code>{overview.merchant.id}</code>
          </p>
          <div className="kv">
            <span className="key">Fixed demo date (as of)</span>
            <span className="value">{overview.demo.as_of}</span>
          </div>
          <div className="kv">
            <span className="key">Last import</span>
            <span className="value">
              {overview.last_import ? `${overview.last_import.source_name} · ${overview.last_import.row_count} rows` : "None yet"}
            </span>
          </div>
          {overview.last_import ? (
            <div className="kv">
              <span className="key">Payment identity</span>
              <span className="value">
                <code>{overview.last_import.id_strategy}</code>
              </span>
            </div>
          ) : null}
        </div>

        <div className="card" data-reveal>
          <h3>Step 1 — load payment data</h3>
          <p className="tiny muted" style={{ marginTop: 0 }}>
            The fixture is a frozen synthetic CSV for one Bengaluru merchant: 243 payment rows including refunded and
            duplicate rows. Re-importing the same file is safe: the checksum makes it idempotent.
          </p>
          <div className="actions" style={{ marginTop: 12 }}>
            <button onClick={importFixture} disabled={busy !== null}>
              {busy === "import" ? <span className="spinner" /> : <Icon name="file" size={16} />}
              Load demo CSV
            </button>
            <label className="btn secondary" style={{ marginBottom: 0, cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1 }}>
              {busy === "upload" ? <span className="spinner" /> : <Icon name="upload" size={16} />}
              Upload CSV
              <input
                type="file"
                accept=".csv,text/csv"
                style={{ display: "none" }}
                disabled={busy !== null}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void uploadCsv(file);
                  event.target.value = "";
                }}
              />
            </label>
          </div>
          <p className="note">
            Required columns: <code>merchant_id</code>, <code>customer_id</code>, <code>paid_at</code>,{" "}
            <code>amount_minor</code>, <code>status</code>, <code>consent</code>. Up to 2 MB.
          </p>
          {uploadError ? (
            <div className="banner bad" style={{ marginTop: 12 }} role="alert">
              <Icon name="alert" />
              <div>{uploadError}</div>
            </div>
          ) : null}
          {flash ? (
            <div className="banner ok" style={{ marginTop: 12 }}>
              <Icon name="check" />
              <div>{flash}</div>
            </div>
          ) : null}
        </div>
      </div>

      {signal ? (
        <>
          <h3 style={{ marginTop: 26 }} data-reveal>
            Retention signal at {overview.demo.as_of}
          </h3>
          <div className="grid four">
            <Stat value={signal.total_customers} label="Customers imported" />
            <Stat value={signal.regular_customers} label="Regulars in last 60 days" tone="info" />
            <Stat value={signal.absent_regulars} label="Regulars now absent 21+ days" tone="warn" />
            <Stat value={signal.eligible_count} label="Eligible after consent" tone="ok" />
          </div>
          <div className="card interactive" data-reveal>
            <div className="actions">
              <a className="btn" href="/signals">
                Inspect the audience <Icon name="arrow" size={15} />
              </a>
              <span className="tiny muted">
                {signal.excluded.consent_false} consent false · {signal.excluded.consent_unknown} consent unknown ·{" "}
                {signal.excluded.no_contact_ref} without contact reference are excluded.
                {excludedForConsent > 0 ? " Consent is a hard gate, not a score." : ""}
              </span>
            </div>
          </div>
        </>
      ) : (
        <div className="card" style={{ marginTop: 20 }} data-reveal>
          <h2>No payment data yet</h2>
          <p className="muted" style={{ margin: 0 }}>
            Load the demo CSV to compute the retention signal.
          </p>
        </div>
      )}

      {overview.campaigns.length > 0 ? (
        <div className="card" data-reveal>
          <h3>Campaigns</h3>
          <div className="scroll" style={{ maxHeight: 320 }}>
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
                    <td style={{ textAlign: "right" }}>
                      <a href={`/campaigns/${campaign.id}/review`}>Open</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {overview.demo.demo_mode && (overview.last_import || overview.campaigns.length > 0) ? (
        <div className="card" data-reveal>
          <div className="actions">
            <button className="secondary" onClick={resetDemo} disabled={busy !== null}>
              {busy === "reset" ? <span className="spinner" /> : <Icon name="refresh" size={15} />}
              Reset demo data
            </button>
            <span className="tiny muted">
              Demo control. Clears this merchant&apos;s imports, campaigns, jobs and simulated outcomes from the shared database so
              the sequence can be rehearsed again. Nothing here is real customer data.
            </span>
          </div>
        </div>
      ) : null}
    </Reveal>
  );
}
