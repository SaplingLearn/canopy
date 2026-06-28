-- Phase 2 — Reconciler: replay ledger + dedupe/change-typing columns.
--
-- The worker stops being a write-through. Per session-scoped item it now
-- reconciles against the KB: a replay (same session_id + item_index) is dropped
-- via the processed_items ledger, an unchanged body is dropped via content-hash
-- dedupe, and a real delta is staged carrying its content_hash, the base it was
-- edited from, and a new/edit/rewrite classification.

-- The replay ledger. One row per (session_id, item_index) the worker has seen.
-- A re-POST of the same payload hits every row → every item drops as unchanged.
-- item_index is assigned by the worker via stable enumeration across the
-- payload's typed arrays (feed → docs → adrs → milestones → focus → triage), so
-- the SAME payload always maps an item to the SAME index.
CREATE TABLE processed_items (
  session_id TEXT NOT NULL,
  item_index INTEGER NOT NULL,
  item_type  TEXT NOT NULL,      -- feed | doc | adr | milestone | focus | triage
  outcome    TEXT NOT NULL,      -- the gate's verdict (written | staged | triaged | unchanged)
  ref        TEXT,               -- what it became (e.g. "slug@2", a feed/adr id), for transparency
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, item_index)
);

-- Doc reconciliation metadata, recorded on each staged version.
ALTER TABLE doc_versions ADD COLUMN content_hash   TEXT;     -- SHA-256 of the proposed body; dedupe key
ALTER TABLE doc_versions ADD COLUMN base_version   INTEGER;  -- the version this edit was based on
ALTER TABLE doc_versions ADD COLUMN change_kind    TEXT;     -- new | edit | rewrite
ALTER TABLE doc_versions ADD COLUMN low_confidence INTEGER NOT NULL DEFAULT 0; -- 1 = staged-and-flagged

-- Content-hash dedupe keys for the other staged types.
ALTER TABLE adrs                ADD COLUMN content_hash TEXT;  -- SHA-256 of title+context+decision+rationale
ALTER TABLE milestone_proposals ADD COLUMN content_hash TEXT;  -- SHA-256 of the proposed milestone fields

CREATE INDEX idx_doc_versions_hash ON doc_versions(slug, content_hash);
CREATE INDEX idx_adrs_hash         ON adrs(content_hash);
CREATE INDEX idx_mileprop_hash     ON milestone_proposals(content_hash);

-- New TEXT status values are introduced WITHOUT a migration (TEXT columns):
--   doc_versions.status += 'rejected'   (set by Phase 3 reject routes)
--   adrs.status         += 'rejected'   (set by Phase 3 reject routes)
-- Documented in shared/rows.ts. Phase 2 never sets them; staging stays non-destructive.
