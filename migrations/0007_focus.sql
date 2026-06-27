-- Per-person "current focus" for the personal dashboard. One row per author
-- (upsert); the feed is the history, so no focus history is kept here.
CREATE TABLE focus (
  author      TEXT PRIMARY KEY,
  working_on  TEXT NOT NULL,
  next_up     TEXT,
  updated_at  TEXT NOT NULL
);
