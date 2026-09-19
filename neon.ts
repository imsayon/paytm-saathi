import { defineConfig } from "@neon/config/v1";

/**
 * Neon is the backend boundary for Saathi: Postgres plus branchable Auth.
 * Applying this policy to a new branch provisions Neon Auth alongside the
 * branch so preview environments do not silently fall back to another IdP.
 */
export default defineConfig({
  auth: true,
});
