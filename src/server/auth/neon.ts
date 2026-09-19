import { createNeonAuth } from "@neondatabase/auth/next/server";
import { config } from "../config";
import { log } from "../observability/log";

export type SessionUser = { id: string; email: string | null; name: string | null };

type NeonAuthInstance = ReturnType<typeof createNeonAuth>;

let cachedAuth: NeonAuthInstance | null = null;

/** Neon Auth is provisioned per Neon branch and proxied through this app. */
export function neonAuthConfigured(): boolean {
  return Boolean(config.neonAuthBaseUrl && config.neonAuthCookieSecret);
}

/**
 * Lazily constructs the server adapter so builds, scripts and the synthetic
 * demo remain usable when an operator has not configured Auth yet.
 */
export function getNeonAuth(): NeonAuthInstance | null {
  if (!neonAuthConfigured()) return null;
  if (!cachedAuth) {
    cachedAuth = createNeonAuth({
      baseUrl: config.neonAuthBaseUrl!,
      cookies: {
        secret: config.neonAuthCookieSecret!,
        sessionDataTtl: 300,
        sameSite: "lax",
      },
      logLevel: "silent",
    });
  }
  return cachedAuth;
}

/** Returns the verified Neon Auth session for the current request. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const auth = getNeonAuth();
  if (!auth) return null;
  try {
    const { data } = await auth.getSession();
    const user = data?.user;
    if (!user) return null;
    const profile = user as typeof user & { name?: string | null; user_metadata?: { name?: string | null } };
    return { id: user.id, email: user.email ?? null, name: profile.name ?? profile.user_metadata?.name ?? null };
  } catch (error) {
    log("warn", "auth.session_lookup_failed", { reason: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}
