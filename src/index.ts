import { app } from "./routes";
import { handleMcp } from "./mcp";
import { resolveBearerPrincipal } from "./auth/principal";
import type { Env } from "./env";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
