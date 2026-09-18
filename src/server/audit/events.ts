import type { Db } from "../db/client";
import { newId } from "../db/client";

export type AuditInput = {
  merchantId: string;
  campaignId?: string | null;
  versionId?: string | null;
  jobId?: string | null;
  actor: string;
  action: string;
  entity: string;
  oldState?: string | null;
  newState?: string | null;
  requestId?: string | null;
  details?: Record<string, unknown>;
};

export function recordAudit(db: Db, input: AuditInput): string {
  const id = newId("aud");
  db.prepare(
    `INSERT INTO audit_event
       (id, merchant_id, campaign_id, version_id, job_id, actor, action, entity, old_state, new_state, request_id, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.merchantId,
    input.campaignId ?? null,
    input.versionId ?? null,
    input.jobId ?? null,
    input.actor,
    input.action,
    input.entity,
    input.oldState ?? null,
    input.newState ?? null,
    input.requestId ?? null,
    JSON.stringify(input.details ?? {}),
    new Date().toISOString(),
  );
  return id;
}

export type AuditRow = {
  id: string;
  action: string;
  entity: string;
  actor: string;
  old_state: string | null;
  new_state: string | null;
  details_json: string;
  created_at: string;
};

export function listAudit(db: Db, merchantId: string, campaignId: string): AuditRow[] {
  return db
    .prepare(
      `SELECT id, action, entity, actor, old_state, new_state, details_json, created_at
         FROM audit_event
        WHERE merchant_id = ? AND campaign_id = ?
        ORDER BY created_at ASC, rowid ASC`,
    )
    .all(merchantId, campaignId) as AuditRow[];
}
