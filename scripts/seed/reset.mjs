// Canonical data-table reset for Canopy, shared by the test harness
// (test/apply-migrations.ts) and the dev seed loader. FK-safe delete order;
// re-seeds the people identity map. When a migration adds a data table, add
// its DELETE here.
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
  "DELETE FROM notification_outbox_bodies",
  "DELETE FROM notification_outbox",
  "DELETE FROM notification_prefs",
  "DELETE FROM notification_policy",
  "UPDATE notification_settings SET send_hour = 8, timezone = 'America/New_York', from_address = 'Canopy <canopy@mail.canopy.saplinglearn.com>' WHERE id = 1",
  "DELETE FROM sessions",
  "DELETE FROM mcp_tokens",
  "DELETE FROM users",
];
