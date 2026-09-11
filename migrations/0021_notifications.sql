-- Email notifications (canopy-email.md §5). Four tables + two teammate columns.
-- The kind registry lives in code (shared/notifications.ts + src/notifications/
-- registry.ts); notification_policy is seeded from it at startup for any kind
-- missing a row and never overwritten (src/notifications/policy.ts).

-- Org-wide existence + default cadence per kind. Admin-authored.
-- enabled = 0 turns a kind off for everyone; the user layer is not consulted.
CREATE TABLE notification_policy (
  kind TEXT PRIMARY KEY,
  default_cadence TEXT NOT NULL CHECK (default_cadence IN ('daily','weekly','off')),
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

-- Single org-level row: when runs fire and who they come from.
CREATE TABLE notification_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  send_hour INTEGER NOT NULL DEFAULT 8,
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  from_address TEXT NOT NULL
);
-- Seed the singleton so the schedule has values from day one; admin edits
-- from_address in Maintenance before the first live send (§7: a dedicated
-- sending subdomain).
INSERT INTO notification_settings (id, send_hour, timezone, from_address)
  VALUES (1, 8, 'America/New_York', 'Canopy <canopy@canopy.saplinglearn.com>');

-- Sparse per-user overrides. Absence = inherit (policy, then registry default).
CREATE TABLE notification_prefs (
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  cadence TEXT NOT NULL CHECK (cadence IN ('daily','weekly','off')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, kind)
);

-- One row per (user, cadence, window): the idempotency ledger for runs. The
-- row is inserted BEFORE rendering; a conflict means the run already happened.
CREATE TABLE notification_outbox (
  idempotency_key TEXT PRIMARY KEY,        -- user:cadence:window_id
  user_id TEXT NOT NULL,
  cadence TEXT NOT NULL,
  window_id TEXT NOT NULL,
  kinds TEXT NOT NULL,                     -- JSON array of kind ids rendered
  status TEXT NOT NULL CHECK (status IN ('pending','sent','skipped','failed')),
  resend_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX idx_notification_outbox_created ON notification_outbox(created_at);

-- Teammate record: the address email goes to (GitHub's OAuth email is
-- unreliable — set by the user in Settings or admin in Maintenance) and the
-- hard unsubscribe gate above cadence resolution. Prefs survive unsubscribe.
ALTER TABLE users ADD COLUMN email TEXT;
ALTER TABLE users ADD COLUMN email_unsubscribed INTEGER NOT NULL DEFAULT 0;
