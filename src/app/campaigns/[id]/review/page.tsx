"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { COMPARISON_EXPLANATION, rewardPromise } from "@/server/domain/rules";
import type { CampaignDetail } from "@/components/types";
import { Reveal, SplitMeter, SplitText, TiltCard } from "@/components/motion";
import { apiCall, AuditTimeline, Banner, DemoBanner, ErrorBanner, Icon, InitialLoad, KeyValue, rupees, StatusPill, Steps } from "@/components/ui";

/** The deterministic checks, in the order a merchant would ask about them. */
const RULE_CHECKS: { label: string; codes: string[] }[] = [
  { label: "Eligible, consented cohort exists", codes: ["NO_ELIGIBLE_COHORT"] },
  { label: "Offer type is inside policy", codes: ["OFFER_KIND_NOT_ALLOWED"] },
  { label: "Reward is a whole-paise amount between ₹1 and ₹100", codes: ["OFFER_AMOUNT_OUT_OF_BOUNDS"] },
  { label: "Validity window is an allowed length", codes: ["OFFER_VALIDITY_NOT_ALLOWED"] },
  { label: "Timing sits inside 08:00–21:00 local", codes: ["TIMING_INVALID", "TIMING_OUTSIDE_POLICY"] },
  { label: "Copy is present and within length limits", codes: ["COPY_TOO_LONG", "COPY_EMPTY"] },
  { label: "Copy promises exactly what the offer gives", codes: ["COPY_OFFER_MISMATCH"] },
  { label: "Whole-cohort exposure fits the budget cap", codes: ["BUDGET_EXCEEDED", "BUDGET_CAP_INVALID"] },
];

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
      window.scrollTo({ top: 0, behavior: "smooth" });
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
  const failedCodes = new Set(rules.errors.map((item) => item.code));
  const dirty =
    Math.round(Number(rewardRupees) * 100) !== detail.proposal.offer.amount_minor ||
    headline !== detail.proposal.copy.headline ||
    body !== detail.proposal.copy.body ||
    cta !== detail.proposal.copy.cta ||
    separateReward !== (detail.proposal.copy_format === "separate_reward");
  const approved = detail.approval !== null;
  const rewardMinorDraft = Math.round(Number(rewardRupees) * 100);
  const sourcePill =
    detail.proposal.copy_source === "merchant" ? "merchant edited" : detail.version.ai_source === "model" ? "AI draft" : "rule-based draft";

  return (
    <Reveal ready refreshKey={`${detail.version.id}:${approved}`}>
      <DemoBanner />
      <Steps current="review" campaignId={id} />

      <div data-reveal>
        <div className="eyebrow">
          <span className="blink" /> Step 3 · review and approve
        </div>
        <div className="page-head">
          <h1>
            <SplitText text="Review" accent="before anything is sent" />
          </h1>
          <StatusPill status={detail.campaign.status} />
          <span className="pill neutral plain">version {detail.campaign.current_version}</span>
        </div>
        <p className="lede">“{detail.campaign.intent}”</p>
      </div>

      <div data-reveal>
        {rules.eligible ? (
          <Banner tone="ok" icon="check">
            <strong>All deterministic checks pass.</strong> Approving locks version {detail.campaign.current_version} and queues{" "}
            {rules.campaign_group_size} delivery jobs. The {rules.holdout_group_size} holdout customers get nothing.
          </Banner>
        ) : (
          <Banner tone="bad" icon="alert">
            <strong>Rules blocked this plan.</strong>
            <ul>
              {rules.errors.map((item) => (
                <li key={item.code + (item.field ?? "")}>{item.message}</li>
              ))}
            </ul>
            {rules.max_cap_safe_reward_minor > 0 ? (
              <p>
                A reward of {rupees(rules.max_cap_safe_reward_minor)} or less keeps {rules.audience_count} customers inside the{" "}
                {rupees(rules.budget_cap_minor)} cap.
              </p>
            ) : null}
          </Banner>
        )}
      </div>

      <div className="grid two" style={{ marginTop: 16 }}>
        <TiltCard className="card" data-reveal>
          <div className="page-head" style={{ marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>Campaign draft</h2>
            <span className={`pill ${detail.version.ai_source === "model" ? "info" : "neutral"}`}>{sourcePill}</span>
          </div>
          <p className="tiny muted" style={{ marginTop: 0 }}>
            {detail.version.ai_source === "model"
              ? "The original draft used Gemini and aggregate cohort facts only."
              : "The original draft used a rule-based template."}{" "}
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
            <Icon name="clock" size={13} /> {detail.proposal.timing.local_start}–{detail.proposal.timing.local_end} local ·{" "}
            {detail.proposal.offer.valid_days} day validity · {detail.proposal.offer.weekday_only ? "weekdays only" : "any day"}
          </p>
          {detail.proposal.model_estimated_cost_minor !== null ? (
            <p className="tiny muted">Model cost estimate: {rupees(detail.proposal.model_estimated_cost_minor)} (advisory only)</p>
          ) : null}
        </TiltCard>

        <TiltCard className="card" data-reveal>
          <div className="page-head" style={{ marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>Verified by rules</h2>
            <span className={`pill ${rules.eligible ? "ok" : "bad"}`}>{rules.eligible ? "passing" : "blocked"}</span>
          </div>
          <ul className="checks" style={{ marginBottom: 14 }}>
            {RULE_CHECKS.map((check) => {
              const failed = check.codes.some((code) => failedCodes.has(code));
              return (
                <li key={check.label}>
                  <span className={`tick ${failed ? "bad" : "ok"}`}>
                    <Icon name={failed ? "x" : "check"} />
                  </span>
                  <span style={failed ? { color: "var(--bad)", fontWeight: 600 } : undefined}>{check.label}</span>
                </li>
              );
            })}
          </ul>
          <div className="divider" />
          <KeyValue label="Eligible cohort" value={String(rules.audience_count)} hint="consented and contactable" />
          <KeyValue label="Campaign group" value={String(rules.campaign_group_size)} hint="receives the offer" />
          <KeyValue label="Holdout group" value={String(rules.holdout_group_size)} hint="receives nothing" />
          <KeyValue label="Reward per customer" value={rupees(rules.reward_minor)} />
          <KeyValue
            label="Conservative cohort exposure"
            value={rupees(rules.estimated_cost_minor)}
            hint={`${rules.audience_count} × ${rupees(rules.reward_minor)}`}
          />
          <KeyValue
            label="Campaign maximum exposure"
            value={rupees(rules.campaign_group_size * rules.reward_minor)}
            hint="only the campaign group can redeem"
          />
          <KeyValue label="Budget cap" value={rupees(rules.budget_cap_minor)} />
          <KeyValue label="Policy" value={detail.version.policy_version} />

          {rules.warnings.length > 0 ? (
            <div className="banner warn" style={{ marginTop: 12, marginBottom: 0 }}>
              <Icon name="info" />
              <div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {rules.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}
        </TiltCard>
      </div>

      <div className="card" data-reveal>
        <h2>Compare affordable offers</h2>
        <p className="tiny muted" style={{ marginTop: 4 }}>
          Same audience and holdout, different reward sizes. The cap conservatively covers the whole eligible cohort; the holdout
          receives no offer.
        </p>
        <p style={{ marginBottom: 8 }}>{detail.proposal.comparison_explanation ?? COMPARISON_EXPLANATION}</p>
        <span className="pill neutral plain">
          {detail.proposal.comparison_source === "model" ? "AI explanation · advisory" : "Rule-based explanation"}
        </span>
        <p className="tiny muted">No option predicts return rate, profit or ROI. Counts and costs below are calculated by rules.</p>
        {detail.offer_options.length === 0 ? (
          <p>No reward fits the current budget and minimum cohort. Increase the budget or import an eligible audience.</p>
        ) : (
          <div className="scroll" style={{ maxHeight: "none" }}>
            <table>
              <thead>
                <tr>
                  <th>Reward</th>
                  <th>Campaign / holdout</th>
                  <th className="num">Conservative exposure</th>
                  <th className="num">Campaign maximum</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {detail.offer_options.map((option) => {
                  const selected = option.reward_minor === rewardMinorDraft;
                  return (
                    <tr key={option.reward_minor} style={selected ? { background: "var(--info-soft)" } : undefined}>
                      <td>
                        <strong>{rupees(option.reward_minor)}</strong>
                      </td>
                      <td>
                        {option.campaign_group_size} / {option.holdout_group_size}
                      </td>
                      <td className="num">{rupees(option.conservative_exposure_minor)}</td>
                      <td className="num">{rupees(option.campaign_exposure_minor)}</td>
                      <td style={{ textAlign: "right" }}>
                        <button
                          className={`small ${selected ? "" : "secondary"}`}
                          disabled={busy !== null || approved}
                          onClick={() => {
                            setRewardRupees(String(option.reward_minor / 100));
                            if (!separateReward) {
                              setHeadline("A welcome back reward");
                              setBody("We would love to welcome you back.");
                              setCta("Visit us");
                            }
                            setSeparateReward(true);
                          }}
                        >
                          {selected ? <Icon name="check" size={13} /> : null}
                          Use {rupees(option.reward_minor)} offer
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="note">Choosing prepares edits only. Save the next version, review it, then approve.</p>
      </div>

      <div className="card" data-reveal>
        <h2>Merchant edits</h2>
        <p className="tiny muted" style={{ marginTop: 0 }}>
          Editing creates a new immutable version, expires any earlier approval, and cancels queued jobs that have not started.
        </p>

        <div className="two-col">
          <div>
            <div className="field">
              <label htmlFor="reward">Reward per customer (₹)</label>
              <input
                id="reward"
                type="number"
                min="1"
                step="0.01"
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
              <input id="headline" type="text" value={headline} onChange={(event) => setHeadline(event.target.value)} disabled={approved} />
            </div>
            <div className="field">
              <label htmlFor="body">{separateReward ? "Message introduction" : "Message body"}</label>
              <textarea id="body" value={body} onChange={(event) => setBody(event.target.value)} disabled={approved} />
            </div>
          </div>
        </div>

        {separateReward ? (
          <div className="banner info" style={{ marginTop: 14 }}>
            <Icon name="lock" />
            <div>
              <strong>Generated offer terms</strong>
              <p>
                {Number.isFinite(rewardMinorDraft) && rewardMinorDraft > 0
                  ? rewardPromise({ ...detail.proposal.offer, kind: "fixed_reward", amount_minor: rewardMinorDraft })
                  : "Enter a valid reward."}
              </p>
              <span className="tiny">These terms are appended to the introduction. Keep amounts out of editable copy.</span>
            </div>
          </div>
        ) : null}

        <div className="actions" style={{ marginTop: 14 }}>
          <button className="secondary" onClick={revise} disabled={busy !== null || !dirty || approved}>
            {busy === "revise" ? <span className="spinner" /> : <Icon name="pen" size={15} />}
            Save as version {detail.campaign.current_version + 1}
          </button>
          <button className="amber" onClick={approve} disabled={busy !== null || !rules.eligible || dirty || approved}>
            {busy === "approve" ? <span className="spinner" /> : <Icon name="stamp" size={15} />}
            Approve version {detail.campaign.current_version}
          </button>
          {dirty ? <span className="tiny muted">Save your edits before approving.</span> : null}
          {approved ? (
            <a className="btn secondary" href={`/campaigns/${id}/status`}>
              Go to delivery <Icon name="arrow" size={15} />
            </a>
          ) : null}
        </div>

        <div style={{ marginTop: 12 }}>
          <ErrorBanner error={error} />
        </div>
      </div>

      <div className="grid two">
        <div className="card" data-reveal>
          <h3>Assignment for this version</h3>
          <div className="split-label">
            <span className="pill info">Campaign {detail.groups.campaign.length}</span>
            <span className="pill neutral">Holdout {detail.groups.holdout.length}</span>
          </div>
          <SplitMeter campaign={detail.groups.campaign.length} holdout={detail.groups.holdout.length} />
          <p className="tiny muted">
            Stored with the version, so the split cannot drift after approval. Cohort hash <code>{detail.version.cohort_hash.slice(0, 12)}…</code>
          </p>
          <p className="tiny muted" style={{ marginBottom: 0 }}>
            Campaign: {detail.groups.campaign.join(", ")}
          </p>
        </div>
        <div className="card" data-reveal>
          <h3>Audit trail</h3>
          <AuditTimeline events={detail.audit} />
        </div>
      </div>
    </Reveal>
  );
}
