import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";

// Runs once per test worker before the suite. applyD1Migrations is idempotent.
// Schema + seeded vocabulary (sections, tags) are applied here and persist for
// all tests. Data tables are truncated before each test so every test starts
// with a clean slate — approximating per-test D1 isolation.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

beforeEach(async () => {
  // Truncate all user-writable data tables, preserving vocabulary tables
  // (sections, tags) that were seeded by the migration.
  await env.DB.exec(
    "DELETE FROM doc_versions; DELETE FROM docs; DELETE FROM feed; DELETE FROM entry_tags; DELETE FROM adrs; DELETE FROM needs_triage;"
  );
});
