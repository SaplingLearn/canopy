-- Retire the legacy prose `summary` column on pr_summaries. PR activity cards
-- are structured-only now (title/what/why/impact); the "Summary" prose row is
-- the ISSUE surface, never the PR surface. A PR whose AI summary fell back to
-- the excerpt (model='excerpt') carries NO content — it renders a "No summary
-- recorded" placeholder and is retried by Sync. issue_summaries.summary is
-- unaffected (issues keep their summary).
ALTER TABLE pr_summaries DROP COLUMN summary;
