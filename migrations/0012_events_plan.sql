-- Phase 0 spine (roadmap/my-work rebuild): captured GitHub events, completed-PR
-- summaries, the per-milestone progress cache, the identity map, and the
-- admin-authored plan with non-destructive version snapshots.

-- The captured-event log My Work and the progress recompute read from.
-- semantic_key is the dedupe identity (e.g. 'gh:pr:42:merged'), NOT the delivery
-- GUID — manual redelivery gets a fresh GUID but the same semantic key.
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  semantic_key TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,            -- 'pr_merged' | 'pr_closed' | 'issue'
  ref_number INTEGER NOT NULL,         -- the PR/issue number (grouping key)
  subject_login TEXT NOT NULL,         -- whose work this is; trusted post-HMAC
  raw TEXT NOT NULL,                   -- JSON snapshot slice — the source of truth
  provenance TEXT NOT NULL,            -- 'webhook' | 'backfill'
  occurred_at TEXT,                    -- from the payload (ISO8601)
  recorded_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL            -- writer identity (the authenticated principal)
);
CREATE INDEX idx_events_subject ON events(event_type, subject_login, occurred_at);
CREATE INDEX idx_events_ref ON events(event_type, ref_number, occurred_at);

-- Worker-generated summary of ONE completed PR's own body. A derived projection,
-- regenerable from events.raw; never the source of truth. Issue events never land here.
CREATE TABLE pr_summaries (
  semantic_key TEXT PRIMARY KEY REFERENCES events(semantic_key),
  pr_number INTEGER NOT NULL,
  summary TEXT NOT NULL,               -- short markdown
  model TEXT,                          -- generator id, or 'excerpt' for the deterministic fallback
  created_at TEXT NOT NULL
);

-- Absolute closed/total per live milestone. Written by the webhook (event-derived)
-- and the scheduled recompute (backstop). Absolute values make ordering irrelevant.
CREATE TABLE milestone_progress (
  milestone_id INTEGER PRIMARY KEY REFERENCES milestones(id),
  closed INTEGER NOT NULL,
  total INTEGER NOT NULL,
  source TEXT NOT NULL,                -- 'event' | 'recompute'
  computed_at TEXT NOT NULL
);

-- Identity map (promotes src/people.ts). Admin-maintained; an unmapped subject's
-- events are captured but do not surface in any My Work until mapped.
CREATE TABLE people (
  login TEXT PRIMARY KEY,
  person TEXT NOT NULL
);
INSERT INTO people (login, person) VALUES
  ('AndresL230', 'Andres'),
  ('Jose-Gael-Cruz-Lopez', 'Jose'),
  ('lpcooper-arch', 'Luke'),
  ('Darkest-Teddy', 'Jack');

-- The admin-authored plan narrative (singleton row) + snapshot history.
-- Direct writes (promote class) but versioned non-destructively.
CREATE TABLE plan (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  narrative TEXT NOT NULL DEFAULT '',
  current_version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  updated_by TEXT
);
INSERT INTO plan (id, narrative, current_version) VALUES (1, '', 0);

CREATE TABLE plan_versions (
  version INTEGER PRIMARY KEY,
  narrative TEXT NOT NULL,
  milestones_json TEXT NOT NULL,       -- full milestones snapshot AFTER this write
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

-- Plan layer on milestones: a coarse phase label ("Now", "Weeks 3-4", …).
ALTER TABLE milestones ADD COLUMN phase TEXT;
