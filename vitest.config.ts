import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.join(import.meta.dirname, "shared"),
    },
  },
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.toml" },
      // Workers AI (the [ai] binding, added for Task 4's capture-time PR
      // summarizer) has no local simulator — Wrangler proxies it to a real
      // Cloudflare account. Without this, every test run tries to open a
      // remote proxy session and fails non-interactively whenever more than
      // one account is available (as here). With it false, env.AI is still
      // present but every property access throws "needs to be run remotely";
      // workersAiSummarizer() catches that (same as any other AI failure) and
      // falls back to excerptSummary, so the suite stays green and hermetic
      // (real D1 via Miniflare, no network) without ever needing a real session.
      remoteBindings: false,
      miniflare: {
        // exposed to tests as env.TEST_MIGRATIONS; applied in the setup file
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            path.join(import.meta.dirname, "migrations")
          ),
          COOKIE_SECRET: "test-cookie-secret",
          GITHUB_CLIENT_ID: "test-client-id",
          GITHUB_CLIENT_SECRET: "test-client-secret",
          GITHUB_WEBHOOK_SECRET: "test-webhook-secret",
          ADMIN_LOGINS: "admin-user", // the admin allowlist the admin-gated route + isAdmin() test against
          DEV_LOGIN: "", // override .dev.vars: tests exercise REAL auth, never the dev bypass
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
