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
          DEV_LOGIN: "", // override .dev.vars: tests exercise REAL auth, never the dev bypass
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
