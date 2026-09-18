export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "STALE_VERSION"
  | "DUPLICATE_APPROVAL"
  | "IDEMPOTENCY_CONFLICT"
  | "RULE_VIOLATION"
  | "DEMO_DISABLED"
  | "RATE_LIMITED"
  | "UNAVAILABLE";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  STALE_VERSION: 409,
  DUPLICATE_APPROVAL: 409,
  IDEMPOTENCY_CONFLICT: 409,
  RULE_VIOLATION: 422,
  DEMO_DISABLED: 403,
  RATE_LIMITED: 429,
  UNAVAILABLE: 503,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details: unknown = null) {
    super(message);
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return STATUS_BY_CODE[this.code];
  }
}

export function errorBody(error: AppError, requestId: string) {
  return {
    error: {
      code: error.code,
      message: error.message,
      details: error.details,
      request_id: requestId,
    },
  };
}
