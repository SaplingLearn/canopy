import { app } from "./routes";
import { handleMcp } from "./mcp";
import type { Env } from "./env";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // Static assets are served by the assets binding before this handler runs.
    // Only non-asset requests reach here.
    if (url.pathname === "/mcp") {
      return handleMcp(request, env, ctx);
    }
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
