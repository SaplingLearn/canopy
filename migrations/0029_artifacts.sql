-- Artifacts (issue #52; spec: docs/superpowers/specs/2026-09-24-artifacts-implementation.md).
-- (0028 is handoffs_prompts — feat/handoffs-prompts-ui — so this is 0029.)
--
-- An artifact is a PAGE (slug, title, kind, status, visibility) with an append-only
-- list of VERSIONS. Text kinds (html / markdown / svg / mermaid) keep their content
-- in D1 (≤ 500 KB); binary kinds (image / pdf / file) keep theirs in R2 under
-- `artifacts/<sha256>` (≤ 10 MB) and store only the key here. Every CHECK below
-- mirrors a constant in shared/artifacts-core.ts — change the two together.
--
-- Authority: artifacts are authored writes in the promote class (like tickets):
-- `consume()` is never involved and nothing is staged. `ratified` is set by a
-- PERSON over a session-cookie route, never by an agent and never inferred.
--
-- PERSON COLUMNS HOLD HANDLES, as plain TEXT with no FK (historical rows survive a
-- person deletion): artifact_pages.author_id / ratified_by,
-- artifact_versions.created_by, artifact_links.created_by and
-- artifact_upload_tokens.principal. Every one is listed in HANDLE_COLUMNS
-- (src/auth/persons.ts) so a handle rename rewrites it.
--
-- A page with current_version = 0 is a binary page whose upload has not landed
-- (created by `mintUploadToken`); it does not exist to ANY reader.
--
-- D1 EXPORT CAVEAT (mirrors 0011_fts_recreate.sql / 0024_tickets.sql): `wrangler
-- d1 export` cannot dump a database with virtual tables, and the recreate step of
-- the workaround was missed once already. So the FTS layer is torn down first and
-- rebuilt from the base tables at the end — re-running that section is a no-op in
-- effect.

-- ── tear down any partial FTS state first ────────────────────────────────────
DROP TRIGGER IF EXISTS artifacts_fts_ad;
DROP TABLE IF EXISTS artifacts_fts;

-- ── the page ─────────────────────────────────────────────────────────────────
CREATE TABLE artifact_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 60),
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('html','markdown','svg','mermaid','image','pdf','file')),
  area TEXT NOT NULL CHECK (area IN ('auth','architecture','infra','api','ui','data')),
  repo TEXT NOT NULL DEFAULT '',                 -- "owner/repo" or ''
  author_id TEXT NOT NULL,                       -- a person handle
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','ratified')),
  visibility TEXT NOT NULL DEFAULT 'org' CHECK (visibility IN ('org','private')),
  current_version INTEGER NOT NULL DEFAULT 0 CHECK (current_version >= 0),
  ratified_version INTEGER,
  ratified_by TEXT,                              -- a person handle
  ratified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,                      -- created_at of the LATEST version: the library's sort key
  CHECK ((status = 'ratified') = (ratified_version IS NOT NULL AND ratified_by IS NOT NULL AND ratified_at IS NOT NULL)),
  CHECK (status = 'ratified' OR (ratified_version IS NULL AND ratified_by IS NULL AND ratified_at IS NULL))
);
CREATE INDEX idx_artifact_pages_updated ON artifact_pages(updated_at);
CREATE INDEX idx_artifact_pages_author ON artifact_pages(author_id);

-- ── versions: append-only ────────────────────────────────────────────────────
-- Exactly one of content (text kinds) / r2_key (binary kinds) is set.
CREATE TABLE artifact_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL REFERENCES artifact_pages(id),
  version_no INTEGER NOT NULL CHECK (version_no >= 1),
  summary TEXT NOT NULL DEFAULT '',
  content TEXT,
  r2_key TEXT,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 10485760),
  content_type TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  filename TEXT,
  created_by TEXT NOT NULL,                      -- a person handle
  created_at TEXT NOT NULL,
  CHECK ((content IS NULL) <> (r2_key IS NULL)),
  CHECK (content IS NULL OR size_bytes <= 512000),
  UNIQUE (page_id, version_no)
);

-- ── links: what a page points AT (tickets, sprints, GitHub PRs / issues) ─────
-- target_ref: ticket / sprint → the integer id as a string; pr / issue → "owner/repo#n".
CREATE TABLE artifact_links (
  page_id INTEGER NOT NULL REFERENCES artifact_pages(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('ticket','sprint','pr','issue')),
  target_ref TEXT NOT NULL,
  created_by TEXT NOT NULL,                      -- a person handle
  created_at TEXT NOT NULL,
  UNIQUE (page_id, target_type, target_ref)
);
CREATE INDEX idx_artifact_links_target ON artifact_links(target_type, target_ref);

-- ── single-use upload tokens for the binary PUT ──────────────────────────────
-- Only the token's SHA-256 is stored. The token is bound to everything the upload
-- will write, so the PUT body is the only thing the bearer supplies.
CREATE TABLE artifact_upload_tokens (
  token_hash TEXT PRIMARY KEY,
  principal TEXT NOT NULL,                       -- a person handle
  page_id INTEGER NOT NULL REFERENCES artifact_pages(id),
  kind TEXT NOT NULL CHECK (kind IN ('image','pdf','file')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 1 AND size_bytes <= 10485760),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  content_type TEXT NOT NULL,
  filename TEXT,
  summary TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

-- ── artifacts_fts: standalone FTS5, kept in sync by the repository ───────────
-- NOT triggers on insert/update: the body needs html/svg tag stripping, which SQL
-- cannot do. description = the latest version's summary. The one trigger cascades
-- a page DELETE so a truncation (scripts/seed/reset.mjs) leaves no leaked rows.
CREATE VIRTUAL TABLE artifacts_fts USING fts5(
  page_id UNINDEXED, title, description, body, tokenize = 'porter unicode61');

CREATE TRIGGER artifacts_fts_ad AFTER DELETE ON artifact_pages BEGIN
  DELETE FROM artifacts_fts WHERE page_id = CAST(old.id AS TEXT);
END;

-- ── backfill (a no-op on first apply; rebuilds the index on a re-run) ────────
-- Raw content (tags NOT stripped — only the repository can do that); the next
-- version write of each page replaces its row with the stripped text.
INSERT INTO artifacts_fts (page_id, title, description, body)
  SELECT CAST(p.id AS TEXT), p.title, COALESCE(v.summary, ''), COALESCE(v.content, '')
  FROM artifact_pages p
  LEFT JOIN artifact_versions v ON v.page_id = p.id AND v.version_no = p.current_version;
