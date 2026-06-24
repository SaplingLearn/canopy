import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import type { Env } from "./env";
import { get_doc, list_docs, get_feed, search_context } from "./tools/reads";
import { append_feed, propose_doc_update } from "./tools/writes";

const asText = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

export function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  // Fresh McpServer per request — MCP SDK 1.26+ guards against reused instances,
  // so it must NOT be constructed in global scope.
  const server = new McpServer({ name: "sapling-context", version: "1.0.0" });

  server.tool("get_doc", "Get a doc and all its versions by slug.", { slug: z.string() }, async ({ slug }) =>
    asText(await get_doc(env.DB, slug))
  );

  server.tool("list_docs", "List docs, optionally filtered by section.", { section: z.string().optional() }, async ({ section }) =>
    asText(await list_docs(env.DB, section))
  );

  server.tool(
    "get_feed",
    "Read the feed with optional author/tags/since/limit filters.",
    { author: z.string().optional(), tags: z.array(z.string()).optional(), since: z.string().optional(), limit: z.number().optional() },
    async (args) => asText(await get_feed(env.DB, args))
  );

  server.tool(
    "search_context",
    "Text search across docs, feed, and ADRs.",
    { query: z.string(), section: z.string().optional(), limit: z.number().optional() },
    async ({ query, section, limit }) => asText(await search_context(env.DB, query, { section, limit }))
  );

  server.tool(
    "append_feed",
    "Append an entry to the append-only feed (working memory).",
    { author: z.string(), summary: z.string(), body: z.string().optional(), tags: z.array(z.string()).optional() },
    async ({ author, summary, body, tags }) => asText({ id: await append_feed(env.DB, { author, summary, body, tags }) })
  );

  server.tool(
    "propose_doc_update",
    "Stage a new doc version (non-destructive; current_version is untouched).",
    {
      slug: z.string(),
      section: z.string(),
      title: z.string().optional(),
      body: z.string(),
      change_summary: z.string(),
      confidence: z.enum(["high", "low"]),
      author: z.string(),
    },
    async ({ author, ...proposal }) => asText(await propose_doc_update(env.DB, proposal, author))
  );

  // createMcpHandler wraps @modelcontextprotocol/sdk over Streamable HTTP, stateless (no McpAgent/DO).
  const handler = createMcpHandler(server, { route: "/mcp" });
  return handler(request, env, ctx);
}
