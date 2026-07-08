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
      // No remote bindings: capture-time summaries go to Gemini over a plain
      // fetch() (not a Cloudflare binding), and GEMINI_API_KEY is unset in tests,
      // so both summarizer construction sites resolve to null → the excerpt
      // fallback. Summarizer behavior is exercised via dependency-injected stubs
      // (and a stubbed fetchImpl), never the network — the suite stays green and
      // hermetic (real D1 via Miniflare, no remote session).
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
