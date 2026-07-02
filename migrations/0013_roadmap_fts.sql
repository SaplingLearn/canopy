-- Read-side brain, roadmap layer: FTS5 over the plan narrative + milestones so
-- `query` stops being roadmap-blind.
--
-- Standalone (NOT external-content) FTS5, exactly like 0008: it sidesteps the
-- INTEGER-milestone-id-vs-rowid mismatch, and its AFTER DELETE trigger cascades
-- `DELETE FROM milestones` into roadmap_fts so the harness's per-test truncation
-- (test/apply-migrations.ts) leaves no leaked FTS rows. (No need to add
-- roadmap_fts to that truncation statement.)
--
-- One virtual table, two kinds of row, keyed by a synthetic `ref`:
--   * 'milestone:<id>' — title = milestone.title; body = description ∥ phase ∥ status
--   * 'plan'           — title = 'Roadmap plan'; body = plan.narrative
--
-- PLAN-ROW INDEXING BEHAVIOUR (chosen, implemented consistently below): the plan
-- singleton is indexed ONLY when its narrative is non-empty. The plan row is
-- seeded/reset to '' (migration seed + the harness `UPDATE plan SET narrative=''`),
-- so an empty plan never pollutes search and never leaks across truncation — the
-- narrative-UPDATE trigger delete-then-CONDITIONALLY-inserts (skips the insert
-- when the new narrative is empty), and the backfill filters `narrative != ''`.
--
-- D1 EXPORT CAVEAT: `wrangler d1 export` cannot dump a database that contains
-- virtual tables. The documented workaround is: DROP the *_fts tables, run the
-- export, then recreate them (re-applying this migration / its backfill).

CREATE VIRTUAL TABLE roadmap_fts USING fts5(
  ref UNINDEXED, title, body, tokenize = 'porter unicode61');

-- ── milestone triggers (delete-then-insert keyed on the synthetic ref) ────────
CREATE TRIGGER roadmap_fts_milestone_ai AFTER INSERT ON milestones BEGIN
  DELETE FROM roadmap_fts WHERE ref = 'milestone:' || new.id;
  INSERT INTO roadmap_fts (ref, title, body)
    VALUES ('milestone:' || new.id, new.title,
            COALESCE(new.description, '') || ' ' || COALESCE(new.phase, '') || ' ' || COALESCE(new.status, ''));
END;

CREATE TRIGGER roadmap_fts_milestone_au AFTER UPDATE OF title, description, phase, status ON milestones BEGIN
  DELETE FROM roadmap_fts WHERE ref = 'milestone:' || new.id;
  INSERT INTO roadmap_fts (ref, title, body)
    VALUES ('milestone:' || new.id, new.title,
            COALESCE(new.description, '') || ' ' || COALESCE(new.phase, '') || ' ' || COALESCE(new.status, ''));
END;

CREATE TRIGGER roadmap_fts_milestone_ad AFTER DELETE ON milestones BEGIN
  DELETE FROM roadmap_fts WHERE ref = 'milestone:' || old.id;
END;

-- ── plan trigger (singleton; the narrative UPDATE makes it searchable) ────────
-- Reset-to-empty (the harness truncation) cascades correctly: the delete clears
-- any prior plan row and the conditional insert emits nothing for an empty body.
CREATE TRIGGER roadmap_fts_plan_au AFTER UPDATE OF narrative ON plan BEGIN
  DELETE FROM roadmap_fts WHERE ref = 'plan';
  INSERT INTO roadmap_fts (ref, title, body)
    SELECT 'plan', 'Roadmap plan', new.narrative WHERE new.narrative != '';
END;

-- ── backfill existing rows ───────────────────────────────────────────────────
INSERT INTO roadmap_fts (ref, title, body)
  SELECT 'milestone:' || id, title,
         COALESCE(description, '') || ' ' || COALESCE(phase, '') || ' ' || COALESCE(status, '')
    FROM milestones;
INSERT INTO roadmap_fts (ref, title, body)
  SELECT 'plan', 'Roadmap plan', narrative FROM plan WHERE narrative != '';
