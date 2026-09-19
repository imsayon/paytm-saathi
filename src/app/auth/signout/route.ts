import { NextResponse } from "next/server";
import { getNeonAuth } from "@/server/auth/neon";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const url = new URL(request.url);
  const auth = getNeonAuth();
  if (auth) await auth.signOut();
  return NextResponse.redirect(new URL("/login", url.origin), { status: 303 });
}
