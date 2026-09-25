-- Doc images (spec: docs/superpowers/specs/2026-09-24-doc-images-design.md).
-- An image a doc embeds as `![alt](/img/<sha256>)`. Content-addressed and immutable:
-- the bytes live in R2 (ARTIFACTS_BUCKET) at `doc-images/<sha256>`, one row per
-- distinct image, never updated or deleted — so a promoted doc version renders the
-- same forever, and uploading the same image twice is a no-op. Agents upload through
-- MCP `upload_asset` with destination "doc"; the doc gate refuses a body that
-- references an image with no row here.
CREATE TABLE doc_images (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/gif','image/webp')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 1 AND size_bytes <= 10485760),
  uploaded_by TEXT NOT NULL,                     -- a person handle
  created_at TEXT NOT NULL
);

-- Single-use, 5-minute upload tokens for doc images: the artifact tokens' twin,
-- bound to principal + sha256 + size + type instead of a page (artifact tokens
-- REQUIRE a page, and SQLite cannot relax that column without rebuilding the table).
-- The PUT is the SAME route as artifacts (/api/artifacts/upload/<token>); the handler
-- looks here first. Only the token's SHA-256 is stored.
CREATE TABLE doc_image_upload_tokens (
  token_hash TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 1 AND size_bytes <= 10485760),
  content_type TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
