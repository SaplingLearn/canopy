-- Ticket source (2026-09-24, feat/tickets-github-mirror). Every GitHub issue in
-- GITHUB_REPO is mirrored into a ticket. ADR-007, AMENDED: a ticket may link to
-- GitHub work, and may be sourced from a GitHub issue, but is never the issue
-- itself — a mirrored ticket is still a D1 row Canopy owns.
--
-- Ownership: GitHub seeds title / body / assignees / status at IMPORT; after
-- that Canopy owns them, EXCEPT that a GitHub close forces the ticket to its
-- final state (done / declined) and a GitHub reopen reopens it. The one hard
-- lock is the source link (`ticket_links.locked = 1`), which can never be
-- removed. There is no trigger enforcing it: scripts/seed/reset.mjs truncates
-- ticket_links before every test and a trigger would break the harness; the
-- writer `remove_ticket_link` (the only link delete path) refuses instead.
--
-- `source_author` is the RAW GitHub login of the issue's author, NOT a handle,
-- so it is deliberately absent from HANDLE_COLUMNS (a rename must not touch it).
-- `source_updated_at` is the issue.updated_at of the last applied delivery — the
-- ordering guard: an older delivery than this is skipped.

ALTER TABLE tickets ADD COLUMN source TEXT NOT NULL DEFAULT 'canopy' CHECK (source IN ('canopy','github'));
ALTER TABLE tickets ADD COLUMN source_ref TEXT;          -- "owner/repo#n"
ALTER TABLE tickets ADD COLUMN source_author TEXT;       -- raw GitHub login, NOT a handle
ALTER TABLE tickets ADD COLUMN source_updated_at TEXT;   -- issue.updated_at of the last applied delivery
CREATE UNIQUE INDEX idx_tickets_source_ref ON tickets(source_ref) WHERE source_ref IS NOT NULL;
ALTER TABLE ticket_links ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;

-- The mirror's fallback requester (an issue whose author maps to no person).
-- `tickets.requester` is a hard FK to persons(handle), so the handle must exist.
-- 'github-webhook' is in RESERVED_HANDLES, so no person can ever claim it.
INSERT OR IGNORE INTO persons (handle, name, color, created_at, onboarded_at)
  VALUES ('github-webhook', 'GitHub', 'stone', '2026-09-24T00:00:00Z', '2026-09-24T00:00:00Z');
