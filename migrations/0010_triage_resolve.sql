-- Phase 3 — Triage write-back: resolution audit columns on needs_triage.
--
-- The desk gains exits in the other direction (discard / assign-materialize). A
-- resolved item leaves the queue via the existing `resolved` flag (set to 1);
-- these columns record HOW it left (the audit trail), never a hard-delete:
--   resolution = 'assigned'  → materialized through the gate into a real entry,
--                              assigned_ref points at what it became (e.g. "doc:slug@2").
--   resolution = 'discarded' → dismissed as not worth placing.
-- Reject (doc_versions.status / adrs.status += 'rejected') is a soft status flip
-- documented in 0009; it needs no schema change here.
ALTER TABLE needs_triage ADD COLUMN resolved_at  TEXT;  -- ISO8601 when it was resolved
ALTER TABLE needs_triage ADD COLUMN resolved_by  TEXT;  -- the authenticated principal who resolved it
ALTER TABLE needs_triage ADD COLUMN resolution   TEXT;  -- assigned | discarded
ALTER TABLE needs_triage ADD COLUMN assigned_ref TEXT;  -- what an assigned item materialized into
