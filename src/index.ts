import { app } from "./routes";
import { handleMcp } from "./mcp";
import { handleGithubWebhook } from "./webhook";
import { resolveBearerPrincipal } from "./auth/principal";
import { recomputeAllProgress } from "./tools/progress";
import { ensureNotificationPolicySeeded } from "./notifications/policy";
import { DAILY_CRON, WEEKLY_CRON, handleNotificationCron } from "./notifications/cron";
import type { Env } from "./env";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Startup seeding (once per isolate): notification_policy gets a row for
    // any registry kind missing one. Never overwrites; never fails a request.
    await ensureNotificationPolicySeeded(env.DB).catch(() => undefined);
    const url = new URL(request.url);
    // Static assets are served by the assets binding before this handler runs.
    if (url.pathname === "/mcp") {
      // Bearer ONLY. On missing/invalid credentials: bare 401, NO WWW-Authenticate,
      // NO OAuth discovery/metadata — Claude Code must use the configured header.
      const principal = await resolveBearerPrincipal(request, env);
      if (!principal) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      return handleMcp(request, env, ctx, principal);
    }
    // Third auth class: GitHub webhook deliveries, HMAC-verified over the raw
    // body against GITHUB_WEBHOOK_SECRET. Never touches sessionGate.
    if (url.pathname === "/webhook/github" && request.method === "POST") {
      return handleGithubWebhook(request, env);
    }
    return app.fetch(request, env, ctx);
  },

  // Dispatched by cron expression (see wrangler.toml [triggers]):
  //  • the two notification triggers → the digest runner, gated in code by
  //    notification_settings (send_hour + timezone) at fire time;
  //  • everything else → the progress-cache backstop: recompute per-milestone
  //    progress from GitHub with the app-level service token — a computed direct
  //    writer (promote class), never on the render path.
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    await ensureNotificationPolicySeeded(env.DB).catch(() => undefined);
    if (controller.cron === DAILY_CRON || controller.cron === WEEKLY_CRON) {
      await handleNotificationCron(env, controller.cron, new Date(controller.scheduledTime));
      return;
    }
    if (!env.GITHUB_SERVICE_TOKEN || !env.GITHUB_REPO) return;
    await recomputeAllProgress(env.DB, { token: env.GITHUB_SERVICE_TOKEN, repo: env.GITHUB_REPO });
  },
} satisfies ExportedHandler<Env>;
