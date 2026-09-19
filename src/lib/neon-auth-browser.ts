"use client";

import { createAuthClient } from "@neondatabase/auth/next";

/** Browser client talks to this app's /api/auth proxy, not directly to Neon. */
export const neonAuthClient = createAuthClient();
