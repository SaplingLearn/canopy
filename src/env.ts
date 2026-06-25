export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  COOKIE_SECRET: string;
  GITHUB_REPO?: string;   // "owner/repo" for live roadmap progress; absent → milestones without progress
}
