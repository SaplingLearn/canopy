export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  COOKIE_SECRET: string;
  GITHUB_WEBHOOK_SECRET?: string; // HMAC key for the /webhook/github third auth class; absent → the surface 401s
  GITHUB_REPO?: string;   // "owner/repo" for live roadmap progress; absent → milestones without progress
  DEV_LOGIN?: string;     // LOCAL DEV ONLY (set in .dev.vars): bypass OAuth, act as this seeded user. Never set in prod.
  AI?: Ai;                // Workers AI binding: capture-time completed-PR summaries only, never at render.
  GITHUB_SERVICE_TOKEN?: string; // app-level token for the scheduled progress-cache recompute backstop; absent → scheduled() no-ops
  ADMIN_LOGINS?: string;  // comma-separated GitHub logins allowed to run admin actions (e.g. the server-side backfill)
}
