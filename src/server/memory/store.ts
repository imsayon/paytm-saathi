import { config } from "../config";
import { newId, type Db } from "../db/client";
import { log } from "../observability/log";

/**
 * What the planner may remember about a merchant: decision-level facts in
 * plain sentences ("approved ₹15 for 20 absent regulars under a ₹300 cap"),
 * written in the same transaction as the decision. Neon is the source of
 * truth; when Cognee is configured, each fact is mirrored there and recall
 * merges Cognee's graph answers with the newest Neon facts.
 */
export type MemoryKind = "draft_blocked" | "revised" | "approved" | "reported" | "dataset";

export async function rememberFact(
  db: Db,
  input: { merchantId: string; campaignId?: string | null; kind: MemoryKind; fact: string; details?: Record<string, unknown>; source?: string },
): Promise<void> {
  await db.run(
    `INSERT INTO merchant_memory (id, merchant_id, campaign_id, kind, fact, details, source, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [newId("mem"), input.merchantId, input.campaignId ?? null, input.kind, input.fact, JSON.stringify(input.details ?? {}), input.source ?? "rules", new Date().toISOString()],
  );
  void mirrorToCognee(input.merchantId, input.fact);
}

export async function recallFacts(db: Db, merchantId: string, limit = 6): Promise<string[]> {
  const rows = await db.all<{ fact: string }>(`SELECT fact FROM merchant_memory WHERE merchant_id = $1 ORDER BY seq DESC LIMIT $2`, [merchantId, limit]);
  const facts = rows.map((row) => row.fact).reverse();
  const graph = await recallFromCognee(merchantId, "What has this merchant approved, rejected or learned about retention offers?");
  return [...new Set([...graph, ...facts])].slice(-limit - 2);
}

function cogneeConfigured(): boolean {
  return Boolean(config.cogneeBaseUrl && config.cogneeApiKey);
}

function datasetFor(merchantId: string): string {
  return `paytm_saathi_${merchantId.replace(/[^a-z0-9_]/gi, "_")}`;
}

/** Best effort: a failure here never affects the decision that was just recorded. */
async function mirrorToCognee(merchantId: string, fact: string): Promise<void> {
  if (!cogneeConfigured()) return;
  try {
    // Cognee 1.0's memory-native API accepts JSON. Keep a small compatibility
    // fallback for self-hosted deployments that still expose the older
    // multipart `remember` contract.
    const response = await fetch(`${config.cogneeBaseUrl}/api/v1/remember`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": config.cogneeApiKey! },
      body: JSON.stringify({ data: fact, dataset_name: datasetFor(merchantId) }),
      signal: AbortSignal.timeout(8_000),
    });
    if (response.ok) return;

    const form = new FormData();
    form.set("datasetName", datasetFor(merchantId));
    form.set("raw_data", fact);
    const legacy = await fetch(`${config.cogneeBaseUrl}/api/v1/remember`, {
      method: "POST",
      headers: { "x-api-key": config.cogneeApiKey! },
      body: form,
      signal: AbortSignal.timeout(8_000),
    });
    if (!legacy.ok) throw new Error(`HTTP ${legacy.status}`);
  } catch (error) {
    log("warn", "memory.cognee_mirror_failed", { reason: error instanceof Error ? error.message.slice(0, 80) : "unknown" });
  }
}

async function recallFromCognee(merchantId: string, query: string): Promise<string[]> {
  if (!cogneeConfigured()) return [];
  try {
    const response = await fetch(`${config.cogneeBaseUrl}/api/v1/search`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": config.cogneeApiKey! },
      body: JSON.stringify({ query, search_type: "GRAPH_COMPLETION", datasets: [datasetFor(merchantId)] }),
      signal: AbortSignal.timeout(8_000),
    });
    let data: unknown;
    if (response.ok) {
      data = await response.json();
    } else {
      const legacy = await fetch(`${config.cogneeBaseUrl}/api/v1/recall`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": config.cogneeApiKey! },
        body: JSON.stringify({ query, top_k: 5, scope: ["graph"], datasets: [datasetFor(merchantId)] }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!legacy.ok) throw new Error(`HTTP ${legacy.status}`);
      data = await legacy.json();
    }
    const texts: string[] = [];
    const walk = (node: unknown) => {
      if (typeof node === "string" && node.length > 8 && node.length < 400) texts.push(node);
      else if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === "object") Object.values(node as Record<string, unknown>).forEach(walk);
    };
    walk(data);
    return texts.slice(0, 5);
  } catch (error) {
    log("warn", "memory.cognee_recall_failed", { reason: error instanceof Error ? error.message.slice(0, 80) : "unknown" });
    return [];
  }
}
