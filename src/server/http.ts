import { NextResponse } from "next/server";
import { config } from "./config";
import { AppError, errorBody } from "./errors";
import { log, newRequestId } from "./observability/log";

export type Handler = (context: { requestId: string; request: Request }) => Promise<NextResponse> | NextResponse;

export async function handle(request: Request, handler: Handler): Promise<NextResponse> {
  const requestId = newRequestId();
  const startedAt = Date.now();

  try {
    const response = await handler({ requestId, request });
    response.headers.set("x-request-id", requestId);
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
        : new AppError("UNAVAILABLE", error instanceof Error ? error.message : "Unexpected server error.");

    log(appError.status >= 500 ? "error" : "warn", "http.error", {
      request_id: requestId,
      method: request.method,
      path: new URL(request.url).pathname,
      code: appError.code,
      status: appError.status,
      duration_ms: Date.now() - startedAt,
    });

    return NextResponse.json(errorBody(appError, requestId), {
      status: appError.status,
      headers: { "x-request-id": requestId },
    });
  }
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new AppError("BAD_REQUEST", "Request body must be valid JSON.");
  }
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
