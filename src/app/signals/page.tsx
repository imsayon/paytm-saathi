"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Reveal, SplitMeter, SplitText, TiltCard } from "@/components/motion";
import { apiCall, DemoBanner, ErrorBanner, Icon, InitialLoad, rupees, Stat, Steps } from "@/components/ui";

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

const REASON_LABEL: Record<string, string> = {
  consent_false: "Consent false",
  consent_unknown: "Consent unknown",
  no_contact_ref: "No contact reference",
  over_cohort_cap: "Over cohort cap",
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
      <Reveal ready>
        <Steps current="signal" />
        <div className="card" data-reveal>
          <h2>No payment data imported</h2>
          <p className="muted" style={{ marginBottom: 0 }}>
            <a href="/">Load the demo CSV</a> first — the audience is derived from settled payments.
          </p>
        </div>
      </Reveal>
    );
  }

  const eligible = signal.absent_customers.filter((customer) => customer.eligible);
  const excluded = signal.absent_customers.filter((customer) => !customer.eligible);
  const campaignSize = Math.floor(eligible.length / 2);
  const holdoutSize = eligible.length - campaignSize;
  const capMinor = Math.round(Number(capRupees) * 100) || 0;

  return (
    <Reveal ready refreshKey={signal.eligible_count}>
      <DemoBanner planner={overview.demo.planner} />
      <Steps current="signal" />

      <div data-reveal>
        <div className="eyebrow">
          <span className="blink" /> Step 2 · the signal
        </div>
        <h1>
          <SplitText text="Why" accent="these customers?" />
        </h1>
        <p className="lede">
          Every number here comes from deterministic rules over settled payments — no model is involved in choosing who is in
          the audience.
        </p>
      </div>

      <div className="grid four">
        <Stat value={signal.regular_customers} label={`Regulars in ${signal.policy.lookbackDays} days`} tone="info" />
        <Stat value={signal.absent_regulars} label={`Absent ${signal.policy.inactivityDays}+ days`} tone="warn" />
        <Stat value={signal.excluded.consent_false + signal.excluded.consent_unknown} label="Excluded for consent" tone="bad" />
        <Stat value={signal.eligible_count} label="Eligible cohort" tone="ok" />
      </div>

      <div className="grid two">
        <TiltCard className="card" data-reveal>
          <h3>Policy {signal.policy.version}</h3>
          <ul className="checks">
            <li>
              <span className="tick ok">
                <Icon name="check" />
              </span>
              <span>
                A regular has at least {signal.policy.minSettledVisits} settled visits across at least{" "}
                {signal.policy.minDistinctDates} distinct dates in the last {signal.policy.lookbackDays} days.
              </span>
            </li>
            <li>
              <span className="tick ok">
                <Icon name="check" />
              </span>
              <span>Absent means no settled visit in the trailing {signal.policy.inactivityDays} days.</span>
            </li>
            <li>
              <span className="tick ok">
                <Icon name="check" />
              </span>
              <span>Refunded and duplicate payments never count as a visit.</span>
            </li>
            <li>
              <span className="tick ok">
                <Icon name="check" />
              </span>
              <span>Consent must be recorded as true and a contact reference must exist.</span>
            </li>
            <li>
              <span className="tick ok">
                <Icon name="check" />
              </span>
              <span>The cohort is capped at {signal.policy.cohortCap} and ordered by a stable hash.</span>
            </li>
          </ul>
        </TiltCard>

        <TiltCard className="card" data-reveal>
          <h3>Deterministic split (applied at approval)</h3>
          <div className="split-label">
            <span className="pill info">Campaign {campaignSize}</span>
            <span className="pill neutral">Holdout {holdoutSize}</span>
          </div>
          <SplitMeter campaign={campaignSize} holdout={holdoutSize} />
          <p className="tiny muted">
            The holdout receives nothing at all — no message and no delivery job. It supplies a comparison baseline; this small
            synthetic cohort cannot establish causal impact.
          </p>
          <div className="field" style={{ marginTop: 14 }}>
            <label htmlFor="intent">Merchant intent</label>
            <textarea id="intent" value={intent} onChange={(event) => setIntent(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="cap">Reward budget cap (₹)</label>
            <input id="cap" type="number" min="1" step="1" value={capRupees} onChange={(event) => setCapRupees(event.target.value)} />
            <p className="help">
              Cap is enforced by rules, not by the model. Current cap: {rupees(capMinor)}
              {eligible.length > 0 ? ` · cap-safe reward ≤ ${rupees(Math.floor(capMinor / eligible.length))}` : ""}
            </p>
          </div>
          <div className="actions" style={{ marginTop: 14 }}>
            <button onClick={createProposal} disabled={busy || eligible.length === 0}>
              {busy ? <span className="spinner" /> : <Icon name="pen" size={16} />}
              Draft a campaign
            </button>
            <span className="tiny muted">The planner sees counts only. Never an identifier, never a contact.</span>
          </div>
          <div style={{ marginTop: 12 }}>
            <ErrorBanner error={error} />
          </div>
        </TiltCard>
      </div>

      <div className="card" data-reveal>
        <h3>Eligible cohort ({eligible.length})</h3>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th className="num">Settled visits</th>
                <th className="num">Distinct dates</th>
                <th>Last visit</th>
                <th className="num">Days absent</th>
                <th>Weekday regular</th>
              </tr>
            </thead>
            <tbody>
              {eligible.map((customer) => (
                <tr key={customer.customer_ref}>
                  <td>
                    <code>{customer.customer_ref}</code>
                  </td>
                  <td className="num">{customer.settled_visits}</td>
                  <td className="num">{customer.distinct_dates}</td>
                  <td>{customer.last_settled_date}</td>
                  <td className="num">{customer.days_since_last_visit}</td>
                  <td>{customer.weekday_regular ? <span className="pill ok plain">Yes</span> : <span className="pill neutral plain">No</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">Identifiers are masked. Contact references are never shown in the UI and never sent to the model.</p>
      </div>

      <div className="card" data-reveal>
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
                  <span className="pill warn">{REASON_LABEL[customer.exclusion_reason ?? ""] ?? customer.exclusion_reason}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Reveal>
  );
}
