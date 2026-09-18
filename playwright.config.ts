import { defineConfig } from "@playwright/test";

const PORT = 3100;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, headless: true },
  webServer: {
    // A production build, not `next dev`: on-demand compilation makes first
    // interactions unpredictably slow and turns real assertions into flakes.
    command: `npm run build && npm run start -- --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/healthz`,
    reuseExistingServer: false,
    timeout: 300_000,
    // A throwaway database so the smoke test never depends on, or disturbs,
    // whatever state the demo database is in.
    env: { SAATHI_DB_PATH: "./data/e2e.db", SAATHI_DEMO_MODE: "true" },
  },
});
