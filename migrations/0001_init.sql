CREATE TABLE sections (name TEXT PRIMARY KEY, description TEXT);
CREATE TABLE tags (tag TEXT PRIMARY KEY, description TEXT);

CREATE TABLE docs (
  slug TEXT PRIMARY KEY,
  section TEXT NOT NULL REFERENCES sections(name),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  updated_by TEXT
);

CREATE TABLE doc_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL REFERENCES docs(slug),
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'staged',
  confidence TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

CREATE TABLE feed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author TEXT NOT NULL,
  summary TEXT NOT NULL,
  body TEXT,
  artifacts TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE adrs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  context TEXT, decision TEXT, rationale TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  confidence TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

CREATE TABLE entry_tags (
  tag TEXT NOT NULL REFERENCES tags(tag),
  entry_type TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  PRIMARY KEY (tag, entry_type, entry_id)
);

CREATE TABLE needs_triage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_author TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_doc_versions_slug ON doc_versions(slug);
CREATE INDEX idx_feed_created_at ON feed(created_at);
CREATE INDEX idx_entry_tags_lookup ON entry_tags(entry_type, entry_id);
