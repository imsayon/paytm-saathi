"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Reveal, SplitMeter, SplitText, TiltCard } from "@/components/motion";
import { apiCall, ErrorBanner, Icon, InitialLoad, rupees, Stat } from "@/components/ui";

type CustomerView = {
  selection_id: string;
  display_name: string;
  customer_ref: string;
  is_important: boolean;
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
    excluded: { consent_false: number; consent_unknown: number; no_contact_ref: number; over_cohort_cap: number; not_selected: number };
    selection_mode: string;
    absent_customers: CustomerView[];
  } | null;
};

const REASON_LABEL: Record<string, string> = {
  consent_false: "Consent false",
  consent_unknown: "Consent unknown",
  no_contact_ref: "No contact reference",
  over_cohort_cap: "Over cohort cap",
  not_selected: "Not on merchant shortlist",
};

export default function SignalsPage() {
  const router = useRouter();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<{ message: string } | null>(null);
  const [intent, setIntent] = useState("");
  const [capRupees, setCapRupees] = useState("300");
  const [busy, setBusy] = useState(false);
  const [selectedCustomerIds, setSelectedCustomerIds] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await apiCall<Overview>("/api/overview");
      setOverview(data);
      setIntent((current) => current || data.demo.suggested_intent);
      setCapRupees(String(data.demo.suggested_budget_cap_minor / 100));
      if (data.signal) {
        const candidates = data.signal.absent_customers.filter((customer) => customer.eligible);
        const marked = candidates.filter((customer) => customer.is_important);
        setSelectedCustomerIds(new Set((marked.length > 0 ? marked : candidates).map((customer) => customer.selection_id)));
      }
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
      const selected = signal?.absent_customers
        .filter((customer) => customer.eligible && selectedCustomerIds.has(customer.selection_id))
        .map((customer) => customer.selection_id) ?? [];
      if (selected.length < 2) {
        throw Object.assign(new Error("Choose at least two important customers before drafting a campaign."), { details: undefined });
      }
      await apiCall("/api/customers/importance", {
        method: "PUT",
        body: JSON.stringify({ customer_ids: selected }),
      });
      const capMinor = Math.round(Number(capRupees) * 100);
      const result = await apiCall<{ campaign: { id: string } }>("/api/campaigns/preview", {
        method: "POST",
        body: JSON.stringify({ intent, budget_cap_minor: capMinor, selected_customer_ids: selected }),
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
        <div className="card" data-reveal>
          <h2>Add payment data first</h2>
          <p className="muted" style={{ marginBottom: 0 }}>
            <a href="/">Upload payment data</a> to see your customer activity.
          </p>
        </div>
      </Reveal>
    );
  }

  const eligible = signal.absent_customers.filter((customer) => customer.eligible);
  const excluded = signal.absent_customers.filter((customer) => !customer.eligible);
  const excludedPreview = excluded.slice(0, 50);
  const selected = eligible.filter((customer) => selectedCustomerIds.has(customer.selection_id));
  const campaignSize = Math.floor(selected.length / 2);
  const holdoutSize = selected.length - campaignSize;
  const capMinor = Math.round(Number(capRupees) * 100) || 0;

  return (
    <Reveal ready refreshKey={signal.eligible_count}>
      <div data-reveal>
        <div className="eyebrow">
          <span className="blink" /> Customer activity
        </div>
        <h1>
          <SplitText text="Choose" accent="your important customers." />
        </h1>
        <p className="lede">
          Saathi surfaces customers who used to visit regularly and have gone quiet. You decide which relationships matter most before
          the campaign is drafted.
        </p>
      </div>

      <div className="grid four">
        <Stat value={signal.regular_customers} label={`Regular customers`} tone="info" />
        <Stat value={signal.absent_regulars} label="Quiet regulars" tone="warn" />
        <Stat value={signal.excluded.consent_false + signal.excluded.consent_unknown} label="Left out" tone="bad" />
        <Stat value={selected.length} label="On your shortlist" tone="ok" />
      </div>

      <div className="grid two">
        <TiltCard className="card" data-reveal>
          <h3>How the list is chosen</h3>
          <ul className="checks">
            <li>
              <span className="tick ok">
                <Icon name="check" />
              </span>
              <span>Regular customers have visited at least {signal.policy.minSettledVisits} times on {signal.policy.minDistinctDates} different days in the last {signal.policy.lookbackDays} days.</span>
            </li>
            <li>
              <span className="tick ok">
                <Icon name="check" />
              </span>
              <span>Quiet means they have not visited in the last {signal.policy.inactivityDays} days.</span>
            </li>
            <li>
              <span className="tick ok">
                <Icon name="check" />
              </span>
              <span>Refunds and duplicate payments are not counted as visits.</span>
            </li>
            <li>
              <span className="tick ok">
                <Icon name="check" />
              </span>
              <span>Only people who have given permission and have contact details are included.</span>
            </li>
            <li>
              <span className="tick ok">
                <Icon name="check" />
              </span>
              <span>The list is limited to {signal.policy.cohortCap} people so it stays manageable.</span>
            </li>
          </ul>
        </TiltCard>

        <TiltCard className="card" data-reveal>
          <h3>Plan your next offer</h3>
          <div className="split-label">
            <span className="pill info">Campaign {campaignSize}</span>
            <span className="pill neutral">Holdout {holdoutSize}</span>
          </div>
          <SplitMeter campaign={campaignSize} holdout={holdoutSize} />
          <p className="tiny muted">
            Your shortlist is split into a campaign group and an untouched holdout so you can compare what happened.
          </p>
          <div className="field" style={{ marginTop: 14 }}>
            <label htmlFor="intent">What would you like to say?</label>
            <textarea id="intent" value={intent} onChange={(event) => setIntent(event.target.value)} />
          </div>
          <div className="field">
              <label htmlFor="cap">Total reward budget (₹)</label>
            <input id="cap" type="number" min="1" step="1" value={capRupees} onChange={(event) => setCapRupees(event.target.value)} />
            <p className="help">
              Your maximum spend is {rupees(capMinor)}
              {eligible.length > 0 ? ` · cap-safe reward ≤ ${rupees(Math.floor(capMinor / eligible.length))}` : ""}
            </p>
          </div>
          <div className="actions" style={{ marginTop: 14 }}>
            <button onClick={createProposal} disabled={busy || selected.length < 2}>
              {busy ? <span className="spinner" /> : <Icon name="pen" size={16} />}
              Save shortlist & draft
            </button>
            <span className="tiny muted">{selected.length} selected · you review the message before anything is sent.</span>
          </div>
          <div style={{ marginTop: 12 }}>
            <ErrorBanner error={error} />
          </div>
        </TiltCard>
      </div>

      <div className="card" data-reveal>
        <div className="page-head" style={{ marginBottom: 8 }}>
          <div>
            <h3 style={{ margin: 0 }}>Customers to review ({eligible.length})</h3>
            <p className="tiny muted" style={{ margin: "4px 0 0" }}>Select the customers you consider important for this campaign.</p>
          </div>
          <span className="pill info plain">{selected.length} selected</span>
        </div>
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Select</th>
                <th>Customer</th>
                <th className="num">Settled visits</th>
                <th className="num">Distinct dates</th>
                <th>Last visit</th>
                <th className="num">Days absent</th>
                <th>Weekday regular</th>
              </tr>
            </thead>
            <tbody>
              {eligible.map((customer, index) => (
                <tr key={`${customer.customer_ref}-${index}`}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${customer.display_name}`}
                      checked={selectedCustomerIds.has(customer.selection_id)}
                      onChange={() => {
                        setSelectedCustomerIds((current) => {
                          const next = new Set(current);
                          if (next.has(customer.selection_id)) next.delete(customer.selection_id);
                          else next.add(customer.selection_id);
                          return next;
                        });
                      }}
                    />
                  </td>
                  <td>
                    <strong>{customer.display_name}</strong>
                    <div><code>{customer.customer_ref}</code></div>
                    {customer.is_important ? <span className="pill ok plain tiny">Important</span> : null}
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
        <p className="note">Consent and contactability remain hard gates. Your shortlist chooses priority; it cannot bypass policy.</p>
      </div>

      <div className="card" data-reveal>
        <h3>Not included ({excluded.length})</h3>
        <table>
          <thead>
            <tr>
              <th>Customer</th>
              <th>Consent</th>
              <th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {excludedPreview.map((customer, index) => (
              <tr key={`${customer.customer_ref}-${index}`}>
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
        <p className="note">
          {excluded.length > excludedPreview.length
            ? `Showing ${excludedPreview.length} of ${excluded.length} excluded customers. Eligibility counts remain complete.`
            : "Eligibility counts remain complete."}
        </p>
      </div>
    </Reveal>
  );
}
