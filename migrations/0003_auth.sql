CREATE TABLE users (
  github_login TEXT PRIMARY KEY,
  name TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user TEXT NOT NULL REFERENCES users(github_login),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE mcp_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT NOT NULL REFERENCES users(github_login),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sessions_user ON sessions(user);
CREATE INDEX idx_mcp_tokens_user ON mcp_tokens(user);
