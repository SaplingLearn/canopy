export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GOOGLE_CLIENT_ID?: string;     // Google OAuth client (second session-class provider); absent → /auth/google/login 503s
  GOOGLE_CLIENT_SECRET?: string; // Google OAuth client secret
  COOKIE_SECRET: string;
  GITHUB_WEBHOOK_SECRET?: string; // HMAC key for the /webhook/github third auth class; absent → the surface 401s
  GITHUB_REPO?: string;   // "owner/repo" for live roadmap progress; absent → sprints without progress
  DEV_LOGIN?: string;     // LOCAL DEV ONLY (set in .dev.vars): bypass OAuth, act as this seeded user. Never set in prod.
  GEMINI_API_KEY?: string; // Google Gemini key for capture-time PR/issue summaries (REST generateContent); absent → excerpt fallback.
  GITHUB_SERVICE_TOKEN?: string; // app-level token for the scheduled progress-cache recompute backstop; absent → scheduled() no-ops
  ADMIN_LOGINS?: string;  // comma-separated GitHub logins allowed to run admin actions (e.g. the server-side backfill)
  PUBLIC_ORIGIN?: string; // absolute origin for links in email (deep links, unsubscribe); absent → relative links
  NOTIFICATIONS_MODE?: "local" | "resend"; // delivery gate; absent → local (bodies to the dev table, Resend never called)
  RESEND_API_KEY?: string; // Resend API key; required only when NOTIFICATIONS_MODE = "resend"
}
