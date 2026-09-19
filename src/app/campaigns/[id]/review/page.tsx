"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { COMPARISON_EXPLANATION, rewardPromise } from "@/server/domain/rules";
import type { CampaignDetail } from "@/components/types";
import { Reveal, SplitMeter, SplitText, TiltCard } from "@/components/motion";
import { apiCall, AuditTimeline, Banner, ErrorBanner, Icon, InitialLoad, KeyValue, rupees, StatusPill } from "@/components/ui";

/** The deterministic checks, in the order a merchant would ask about them. */
const RULE_CHECKS: { label: string; codes: string[] }[] = [
  { label: "There are customers to reach", codes: ["NO_ELIGIBLE_COHORT"] },
  { label: "The offer is available", codes: ["OFFER_KIND_NOT_ALLOWED"] },
  { label: "The reward is between ₹1 and ₹100", codes: ["OFFER_AMOUNT_OUT_OF_BOUNDS"] },
  { label: "The offer lasts for an allowed number of days", codes: ["OFFER_VALIDITY_NOT_ALLOWED"] },
  { label: "The timing is between 08:00 and 21:00", codes: ["TIMING_INVALID", "TIMING_OUTSIDE_POLICY"] },
  { label: "The message is ready", codes: ["COPY_TOO_LONG", "COPY_EMPTY"] },
  { label: "The message matches the offer", codes: ["COPY_OFFER_MISMATCH"] },
  { label: "The offer fits your budget", codes: ["BUDGET_EXCEEDED", "BUDGET_CAP_INVALID"] },
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
  const sourcePill = detail.proposal.copy_source === "merchant" ? "Edited by you" : "Suggested draft";

  return (
    <Reveal ready refreshKey={`${detail.version.id}:${approved}`}>
      <div data-reveal>
        <div className="eyebrow">
          <span className="blink" /> Review your offer
        </div>
        <div className="page-head">
          <h1>
            <SplitText text="Review" accent="before you send it" />
          </h1>
          <StatusPill status={detail.campaign.status} />
          <span className="pill neutral plain">version {detail.campaign.current_version}</span>
        </div>
        <p className="lede">“{detail.campaign.intent}”</p>
      </div>

      <div data-reveal>
        {rules.eligible ? (
          <Banner tone="ok" icon="check">
            <strong>This offer is ready.</strong> Approving sends it to {rules.campaign_group_size} customers. The {rules.holdout_group_size} customers kept aside will not receive it.
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
                A reward of {rupees(rules.max_cap_safe_reward_minor)} or less keeps the offer within your {rupees(rules.budget_cap_minor)} budget.
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
            This is a suggested message. You can edit it before deciding. People are only included when they have given permission and the offer fits your budget.
          </p>

          <h3 style={{ marginTop: 16 }}>Who this is for</h3>
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
        </TiltCard>

        <TiltCard className="card" data-reveal>
          <div className="page-head" style={{ marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>Offer check</h2>
            <span className={`pill ${rules.eligible ? "ok" : "bad"}`}>{rules.eligible ? "Ready" : "Needs changes"}</span>
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
          <KeyValue label="Customers" value={String(rules.audience_count)} hint="with permission to hear from you" />
          <KeyValue label="Offer group" value={String(rules.campaign_group_size)} hint="will receive the offer" />
          <KeyValue label="Kept aside" value={String(rules.holdout_group_size)} hint="will not receive it" />
          <KeyValue label="Reward per customer" value={rupees(rules.reward_minor)} />
          <KeyValue
            label="Maximum possible spend"
            value={rupees(rules.estimated_cost_minor)}
            hint={`${rules.audience_count} × ${rupees(rules.reward_minor)}`}
          />
          <KeyValue
            label="Offer group spend"
            value={rupees(rules.campaign_group_size * rules.reward_minor)}
            hint="only the campaign group can redeem"
          />
          <KeyValue label="Budget limit" value={rupees(rules.budget_cap_minor)} />

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
        <h2>Compare offers</h2>
        <p className="tiny muted" style={{ marginTop: 4 }}>
          Try a few reward amounts for the same customer list. The people kept aside will not receive an offer.
        </p>
        <p style={{ marginBottom: 8 }}>{detail.proposal.comparison_explanation ?? COMPARISON_EXPLANATION}</p>
        {detail.offer_options.length === 0 ? (
          <p>No reward fits the current budget. Increase the budget or add more customers to the list.</p>
        ) : (
          <div className="scroll" style={{ maxHeight: "none" }}>
            <table>
              <thead>
                <tr>
                  <th>Reward</th>
                  <th>Offer group / kept aside</th>
                  <th className="num">Maximum spend</th>
                  <th className="num">Offer group spend</th>
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
        <p className="note">Choose an offer, edit the message if you like, then save and approve it.</p>
      </div>

      <div className="card" data-reveal>
        <h2>Edit your offer</h2>
        <p className="tiny muted" style={{ marginTop: 0 }}>
          Make the message and reward feel right for your shop. You can review everything again before approving.
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
              <strong>Offer details</strong>
              <p>
                {Number.isFinite(rewardMinorDraft) && rewardMinorDraft > 0
                  ? rewardPromise({ ...detail.proposal.offer, kind: "fixed_reward", amount_minor: rewardMinorDraft })
                  : "Enter a valid reward."}
              </p>
              <span className="tiny">The reward details will be added automatically.</span>
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
          <h3>Customer groups</h3>
          <div className="split-label">
            <span className="pill info">Campaign {detail.groups.campaign.length}</span>
            <span className="pill neutral">Holdout {detail.groups.holdout.length}</span>
          </div>
          <SplitMeter campaign={detail.groups.campaign.length} holdout={detail.groups.holdout.length} />
          <p className="tiny muted">
            The offer group receives the message. The group kept aside does not.
          </p>
        </div>
        <div className="card" data-reveal>
          <h3>Activity</h3>
          <AuditTimeline events={detail.audit} />
        </div>
      </div>
    </Reveal>
  );
}
