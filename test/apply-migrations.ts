import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";
import { RESET_STATEMENTS } from "../scripts/seed/reset.mjs";

// Runs once per test worker before the suite. applyD1Migrations is idempotent.
// Schema + seeded vocabulary (sections, tags) are applied here and persist for
// all tests. Data tables are truncated before each test so every test starts
// with a clean slate — approximating per-test D1 isolation.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

beforeEach(async () => {
  // The canonical data-table reset lives in scripts/seed/reset.mjs, shared by
  // this harness and the dev seed loader (FK-safe delete order + people
  // re-seed). Truncates all user-writable data tables, preserving vocabulary
  // tables (sections, tags) that were seeded by the migration.
  await env.DB.exec(RESET_STATEMENTS.join("; ") + ";");
});
