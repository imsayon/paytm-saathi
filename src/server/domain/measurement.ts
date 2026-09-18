import type { Db } from "../db/client";
import { SIMULATION } from "./simulator";

export type GroupMetrics = {
  size: number;
  returns: number;
  return_rate: number;
  return_volume_minor: number;
};

export type MeasurementReport = {
  has_outcomes: boolean;
  window_start: string | null;
  window_end: string | null;
  campaign: GroupMetrics;
  holdout: GroupMetrics;
  observed_lift_pp: number;
  expected_incremental_returns: number;
  expected_campaign_baseline_volume_minor: number;
  incremental_payment_volume_minor: number;
  reward_cost_minor: number;
  contribution_proxy_minor: number;
  opt_outs: number;
  delivery_errors: number;
  average_return_amount_minor: number;
  formulas: Record<string, string>;
  caveats: string[];
};

type OutcomeRow = {
  assignment_group: "campaign" | "holdout";
  returned: number;
  settled_amount_minor: number;
  reward_cost_minor: number;
  opted_out: number;
  window_start: string;
  window_end: string;
};

function rate(returns: number, size: number): number {
  return size === 0 ? 0 : returns / size;
}

function groupMetrics(rows: OutcomeRow[], group: "campaign" | "holdout"): GroupMetrics {
  const inGroup = rows.filter((row) => row.assignment_group === group);
  const returns = inGroup.filter((row) => row.returned === 1).length;
  return {
    size: inGroup.length,
    returns,
    return_rate: rate(returns, inGroup.length),
    return_volume_minor: inGroup.reduce((sum, row) => sum + row.settled_amount_minor, 0),
  };
}

/**
 * Every figure here is computed from stored assignments and outcome rows. No
 * model output reaches this function.
 */
export function buildReport(db: Db, campaignId: string, versionId: string): MeasurementReport {
  const rows = db
    .prepare(
      `SELECT assignment_group, returned, settled_amount_minor, reward_cost_minor, opted_out, window_start, window_end
         FROM outcome WHERE campaign_id = ?`,
    )
    .all(campaignId) as OutcomeRow[];

  const deliveryErrors = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM delivery_job WHERE version_id = ? AND status IN ('FAILED', 'NEEDS_REVIEW')`,
      )
      .get(versionId) as { n: number }
  ).n;

  const campaign = groupMetrics(rows, "campaign");
  const holdout = groupMetrics(rows, "holdout");

  const returners = rows.filter((row) => row.returned === 1);
  const averageReturnAmount =
    returners.length === 0
      ? SIMULATION.returnAmountMinor
      : Math.round(returners.reduce((sum, row) => sum + row.settled_amount_minor, 0) / returners.length);

  const observedLift = campaign.return_rate - holdout.return_rate;
  const expectedBaselineVolume = Math.round(holdout.return_rate * campaign.size * averageReturnAmount);
  const incrementalVolume = campaign.return_volume_minor - expectedBaselineVolume;
  const rewardCost = rows.reduce((sum, row) => sum + row.reward_cost_minor, 0);

  return {
    has_outcomes: rows.length > 0,
    window_start: rows[0]?.window_start ?? null,
    window_end: rows[0]?.window_end ?? null,
    campaign,
    holdout,
    observed_lift_pp: Number((observedLift * 100).toFixed(1)),
    expected_incremental_returns: Number((campaign.size * observedLift).toFixed(1)),
    expected_campaign_baseline_volume_minor: expectedBaselineVolume,
    incremental_payment_volume_minor: incrementalVolume,
    reward_cost_minor: rewardCost,
    contribution_proxy_minor: incrementalVolume - rewardCost,
    opt_outs: rows.filter((row) => row.opted_out === 1).length,
    delivery_errors: deliveryErrors,
    average_return_amount_minor: averageReturnAmount,
    formulas: {
      return_rate: "returning customers / assigned group size",
      observed_lift_pp: "campaign return rate - holdout return rate, in percentage points",
      expected_incremental_returns: "campaign group size x observed lift",
      expected_campaign_baseline_volume: "holdout return rate x campaign group size x average return amount",
      incremental_payment_volume: "campaign return volume - expected campaign baseline volume",
      contribution_proxy: "incremental payment volume - reward cost",
    },
    caveats: [
      "Synthetic, fixed-seed simulation on demo data. Descriptive comparison only, not proven causal impact.",
      "Contribution proxy is payment volume after reward. Merchant margin, messaging cost and support cost are unavailable, so this is not profit.",
      "Group sizes are small, so the difference is illustrative rather than statistically powered.",
    ],
  };
}
