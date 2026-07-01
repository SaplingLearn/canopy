-- Repair — recreate the FTS5 search index (idempotent, self-healing).
--
-- WHY: the `query` MCP tool was failing in production with
--   D1_ERROR: no such table: docs_fts: SQLITE_ERROR
-- The `docs_fts` / `feed_fts` / `adrs_fts` virtual tables were created in 0008
-- but are absent from the live database. The most likely cause is the export
-- caveat documented in 0008: `wrangler d1 export` cannot dump a database that
-- contains virtual tables, and the documented workaround is to DROP the three
-- *_fts tables, run the export, then recreate them — the recreate step was
-- evidently missed, and the tables were never restored.
--
-- Re-running `wrangler d1 migrations apply` does NOT fix this: the migration
-- tracker still records 0008 as applied, so it is never re-executed. Hence this
-- new, self-contained migration that rebuilds the index from the base tables.
--
-- Idempotent by construction: it DROPs (IF EXISTS) any partial/dangling state —
-- including base-table triggers left pointing at a since-dropped *_fts table —
-- then recreates the tables, triggers, and backfill exactly as 0008 defined
-- them. Running it against a healthy database simply rebuilds the index from the
-- current base rows, which is a safe no-op in effect.

-- ── tear down any partial state (dropped tables leave these triggers dangling) ─
DROP TRIGGER IF EXISTS docs_fts_ai;
DROP TRIGGER IF EXISTS docs_fts_ad;
DROP TRIGGER IF EXISTS docs_fts_au;
DROP TRIGGER IF EXISTS feed_fts_ai;
DROP TRIGGER IF EXISTS feed_fts_ad;
DROP TRIGGER IF EXISTS adrs_fts_ai;
DROP TRIGGER IF EXISTS adrs_fts_ad;

DROP TABLE IF EXISTS docs_fts;
DROP TABLE IF EXISTS feed_fts;
DROP TABLE IF EXISTS adrs_fts;

-- ── recreate the standalone FTS5 tables (mirrors 0008) ───────────────────────
CREATE VIRTUAL TABLE docs_fts USING fts5(
  slug UNINDEXED, title, section UNINDEXED, body, tokenize = 'porter unicode61');

CREATE VIRTUAL TABLE feed_fts USING fts5(
  feed_id UNINDEXED, summary, body, tokenize = 'porter unicode61');

CREATE VIRTUAL TABLE adrs_fts USING fts5(
  adr_id UNINDEXED, title, context, decision, rationale, tokenize = 'porter unicode61');

-- ── docs triggers ────────────────────────────────────────────────────────────
CREATE TRIGGER docs_fts_ai AFTER INSERT ON docs BEGIN
  DELETE FROM docs_fts WHERE slug = new.slug;
  INSERT INTO docs_fts (slug, title, section, body)
    VALUES (new.slug, new.title, new.section, new.body);
END;

CREATE TRIGGER docs_fts_ad AFTER DELETE ON docs BEGIN
  DELETE FROM docs_fts WHERE slug = old.slug;
END;

CREATE TRIGGER docs_fts_au AFTER UPDATE OF title, section, body ON docs BEGIN
  DELETE FROM docs_fts WHERE slug = new.slug;
  INSERT INTO docs_fts (slug, title, section, body)
    VALUES (new.slug, new.title, new.section, new.body);
END;

-- ── feed triggers (append-only) ──────────────────────────────────────────────
CREATE TRIGGER feed_fts_ai AFTER INSERT ON feed BEGIN
  INSERT INTO feed_fts (feed_id, summary, body)
    VALUES (CAST(new.id AS TEXT), new.summary, new.body);
END;

CREATE TRIGGER feed_fts_ad AFTER DELETE ON feed BEGIN
  DELETE FROM feed_fts WHERE feed_id = CAST(old.id AS TEXT);
END;

-- ── adrs triggers (status flips don't change searchable text) ────────────────
CREATE TRIGGER adrs_fts_ai AFTER INSERT ON adrs BEGIN
  INSERT INTO adrs_fts (adr_id, title, context, decision, rationale)
    VALUES (CAST(new.id AS TEXT), new.title, new.context, new.decision, new.rationale);
END;

CREATE TRIGGER adrs_fts_ad AFTER DELETE ON adrs BEGIN
  DELETE FROM adrs_fts WHERE adr_id = CAST(old.id AS TEXT);
END;

-- ── backfill existing rows ───────────────────────────────────────────────────
INSERT INTO docs_fts (slug, title, section, body)
  SELECT slug, title, section, body FROM docs;
INSERT INTO feed_fts (feed_id, summary, body)
  SELECT CAST(id AS TEXT), summary, body FROM feed;
INSERT INTO adrs_fts (adr_id, title, context, decision, rationale)
  SELECT CAST(id AS TEXT), title, context, decision, rationale FROM adrs;
