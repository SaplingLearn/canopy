-- Phase 1 — Read-side brain: FTS5 search index.
--
-- Standalone (NOT external-content) FTS5 virtual tables mirroring the searchable
-- text of docs / feed / adrs. Standalone was chosen deliberately:
--   * it sidesteps the TEXT-slug-vs-INTEGER-rowid mismatch on `docs` (an
--     external-content table keys on rowid; docs has a TEXT primary key), and
--   * it keeps the test harness's per-test truncation working — the AFTER DELETE
--     triggers below cascade `DELETE FROM <base>` into the matching `*_fts` table,
--     so truncating the base tables (test/apply-migrations.ts) leaves no leaked
--     FTS rows. (No need to add the *_fts tables to that truncation statement.)
--
-- D1 EXPORT CAVEAT: `wrangler d1 export` cannot dump a database that contains
-- virtual tables. The documented workaround is: DROP the three *_fts tables,
-- run the export, then recreate them (re-applying this migration / its backfill).

CREATE VIRTUAL TABLE docs_fts USING fts5(
  slug UNINDEXED, title, section UNINDEXED, body, tokenize = 'porter unicode61');

CREATE VIRTUAL TABLE feed_fts USING fts5(
  feed_id UNINDEXED, summary, body, tokenize = 'porter unicode61');

CREATE VIRTUAL TABLE adrs_fts USING fts5(
  adr_id UNINDEXED, title, context, decision, rationale, tokenize = 'porter unicode61');

-- ── docs triggers ────────────────────────────────────────────────────────────
-- Re-index by delete-then-insert keyed on slug. The body-update trigger is what
-- makes a doc newly searchable on PROMOTE (promote_doc UPDATEs docs.body), since
-- a freshly-proposed doc is INSERTed with an empty live body.
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
-- feed.id is INTEGER; FTS5 columns have no affinity, so store/compare the key as
-- TEXT consistently (CAST both sides) to keep the keyed delete reliable.
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
