"use client";

export function rupees(minor: number): string {
  return `₹${(minor / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(0)}%`;
}

const STATUS_TONE: Record<string, string> = {
  DELIVERED: "ok",
  REPORTED: "ok",
  APPROVED: "ok",
  QUEUED: "info",
  SENDING: "info",
  PROCESSING: "info",
  REVIEW: "warn",
  DRAFT: "neutral",
  OUTCOME_WINDOW: "info",
  PARTIALLY_DELIVERED: "warn",
  UNKNOWN: "warn",
  NEEDS_REVIEW: "warn",
  CANCELLED: "neutral",
  FAILED: "bad",
  EXPIRED: "bad",
};

export function StatusPill({ status }: { status: string }) {
  return <span className={`pill ${STATUS_TONE[status] ?? "neutral"}`}>{status.replaceAll("_", " ")}</span>;
}

export function Stat({ value, label, tone }: { value: string | number; label: string; tone?: string }) {
  return (
    <div className="card">
      <div className="stat" style={tone ? { color: `var(--${tone})` } : undefined}>
        {value}
      </div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export function KeyValue({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="kv">
      <span className="key">
        {label}
        {hint ? <span className="tiny muted"> · {hint}</span> : null}
      </span>
      <span className="value">{value}</span>
    </div>
  );
}

export function Steps({ current }: { current: "import" | "signal" | "review" | "delivery" | "outcome" }) {
  const steps: { id: typeof current; label: string }[] = [
    { id: "import", label: "1 · Import" },
    { id: "signal", label: "2 · Signal" },
    { id: "review", label: "3 · Review & approve" },
    { id: "delivery", label: "4 · Mock delivery" },
    { id: "outcome", label: "5 · Holdout report" },
  ];
  const activeIndex = steps.findIndex((step) => step.id === current);

  return (
    <div className="steps">
      {steps.map((step, index) => (
        <span
          key={step.id}
          className={`step ${index < activeIndex ? "done" : index === activeIndex ? "current" : ""}`}
        >
          {step.label}
        </span>
      ))}
    </div>
  );
}

export function DemoBanner({ planner }: { planner?: string }) {
  return (
    <div className="demo-flag">
      <strong>Demo build.</strong> Synthetic data, a development-only merchant session, and a mock delivery provider.
      No Paytm integration and no real customer is ever contacted.
      {planner ? (
        <>
          {" "}
          Planner: <code>{planner === "openai" ? "OpenAI" : "deterministic template fallback"}</code>.
        </>
      ) : null}
    </div>
  );
}

export function ErrorBanner({ error }: { error: { message: string; details?: unknown } | null }) {
  if (!error) return null;
  const ruleErrors =
    error.details && typeof error.details === "object" && "errors" in (error.details as Record<string, unknown>)
      ? ((error.details as { errors: { code: string; message: string }[] }).errors ?? [])
      : [];

  return (
    <div className="banner bad" role="alert">
      {error.message}
      {ruleErrors.length > 0 ? (
        <ul>
          {ruleErrors.map((item) => (
            <li key={item.code}>{item.message}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function AuditTimeline({
  events,
}: {
  events: { id: string; action: string; actor: string; details: unknown; created_at: string }[];
}) {
  if (events.length === 0) return <p className="muted tiny">No audit events yet.</p>;

  return (
    <ul className="timeline">
      {events.map((event) => (
        <li key={event.id}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            <strong>{event.action}</strong>
            <span className="pill neutral tiny">{event.actor}</span>
            <span className="tiny muted">{new Date(event.created_at).toLocaleTimeString()}</span>
          </div>
          <div className="tiny muted" style={{ wordBreak: "break-word" }}>
            {JSON.stringify(event.details)}
          </div>
        </li>
      ))}
    </ul>
  );
}

export async function apiCall<T>(
  url: string,
  init?: RequestInit & { idempotencyKey?: string },
): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init?.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;

  const response = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers as object) } });
  const payload = await response.json();

  if (!response.ok) {
    const error = payload?.error ?? { message: "Request failed." };
    throw Object.assign(new Error(error.message), { details: error.details, code: error.code });
  }
  return payload as T;
}
