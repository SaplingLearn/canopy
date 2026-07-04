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
    // pr_summaries.semantic_key REFERENCES events(semantic_key) — delete the
    // child before its parent, or the FK constraint rejects the parent delete.
    // people gains a runtime write path (identity resolve), so it is reset to
    // the 0012 seed each test rather than left to accumulate mappings.
    "DELETE FROM processed_items; DELETE FROM pr_summaries; DELETE FROM issue_summaries; DELETE FROM events; DELETE FROM milestone_progress; DELETE FROM plan_versions; UPDATE plan SET narrative = '', current_version = 0, updated_at = NULL, updated_by = NULL; DELETE FROM milestone_proposals; DELETE FROM milestones; DELETE FROM doc_versions; DELETE FROM docs; DELETE FROM feed; DELETE FROM entry_tags; DELETE FROM adrs; DELETE FROM needs_triage; DELETE FROM identity_tasks; DELETE FROM people; INSERT INTO people (login, person) VALUES ('AndresL230', 'Andres'), ('Jose-Gael-Cruz-Lopez', 'Jose'), ('lpcooper-arch', 'Luke'), ('Darkest-Teddy', 'Jack'); DELETE FROM sessions; DELETE FROM mcp_tokens; DELETE FROM users;"
  );
});
