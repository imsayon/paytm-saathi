import { createServerClient } from "@supabase/ssr";
import { config } from "../config";
import { log } from "../observability/log";

export type SessionUser = { id: string; email: string | null; phone: string | null };

export function supabaseConfigured(): boolean {
  return Boolean(config.supabaseUrl && config.supabaseAnonKey);
}

/**
 * The signed-in Supabase user for the current request, or null when nobody is
 * signed in, Supabase is not configured, or there is no request scope (scripts,
 * tests). `getUser()` validates the token with Supabase rather than trusting
 * the cookie, and the SSR helper writes refreshed tokens back as cookies.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  if (!supabaseConfigured()) return null;
  let cookieStore: Awaited<ReturnType<typeof import("next/headers").cookies>>;
  try {
    const { cookies } = await import("next/headers");
    cookieStore = await cookies();
  } catch {
    return null;
  }
  const supabase = createServerClient(config.supabaseUrl!, config.supabaseAnonKey!, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        } catch {
          // Server components cannot write cookies; route handlers can. Either way the session still resolves.
        }
      },
    },
  });
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return null;
    return { id: data.user.id, email: data.user.email ?? null, phone: data.user.phone ?? null };
  } catch (error) {
    log("warn", "auth.session_lookup_failed", { reason: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}
