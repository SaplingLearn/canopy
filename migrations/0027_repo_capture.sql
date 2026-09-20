-- Repo dashboard capture (docs/superpowers/plans/2026-09-20-repo-dashboard-capture.md).
-- Deliberately NOT the `events` table: that one drives My Work and raises an
-- identity task per login; this is high-volume repo telemetry, much of it by bots.

-- Append-only. One row per captured fact; typed columns so reads never parse JSON.
--   push   : ref=branch sha=after actor_login=pusher count=distinct commits title=head commit subject url=compare
--   pr     : number state=draft|review|merged|closed ref=head branch sha=head sha actor_login=author title url
--   review : number state=approved|changes_requested|commented|dismissed actor_login=reviewer url
--   deploy : number=deployment id env part='backend' sha state=<github status> name=<github environment> actor_login url=log
--   check  : number=check_run id sha ref=head branch name state=pending|<conclusion> env/part set for a frontend deploy url
--   run    : number=run id name=workflow ref sha state=<conclusion> actor_login url title=failing job · step count=attempt
CREATE TABLE repo_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  semantic_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('push','pr','review','deploy','check','run')),
  ref TEXT,
  sha TEXT,
  number INTEGER,
  env TEXT,
  part TEXT CHECK (part IS NULL OR part IN ('backend','frontend')),
  state TEXT,
  name TEXT,
  actor_login TEXT,
  title TEXT,
  url TEXT,
  count INTEGER,
  raw TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('webhook','backfill')),
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX idx_repo_events_kind_at ON repo_events(kind, occurred_at);
CREATE INDEX idx_repo_events_kind_number ON repo_events(kind, number, occurred_at);
CREATE INDEX idx_repo_events_kind_sha ON repo_events(kind, sha);
CREATE INDEX idx_repo_events_kind_ref ON repo_events(kind, ref, occurred_at);
CREATE INDEX idx_repo_events_deploys ON repo_events(kind, env, part, occurred_at);

-- One row per computed result (drift, branches): costly to compute, cheap to read.
CREATE TABLE repo_snapshots (
  kind TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  computed_at TEXT NOT NULL
);

-- Time series. env/part are '' (not NULL) when a metric has none, so the UNIQUE
-- key dedupes a redelivered status or a double-fired cron.
CREATE TABLE repo_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric TEXT NOT NULL,
  env TEXT NOT NULL DEFAULT '',
  part TEXT NOT NULL DEFAULT '',
  value REAL NOT NULL,
  at TEXT NOT NULL,
  UNIQUE (metric, env, part, at)
);
CREATE INDEX idx_repo_metrics_series ON repo_metrics(metric, env, part, at);
