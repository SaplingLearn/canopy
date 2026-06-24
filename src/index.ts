// Interim stub so the Workers test pool can resolve `main` in wrangler.toml.
// Replaced with the real routing (Hono + MCP) in Task 10.
export default {
  async fetch(): Promise<Response> {
    return new Response("sapling-context: not wired yet", { status: 200 });
  },
};
