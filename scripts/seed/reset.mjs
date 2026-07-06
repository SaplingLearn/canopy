// Canonical local-D1 reset. MUST mirror the beforeEach truncation in
// test/apply-migrations.ts (same FK-safe delete order, same people re-seed).
// If a migration adds a table to that truncation, add it here too.
export const RESET_STATEMENTS = [
  "DELETE FROM processed_items",
  "DELETE FROM pr_summaries",
  "DELETE FROM issue_summaries",
  "DELETE FROM events",
  "DELETE FROM milestone_progress",
  "DELETE FROM plan_versions",
  "UPDATE plan SET narrative = '', current_version = 0, updated_at = NULL, updated_by = NULL",
  "DELETE FROM milestone_proposals",
  "DELETE FROM milestones",
  "DELETE FROM doc_versions",
  "DELETE FROM docs",
  "DELETE FROM feed",
  "DELETE FROM entry_tags",
  "DELETE FROM adrs",
  "DELETE FROM needs_triage",
  "DELETE FROM identity_tasks",
  "DELETE FROM people",
  "INSERT INTO people (login, person) VALUES ('AndresL230', 'Andres'), ('Jose-Gael-Cruz-Lopez', 'Jose'), ('lpcooper-arch', 'Luke'), ('Darkest-Teddy', 'Jack')",
  "DELETE FROM sessions",
  "DELETE FROM mcp_tokens",
  "DELETE FROM users",
];
