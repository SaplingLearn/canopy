/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from "@cloudflare/vitest-pool-workers";

// Augment Cloudflare.Env so that env.DB and env.TEST_MIGRATIONS are typed
// in cloudflare:test (env is typed as Cloudflare.Env in @cloudflare/vitest-pool-workers v0.16+)
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      ASSETS: Fetcher;
      TEST_MIGRATIONS: D1Migration[];
      COOKIE_SECRET: string;
      GITHUB_CLIENT_ID: string;
      GITHUB_CLIENT_SECRET: string;
    }
  }
}
