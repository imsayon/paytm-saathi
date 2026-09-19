import { NextResponse } from "next/server";
import type { z } from "zod";
import { config } from "./config";
import { AppError, errorBody } from "./errors";
import { log, newRequestId } from "./observability/log";
import { dispatchSoon } from "./integrations/events";
import { getDb } from "./db/client";

export type Handler = (context: { requestId: string; request: Request }) => Promise<NextResponse> | NextResponse;

export async function handle(request: Request, handler: Handler): Promise<NextResponse> {
  const requestId = newRequestId();
  const startedAt = Date.now();

  try {
    const response = await handler({ requestId, request });
    response.headers.set("x-request-id", requestId);
    if (request.method !== "GET" && config.hasDatabaseUrl) dispatchSoon(getDb());
    log("info", "http.ok", {
      request_id: requestId,
      method: request.method,
      path: new URL(request.url).pathname,
      status: response.status,
      duration_ms: Date.now() - startedAt,
    });
    return response;
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError("UNAVAILABLE", "The service is temporarily unavailable. Please retry.");

    log(appError.status >= 500 ? "error" : "warn", "http.error", {
      request_id: requestId,
      method: request.method,
      path: new URL(request.url).pathname,
      code: appError.code,
      status: appError.status,
      duration_ms: Date.now() - startedAt,
      // The client only ever sees the generic message; the real cause stays in
      // the server log, keyed by request id.
      ...(error instanceof AppError ? {} : { cause: describeUnexpectedError(error) }),
    });

    return NextResponse.json(errorBody(appError, requestId), {
      status: appError.status,
      headers: { "x-request-id": requestId },
    });
  }
}

/** Name and message only, with anything that looks like a connection string removed. */
function describeUnexpectedError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.replace(/[a-z]+:\/\/[^\s]*@[^\s]*/gi, "<connection string>").slice(0, 300);
}

export async function readJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new AppError("BAD_REQUEST", "Content-Type must be application/json.");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new AppError("BAD_REQUEST", "A JSON request body is required.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > config.maxImportBytes * 6 + 1024) {
        await reader.cancel();
        throw new AppError("BAD_REQUEST", "Request body exceeds the upload limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError("BAD_REQUEST", "Request body must be valid JSON.");
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AppError("BAD_REQUEST", "Request fields are invalid.", {
      fields: result.error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
    });
  }
  return result.data;
}

export function requireDemoMode(): void {
  if (!config.demoMode) {
    throw new AppError("DEMO_DISABLED", "Demo controls are disabled because SAATHI_DEMO_MODE is not true.");
  }
}

const buckets = new Map<string, { count: number; resetAt: number }>();

/** Small in-process limiter. One host, one process: enough for import/preview abuse. */
export function rateLimit(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  if (bucket.count >= limit) {
    throw new AppError("RATE_LIMITED", "Too many requests. Wait a moment and try again.");
  }
  bucket.count += 1;
}
