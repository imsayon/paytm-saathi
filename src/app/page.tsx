"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Marquee, ParticleField, Pipeline, Rail, Reveal, SplitText, TiltCard, type PipelineStage, type RailStage } from "@/components/motion";
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

const RAIL: RailStage[] = [
  { key: "import", title: "Import", detail: "validated whole-file", glyph: <path d="M12 16V4M7 9l5-5 5 5M4 20h16" /> },
  { key: "signal", title: "Signal", detail: "regulars gone quiet", glyph: <><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19c.6-3.3 3-5 5.5-5s4.9 1.7 5.5 5M15.5 5.3a3 3 0 010 5.4M17 14c2 .4 3.4 1.9 3.8 5" /></> },
  { key: "draft", title: "Draft", detail: "aggregates only", glyph: <path d="M4 20l4.5-1 10-10-3.5-3.5-10 10L4 20zM13 7.5l3.5 3.5" /> },
  { key: "review", title: "Review", detail: "eight rule checks", glyph: <path d="M12 3l7 3v5.5c0 4.4-3 8.1-7 9.5-4-1.4-7-5.1-7-9.5V6l7-3z" /> },
  { key: "approve", title: "Approve", detail: "the human gate", glyph: <path d="M9 11V6a3 3 0 016 0v5h3l1 5H5l1-5h3zM6 20h12" />, gate: true },
  { key: "deliver", title: "Delivery", detail: "idempotent jobs", glyph: <path d="M3 11.5l18-8-8 18-2.5-7.5L3 11.5z" /> },
  { key: "report", title: "Holdout report", detail: "campaign vs control", glyph: <path d="M4 20V10M10 20V4M16 20v-8M22 20H2" /> },
];

const STAGES: PipelineStage[] = RAIL.map((stage) => ({
  key: stage.key,
  title: stage.title,
  detail: stage.detail,
  gate: stage.gate,
  icon: (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {stage.glyph}
    </svg>
  ),
}));

const GUARANTEES = [
  "No provider call before approval",
  "The holdout receives nothing",
  "Consent checked three times",
  "Budget arithmetic by rules, not the model",
  "One immutable version per approval",
  "Idempotency-Key on every approval",
  "Status check before any retry",
  "Every transition audited in-transaction",
];

export default function ImportPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<{ message: string } | null>(null);
  const [busy, setBusy] = useState<"import" | "upload" | "reset" | "synthetic" | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [syntheticSeed, setSyntheticSeed] = useState("20260919");
  const [syntheticCustomers, setSyntheticCustomers] = useState("90");
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
      const customers = Number.parseInt(syntheticCustomers, 10);
      const absentShare = Number.parseInt(syntheticAbsentShare, 10) / 100;
      const result = await apiCall<{
        synthetic: {
          seed: number;
          persona_source: string;
          persona: { merchant_name?: string; area?: string; city?: string; category?: string };
          import: { rowCount?: number; row_count?: number; customerCount?: number; customer_count?: number };
        };
      }>("/api/synthetic/generate", {
        method: "POST",
        body: JSON.stringify({ seed, customers, absent_share: absentShare, replace: true }),
      });
      const persona = result.synthetic.persona;
      const rowCount = result.synthetic.import.rowCount ?? result.synthetic.import.row_count ?? 0;
      const customerCount = result.synthetic.import.customerCount ?? result.synthetic.import.customer_count ?? customers;
      const source = result.synthetic.persona_source === "model" ? "AI-assisted profile" : "rules-based profile";
      setFlash(`Generated ${persona.merchant_name ?? "a fresh merchant"} · ${customerCount} customers · ${rowCount} payments · ${source}.`);
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
      <DemoBanner planner={overview.demo.planner} />
      <Steps current="import" />

      <section ref={hero} className="hero" onMouseMove={onHeroMove}>
        <div className="spot" aria-hidden="true" />
        <ParticleField />
        <div className="copy">
          <div className="eyebrow">
            <span className="blink" /> Merchant Growth AI · retention
          </div>
          <h1>
            <SplitText text="Bring back the regulars" accent="who stopped coming." />
          </h1>
          <p className="lede">
            Saathi reads settled payment history, finds customers who used to be regulars and have gone quiet, and takes one
            measured offer through merchant approval before anything is sent.
          </p>
          <div className="actions">
            <button onClick={importFixture} disabled={busy !== null}>
              {busy === "import" ? <span className="spinner" /> : <Icon name="file" size={16} />}
              Load sample data
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
            {signal ? (
              <a className="btn ghost" href="/signals">
                See who qualifies <Icon name="arrow" size={15} />
              </a>
            ) : null}
          </div>
          <div className="hero-stats">
            <div className="hero-stat">
              <b>{overview.last_import ? overview.last_import.row_count : 243}</b> payment rows
            </div>
            <div className="hero-stat">
              <b>{signal ? signal.total_customers : 78}</b> customers
            </div>
            <div className="hero-stat">
              <b>{Number(overview.integrations.n8n.configured) + Number(overview.integrations.cognee.configured)}</b> connected services
            </div>
            <div className="hero-stat">
              <b>1</b> human approval gate
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
        <TiltCard className="card" data-reveal>
          <div className="page-head" style={{ marginBottom: 8 }}>
            <div>
              <div className="eyebrow" style={{ marginBottom: 4 }}><span className="blink" /> scenario studio</div>
              <h2 style={{ margin: 0 }}>Build a fresh scenario</h2>
            </div>
            <span className="pill info plain">repeatable</span>
          </div>
          <p className="tiny muted" style={{ marginTop: 0 }}>
            Create a new merchant profile, customer mix, payment history and retention signal. The same scenario key reproduces the
            same result; rules own the numbers, consent and exclusions.
          </p>
          <div className="two-col">
            <div className="field">
              <label htmlFor="synthetic-seed">Scenario key</label>
              <input id="synthetic-seed" type="number" min="1" max="2147483647" value={syntheticSeed} onChange={(event) => setSyntheticSeed(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="synthetic-customers">Customers</label>
              <input id="synthetic-customers" type="number" min="20" max="400" value={syntheticCustomers} onChange={(event) => setSyntheticCustomers(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="synthetic-absent-share">Quiet regulars (%)</label>
              <input id="synthetic-absent-share" type="number" min="10" max="50" value={syntheticAbsentShare} onChange={(event) => setSyntheticAbsentShare(event.target.value)} />
            </div>
          </div>
          <div className="actions" style={{ marginTop: 14 }}>
            <button onClick={generateSynthetic} disabled={busy !== null}>
              {busy === "synthetic" ? <span className="spinner" /> : <Icon name="spark" size={15} />} Generate + replace active dataset
            </button>
            <button className="ghost small" onClick={randomizeSyntheticSeed} disabled={busy !== null}>
              <Icon name="refresh" size={14} /> New seed
            </button>
          </div>
        </TiltCard>

        <TiltCard className="card" data-reveal>
          <div className="page-head" style={{ marginBottom: 8 }}>
            <h2 style={{ margin: 0 }}>Workspace context</h2>
            <span className="pill neutral plain">Neon record</span>
          </div>
          {overview.latest_synthetic ? (
            <>
              <h3 style={{ marginTop: 0 }}>{overview.latest_synthetic.persona.merchant_name ?? "Generated merchant"}</h3>
              <p className="tiny muted" style={{ marginTop: 0 }}>
                {overview.latest_synthetic.persona.area ?? "Neighbourhood"}, {overview.latest_synthetic.persona.city ?? "India"} · scenario <code>{overview.latest_synthetic.seed}</code>
              </p>
              <div className="kv"><span className="key">Active dataset</span><span className="value">{overview.latest_synthetic.customer_count} customers · {overview.latest_synthetic.row_count} payments</span></div>
            </>
          ) : (
            <p className="muted">Generate a scenario to create an active merchant workspace.</p>
          )}
          <div className="kv"><span className="key">Saathi memory</span><span className="value">{overview.memory.facts} retained fact{overview.memory.facts === 1 ? "" : "s"}</span></div>
          <div className="kv"><span className="key">Workflow automation</span><span className="value">{overview.integrations.n8n.configured ? `${overview.integrations.n8n.pending_events} pending` : "standby"}</span></div>
          <div className="kv"><span className="key">Memory sync</span><span className="value">{overview.integrations.cognee.configured ? "Neon + semantic mirror" : "Neon"}</span></div>
          <p className="note" style={{ marginBottom: 0 }}>Resetting active data preserves the decision history, integrations, memory and scenario history.</p>
        </TiltCard>
      </div>

      <Marquee items={GUARANTEES} />

      <div className="section-title" data-reveal>
        <h2>How it works</h2>
        <span className="mono">one loop, in order · approval is the only gate</span>
      </div>
      <TiltCard className="card" data-reveal>
        <Rail stages={RAIL} />
        <Pipeline stages={STAGES} className="mobile-only" />
        <p className="note">
          Nothing reaches a provider before the approval gate. The holdout never receives a message, so the report can compare
          rather than guess.
        </p>
      </TiltCard>

      <div className="grid two" style={{ marginTop: 16 }}>
        <TiltCard className="card hero-card" data-reveal>
          <h3>Merchant</h3>
          <h2 style={{ fontSize: 21 }}>{overview.merchant.name}</h2>
          <p className="tiny" style={{ margin: "4px 0 12px" }}>
            {overview.merchant.timezone} · workspace <code>{overview.merchant.id}</code>
          </p>
          <div className="kv">
            <span className="key">Reporting as of</span>
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
        </TiltCard>

        <TiltCard className="card" data-reveal>
          <h3>Step 1 — load payment data</h3>
          <p className="tiny muted" style={{ marginTop: 0 }}>
            Load the starter CSV or connect a payment feed. It includes settled, refunded and duplicate rows so the signal can be
            checked end to end. Re-importing the same file is safe: the checksum makes it idempotent.
          </p>
          <p className="note">
            Required columns: <code>merchant_id</code>, <code>customer_id</code>, <code>paid_at</code>, <code>amount_minor</code>,{" "}
            <code>status</code>, <code>consent</code>. Optional <code>payment_id</code>, <code>customer_name</code>,{" "}
            <code>contact_ref</code>. Up to 2 MB. Formula-looking cells are neutralised, and a file with one bad row publishes nothing.
          </p>
          {overview.demo.demo_mode && (overview.last_import || overview.campaigns.length > 0) ? (
            <div className="actions" style={{ marginTop: 14 }}>
              <button className="secondary small" onClick={resetDemo} disabled={busy !== null}>
                {busy === "reset" ? <span className="spinner" /> : <Icon name="refresh" size={14} />}
                Reset workspace
              </button>
              <span className="tiny muted">Clears active workspace data while retaining the decision history.</span>
            </div>
          ) : null}
        </TiltCard>
      </div>

      {signal ? (
        <>
          <div className="section-title" data-reveal>
            <h2>Retention signal at {overview.demo.as_of}</h2>
            <span className="mono">deterministic · policy retention-v1</span>
          </div>
          <div className="grid four">
            <Stat value={signal.total_customers} label="Customers imported" />
            <Stat value={signal.regular_customers} label="Regulars in last 60 days" tone="info" />
            <Stat value={signal.absent_regulars} label="Regulars now absent 21+ days" tone="warn" />
            <Stat value={signal.eligible_count} label="Eligible after consent" tone="ok" />
          </div>
          <TiltCard className="card interactive" data-reveal>
            <div className="actions">
              <a className="btn" href="/signals">
                Inspect the audience <Icon name="arrow" size={15} />
              </a>
              <span className="tiny muted">
                {signal.excluded.consent_false} consent false · {signal.excluded.consent_unknown} consent unknown ·{" "}
                {signal.excluded.no_contact_ref} without contact reference are excluded. Consent is a hard gate, not a score.
              </span>
            </div>
          </TiltCard>
        </>
      ) : (
        <div className="card" style={{ marginTop: 20 }} data-reveal>
          <h2>No payment data yet</h2>
          <p className="muted" style={{ margin: 0 }}>
            Load payment data to compute the retention signal.
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
    </Reveal>
  );
}
