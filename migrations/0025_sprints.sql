-- Sprints (2026-09-16 tickets build, phase 1b). Sprints ARE milestones, renamed.
-- Same rows, same purpose, same ids — a new label and a few new fields. There is
-- deliberately NO parallel table and NO data copy: every existing milestone keeps
-- its id, so `plan_versions` snapshots, the progress cache, `github_ref` links and
-- anything else that referenced a milestone id keeps pointing at the same row.
--
-- WHAT A SPRINT IS NOW: the container the Roadmap shows. It holds tickets (0024,
-- `tickets.sprint_id`) and, as before, may carry a `github_ref` so event-derived
-- GitHub issue progress still counts toward it. Column mapping across the seam
-- (see shared/sprints.ts):
--   title       → the DTO's `label`
--   target_date → the DTO's `due`
--   status      → 'upcoming' | 'in_progress' | 'done'; the DTO's `active` is
--                 derived (`status === 'in_progress'`). 'done' stays admin-only.
--   description → rendered as markdown from here on (a render-side change only)
--
-- SQLite RENAME semantics this migration relies on (legacy_alter_table OFF, the
-- default in the SQLite that D1 ships):
--   * `ALTER TABLE ... RENAME TO` rewrites REFERENCES clauses in OTHER tables, so
--     `milestone_progress.milestone_id REFERENCES milestones(id)` automatically
--     becomes `REFERENCES sprints(id)` — verified in test/sprints.schema.test.ts
--     with `PRAGMA foreign_key_list(sprint_progress)`.
--   * It also rewrites trigger bodies that name the renamed table. We drop and
--     recreate the roadmap_fts triggers regardless, because the synthetic `ref`
--     string they write CHANGES ('milestone:<id>' → 'sprint:<id>') — a rewrite of
--     the table name alone would leave the old refs in the index.
--   * Indexes survive a table rename but keep their old NAME, so the target_date
--     index is dropped and recreated under the new name.
--
-- THE APPROVAL SYSTEM GOES. `milestone_proposals` (the agent-proposed,
-- human-promoted milestone queue) is dropped at the bottom of this file. The
-- `propose_milestone` MCP tool was already retired; 1b removes the table, the
-- gate fn, the contract schema, the writers, the reads, the routes, the
-- triage-assign kind and the web surface. Sprints are authored directly (the
-- admin plan write, and the Phase 3 sprint routes) — promote class, never the
-- ingestion gate.

-- ── 1. roadmap_fts triggers: drop BEFORE the rename ──────────────────────────
-- Dropping first means the rename has no trigger body to rewrite, and the
-- recreate below is the single definition of the new 'sprint:<id>' refs.
DROP TRIGGER IF EXISTS roadmap_fts_milestone_ai;
DROP TRIGGER IF EXISTS roadmap_fts_milestone_au;
DROP TRIGGER IF EXISTS roadmap_fts_milestone_ad;

-- ── 2. the table rename ──────────────────────────────────────────────────────
DROP INDEX IF EXISTS idx_milestones_target_date;
ALTER TABLE milestones RENAME TO sprints;
CREATE INDEX idx_sprints_target_date ON sprints(target_date);

-- ── 3. the progress cache follows it ─────────────────────────────────────────
-- Still ABSOLUTE closed/total per sprint, written by the webhook (event-derived)
-- and the scheduled recompute. Its FK was rewritten to `sprints(id)` by step 2.
ALTER TABLE milestone_progress RENAME TO sprint_progress;
ALTER TABLE sprint_progress RENAME COLUMN milestone_id TO sprint_id;

-- ── 4. the plan snapshot column ──────────────────────────────────────────────
-- plan_versions holds a full snapshot of the sprint rows AFTER each plan write.
-- Renaming the column (rather than adding one) keeps every historical snapshot
-- readable through the same field.
ALTER TABLE plan_versions RENAME COLUMN milestones_json TO sprints_json;

-- ── 5. the new sprint fields ─────────────────────────────────────────────────
-- `phase` is NOT here: it already exists (added by 0012).
-- SQLite's ALTER TABLE ADD COLUMN accepts a CHECK constraint; a NOT NULL column
-- needs a non-NULL default, which is why `urgency` has one and the others don't.
ALTER TABLE sprints ADD COLUMN dates TEXT;                 -- human date range, e.g. "Sep 16 – Sep 30"
ALTER TABLE sprints ADD COLUMN summary TEXT;               -- one line under the sprint label on the card
ALTER TABLE sprints ADD COLUMN urgency TEXT NOT NULL DEFAULT 'normal' CHECK (urgency IN ('low', 'normal', 'high'));
ALTER TABLE sprints ADD COLUMN lead TEXT;                  -- person HANDLE (soft ref; in HANDLE_COLUMNS)
ALTER TABLE sprints ADD COLUMN domain TEXT CHECK (domain IN ('notifications', 'tickets', 'gate', 'feed', 'search', 'infra'));

-- ── 6. roadmap_fts triggers, recreated for sprints ───────────────────────────
-- Same delete-then-insert shape as 0013, keyed on the synthetic ref, with two
-- changes: the ref is now 'sprint:<id>', and `summary` joins the indexed body
-- (and the AFTER UPDATE OF column list) since it is new searchable prose.
CREATE TRIGGER roadmap_fts_sprint_ai AFTER INSERT ON sprints BEGIN
  DELETE FROM roadmap_fts WHERE ref = 'sprint:' || new.id;
  INSERT INTO roadmap_fts (ref, title, body)
    VALUES ('sprint:' || new.id, new.title,
            COALESCE(new.description, '') || ' ' || COALESCE(new.summary, '') || ' ' ||
            COALESCE(new.phase, '') || ' ' || COALESCE(new.status, ''));
END;

CREATE TRIGGER roadmap_fts_sprint_au AFTER UPDATE OF title, description, summary, phase, status ON sprints BEGIN
  DELETE FROM roadmap_fts WHERE ref = 'sprint:' || new.id;
  INSERT INTO roadmap_fts (ref, title, body)
    VALUES ('sprint:' || new.id, new.title,
            COALESCE(new.description, '') || ' ' || COALESCE(new.summary, '') || ' ' ||
            COALESCE(new.phase, '') || ' ' || COALESCE(new.status, ''));
END;

CREATE TRIGGER roadmap_fts_sprint_ad AFTER DELETE ON sprints BEGIN
  DELETE FROM roadmap_fts WHERE ref = 'sprint:' || old.id;
END;

-- ── 7. re-key the existing index rows ────────────────────────────────────────
-- The rows written under the old ref are stale the moment the ref string changes
-- (nothing would ever delete or update them again), so they go and are rebuilt.
-- The 'plan' singleton row is untouched — its trigger is on `plan`, not here.
DELETE FROM roadmap_fts WHERE ref LIKE 'milestone:%';
INSERT INTO roadmap_fts (ref, title, body)
  SELECT 'sprint:' || id, title,
         COALESCE(description, '') || ' ' || COALESCE(summary, '') || ' ' ||
         COALESCE(phase, '') || ' ' || COALESCE(status, '')
    FROM sprints;

-- ── 8. sprint resources ──────────────────────────────────────────────────────
-- Links attached to the sprint itself (a spec, a Figma file, a tracking issue),
-- parsed with the SAME parser as ticket links (shared/tickets.ts parseTicketLink),
-- hence the identical kind vocabulary. GET /sprints/:id (Phase 3) unions these
-- with the ticket links inside the sprint, deduped by url.
CREATE TABLE sprint_resources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sprint_id INTEGER NOT NULL REFERENCES sprints(id),
  url TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('github', 'figma', 'plain')),
  label TEXT NOT NULL,
  meta TEXT NOT NULL
);
CREATE INDEX idx_sprint_resources_sprint ON sprint_resources(sprint_id);

-- ── 9. the milestone proposal queue is retired ───────────────────────────────
-- Nothing references this table (no FKs point at it), so the DROP is clean. Any
-- rows still staged in it were never live roadmap content by definition — a
-- proposal only became real through the promote route, which is also gone.
DROP TABLE IF EXISTS milestone_proposals;
