import { defineConfig } from "@playwright/test";
import { loadEnvFiles } from "./src/server/env";

loadEnvFiles();

const PORT = 3100;

// The smoke test resets the demo merchant's data, so it only ever runs against a
// database that was explicitly nominated for testing: never the production branch
// by accident.
const databaseUrl = process.env.E2E_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "Set TEST_DATABASE_URL (the Neon `test` branch or a local Postgres) or E2E_DATABASE_URL before running npm run test:e2e.",
  );
}

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: `http://127.0.0.1:${PORT}`, headless: true },
  webServer: {
    // A production build, not `next dev`: on-demand compilation makes first
    // interactions unpredictably slow and turns real assertions into flakes.
    command: `npm run db:migrate && npm run build && npm run start -- --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/readyz`,
    reuseExistingServer: false,
    timeout: 300_000,
    env: {
      DATABASE_URL: databaseUrl,
      DATABASE_URL_UNPOOLED: databaseUrl,
      SAATHI_DEMO_MODE: "true",
    },
  },
});
