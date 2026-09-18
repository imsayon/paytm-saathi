import crypto from "node:crypto";
import type { Db } from "../db/client";
import { addDays, isWeekday } from "./time";

export const RETENTION_POLICY = {
  version: "retention-v1",
  lookbackDays: 60,
  inactivityDays: 21,
  minSettledVisits: 3,
  minDistinctDates: 2,
  cohortCap: 20,
} as const;

export type CustomerSignal = {
  customerId: string;
  externalId: string;
  displayName: string;
  hasContactRef: boolean;
  consent: "true" | "false" | "unknown";
  settledVisits: number;
  distinctDates: number;
  weekdayVisits: number;
  lastSettledDate: string | null;
  daysSinceLastVisit: number | null;
  isRegular: boolean;
  isAbsent: boolean;
  isWeekdayRegular: boolean;
  eligible: boolean;
  exclusionReason: string | null;
};

export type SignalSummary = {
  asOf: string;
  policy: typeof RETENTION_POLICY;
  totalCustomers: number;
  regularCustomers: number;
  absentRegulars: number;
  eligibleCount: number;
  cohortHash: string;
  excluded: {
    consent_false: number;
    consent_unknown: number;
    no_contact_ref: number;
    over_cohort_cap: number;
  };
  eligible: CustomerSignal[];
  absent: CustomerSignal[];
};

type PaymentRow = {
  customer_id: string;
  local_date: string;
  status: string;
};

type CustomerRow = {
  id: string;
  external_id: string;
  display_name: string;
  contact_ref: string | null;
};

/** Deterministic ordering key so campaign/holdout assignment never depends on row order. */
export function stableHash(...parts: string[]): string {
  return crypto.createHash("sha256").update(parts.join("|")).digest("hex");
}

async function latestConsentByCustomer(
  db: Db,
  merchantId: string,
): Promise<Map<string, "true" | "false" | "unknown">> {
  const rows = await db.all<{ customer_id: string; state: "true" | "false" | "unknown" }>(
    `SELECT customer_id, state
       FROM consent
      WHERE merchant_id = $1
      ORDER BY observed_at ASC, seq ASC`,
    [merchantId],
  );

  const latest = new Map<string, "true" | "false" | "unknown">();
  for (const row of rows) latest.set(row.customer_id, row.state);
  return latest;
}

export async function computeSignal(db: Db, merchantId: string, asOf: string): Promise<SignalSummary> {
  const windowStart = addDays(asOf, -RETENTION_POLICY.lookbackDays);
  const inactivityStart = addDays(asOf, -RETENTION_POLICY.inactivityDays);

  const [customers, payments, consentByCustomer] = await Promise.all([
    db.all<CustomerRow>(
      `SELECT id, external_id, display_name, contact_ref FROM customer WHERE merchant_id = $1 ORDER BY external_id`,
      [merchantId],
    ),
    db.all<PaymentRow>(
      `SELECT customer_id, local_date, status
         FROM payment
        WHERE merchant_id = $1 AND status = 'settled' AND local_date >= $2 AND local_date <= $3`,
      [merchantId, windowStart, asOf],
    ),
    latestConsentByCustomer(db, merchantId),
  ]);
  const byCustomer = new Map<string, PaymentRow[]>();
  for (const payment of payments) {
    const list = byCustomer.get(payment.customer_id);
    if (list) list.push(payment);
    else byCustomer.set(payment.customer_id, [payment]);
  }

  const signals: CustomerSignal[] = customers.map((customer) => {
    const visits = byCustomer.get(customer.id) ?? [];
    const dates = visits.map((visit) => visit.local_date).sort();
    const distinctDates = new Set(dates).size;
    const weekdayVisits = dates.filter((date) => isWeekday(date)).length;
    const lastSettledDate = dates.length > 0 ? dates[dates.length - 1]! : null;

    const isRegular =
      visits.length >= RETENTION_POLICY.minSettledVisits && distinctDates >= RETENTION_POLICY.minDistinctDates;
    const isAbsent = lastSettledDate === null || lastSettledDate <= inactivityStart;
    const consent = consentByCustomer.get(customer.id) ?? "unknown";
    const hasContactRef = Boolean(customer.contact_ref);

    let exclusionReason: string | null = null;
    if (isRegular && isAbsent) {
      if (consent === "false") exclusionReason = "consent_false";
      else if (consent === "unknown") exclusionReason = "consent_unknown";
      else if (!hasContactRef) exclusionReason = "no_contact_ref";
    }

    return {
      customerId: customer.id,
      externalId: customer.external_id,
      displayName: customer.display_name,
      hasContactRef,
      consent,
      settledVisits: visits.length,
      distinctDates,
      weekdayVisits,
      lastSettledDate,
      daysSinceLastVisit:
        lastSettledDate === null
          ? null
          : Math.round(
              (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${lastSettledDate}T00:00:00Z`)) / 86_400_000,
            ),
      isRegular,
      isAbsent,
      isWeekdayRegular: visits.length > 0 && weekdayVisits * 2 > visits.length,
      eligible: isRegular && isAbsent && consent === "true" && hasContactRef,
      exclusionReason,
    };
  });

  const absent = signals
    .filter((signal) => signal.isRegular && signal.isAbsent)
    .sort((a, b) => stableHash(merchantId, a.customerId).localeCompare(stableHash(merchantId, b.customerId)));

  const eligibleAll = absent.filter((signal) => signal.eligible);
  const eligible = eligibleAll.slice(0, RETENTION_POLICY.cohortCap);
  const overCap = eligibleAll.length - eligible.length;

  return {
    asOf,
    policy: RETENTION_POLICY,
    totalCustomers: customers.length,
    regularCustomers: signals.filter((signal) => signal.isRegular).length,
    absentRegulars: absent.length,
    eligibleCount: eligible.length,
    cohortHash: stableHash(merchantId, asOf, ...eligible.map((signal) => signal.customerId)),
    excluded: {
      consent_false: absent.filter((signal) => signal.exclusionReason === "consent_false").length,
      consent_unknown: absent.filter((signal) => signal.exclusionReason === "consent_unknown").length,
      no_contact_ref: absent.filter((signal) => signal.exclusionReason === "no_contact_ref").length,
      over_cohort_cap: overCap,
    },
    eligible,
    absent,
  };
}
