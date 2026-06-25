-- Live, human-confirmed roadmap milestones. Coarse goals, not tickets.
-- No issue/progress state is stored here; progress is computed live from GitHub at read time.
CREATE TABLE milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  target_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'upcoming',   -- 'upcoming' | 'in_progress' | 'done'
  github_ref TEXT,                            -- JSON: a milestone number OR an array of issue numbers
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT
);

-- Agent-proposed milestone create/update, staged for human review (mirrors doc_versions → docs).
CREATE TABLE milestone_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  target_date TEXT NOT NULL,
  status TEXT NOT NULL,                        -- proposed status; the gate rejects 'done'
  github_ref TEXT,
  change_summary TEXT NOT NULL,
  confidence TEXT NOT NULL,
  staged_status TEXT NOT NULL DEFAULT 'staged', -- 'staged' | 'promoted'
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

CREATE INDEX idx_milestones_target_date ON milestones(target_date);

-- Retain the GitHub OAuth token (AES-GCM sealed under COOKIE_SECRET) for live roadmap progress.
ALTER TABLE users ADD COLUMN github_token TEXT;
