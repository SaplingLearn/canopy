// Canonical data-table reset for Canopy, shared by the test harness
// (test/apply-migrations.ts) and the dev seed loader. FK-safe delete order;
// re-seeds the people identity map. When a migration adds a data table, add
// its DELETE here.
export const RESET_STATEMENTS = [
  // Tickets (0024) first: the ticket_* children reference tickets, and tickets
  // references persons(handle) (and, from 0025, sprints(id)) — so the whole tree
  // clears before anything it points at. tickets_fts needs no DELETE: the
  // tickets_fts_ad trigger cascades the `DELETE FROM tickets` into the index.
  "DELETE FROM ticket_events",
  "DELETE FROM ticket_comments",
  "DELETE FROM ticket_links",
  "DELETE FROM ticket_assignees",
  "DELETE FROM tickets",
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
  "DELETE FROM notification_outbox_bodies",
  "DELETE FROM notification_outbox",
  "DELETE FROM notification_prefs",
  "DELETE FROM notification_policy",
  "UPDATE notification_settings SET send_hour = 8, timezone = 'America/New_York', from_address = 'Canopy <canopy@canopy.saplinglearn.com>' WHERE id = 1",
  "DELETE FROM sessions",
  "DELETE FROM mcp_tokens",
  "DELETE FROM identities",
  "DELETE FROM invites",
  "DELETE FROM persons",
  // The dev/test person seed (was the `people` map): four persons, each with their github identity.
  "INSERT INTO persons (handle, name, color, created_at, onboarded_at) VALUES ('AndresL230', 'Andres', 'moss', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), ('Jose-Gael-Cruz-Lopez', 'Jose', 'sky', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), ('lpcooper-arch', 'Luke', 'fern', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), ('Darkest-Teddy', 'Jack', 'plum', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
  "INSERT INTO identities (provider, subject, label, person, linked_at, linked_by) VALUES ('github', 'AndresL230', 'AndresL230', 'AndresL230', '2026-01-01T00:00:00Z', 'seed'), ('github', 'Jose-Gael-Cruz-Lopez', 'Jose-Gael-Cruz-Lopez', 'Jose-Gael-Cruz-Lopez', '2026-01-01T00:00:00Z', 'seed'), ('github', 'lpcooper-arch', 'lpcooper-arch', 'lpcooper-arch', '2026-01-01T00:00:00Z', 'seed'), ('github', 'Darkest-Teddy', 'Darkest-Teddy', 'Darkest-Teddy', '2026-01-01T00:00:00Z', 'seed')",
];
