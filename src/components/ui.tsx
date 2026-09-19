"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { CountUp, Reveal, TiltCard } from "@/components/motion";

export function rupees(minor: number): string {
  return `₹${(minor / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(0)}%`;
}

/* Inline icons: no icon font, no network. */
const ICONS: Record<string, ReactNode> = {
  spark: (
    <path d="M12 2l2.2 6.3L20.5 10l-6.3 2.2L12 18.5l-2.2-6.3L3.5 10l6.3-1.7L12 2zM19 16l.9 2.1L22 19l-2.1.9L19 22l-.9-2.1L16 19l2.1-.9L19 16z" fill="currentColor" />
  ),
  check: <path d="M4 12.5l5 5L20 6.5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />,
  x: <path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />,
  alert: (
    <>
      <path d="M12 3l10 18H2L12 3z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M12 9v5M12 17.3v.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 11v6M12 7.4v.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </>
  ),
  shield: (
    <path d="M12 3l7 3v5.5c0 4.4-3 8.1-7 9.5-4-1.4-7-5.1-7-9.5V6l7-3z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M3.5 19c.6-3.3 3-5 5.5-5s4.9 1.7 5.5 5M15.5 5.3a3 3 0 010 5.4M17 14c2 .4 3.4 1.9 3.8 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </>
  ),
  send: <path d="M3 11.5l18-8-8 18-2.5-7.5L3 11.5z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />,
  chart: (
    <path d="M4 20V10M10 20V4M16 20v-8M22 20H2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 7v5l3.5 2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </>
  ),
  upload: (
    <path d="M12 16V4M7 9l5-5 5 5M4 20h16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  ),
  file: (
    <path d="M6 3h8l5 5v13H6V3zM14 3v5h5M9 13h7M9 17h7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
  ),
  pen: (
    <path d="M4 20l4.5-1 10-10-3.5-3.5-10 10L4 20zM13 7.5l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
  ),
  stamp: (
    <path d="M9 11V6a3 3 0 016 0v5h3l1 5H5l1-5h3zM6 20h12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
  ),
  queue: (
    <path d="M4 6h16M4 12h10M4 18h13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />,
  refresh: (
    <path d="M20 12a8 8 0 01-14.3 4.9M4 12a8 8 0 0114.3-4.9M18 3v4.5h-4.5M6 21v-4.5h4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  ),
  lock: (
    <path d="M6 11V8a6 6 0 0112 0v3M5 11h14v10H5V11z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
  ),
};

export function Icon({ name, size = 18, className }: { name: keyof typeof ICONS | string; size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className={className} focusable="false">
      {ICONS[name] ?? ICONS.info}
    </svg>
  );
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

const LIVE_STATUSES = new Set(["QUEUED", "SENDING", "PROCESSING", "UNKNOWN", "OUTCOME_WINDOW"]);

export function StatusPill({ status }: { status: string }) {
  const live = LIVE_STATUSES.has(status);
  return <span className={`pill ${STATUS_TONE[status] ?? "neutral"}${live ? " live" : ""}`}>{status.replaceAll("_", " ")}</span>;
}

export function Stat({
  value,
  label,
  tone,
  hint,
  icon,
}: {
  value: string | number;
  label: string;
  tone?: "ok" | "warn" | "bad" | "info";
  hint?: string;
  icon?: string;
}) {
  return (
    <TiltCard className={`card stat-card${tone ? ` tone-${tone}` : ""}`} data-reveal>
      <span className="glow-bar" aria-hidden="true" />
      <div className="stat">
        <CountUp value={value} />
      </div>
      <div className="stat-label">
        {icon ? <Icon name={icon} size={13} className="muted" /> : null} {label}
      </div>
      {hint ? <div className="stat-hint">{hint}</div> : null}
    </TiltCard>
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

type StepId = "import" | "signal" | "review" | "delivery" | "outcome";

/** The five-step rail. Completed steps link back when a campaign is known. */
export function Steps({ current, campaignId }: { current: StepId; campaignId?: string }) {
  const steps: { id: StepId; label: string; href: string | null }[] = [
    { id: "import", label: "Import", href: "/" },
    { id: "signal", label: "Signal", href: "/signals" },
    { id: "review", label: "Review & approve", href: campaignId ? `/campaigns/${campaignId}/review` : null },
    { id: "delivery", label: "Mock delivery", href: campaignId ? `/campaigns/${campaignId}/status` : null },
    { id: "outcome", label: "Holdout report", href: campaignId ? `/campaigns/${campaignId}/outcome` : null },
  ];
  const activeIndex = steps.findIndex((step) => step.id === current);

  return (
    <div className="steps" aria-label="Workflow steps">
      {steps.map((step, index) => {
        const state = index < activeIndex ? "done" : index === activeIndex ? "current" : "";
        const body = (
          <>
            <span className="n">{state === "done" ? <Icon name="check" size={11} /> : index + 1}</span>
            {step.label}
          </>
        );
        return step.href && state !== "current" ? (
          <a key={step.id} href={step.href} className={`step ${state}`}>
            {body}
          </a>
        ) : (
          <span key={step.id} className={`step ${state}`} aria-current={state === "current" ? "step" : undefined}>
            {body}
          </span>
        );
      })}
    </div>
  );
}

export function DemoBanner({ planner }: { planner?: string }) {
  return (
    <div className="demo-flag" data-reveal>
      <Icon name="shield" />
      <div>
        <strong>Sandbox boundary.</strong> Synthetic data, a human approval gate, and aggregate-only AI planning. Paytm credentials
        are not connected; delivery is mock unless a live provider is explicitly configured after approval.
        {planner ? (
          <>
            {" "}
            Planner: <code>{planner === "gemini" ? "Gemini (configured; draft source shown on review)" : "deterministic template fallback"}</code>.
          </>
        ) : null}
      </div>
    </div>
  );
}

export function ErrorBanner({ error }: { error: { message: string; details?: unknown } | null }) {
  if (!error) return null;
  const details = error.details && typeof error.details === "object" ? (error.details as Record<string, unknown>) : null;
  const ruleErrors = Array.isArray(details?.errors) ? (details!.errors as { code: string; message: string }[]) : [];
  const fieldErrors = Array.isArray(details?.fields) ? (details!.fields as { field: string; message: string }[]) : [];

  return (
    <div className="banner bad" role="alert">
      <Icon name="alert" />
      <div>
        {error.message}
        {ruleErrors.length > 0 ? (
          <ul>
            {ruleErrors.map((item) => (
              <li key={item.code + item.message}>{item.message}</li>
            ))}
          </ul>
        ) : null}
        {fieldErrors.length > 0 ? (
          <ul>
            {fieldErrors.map((item) => (
              <li key={item.field + item.message}>
                <code>{item.field || "body"}</code> {item.message}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

export function Banner({ tone, icon, children }: { tone: "ok" | "warn" | "info" | "bad"; icon?: string; children: ReactNode }) {
  return (
    <div className={`banner ${tone}`}>
      <Icon name={icon ?? (tone === "ok" ? "check" : tone === "bad" ? "alert" : "info")} />
      <div>{children}</div>
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
    <Reveal ready refreshKey={events.length}>
      <ul className="timeline">
        {events.map((event) => (
          <li key={event.id} data-reveal>
            <div className="row">
              <strong>{event.action}</strong>
              <span className="pill neutral tiny plain">{event.actor}</span>
              <span className="tiny muted">{new Date(event.created_at).toLocaleTimeString()}</span>
            </div>
            <div className="payload">{JSON.stringify(event.details)}</div>
          </li>
        ))}
      </ul>
    </Reveal>
  );
}

export function InitialLoad({ error, retry }: { error: { message: string } | null; retry: () => void }) {
  return (
    <div className="card">
      {error ? (
        <>
          <ErrorBanner error={error} />
          <button onClick={retry}>
            <Icon name="refresh" size={15} /> Retry loading
          </button>
        </>
      ) : (
        <div role="status" aria-label="Loading">
          <div className="skeleton" style={{ width: "42%" }} />
          <div className="skeleton" style={{ width: "76%" }} />
          <div className="skeleton" style={{ width: "58%" }} />
        </div>
      )}
    </div>
  );
}

/** Persisted light/dark switch. Dark is the default look; one click flips it for a bright projector. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("dark");

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem("saathi-theme");
    } catch {
      stored = null;
    }
    const initial = stored === "light" ? "light" : "dark";
    setTheme(initial);
    document.documentElement.dataset.theme = initial;
  }, []);

  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try {
      window.localStorage.setItem("saathi-theme", next);
    } catch {
      // A blocked storage just means the choice is not remembered.
    }
  }

  return (
    <button type="button" className="icon-btn" onClick={toggle} aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} title="Toggle theme">
      <Icon name={theme === "dark" ? "sun" : "moon"} />
    </button>
  );
}

type Me = { signed_in: boolean; auth_configured: boolean; merchant: { name: string; demo_session: boolean } | null; user: { email: string | null } | null };

export function Nav() {
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled) setMe(data);
      })
      .catch(() => {
        // The header simply shows no session state.
      });
    return () => {
      cancelled = true;
    };
  }, [pathname]);
  const links = [
    { href: "/", label: "Import", active: pathname === "/" },
    { href: "/signals", label: "Signal", active: pathname.startsWith("/signals") },
  ];
  const campaign = pathname.startsWith("/campaigns/");
  return (
    <nav>
      {links.map((link) => (
        <a key={link.href} href={link.href} className={link.active ? "active" : undefined}>
          {link.label}
        </a>
      ))}
      {campaign ? <span className="pill info plain">Campaign</span> : null}
      {me?.signed_in ? (
        <form action="/auth/signout" method="post" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span className="pill ok plain" title={me.merchant?.name ?? ""}>{me.user?.email ?? "signed in"}</span>
          <button type="submit" className="ghost small">Sign out</button>
        </form>
      ) : me?.auth_configured ? (
        <a href="/login" className={pathname === "/login" ? "active" : undefined}>
          Sign in
        </a>
      ) : null}
      <ThemeToggle />
    </nav>
  );
}

export async function apiCall<T>(
  url: string,
  init?: RequestInit & { idempotencyKey?: string },
): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init?.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;

  const response = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers as object) } });
  const raw = await response.text();
  let payload: { error?: { message?: string; details?: unknown; code?: string } } | null = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = payload?.error ?? { message: `Request failed (HTTP ${response.status}).` };
    throw Object.assign(new Error(error.message ?? "Request failed."), { details: error.details, code: error.code });
  }
  return payload as T;
}
