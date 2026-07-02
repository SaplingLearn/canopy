-- Per-user GitHub token retirement (Task 17). Nothing on the render path reads
-- GitHub anymore (Phase 3 deleted every getStoredToken call); the only
-- remaining GitHub read is the scheduled recompute using the service token
-- (env.GITHUB_SERVICE_TOKEN — Task 5). The sealed per-user token is dead
-- weight (spec decision 10).
ALTER TABLE users DROP COLUMN github_token;
