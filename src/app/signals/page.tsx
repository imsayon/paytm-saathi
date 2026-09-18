"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { InitialLoad, apiCall, DemoBanner, ErrorBanner, rupees, Stat, Steps } from "@/components/ui";

type CustomerView = {
  customer_ref: string;
  consent: string;
  settled_visits: number;
  distinct_dates: number;
  last_settled_date: string | null;
  days_since_last_visit: number | null;
  weekday_regular: boolean;
  eligible: boolean;
  exclusion_reason: string | null;
};

type Overview = {
  demo: { as_of: string; suggested_intent: string; suggested_budget_cap_minor: number; planner: string };
  signal: {
    as_of: string;
    policy: {
      version: string;
      lookbackDays: number;
      inactivityDays: number;
      minSettledVisits: number;
      minDistinctDates: number;
      cohortCap: number;
    };
    total_customers: number;
    regular_customers: number;
    absent_regulars: number;
    eligible_count: number;
    excluded: { consent_false: number; consent_unknown: number; no_contact_ref: number; over_cohort_cap: number };
    absent_customers: CustomerView[];
  } | null;
};

export default function SignalsPage() {
  const router = useRouter();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<{ message: string } | null>(null);
  const [intent, setIntent] = useState("");
  const [capRupees, setCapRupees] = useState("300");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await apiCall<Overview>("/api/overview");
      setOverview(data);
      setIntent((current) => current || data.demo.suggested_intent);
      setCapRupees(String(data.demo.suggested_budget_cap_minor / 100));
    } catch (caught) {
      setError(caught as Error);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createProposal() {
    setBusy(true);
    setError(null);
    try {
      const capMinor = Math.round(Number(capRupees) * 100);
      const result = await apiCall<{ campaign: { id: string } }>("/api/campaigns/preview", {
        method: "POST",
        body: JSON.stringify({ intent, budget_cap_minor: capMinor }),
      });
      router.push(`/campaigns/${result.campaign.id}/review`);
    } catch (caught) {
      setError(caught as Error);
      setBusy(false);
    }
  }

  if (!overview) return <InitialLoad error={error} retry={() => void load()} />;

  const signal = overview.signal;
  if (!signal) {
    return (
      <>
        <Steps current="signal" />
        <div className="card">
          <h2>No payment data imported</h2>
          <p className="muted">
            <a href="/">Load the demo CSV</a> first — the audience is derived from settled payments.
          </p>
        </div>
      </>
    );
  }

  const eligible = signal.absent_customers.filter((customer) => customer.eligible);
  const excluded = signal.absent_customers.filter((customer) => !customer.eligible);
  const campaignSize = Math.floor(eligible.length / 2);

  return (
    <>
      <DemoBanner planner={overview.demo.planner} />
      <Steps current="signal" />

      <h1>Why these customers?</h1>
      <p className="lede">
        Every number here comes from deterministic rules over settled payments — no model is involved in choosing who
        is in the audience.
      </p>

      <div className="grid four">
        <Stat value={signal.regular_customers} label={`Regulars in ${signal.policy.lookbackDays} days`} />
        <Stat value={signal.absent_regulars} label={`Absent ${signal.policy.inactivityDays}+ days`} />
        <Stat value={signal.excluded.consent_false + signal.excluded.consent_unknown} label="Excluded for consent" tone="warn" />
        <Stat value={signal.eligible_count} label="Eligible cohort" tone="ok" />
      </div>

      <div className="grid two">
        <div className="card">
          <h3>Policy {signal.policy.version}</h3>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li>
              A regular has at least {signal.policy.minSettledVisits} settled visits across at least{" "}
              {signal.policy.minDistinctDates} distinct dates in the last {signal.policy.lookbackDays} days.
            </li>
            <li>Absent means no settled visit in the trailing {signal.policy.inactivityDays} days.</li>
            <li>Refunded and duplicate payments never count as a visit.</li>
            <li>Consent must be recorded as true and a contact reference must exist.</li>
            <li>The cohort is capped at {signal.policy.cohortCap} and ordered by a stable hash.</li>
          </ul>
        </div>

        <div className="card">
          <h3>Deterministic split (applied at approval)</h3>
          <div className="split-label">
            <span className="pill info">Campaign {campaignSize}</span>
            <span className="pill neutral">Holdout {eligible.length - campaignSize}</span>
          </div>
          <p className="tiny muted">
            The holdout receives nothing at all — no message and no delivery job. It supplies a comparison baseline; this small synthetic cohort cannot establish causal impact.
          </p>
          <div className="field" style={{ marginTop: 14 }}>
            <label htmlFor="intent">Merchant intent</label>
            <textarea id="intent" value={intent} onChange={(event) => setIntent(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="cap">Reward budget cap (₹)</label>
            <input id="cap" type="number" value={capRupees} onChange={(event) => setCapRupees(event.target.value)} />
            <p className="tiny muted" style={{ margin: "6px 0 0" }}>
              Cap is enforced by rules, not by the model. Current cap: {rupees(Math.round(Number(capRupees) * 100) || 0)}
            </p>
          </div>
          <div className="actions" style={{ marginTop: 14 }}>
            <button onClick={createProposal} disabled={busy || eligible.length === 0}>
              {busy ? <span className="spinner" /> : null}
              Draft a campaign
            </button>
          </div>
          <div style={{ marginTop: 12 }}>
            <ErrorBanner error={error} />
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Eligible cohort ({eligible.length})</h3>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Settled visits</th>
                <th>Distinct dates</th>
                <th>Last visit</th>
                <th>Days absent</th>
                <th>Weekday regular</th>
              </tr>
            </thead>
            <tbody>
              {eligible.map((customer) => (
                <tr key={customer.customer_ref}>
                  <td>
                    <code>{customer.customer_ref}</code>
                  </td>
                  <td>{customer.settled_visits}</td>
                  <td>{customer.distinct_dates}</td>
                  <td>{customer.last_settled_date}</td>
                  <td>{customer.days_since_last_visit}</td>
                  <td>{customer.weekday_regular ? "Yes" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="tiny muted" style={{ marginBottom: 0 }}>
          Identifiers are masked. Contact references are never shown in the UI and never sent to the model.
        </p>
      </div>

      <div className="card">
        <h3>Excluded from the audience ({excluded.length})</h3>
        <table>
          <thead>
            <tr>
              <th>Customer</th>
              <th>Consent</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {excluded.map((customer) => (
              <tr key={customer.customer_ref}>
                <td>
                  <code>{customer.customer_ref}</code>
                </td>
                <td>{customer.consent}</td>
                <td>
                  <span className="pill warn">{customer.exclusion_reason}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
