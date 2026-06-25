import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import type { Env } from "./env";
import type { Principal } from "./auth/principal";
import { get_doc, list_docs, get_feed, search_context } from "./tools/reads";
import { list_roadmap } from "./tools/roadmap";
import { getStoredToken } from "./auth/github";
import { ingestFeedEntry, ingestDocProposal, ingestMilestoneProposal } from "./consumer";

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

  server.tool("get_roadmap", "Read the roadmap: milestones in target-date order with live GitHub progress.", {}, async () =>
    runTool(async () => {
      const token = await getStoredToken(env.DB, principal.login, env.COOKIE_SECRET);
      return list_roadmap(env.DB, { token, repo: env.GITHUB_REPO });
    })
  );

  server.tool(
    "propose_milestone",
    "Propose a NEW roadmap milestone through the gate; staged for a human to promote into a live milestone. A 'done' status or low confidence routes to needs_triage.",
    {
      title: z.string(),
      target_date: z.string(),
      status: z.enum(["upcoming", "in_progress", "done"]),
      github_ref: z.union([z.number(), z.array(z.number())]).optional(),
      change_summary: z.string(),
      confidence: z.enum(["high", "low"]),
    },
    async (proposal) => runTool(() => ingestMilestoneProposal(env.DB, proposal, principal.login))
  );

  // createMcpHandler wraps @modelcontextprotocol/sdk over Streamable HTTP, stateless (no McpAgent/DO).
  const handler = createMcpHandler(server, { route: "/mcp" });
  return handler(request, env, ctx);
}
