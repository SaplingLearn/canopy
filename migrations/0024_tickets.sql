-- Tickets (2026-09-16 tickets build, phase 1a). One queue the whole org files
-- into. Tickets are D1 rows, never GitHub issues (ADR-007 in the locked design):
-- a ticket may LINK to GitHub or Figma work, it never IS that work.
--
-- Authority model: every ticket write is a human authored write in the promote
-- class — `consume()` (the ingestion gate) is never involved, there is no staged
-- state, and `done` / `declined` are set by a person, never inferred from a PR
-- merge or an issue closing.
--
-- PERSON COLUMNS HOLD HANDLES. The identity root is `persons(handle)` (0023);
-- there is no `users` table. `tickets.requester` carries a hard FK because a
-- ticket always has a live requester; `ticket_assignees.login` (name kept from
-- the brief — it stores a HANDLE), `ticket_links.created_by`,
-- `ticket_comments.author` and `ticket_events.actor` are plain TEXT handles, the
-- same choice as `notification_prefs.user_id`, so historical rows survive a
-- person deletion. Every one of these columns is listed in HANDLE_COLUMNS
-- (src/auth/persons.ts) so a handle rename rewrites them.
--
-- FORWARD REFERENCE, AND WHY IT IS A COMMENT AND NOT A CONSTRAINT:
-- `tickets.sprint_id` points at `sprints(id)`, a table that does not exist yet —
-- 0025 creates it, by renaming `milestones`. SQLite does accept a forward
-- reference at CREATE TABLE time (an FK clause is parsed, not resolved, when the
-- child table is created), so `REFERENCES sprints(id)` would apply cleanly here.
-- It cannot stay, though: foreign keys ARE enforced on D1's connections (which
-- is why renamePerson has to `PRAGMA defer_foreign_keys` for its batch), and
-- SQLite resolves every FK of a table when it PREPARES any statement against it
-- — not only when a constraint is checked. With the clause in place, a plain
--   DELETE FROM tickets
-- fails with `no such table: main.sprints: SQLITE_ERROR`, which takes the whole
-- test harness down with it. So `sprint_id` is a plain INTEGER (NULL = backlog),
-- a soft reference of exactly the kind the person-handle columns below are, and
-- this comment is the documentation of the relationship. 0025 may promote it to
-- a real FK once `sprints` exists (that needs a table rebuild — SQLite has no
-- ALTER TABLE ADD CONSTRAINT); nothing in the read or write paths depends on it.
--
-- D1 EXPORT CAVEAT (the reason the FTS layer below is written as a DROP-then-
-- CREATE, mirroring 0011_fts_recreate.sql): `wrangler d1 export` cannot dump a
-- database that contains virtual tables. The documented workaround is to DROP
-- the *_fts tables, run the export, then recreate them — and that recreate step
-- was missed once already (0008 → 0011). So the `tickets_fts` section here tears
-- down any partial/dangling state first (including base-table triggers left
-- pointing at a since-dropped virtual table), then rebuilds the index and
-- backfills it from `tickets`. Re-running that section against a healthy
-- database rebuilds the index from the current rows: safe, and a no-op in effect.

-- ── tear down any partial FTS state first (dropped tables leave triggers dangling) ─
DROP TRIGGER IF EXISTS tickets_fts_ai;
DROP TRIGGER IF EXISTS tickets_fts_au;
DROP TRIGGER IF EXISTS tickets_fts_ad;
DROP TABLE IF EXISTS tickets_fts;

-- ── the ticket itself ────────────────────────────────────────────────────────
CREATE TABLE tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('bug','request','question','access','other')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','in_progress','done','declined')),
  requester TEXT NOT NULL REFERENCES persons(handle),   -- a person handle (0023)
  parent_id INTEGER REFERENCES tickets(id),             -- ONE level only; enforced in the route, not here
  sprint_id INTEGER,                                    -- NULL = backlog; soft ref to sprints(id), which 0025 creates (see above)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Queue reads: the list is segmented by status and sorted `updated_at DESC`;
-- the sprint grouping and the sub-ticket counts are per-parent/per-sprint fan-outs.
CREATE INDEX idx_tickets_status_updated ON tickets(status, updated_at);
CREATE INDEX idx_tickets_sprint ON tickets(sprint_id);
CREATE INDEX idx_tickets_parent ON tickets(parent_id);

-- ── assignees: many per ticket, toggled (no confirm step) ────────────────────
-- `login` holds a person HANDLE. The column name is the brief's.
CREATE TABLE ticket_assignees (
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  login TEXT NOT NULL,
  PRIMARY KEY (ticket_id, login)
);
CREATE INDEX idx_ticket_assignees_login ON ticket_assignees(login);

-- ── linked work: the GitHub/Figma/plain references a ticket points AT ────────
-- kind/label/meta are what `parseTicketLink` (shared/tickets.ts) derived from the
-- raw input; the url is stored resolved (a bare `#214` becomes the issue URL).
CREATE TABLE ticket_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  url TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('github','figma','plain')),
  label TEXT NOT NULL,
  meta TEXT NOT NULL,
  created_by TEXT NOT NULL,            -- a person handle
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ticket_links_ticket ON ticket_links(ticket_id);

-- ── the comment thread ───────────────────────────────────────────────────────
CREATE TABLE ticket_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  author TEXT NOT NULL,                -- a person handle
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ticket_comments_ticket ON ticket_comments(ticket_id, created_at);

-- ── history: one row per status change, plus the opening row ─────────────────
-- The opening row has from_status NULL and to_status 'submitted' ("opened · SUBMITTED").
CREATE TABLE ticket_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  actor TEXT NOT NULL,                 -- a person handle
  from_status TEXT CHECK (from_status IS NULL OR from_status IN ('submitted','in_progress','done','declined')),
  to_status TEXT NOT NULL CHECK (to_status IN ('submitted','in_progress','done','declined')),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_ticket_events_ticket ON ticket_events(ticket_id, created_at);

-- ── tickets_fts: standalone FTS5 over title + body (mirrors 0008/0011) ───────
-- Standalone, NOT external-content: it sidesteps the INTEGER-ticket-id-vs-rowid
-- mismatch, and the AFTER DELETE trigger cascades `DELETE FROM tickets` into
-- tickets_fts so the harness's per-test truncation (scripts/seed/reset.mjs, run
-- by test/apply-migrations.ts) leaves no leaked FTS rows — tickets_fts itself
-- never needs a DELETE in that reset.
CREATE VIRTUAL TABLE tickets_fts USING fts5(
  ticket_id UNINDEXED, title, body, tokenize = 'porter unicode61');

CREATE TRIGGER tickets_fts_ai AFTER INSERT ON tickets BEGIN
  DELETE FROM tickets_fts WHERE ticket_id = CAST(new.id AS TEXT);
  INSERT INTO tickets_fts (ticket_id, title, body)
    VALUES (CAST(new.id AS TEXT), new.title, new.body);
END;

-- Status/assignee/sprint churn does not change searchable text; only title/body do.
CREATE TRIGGER tickets_fts_au AFTER UPDATE OF title, body ON tickets BEGIN
  DELETE FROM tickets_fts WHERE ticket_id = CAST(new.id AS TEXT);
  INSERT INTO tickets_fts (ticket_id, title, body)
    VALUES (CAST(new.id AS TEXT), new.title, new.body);
END;

CREATE TRIGGER tickets_fts_ad AFTER DELETE ON tickets BEGIN
  DELETE FROM tickets_fts WHERE ticket_id = CAST(old.id AS TEXT);
END;

-- ── backfill existing rows ───────────────────────────────────────────────────
INSERT INTO tickets_fts (ticket_id, title, body)
  SELECT CAST(id AS TEXT), title, body FROM tickets;
