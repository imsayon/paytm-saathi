"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { COMPARISON_EXPLANATION, rewardPromise } from "@/server/domain/rules";
import type { CampaignDetail } from "@/components/types";
import { InitialLoad, apiCall, AuditTimeline, DemoBanner, ErrorBanner, KeyValue, rupees, StatusPill, Steps } from "@/components/ui";

export default function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();

  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [error, setError] = useState<{ message: string; details?: unknown } | null>(null);
  const [busy, setBusy] = useState<"revise" | "approve" | null>(null);

  const [separateReward, setSeparateReward] = useState(false);
  const [rewardRupees, setRewardRupees] = useState("");
  const [headline, setHeadline] = useState("");
  const [body, setBody] = useState("");
  const [cta, setCta] = useState("");

  const applyDetail = useCallback((data: CampaignDetail) => {
    setDetail(data);
    setSeparateReward(data.proposal.copy_format === "separate_reward");
    setRewardRupees(String(data.proposal.offer.amount_minor / 100));
    setHeadline(data.proposal.copy.headline);
    setBody(data.proposal.copy.body);
    setCta(data.proposal.copy.cta);
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      applyDetail(await apiCall<CampaignDetail>(`/api/campaigns/${id}`));
    } catch (caught) {
      setError(caught as Error);
    }
  }, [id, applyDetail]);

  useEffect(() => {
    void load();
  }, [load]);

  async function revise() {
    setBusy("revise");
    setError(null);
    try {
      const data = await apiCall<CampaignDetail>(`/api/campaigns/${id}/revise`, {
        method: "POST",
        body: JSON.stringify({
          ...(separateReward ? { copy_format: "separate_reward" } : {}),
          reward_minor: Math.round(Number(rewardRupees) * 100),
          copy: { headline, body, cta },
        }),
      });
      applyDetail(data);
    } catch (caught) {
      setError(caught as Error);
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    if (!detail) return;
    setBusy("approve");
    setError(null);
    try {
      await apiCall(`/api/campaigns/${id}/approve`, {
        method: "POST",
        body: JSON.stringify({ version: detail.campaign.current_version }),
        idempotencyKey: `approve-${id}-v${detail.campaign.current_version}`,
      });
      router.push(`/campaigns/${id}/status`);
    } catch (caught) {
      setError(caught as Error);
      setBusy(null);
    }
  }

  if (!detail) return <InitialLoad error={error} retry={() => void load()} />;

  const rules = detail.rule_result;
  const dirty =
    Math.round(Number(rewardRupees) * 100) !== detail.proposal.offer.amount_minor ||
    headline !== detail.proposal.copy.headline ||
    body !== detail.proposal.copy.body ||
    cta !== detail.proposal.copy.cta ||
    separateReward !== (detail.proposal.copy_format === "separate_reward");
  const approved = detail.approval !== null;

  return (
    <>
      <DemoBanner />
      <Steps current="review" />

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
        <h1 style={{ margin: 0 }}>Review before anything is sent</h1>
        <StatusPill status={detail.campaign.status} />
        <span className="pill neutral">version {detail.campaign.current_version}</span>
      </div>
      <p className="lede">“{detail.campaign.intent}”</p>

      {rules.eligible ? (
        <div className="banner ok">
          All deterministic checks pass. Approving locks version {detail.campaign.current_version} and queues{" "}
          {rules.campaign_group_size} mock delivery jobs.
        </div>
      ) : (
        <div className="banner bad">
          <strong>Rules blocked this plan.</strong>
          <ul>
            {rules.errors.map((item) => (
              <li key={item.code + (item.field ?? "")}>{item.message}</li>
            ))}
          </ul>
          {rules.max_cap_safe_reward_minor > 0 ? (
            <p style={{ margin: "8px 0 0" }}>
              A reward of {rupees(rules.max_cap_safe_reward_minor)} or less keeps {rules.audience_count} customers
              inside the {rupees(rules.budget_cap_minor)} cap.
            </p>
          ) : null}
        </div>
      )}

      <div className="grid two" style={{ marginTop: 16 }}>
        <div className="card">
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>Campaign draft</h2>
            <span className="pill info">
              {detail.proposal.copy_source === "merchant" ? "merchant edited" : detail.version.ai_source === "model" ? "model" : "template fallback"}
            </span>
          </div>
          <p className="tiny muted" style={{ marginTop: 0 }}>
            {detail.version.ai_source === "model" ? "The original draft used Gemini and aggregate cohort facts only." : "The original draft used a deterministic template; no model generated it."}{" "}
            Merchant edits are saved separately. Rules choose recipients and enforce consent and the cap.
          </p>

          <h3 style={{ marginTop: 16 }}>Audience label</h3>
          <p style={{ marginTop: 0 }}>{detail.proposal.audience_label}</p>

          <h3>Rationale</h3>
          <ul style={{ marginTop: 0, paddingLeft: 18 }}>
            {detail.proposal.rationale.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>

          <h3>Timing</h3>
          <p className="tiny muted" style={{ marginTop: 0 }}>
            {detail.proposal.timing.local_start}–{detail.proposal.timing.local_end} local ·{" "}
            {detail.proposal.offer.valid_days} day validity ·{" "}
            {detail.proposal.offer.weekday_only ? "weekdays only" : "any day"}
          </p>
          {detail.proposal.model_estimated_cost_minor !== null ? (
            <p className="tiny muted">
              Model cost estimate: {rupees(detail.proposal.model_estimated_cost_minor)} (advisory only)
            </p>
          ) : null}
        </div>

        <div className="card">
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>Verified by rules</h2>
            <span className={`pill ${rules.eligible ? "ok" : "bad"}`}>{rules.eligible ? "passing" : "blocked"}</span>
          </div>
          <KeyValue label="Eligible cohort" value={String(rules.audience_count)} hint="consented and contactable" />
          <KeyValue label="Campaign group" value={String(rules.campaign_group_size)} hint="receives the offer" />
          <KeyValue label="Holdout group" value={String(rules.holdout_group_size)} hint="receives nothing" />
          <KeyValue label="Reward per customer" value={rupees(rules.reward_minor)} />
          <KeyValue
            label="Conservative cohort exposure"
            value={rupees(rules.estimated_cost_minor)}
            hint={`${rules.audience_count} × ${rupees(rules.reward_minor)}`}
          />
          <KeyValue label="Campaign maximum exposure" value={rupees(rules.campaign_group_size * rules.reward_minor)} hint="Only the campaign group can receive a reward" />
          <KeyValue label="Budget cap" value={rupees(rules.budget_cap_minor)} />
          <KeyValue label="Policy" value={detail.version.policy_version} />

          {rules.warnings.length > 0 ? (
            <div className="banner warn" style={{ marginTop: 12 }}>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {rules.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>

      <div className="card">
        <h2>Compare affordable offers</h2>
        <p className="tiny muted">Same audience and holdout, different reward sizes. The cap conservatively covers the whole eligible cohort; the holdout receives no offer.</p>
        <p>{detail.proposal.comparison_explanation ?? COMPARISON_EXPLANATION}</p>
        <span className="pill neutral">{detail.proposal.comparison_source === "model" ? "AI explanation · advisory" : "Rule-based explanation"}</span>
        <p className="tiny muted">No option predicts return rate, profit or ROI. Counts and costs below are calculated by rules.</p>
        {detail.offer_options.length === 0 ? <p>No reward fits the current budget and minimum cohort. Increase the budget or import an eligible audience.</p> : (
          <div className="scroll"><table>
            <thead><tr><th>Reward</th><th>Campaign / holdout</th><th>Conservative exposure</th><th>Campaign maximum</th><th>Action</th></tr></thead>
            <tbody>{detail.offer_options.map((option) => <tr key={option.reward_minor}>
              <td>{rupees(option.reward_minor)}</td><td>{option.campaign_group_size} / {option.holdout_group_size}</td>
              <td>{rupees(option.conservative_exposure_minor)}</td><td>{rupees(option.campaign_exposure_minor)}</td>
              <td><button className="secondary" disabled={busy !== null || approved} onClick={() => {
                setRewardRupees(String(option.reward_minor / 100));
                if (!separateReward) {
                  setHeadline("A welcome back reward"); setBody("We would love to welcome you back."); setCta("Visit us");
                }
                setSeparateReward(true);
              }}>Use {rupees(option.reward_minor)} offer</button></td>
            </tr>)}</tbody>
          </table></div>
        )}
        <p className="tiny muted">Choosing prepares edits only. Save the next version, review it, then approve.</p>
      </div>

      <div className="card">
        <h2>Merchant edits</h2>
        <p className="tiny muted" style={{ marginTop: 0 }}>
          Editing creates a new immutable version, expires any earlier approval, and cancels queued jobs that have not
          started.
        </p>

        <div className="grid two">
          <div>
            <div className="field">
              <label htmlFor="reward">Reward per customer (₹)</label>
              <input
                id="reward"
                type="number"
                value={rewardRupees}
                onChange={(event) => setRewardRupees(event.target.value)}
                disabled={approved}
              />
            </div>
            <div className="field">
              <label htmlFor="cta">Call to action</label>
              <input id="cta" type="text" value={cta} onChange={(event) => setCta(event.target.value)} disabled={approved} />
            </div>
          </div>
          <div>
            <div className="field">
              <label htmlFor="headline">Headline</label>
              <input
                id="headline"
                type="text"
                value={headline}
                onChange={(event) => setHeadline(event.target.value)}
                disabled={approved}
              />
            </div>
            <div className="field">
              <label htmlFor="body">{separateReward ? "Message introduction" : "Message body"}</label>
              <textarea id="body" value={body} onChange={(event) => setBody(event.target.value)} disabled={approved} />
            </div>
          </div>
        </div>

        {separateReward ? <div className="banner info"><strong>Generated offer terms</strong><p>{Number.isFinite(Number(rewardRupees)) ? rewardPromise({ ...detail.proposal.offer, kind: "fixed_reward", amount_minor: Math.round(Number(rewardRupees) * 100) }) : "Enter a valid reward."}</p><span className="tiny">These terms are appended to the introduction. Keep amounts out of editable copy.</span></div> : null}

        <div className="actions" style={{ marginTop: 14 }}>
          <button className="secondary" onClick={revise} disabled={busy !== null || !dirty || approved}>
            {busy === "revise" ? <span className="spinner" /> : null}
            Save as version {detail.campaign.current_version + 1}
          </button>
          <button onClick={approve} disabled={busy !== null || !rules.eligible || dirty || approved}>
            {busy === "approve" ? <span className="spinner" /> : null}
            Approve version {detail.campaign.current_version}
          </button>
          {dirty ? <span className="tiny muted">Save your edits before approving.</span> : null}
          {approved ? (
            <a className="btn secondary" href={`/campaigns/${id}/status`}>
              Go to delivery
            </a>
          ) : null}
        </div>

        <div style={{ marginTop: 12 }}>
          <ErrorBanner error={error} />
        </div>
      </div>

      <div className="grid two">
        <div className="card">
          <h3>Assignment for this version</h3>
          <div className="split-label">
            <span className="pill info">Campaign {detail.groups.campaign.length}</span>
            <span className="pill neutral">Holdout {detail.groups.holdout.length}</span>
          </div>
          <p className="tiny muted">
            Stored with the version, so the split cannot drift after approval. Cohort hash{" "}
            <code>{detail.version.cohort_hash.slice(0, 12)}…</code>
          </p>
          <p className="tiny muted" style={{ marginBottom: 0 }}>
            Campaign: {detail.groups.campaign.join(", ")}
          </p>
        </div>
        <div className="card">
          <h3>Audit trail</h3>
          <AuditTimeline events={detail.audit} />
        </div>
      </div>
    </>
  );
}
