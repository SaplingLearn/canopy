-- Person-centric identity (2026-09-14 design). A person is the root identity;
-- the GitHub login and Google subject are rows in `identities`. Replaces
-- `users` (one row per GitHub login) and `people` (login → display-name map).
-- Existing GitHub users keep their login as their handle, so every stored
-- recorded_by / created_by / user_id string keeps its meaning.

CREATE TABLE persons (
  handle TEXT PRIMARY KEY COLLATE NOCASE,
  name TEXT,
  color TEXT NOT NULL CHECK (color IN ('moss','fern','sky','slate','plum','rose','rust','ochre','clay','stone')),
  avatar_url TEXT,
  email TEXT,
  email_unsubscribed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  onboarded_at TEXT NOT NULL
);

CREATE TABLE identities (
  provider TEXT NOT NULL CHECK (provider IN ('github','google')),
  subject TEXT NOT NULL,                  -- github: the login; google: the stable `sub` claim
  label TEXT NOT NULL,                    -- github login / google email
  person TEXT NOT NULL REFERENCES persons(handle),
  linked_at TEXT NOT NULL,
  linked_by TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX idx_identities_person ON identities(person);

CREATE TABLE invites (
  email TEXT PRIMARY KEY,                 -- lowercased
  name TEXT,
  invited_by TEXT NOT NULL,
  invited_at TEXT NOT NULL,
  accepted_by TEXT,
  revoked_at TEXT,
  email_sent_at TEXT,
  email_id TEXT,
  email_error TEXT
);

-- Backfill persons from users. Color: a stable hash of the login over the ten tokens.
INSERT INTO persons (handle, name, color, avatar_url, email, email_unsubscribed, created_at, onboarded_at)
SELECT github_login, name,
  CASE (unicode(github_login) + length(github_login)) % 10
    WHEN 0 THEN 'moss' WHEN 1 THEN 'fern' WHEN 2 THEN 'sky' WHEN 3 THEN 'slate' WHEN 4 THEN 'plum'
    WHEN 5 THEN 'rose' WHEN 6 THEN 'rust' WHEN 7 THEN 'ochre' WHEN 8 THEN 'clay' ELSE 'stone' END,
  avatar_url, email, email_unsubscribed, created_at, created_at
FROM users;

INSERT INTO identities (provider, subject, label, person, linked_at, linked_by)
SELECT 'github', github_login, github_login, github_login, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'migration' FROM users;

-- people → identities: match the display-name column to a person by login first, then by name.
INSERT OR IGNORE INTO identities (provider, subject, label, person, linked_at, linked_by)
SELECT 'github', p.login, p.login, u.github_login, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'migration'
FROM people p JOIN users u ON u.github_login = p.person;
INSERT OR IGNORE INTO identities (provider, subject, label, person, linked_at, linked_by)
SELECT 'github', p.login, p.login, u.github_login, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'migration'
FROM people p JOIN users u ON u.name = p.person;
-- Anything left is not guessed: an admin maps it in Maintenance.
INSERT OR IGNORE INTO identity_tasks (login, first_seen, status)
SELECT p.login, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'pending'
FROM people p WHERE NOT EXISTS (SELECT 1 FROM identities i WHERE i.provider = 'github' AND i.subject = p.login);

-- Repoint sessions + mcp_tokens (D1 cannot rename an FK'd column: recreate).
CREATE TABLE sessions_new (
  id TEXT PRIMARY KEY,
  person TEXT NOT NULL REFERENCES persons(handle),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
INSERT INTO sessions_new (id, person, created_at, expires_at) SELECT id, user, created_at, expires_at FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
CREATE INDEX idx_sessions_person ON sessions(person);

CREATE TABLE mcp_tokens_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person TEXT NOT NULL REFERENCES persons(handle),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);
INSERT INTO mcp_tokens_new (id, person, token_hash, created_at, last_used_at, revoked) SELECT id, user, token_hash, created_at, last_used_at, revoked FROM mcp_tokens;
DROP TABLE mcp_tokens;
ALTER TABLE mcp_tokens_new RENAME TO mcp_tokens;
CREATE INDEX idx_mcp_tokens_person ON mcp_tokens(person);

-- The dev-only bodies store loses its FK so transactional mail (invites) can land there too.
CREATE TABLE notification_outbox_bodies_new (
  idempotency_key TEXT PRIMARY KEY,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO notification_outbox_bodies_new SELECT idempotency_key, to_address, subject, html, text, created_at FROM notification_outbox_bodies;
DROP TABLE notification_outbox_bodies;
ALTER TABLE notification_outbox_bodies_new RENAME TO notification_outbox_bodies;

DROP TABLE people;
DROP TABLE users;
