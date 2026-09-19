import { NextResponse, type NextRequest } from "next/server";
import { getNeonAuth } from "@/server/auth/neon";
import { config as appConfig } from "@/server/config";

export async function proxy(request: NextRequest) {
  // The public hackathon demo intentionally remains explorable without an
  // account. A non-demo deployment uses Neon Auth middleware as the perimeter.
  if (appConfig.demoMode) return NextResponse.next({ request });

  const pathname = request.nextUrl.pathname;
  if (
    pathname === "/login" ||
    pathname === "/api/healthz" ||
    pathname === "/api/readyz" ||
    pathname.startsWith("/api/auth/")
  ) {
    return NextResponse.next({ request });
  }

  const auth = getNeonAuth();
  return auth ? auth.middleware({ loginUrl: "/login" })(request) : NextResponse.next({ request });
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
