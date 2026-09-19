import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { config } from "@/server/config";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const url = new URL(request.url);
  if (config.supabaseUrl && config.supabaseAnonKey) {
    const cookieStore = await cookies();
    const supabase = createServerClient(config.supabaseUrl, config.supabaseAnonKey, {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet) => {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        },
      },
    });
    await supabase.auth.signOut();
  }
  return NextResponse.redirect(new URL("/login", url.origin), { status: 303 });
}
