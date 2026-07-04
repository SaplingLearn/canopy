-- Identity triage (Maintenance group): one pending task per unknown GitHub login
-- seen on a captured event. Raised by ingestEvent AFTER the event row lands, so
-- capture never depends on the task. Resolved by the human map-to-person route,
-- which performs the `people` table's only runtime write. login is the PK: many
-- events from one unknown person collapse into one task (INSERT OR IGNORE), and
-- a resolved task is never re-raised. Soft resolve only — rows are never deleted.
CREATE TABLE identity_tasks (
  login TEXT PRIMARY KEY,                   -- the unmapped GitHub login
  first_seen TEXT NOT NULL,                 -- ISO8601 of the first event that raised it
  status TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'resolved'
  resolved_at TEXT,                         -- ISO8601 when mapped
  resolved_by TEXT                          -- the authenticated principal who mapped it
);
