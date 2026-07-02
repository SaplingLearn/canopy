-- Focus teardown (Task 16): the per-person "current focus" table (0007) is
-- torn down for good. The PAYLOAD arm was already removed from the gate
-- (Phase 1) and the dashboard/web never read it beyond a short-lived spike
-- (Phase 3) — nothing depends on it. The feed remains the history.
DROP TABLE focus;
