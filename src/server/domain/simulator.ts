import { recordAudit } from "../audit/events";
import type { MerchantContext } from "../auth/context";
import { inWriteTransaction, newId, type Db } from "../db/client";
import { AppError } from "../errors";
import { listRecipients, loadCampaign, loadVersion } from "./campaign";
import type { Proposal } from "./rules";
import { stableHash } from "./signal";
import { addDays } from "./time";

/**
 * Synthetic demo parameters. These are assumptions baked into the fixture, not
 * measured effects: the simulator exists to exercise the measurement and holdout
 * machinery, not to predict how real customers behave.
 */
export const SIMULATION = {
  windowDays: 7,
  campaignReturnRate: 0.6,
  holdoutReturnRate: 0.2,
  returnAmountMinor: 18_000,
  optOutsPerCampaignGroup: 1,
} as const;

export type SimulationResult = {
  windowStart: string;
  windowEnd: string;
  campaignReturns: number;
  holdoutReturns: number;
  created: number;
  alreadySimulated: boolean;
};

function orderByOutcomeHash<T extends { customer_id: string }>(campaignId: string, rows: T[]): T[] {
  return [...rows].sort((a, b) =>
    stableHash(campaignId, a.customer_id, "outcome").localeCompare(stableHash(campaignId, b.customer_id, "outcome")),
  );
}

export function runOutcomeSimulation(db: Db, ctx: MerchantContext, campaignId: string): SimulationResult {
  const campaign = loadCampaign(db, ctx, campaignId);

  if (!["QUEUED", "SENDING", "PARTIALLY_DELIVERED", "NEEDS_REVIEW", "OUTCOME_WINDOW", "REPORTED"].includes(campaign.status)) {
    throw new AppError(
      "RULE_VIOLATION",
      `Outcomes can only be simulated after approval and delivery. Campaign is ${campaign.status}.`,
    );
  }

  const version = loadVersion(db, campaign.id, campaign.current_version);
  const recipients = listRecipients(db, version.id);
  if (recipients.length === 0) {
    throw new AppError("RULE_VIOLATION", "This version has no recipients to measure.");
  }

  const windowStart = campaign.window_start ?? addDays(campaign.as_of, 1);
  const windowEnd = campaign.window_end ?? addDays(windowStart, SIMULATION.windowDays);
  const proposal = JSON.parse(version.proposal_json) as Proposal;

  const existing = (
    db.prepare(`SELECT COUNT(*) AS n FROM outcome WHERE campaign_id = ? AND window_start = ?`).get(
      campaign.id,
      windowStart,
    ) as { n: number }
  ).n;

  if (existing > 0) {
    const counts = db
      .prepare(
        `SELECT assignment_group, SUM(returned) AS returns FROM outcome WHERE campaign_id = ? AND window_start = ? GROUP BY assignment_group`,
      )
      .all(campaign.id, windowStart) as { assignment_group: string; returns: number }[];
    return {
      windowStart,
      windowEnd,
      campaignReturns: counts.find((row) => row.assignment_group === "campaign")?.returns ?? 0,
      holdoutReturns: counts.find((row) => row.assignment_group === "holdout")?.returns ?? 0,
      created: 0,
      alreadySimulated: true,
    };
  }

  const deliveredCustomerIds = new Set(
    (
      db
        .prepare(`SELECT customer_id FROM delivery_job WHERE version_id = ? AND status = 'DELIVERED'`)
        .all(version.id) as { customer_id: string }[]
    ).map((row) => row.customer_id),
  );

  const campaignGroup = recipients.filter((recipient) => recipient.assignment_group === "campaign");
  const holdoutGroup = recipients.filter((recipient) => recipient.assignment_group === "holdout");

  // Only a customer who actually received the message can respond to it.
  const reachable = orderByOutcomeHash(
    campaign.id,
    campaignGroup.filter((recipient) => deliveredCustomerIds.has(recipient.customer_id)),
  );
  const campaignReturnTarget = Math.min(
    reachable.length,
    Math.round(SIMULATION.campaignReturnRate * campaignGroup.length),
  );
  const holdoutOrdered = orderByOutcomeHash(campaign.id, holdoutGroup);
  const holdoutReturnTarget = Math.round(SIMULATION.holdoutReturnRate * holdoutGroup.length);

  const campaignReturners = new Set(reachable.slice(0, campaignReturnTarget).map((r) => r.customer_id));
  const holdoutReturners = new Set(holdoutOrdered.slice(0, holdoutReturnTarget).map((r) => r.customer_id));
  const optOuts = new Set(
    reachable
      .filter((recipient) => !campaignReturners.has(recipient.customer_id))
      .slice(0, SIMULATION.optOutsPerCampaignGroup)
      .map((recipient) => recipient.customer_id),
  );

  return inWriteTransaction(db, () => {
    const insertOutcome = db.prepare(
      `INSERT INTO outcome
         (id, merchant_id, campaign_id, version_id, customer_id, assignment_group, returned, return_at, settled_amount_minor, reward_cost_minor, opted_out, window_start, window_end, simulated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT (campaign_id, customer_id, window_start) DO NOTHING`,
    );

    let created = 0;
    recipients.forEach((recipient, index) => {
      const isCampaign = recipient.assignment_group === "campaign";
      const returned = isCampaign
        ? campaignReturners.has(recipient.customer_id)
        : holdoutReturners.has(recipient.customer_id);
      const returnDay = (index % SIMULATION.windowDays) + 1;

      const result = insertOutcome.run(
        newId("out"),
        ctx.merchantId,
        campaign.id,
        version.id,
        recipient.customer_id,
        recipient.assignment_group,
        returned ? 1 : 0,
        returned ? `${addDays(windowStart, returnDay - 1)}T12:00:00.000Z` : null,
        returned ? SIMULATION.returnAmountMinor : 0,
        returned && isCampaign ? proposal.offer.amount_minor : 0,
        optOuts.has(recipient.customer_id) ? 1 : 0,
        windowStart,
        windowEnd,
      );
      created += result.changes;
    });

    db.prepare(`UPDATE campaign SET status = 'REPORTED', window_start = ?, window_end = ?, updated_at = ? WHERE id = ?`).run(
      windowStart,
      windowEnd,
      new Date().toISOString(),
      campaign.id,
    );

    recordAudit(db, {
      merchantId: ctx.merchantId,
      campaignId: campaign.id,
      versionId: version.id,
      actor: ctx.actor,
      action: "outcome_window.opened",
      entity: `campaign:${campaign.id}`,
      oldState: campaign.status,
      newState: "OUTCOME_WINDOW",
      details: { window_start: windowStart, window_end: windowEnd, window_days: SIMULATION.windowDays },
    });

    recordAudit(db, {
      merchantId: ctx.merchantId,
      campaignId: campaign.id,
      versionId: version.id,
      actor: "system",
      action: "report.generated",
      entity: `campaign:${campaign.id}`,
      oldState: "OUTCOME_WINDOW",
      newState: "REPORTED",
      details: {
        campaign_returns: campaignReturners.size,
        holdout_returns: holdoutReturners.size,
        simulated: true,
        note: "Synthetic fixed-seed simulation. Descriptive only; not evidence of production effect.",
      },
    });

    return {
      windowStart,
      windowEnd,
      campaignReturns: campaignReturners.size,
      holdoutReturns: holdoutReturners.size,
      created,
      alreadySimulated: false,
    };
  });
}
