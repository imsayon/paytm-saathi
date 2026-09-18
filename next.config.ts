import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Postgres driver stays a Node module rather than being bundled.
  serverExternalPackages: ["pg"],
  // The Playwright run builds into its own directory so a production build
  // never overwrites the chunks a running `next dev` is serving.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
};

export default nextConfig;
