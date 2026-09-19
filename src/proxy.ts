import { NextResponse, type NextRequest } from "next/server";
import { getNeonAuth } from "@/server/auth/neon";
import { config as appConfig } from "@/server/config";

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const auth = getNeonAuth();

  // The public preview remains explorable without an account, but Neon Auth
  // still needs to see every request so it can exchange the OAuth verifier and
  // refresh an existing session cookie. Skipping middleware here makes Google
  // sign-in appear to succeed while leaving the browser anonymous.
  if (appConfig.demoMode) {
    return auth
      ? auth.middleware({ loginUrl: pathname || "/" })(request)
      : NextResponse.next({ request });
  }

  if (
    pathname === "/login" ||
    pathname === "/api/healthz" ||
    pathname === "/api/readyz" ||
    pathname.startsWith("/api/auth/")
  ) {
    return NextResponse.next({ request });
  }

  return auth ? auth.middleware({ loginUrl: "/login" })(request) : NextResponse.next({ request });
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
