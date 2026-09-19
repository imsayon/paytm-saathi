import { NextResponse } from "next/server";
import { getNeonAuth } from "@/server/auth/neon";

export const dynamic = "force-dynamic";

type AuthRouteContext = { params: Promise<{ path: string[] }> };

async function forward(
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  request: Request,
  context: AuthRouteContext,
): Promise<Response> {
  const auth = getNeonAuth();
  if (!auth) {
    return NextResponse.json(
      { error: { message: "Neon Auth is not configured on this deployment." } },
      { status: 503 },
    );
  }
  return auth.handler()[method](request, context);
}

export function GET(request: Request, context: AuthRouteContext) {
  return forward("GET", request, context);
}

export function POST(request: Request, context: AuthRouteContext) {
  return forward("POST", request, context);
}

export function PUT(request: Request, context: AuthRouteContext) {
  return forward("PUT", request, context);
}

export function DELETE(request: Request, context: AuthRouteContext) {
  return forward("DELETE", request, context);
}

export function PATCH(request: Request, context: AuthRouteContext) {
  return forward("PATCH", request, context);
}
