import { applyD1Migrations, env } from "cloudflare:test";

// Runs once per test worker before the suite. applyD1Migrations is idempotent.
// With isolated per-test storage, the seeded schema is visible to every test
// while each test's own writes roll back.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
