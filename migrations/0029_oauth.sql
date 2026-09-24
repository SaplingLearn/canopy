-- MCP OAuth (spec: docs/superpowers/specs/2026-09-24-mcp-oauth-design.md).
-- An OAuth-issued bearer token resolves to a person handle exactly like an
-- mcp_tokens row does; these tables are how that token is obtained. Every raw
-- secret is stored only as its SHA-256 hex hash. Grants are never deleted.

CREATE TABLE oauth_clients (
  client_id     TEXT PRIMARY KEY,
  client_name   TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE oauth_grants (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  person         TEXT NOT NULL REFERENCES persons(handle),
  client_id      TEXT NOT NULL,
  client_name    TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  last_used_at   TEXT,
  revoked_at     TEXT,
  revoked_reason TEXT
);
CREATE INDEX idx_oauth_grants_person ON oauth_grants(person);

CREATE TABLE oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL REFERENCES oauth_clients(client_id),
  person         TEXT NOT NULL REFERENCES persons(handle),
  grant_id       INTEGER NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource       TEXT,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  used_at        TEXT
);

CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id   INTEGER NOT NULL REFERENCES oauth_grants(id),
  kind       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  rotated_at TEXT
);
CREATE INDEX idx_oauth_tokens_grant ON oauth_tokens(grant_id);
