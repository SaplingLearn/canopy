export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  COOKIE_SECRET: string;
  GITHUB_REPO?: string;   // "owner/repo" for live roadmap progress; absent → milestones without progress
  DEV_LOGIN?: string;     // LOCAL DEV ONLY (set in .dev.vars): bypass OAuth, act as this seeded user. Never set in prod.
}
