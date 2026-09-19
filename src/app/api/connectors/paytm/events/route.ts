import { NextResponse } from "next/server";
import { canonicalBatchSchema, ingestCanonicalBatch, verifyConnectorSignature } from "@/server/connectors/canonical";
import { getDb } from "@/server/db/client";
import { AppError } from "@/server/errors";
import { handle } from "@/server/http";

export const dynamic = "force-dynamic";

/**
 * Paytm-shaped canonical ingestion boundary. Paytm can later replace this
 * adapter with its event bus/webhooks without changing signal or campaign
 * code. It accepts normalized payment and purpose-scoped consent events only.
 */
export async function POST(request: Request) {
  return handle(request, async ({ requestId }) => {
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > 6 * 2 * 1024 * 1024) {
      throw new AppError("BAD_REQUEST", "Connector request body exceeds the upload limit.");
    }

    verifyConnectorSignature(request, rawBody);

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      throw new AppError("BAD_REQUEST", "Connector request body must be valid JSON.");
    }
    const parsed = canonicalBatchSchema.safeParse(parsedBody);
    if (!parsed.success) {
      throw new AppError("BAD_REQUEST", "Connector event fields are invalid.", {
        fields: parsed.error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
      });
    }

    const result = await ingestCanonicalBatch(getDb(), parsed.data, requestId);
    return NextResponse.json(
      {
        ingestion: {
          batch_id: result.batchId,
          checksum: result.checksum,
          payment_events: result.paymentEvents,
          consent_events: result.consentEvents,
          duplicate_events: result.duplicateEvents,
          already_imported: result.alreadyImported,
        },
      },
      { status: result.alreadyImported ? 200 : 202 },
    );
  });
}
