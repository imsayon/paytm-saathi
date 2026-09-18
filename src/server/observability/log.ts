const REDACTED_KEYS = new Set(["contact_ref", "contactRef", "apiKey", "openAiApiKey", "authorization"]);

function redact(details: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    safe[key] = REDACTED_KEYS.has(key) ? "[redacted]" : value;
  }
  return safe;
}

export function log(
  level: "info" | "warn" | "error",
  event: string,
  details: Record<string, unknown> = {},
): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...redact(details),
  });
  if (level === "error") console.error(line);
  else console.log(line);
}

export function newRequestId(): string {
  return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
