-- Handoffs and the Prompt Library (Claude Design `Canopy.dc.html`, project 2c8cfa50).
--
-- A handoff is an ADDRESSED MESSAGE from one session to the next, not knowledge:
-- it never passes the ingestion gate (src/consumer.ts). Its writers are direct
-- (src/tools/handoffs.ts), replay-safe through processed_items when the caller
-- supplies a session id. A prompt is a versioned, reusable instruction: every
-- save appends a prompt_versions row and `current_version` points at the latest,
-- whose status and body ARE the prompt's.

-- ── tear down any partial FTS state first (see 0024's note on D1 export) ─────
DROP TRIGGER IF EXISTS prompts_fts_ai;
DROP TRIGGER IF EXISTS prompts_fts_au;
DROP TRIGGER IF EXISTS prompts_fts_ad;
DROP TRIGGER IF EXISTS prompts_fts_vai;
DROP TRIGGER IF EXISTS prompts_fts_vau;
DROP TABLE IF EXISTS prompts_fts;

-- ── handoffs ─────────────────────────────────────────────────────────────────
-- `recipient` is a person handle OR the literal 'anyone' (the first session to
-- claim it gets it), so neither handle column carries an FK. `context` is JSON
-- { repo, branch, task, done[], next[], files[] }. The prompt is inline and
-- belongs to this handoff only: both title and body, or neither.
CREATE TABLE handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','expired')),
  body TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '{"repo":"","branch":"","task":"","done":[],"next":[],"files":[]}',
  prompt_title TEXT,
  prompt_body TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  claimed_by TEXT,
  claimed_by_session TEXT,
  expires_at TEXT NOT NULL,
  CHECK ((prompt_title IS NULL) = (prompt_body IS NULL))
);
CREATE INDEX idx_handoffs_recipient ON handoffs(recipient, status);
CREATE INDEX idx_handoffs_sender ON handoffs(sender, created_at);

-- ── prompts ──────────────────────────────────────────────────────────────────
CREATE TABLE prompts (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',          -- JSON array, lowercased, deduped
  author TEXT NOT NULL,                     -- the creator
  current_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE prompt_versions (
  slug TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','staged','published')),
  author TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (slug, version)
);

-- ── prompts_fts: standalone FTS5 over the prompt AT ITS LATEST VERSION ───────
-- Standalone (like tickets_fts), one row per slug. The body lives on the version
-- row, so the index is rebuilt for a slug whenever the prompt row changes OR a
-- version row lands — the rebuild reads the join, so it is always the latest.
CREATE VIRTUAL TABLE prompts_fts USING fts5(
  slug, title, description, body, tags, tokenize = 'porter unicode61');

CREATE TRIGGER prompts_fts_ai AFTER INSERT ON prompts BEGIN
  DELETE FROM prompts_fts WHERE slug = new.slug;
  INSERT INTO prompts_fts (slug, title, description, body, tags)
    SELECT p.slug, p.title, p.description, COALESCE(v.body, ''), p.tags
    FROM prompts p LEFT JOIN prompt_versions v ON v.slug = p.slug AND v.version = p.current_version
    WHERE p.slug = new.slug;
END;

CREATE TRIGGER prompts_fts_au AFTER UPDATE ON prompts BEGIN
  DELETE FROM prompts_fts WHERE slug = old.slug;
  DELETE FROM prompts_fts WHERE slug = new.slug;
  INSERT INTO prompts_fts (slug, title, description, body, tags)
    SELECT p.slug, p.title, p.description, COALESCE(v.body, ''), p.tags
    FROM prompts p LEFT JOIN prompt_versions v ON v.slug = p.slug AND v.version = p.current_version
    WHERE p.slug = new.slug;
END;

CREATE TRIGGER prompts_fts_ad AFTER DELETE ON prompts BEGIN
  DELETE FROM prompts_fts WHERE slug = old.slug;
END;

CREATE TRIGGER prompts_fts_vai AFTER INSERT ON prompt_versions BEGIN
  DELETE FROM prompts_fts WHERE slug = new.slug;
  INSERT INTO prompts_fts (slug, title, description, body, tags)
    SELECT p.slug, p.title, p.description, COALESCE(v.body, ''), p.tags
    FROM prompts p LEFT JOIN prompt_versions v ON v.slug = p.slug AND v.version = p.current_version
    WHERE p.slug = new.slug;
END;

CREATE TRIGGER prompts_fts_vau AFTER UPDATE ON prompt_versions BEGIN
  DELETE FROM prompts_fts WHERE slug = new.slug;
  INSERT INTO prompts_fts (slug, title, description, body, tags)
    SELECT p.slug, p.title, p.description, COALESCE(v.body, ''), p.tags
    FROM prompts p LEFT JOIN prompt_versions v ON v.slug = p.slug AND v.version = p.current_version
    WHERE p.slug = new.slug;
END;

-- ── backfill (a no-op on a fresh table; safe on a re-run) ────────────────────
INSERT INTO prompts_fts (slug, title, description, body, tags)
  SELECT p.slug, p.title, p.description, COALESCE(v.body, ''), p.tags
  FROM prompts p LEFT JOIN prompt_versions v ON v.slug = p.slug AND v.version = p.current_version;
