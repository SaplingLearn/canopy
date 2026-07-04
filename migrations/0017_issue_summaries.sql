-- Worker-generated summary of ONE assigned issue's own body. A derived
-- projection, regenerable from events.raw; never the source of truth — same
-- posture as pr_summaries (0012). Keyed by issue_number, NOT semantic_key:
-- unlike a PR (merges/closes once), an issue's semantic_key changes on every
-- reassignment/edit, but only the CURRENT summary matters for the to-do list.
-- No FK to events — there is no stable 1:1 semantic_key to reference.
CREATE TABLE issue_summaries (
  issue_number INTEGER PRIMARY KEY,
  summary TEXT NOT NULL,
  model TEXT,                          -- generator id, or 'excerpt' for the deterministic fallback
  created_at TEXT NOT NULL
);
