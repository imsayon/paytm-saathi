"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ParticleField, Reveal, SplitText, TiltCard } from "@/components/motion";
import { apiCall, Icon, InitialLoad, Stat, StatusPill } from "@/components/ui";

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
  latest_synthetic: {
    id: string;
    seed: number;
    persona: { merchant_name?: string; area?: string; city?: string; category?: string };
    persona_source: string;
    row_count: number;
    customer_count: number;
    created_at: string;
  } | null;
  memory: { facts: number };
  integrations: {
    n8n: { configured: boolean; pending_events: number; last_event_at: string | null };
    cognee: { configured: boolean };
  };
  campaigns: { id: string; intent: string; status: string; current_version: number; created_at: string }[];
};

function displaySourceName(sourceName: string) {
  return sourceName.replace(/^synthetic-/i, "scenario-");
}

export default function ImportPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<{ message: string } | null>(null);
  const [busy, setBusy] = useState<"import" | "upload" | "reset" | "synthetic" | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [syntheticSeed, setSyntheticSeed] = useState("20260919");
  const [syntheticRows, setSyntheticRows] = useState("10000");
  const [syntheticCustomers, setSyntheticCustomers] = useState("2000");
  const [syntheticAbsentShare, setSyntheticAbsentShare] = useState("30");
  const hero = useRef<HTMLDivElement>(null);

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

  function onHeroMove(event: React.MouseEvent<HTMLDivElement>) {
    const el = hero.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${(((event.clientX - rect.left) / rect.width) * 100).toFixed(1)}%`);
    el.style.setProperty("--my", `${(((event.clientY - rect.top) / rect.height) * 100).toFixed(1)}%`);
  }

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
          ? "Already loaded: the checksum matched, so nothing was written twice."
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
    if (!window.confirm("Clear this workspace's imports, campaigns, jobs and outcomes so you can start again?")) {
      return;
    }
    setBusy("reset");
    setUploadError(null);
    setFlash(null);
    try {
      await apiCall("/api/demo/reset", { method: "POST", body: "{}" });
      setFlash("Workspace data cleared. Load the sample data to start again.");
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

  function randomizeSyntheticSeed() {
    setSyntheticSeed(String(Math.max(1, Math.floor(Date.now() % 2_147_483_647))));
  }

  async function generateSynthetic() {
    setBusy("synthetic");
    setUploadError(null);
    setFlash(null);
    try {
      const seed = Number.parseInt(syntheticSeed, 10);
      const rows = Number.parseInt(syntheticRows, 10);
      const customers = Number.parseInt(syntheticCustomers, 10);
      const absentShare = Number.parseInt(syntheticAbsentShare, 10) / 100;
      const result = await apiCall<{
        synthetic: {
          seed: number;
          persona_source: string;
          persona: { merchant_name?: string; area?: string; city?: string; category?: string };
          import: { rowCount?: number; row_count?: number; customerCount?: number; customer_count?: number };
        };
      }>("/api/datasets/generate", {
        method: "POST",
        body: JSON.stringify({ seed, rows, customers, absent_share: absentShare, replace: true }),
      });
      const persona = result.synthetic.persona;
      const rowCount = result.synthetic.import.rowCount ?? result.synthetic.import.row_count ?? 0;
      const customerCount = result.synthetic.import.customerCount ?? result.synthetic.import.customer_count ?? customers;
      setFlash(`Built ${persona.merchant_name ?? "a fresh merchant"} · ${customerCount} customers · ${rowCount} payments.`);
      await load();
    } catch (caught) {
      setUploadError((caught as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!overview) return <InitialLoad error={error} retry={() => void load()} />;

  const signal = overview.signal;

  return (
    <Reveal ready refreshKey={`${overview.last_import?.id ?? "none"}:${overview.campaigns.length}`}>
      <section ref={hero} className="hero" onMouseMove={onHeroMove}>
        <div className="spot" aria-hidden="true" />
        <ParticleField />
        <div className="copy">
          <div className="eyebrow">
            <span className="blink" /> Merchant workspace
          </div>
          <h1>
            <SplitText text="Welcome back to" accent={overview.merchant.name} />
          </h1>
          <p className="lede">
            Keep track of customer activity, find regulars who have gone quiet, and plan your next offer from one place.
          </p>
          <div className="actions">
            {overview.demo.demo_mode ? (
              <button onClick={importFixture} disabled={busy !== null}>
                {busy === "import" ? <span className="spinner" /> : <Icon name="file" size={16} />}
                Load sample data
              </button>
            ) : null}
            <label className="btn secondary" style={{ marginBottom: 0, cursor: busy ? "not-allowed" : "pointer", opacity: busy ? 0.6 : 1 }}>
              {busy === "upload" ? <span className="spinner" /> : <Icon name="upload" size={16} />}
              Upload payment data
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
            {signal ? (
              <a className="btn ghost" href="/signals">
                Review customers <Icon name="arrow" size={15} />
              </a>
            ) : null}
          </div>
          <div className="hero-stats">
            <div className="hero-stat">
              <b>{signal ? signal.total_customers : "—"}</b> customers
            </div>
            <div className="hero-stat">
              <b>{signal ? signal.absent_regulars : "—"}</b> quiet regulars
            </div>
            <div className="hero-stat">
              <b>{signal ? signal.eligible_count : "—"}</b> ready to reach
            </div>
            <div className="hero-stat">
              <b>{overview.campaigns.length}</b> active campaigns
            </div>
          </div>
          {uploadError ? (
            <div className="banner bad" style={{ marginTop: 16 }} role="alert">
              <Icon name="alert" />
              <div>{uploadError}</div>
            </div>
          ) : null}
          {flash ? (
            <div className="banner ok" style={{ marginTop: 16 }}>
              <Icon name="check" />
              <div>{flash}</div>
            </div>
          ) : null}
        </div>
      </section>

      <div className="grid two" style={{ marginTop: 16 }}>
        <TiltCard className="card hero-card" data-reveal>
          <h3>Your workspace</h3>
          <h2 style={{ fontSize: 22 }}>{overview.merchant.name}</h2>
          <p className="tiny" style={{ margin: "4px 0 16px" }}>{overview.merchant.timezone}</p>
          <div className="kv">
            <span className="key">Last updated</span>
            <span className="value">{overview.demo.as_of}</span>
          </div>
          <div className="kv">
            <span className="key">Payment data</span>
            <span className="value">{overview.last_import ? `${overview.last_import.row_count} rows` : "Not added yet"}</span>
          </div>
          {overview.last_import ? (
            <div className="kv">
              <span className="key">Latest file</span>
              <span className="value">{displaySourceName(overview.last_import.source_name)}</span>
            </div>
          ) : null}
        </TiltCard>

        <TiltCard className="card" data-reveal>
          <h3>Next step</h3>
          <h2>{signal ? "Review your customer list" : "Add your payment data"}</h2>
          <p className="muted" style={{ marginTop: 8 }}>
            {signal
              ? `${signal.eligible_count} customers are ready for you to review.`
              : "Upload a payment file to see customer activity and find regulars who have gone quiet."}
          </p>
          {signal ? (
            <a className="btn" href="/signals">Review customers <Icon name="arrow" size={15} /></a>
          ) : null}
        </TiltCard>
      </div>

      <div className="grid two" style={{ marginTop: 16 }}>
          <TiltCard className="card" data-reveal>
            <div className="page-head" style={{ marginBottom: 8 }}>
              <div>
                <div className="eyebrow" style={{ marginBottom: 4 }}><span className="blink" /> Data generator</div>
                <h2 style={{ margin: 0 }}>Generate payment data</h2>
              </div>
              <span className="pill info plain">Up to 10,000 rows</span>
            </div>
            <p className="tiny muted" style={{ marginTop: 0 }}>
              Build a fresh payment file, load it into this workspace, and review the customers it surfaces.
            </p>
            <div className="two-col">
              <div className="field">
                <label htmlFor="synthetic-seed">Scenario key</label>
                <input id="synthetic-seed" type="number" min="1" max="2147483647" value={syntheticSeed} onChange={(event) => setSyntheticSeed(event.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="synthetic-rows">Payment rows</label>
                <input id="synthetic-rows" type="number" min="100" max="10000" value={syntheticRows} onChange={(event) => setSyntheticRows(event.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="synthetic-customers">Customers</label>
                <input id="synthetic-customers" type="number" min="20" max="2500" value={syntheticCustomers} onChange={(event) => setSyntheticCustomers(event.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="synthetic-absent-share">Quiet regulars (%)</label>
                <input id="synthetic-absent-share" type="number" min="10" max="50" value={syntheticAbsentShare} onChange={(event) => setSyntheticAbsentShare(event.target.value)} />
              </div>
            </div>
            <div className="actions" style={{ marginTop: 14 }}>
              <button onClick={generateSynthetic} disabled={busy !== null}>
                {busy === "synthetic" ? <span className="spinner" /> : <Icon name="spark" size={15} />} Generate dataset
              </button>
              <button className="ghost small" onClick={randomizeSyntheticSeed} disabled={busy !== null}>
                <Icon name="refresh" size={14} /> New key
              </button>
            </div>
          </TiltCard>

          <TiltCard className="card" data-reveal>
            <h3>Current dataset</h3>
            {overview.latest_synthetic ? (
              <>
                <h2>{overview.latest_synthetic.persona.merchant_name ?? "Current merchant"}</h2>
                <p className="tiny muted" style={{ marginTop: 4 }}>
                  {overview.latest_synthetic.persona.area ?? "Neighbourhood"}, {overview.latest_synthetic.persona.city ?? "India"}
                </p>
                <div className="kv"><span className="key">Customers</span><span className="value">{overview.latest_synthetic.customer_count}</span></div>
                <div className="kv"><span className="key">Payments</span><span className="value">{overview.latest_synthetic.row_count}</span></div>
              </>
            ) : (
              <p className="muted">Generate or upload payment data to populate this workspace.</p>
            )}
            {overview.demo.demo_mode && (overview.last_import || overview.campaigns.length > 0) ? (
              <div className="actions" style={{ marginTop: 14 }}>
                <button className="secondary small" onClick={resetDemo} disabled={busy !== null}>
                  {busy === "reset" ? <span className="spinner" /> : <Icon name="refresh" size={14} />}
                  Start over
                </button>
              </div>
            ) : null}
          </TiltCard>
        </div>

      {signal ? (
        <>
          <div className="section-title" data-reveal>
            <h2>Customer activity</h2>
            <span className="mono">updated {overview.demo.as_of}</span>
          </div>
          <div className="grid four">
            <Stat value={signal.total_customers} label="Customers" />
            <Stat value={signal.regular_customers} label="Regular customers" tone="info" />
            <Stat value={signal.absent_regulars} label="Quiet regulars" tone="warn" />
            <Stat value={signal.eligible_count} label="Ready to reach" tone="ok" />
          </div>
          <TiltCard className="card interactive" data-reveal>
            <div className="actions">
              <a className="btn" href="/signals">
                Review customers <Icon name="arrow" size={15} />
              </a>
              <span className="tiny muted">
                People without permission or contact details stay out of the list.
              </span>
            </div>
          </TiltCard>
        </>
      ) : (
        <div className="card" style={{ marginTop: 20 }} data-reveal>
          <h2>Your workspace is ready</h2>
          <p className="muted" style={{ margin: 0 }}>
            Upload payment data above to see customer activity here.
          </p>
        </div>
      )}

      {overview.campaigns.length > 0 ? (
        <div className="card" data-reveal>
          <h3>Recent campaigns</h3>
          <div className="scroll" style={{ maxHeight: 320 }}>
            <table>
              <thead>
                <tr>
                  <th>Goal</th>
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
    </Reveal>
  );
}
