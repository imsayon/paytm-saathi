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

export async function recordAudit(db: Db, input: AuditInput): Promise<string> {
  const id = newId("aud");
  await db.run(
    `INSERT INTO audit_event
       (id, merchant_id, campaign_id, version_id, job_id, actor, action, entity, old_state, new_state, request_id, details, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)`,
    [
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
    ],
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
  details: Record<string, unknown>;
  created_at: string;
};

export function listAudit(db: Db, merchantId: string, campaignId: string): Promise<AuditRow[]> {
  return db.all<AuditRow>(
    `SELECT id, action, entity, actor, old_state, new_state, details, created_at
       FROM audit_event
      WHERE merchant_id = $1 AND campaign_id = $2
      ORDER BY created_at ASC, seq ASC`,
    [merchantId, campaignId],
  );
}
