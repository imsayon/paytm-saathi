import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Neon Auth normally returns directly to the requested callback URL. */
export function GET(request: Request) {
  const url = new URL(request.url);
  const next = url.searchParams.get("next") ?? "/";
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  return NextResponse.redirect(new URL(safeNext, url.origin));
}
