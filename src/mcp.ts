import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import type { Env } from "./env";
import type { Principal } from "./auth/principal";
import { get_doc, list_docs, get_feed, search_context } from "./tools/reads";
import { ingestFeedEntry, ingestDocProposal } from "./consumer";

const asText = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

async function runTool(fn: () => Promise<unknown>) {
  try {
    return asText(await fn());
  } catch (err) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
      isError: true as const,
    };
  }
}

export function handleMcp(request: Request, env: Env, ctx: ExecutionContext, principal: Principal): Promise<Response> {
  // Fresh McpServer per request — MCP SDK 1.26+ guards against reused instances,
  // so it must NOT be constructed in global scope.
  const server = new McpServer({ name: "canopy", version: "1.0.0" });

  server.tool("get_doc", "Get a doc and all its versions by slug.", { slug: z.string() }, async ({ slug }) =>
    runTool(() => get_doc(env.DB, slug))
  );

  server.tool("list_docs", "List docs, optionally filtered by section.", { section: z.string().optional() }, async ({ section }) =>
    runTool(() => list_docs(env.DB, section))
  );

  server.tool(
    "get_feed",
    "Read the feed with optional author/tags/since/limit filters.",
    { author: z.string().optional(), tags: z.array(z.string()).optional(), since: z.string().optional(), limit: z.number().optional() },
    async (args) => runTool(() => get_feed(env.DB, args))
  );

  server.tool(
    "search_context",
    "Text search across docs, feed, and ADRs.",
    { query: z.string(), section: z.string().optional(), limit: z.number().optional() },
    async ({ query, section, limit }) => runTool(() => search_context(env.DB, query, { section, limit }))
  );

  server.tool(
    "append_feed",
    "Append a feed entry through the vocabulary gate (an out-of-vocab tag routes the entry to needs_triage). Optional issues link GitHub issue numbers.",
    { summary: z.string(), body: z.string().optional(), tags: z.array(z.string()).optional(), issues: z.array(z.number()).optional() },
    async ({ summary, body, tags, issues }) =>
      // Thin adapter: shape the args into a FeedEntry and let the gate decide write-vs-triage.
      runTool(() =>
        ingestFeedEntry(
          env.DB,
          { summary, body: body ?? "", tags: tags ?? [], artifacts: { prs: [], commits: [], issues: issues ?? [] } },
          principal.login
        )
      )
  );

  server.tool(
    "propose_doc_update",
    "Propose a doc version through the gate (out-of-vocab section or low confidence routes to needs_triage; otherwise staged non-destructively — current_version is untouched).",
    {
      slug: z.string(),
      section: z.string(),
      title: z.string().optional(),
      body: z.string(),
      change_summary: z.string(),
      confidence: z.enum(["high", "low"]),
    },
    async (proposal) => runTool(() => ingestDocProposal(env.DB, proposal, principal.login))
  );

  // createMcpHandler wraps @modelcontextprotocol/sdk over Streamable HTTP, stateless (no McpAgent/DO).
  const handler = createMcpHandler(server, { route: "/mcp" });
  return handler(request, env, ctx);
}
