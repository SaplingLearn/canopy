-- Structured summary fields (spec 2026-07-06-structured-mywork-summaries).
-- All NULLable: NULL means a prose-era or excerpt-fallback row. `title IS NOT
-- NULL` doubles as the structured-generation marker the Sync skip-check reads
-- (a row is "done" only when model != 'excerpt' AND title IS NOT NULL).
-- `summary` stays NOT NULL as the prose mirror: `what` (PRs) / the structured
-- summary field (issues) on success, the deterministic excerpt on fallback.
ALTER TABLE pr_summaries ADD COLUMN title TEXT;
ALTER TABLE pr_summaries ADD COLUMN what TEXT;
ALTER TABLE pr_summaries ADD COLUMN why TEXT;
ALTER TABLE pr_summaries ADD COLUMN impact TEXT;
ALTER TABLE issue_summaries ADD COLUMN title TEXT;
ALTER TABLE issue_summaries ADD COLUMN next_step TEXT;
