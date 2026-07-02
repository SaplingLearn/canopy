import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import type { Env } from "./env";
import type { Principal } from "./auth/principal";
import { get_doc, list_docs, get_feed, query } from "./tools/reads";
import { getMyWork, list_events } from "./tools/mywork";
import { ingestFeedEntry, ingestDocProposal, consume } from "./consumer";
import { feedEntryFromMcpArgs } from "./mcp-args";
import { IngestPayload } from "@shared/contract";
import { write_plan, get_plan, type PlanWrite } from "./tools/plan";

const asText = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

// Each MCP write tool is a one-item batch with an ephemeral session id, so it
// funnels through the SAME reconciling gate as /ingest — no second write path.
// A fresh uuid never collides in the replay ledger, so each call is reconciled
// on its own merits (vocab/confidence/content-hash dedupe still apply).
const ephemeralLedger = () => ({ sessionId: crypto.randomUUID(), itemIndex: 0 });

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

/**
 * Build a fully-registered Canopy MCP server for one principal. Exported so tests
 * can drive the REAL registered tools (e.g. over an in-memory transport) rather
 * than re-implementing the tool bodies — the same closures production runs.
 *
 * A fresh McpServer per request is required (SDK 1.26+ guards against reuse), so
 * this must NOT be hoisted to global scope.
 */
export function buildCanopyMcpServer(env: Env, principal: Principal): McpServer {
  const server = new McpServer({ name: "canopy", version: "1.0.0" });

  server.tool(
    "query",
    "Retrieve assembled context from the team brain (Canopy): whole authoritative bodies for the top hits plus ranked pointers to the rest. Each result is flagged live / staged_pending / unpromoted / draft — treat anything not 'live' as not-yet-settled. Use this to orient before working an existing area and ALWAYS before proposing a doc change. Read-only and safe to call freely.",
    {
      q: z.string().optional(),
      types: z.array(z.enum(["doc", "decision", "feed", "milestone"])).optional(),
      section: z.string().optional(),
      space: z.enum(["sapling", "canopy"]).optional(),
      include_staged: z.boolean().optional(),
      limit: z.number().optional(),
      pointer_limit: z.number().optional(),
    },
    // Agent default include_staged:true — the agent should see staged/unpromoted
    // context (flagged), unlike the human Search which defaults false.
    async (args) => runTool(() => query(env.DB, { ...args, q: args.q ?? "", include_staged: args.include_staged ?? true })),
  );

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
    "append_feed",
    "Append a feed entry through the vocabulary gate (an out-of-vocab tag routes the entry to needs_triage). Optional prs/commits/issues record the artifacts (PR urls, commit shas, GitHub issue numbers) this session observed.",
    {
      summary: z.string(),
      body: z.string().optional(),
      tags: z.array(z.string()).optional(),
      prs: z.array(z.string()).optional(),
      commits: z.array(z.string()).optional(),
      issues: z.array(z.number()).optional(),
    },
    async ({ summary, body, tags, prs, commits, issues }) =>
      // Thin adapter: feedEntryFromMcpArgs shapes the args into a FeedEntry
      // (carrying prs/commits/issues), then the gate decides write-vs-triage.
      runTool(() =>
        ingestFeedEntry(
          env.DB,
          feedEntryFromMcpArgs({ summary, body, tags, prs, commits, issues }),
          principal.login,
          ephemeralLedger()
        )
      )
  );

  server.tool(
    "propose_doc_update",
    "Propose a doc version through the reconciling gate. Out-of-vocab section or low confidence on a NEW slug routes to needs_triage; an unchanged body is dropped; otherwise staged non-destructively (current_version untouched) and classified new/edit/rewrite. Pass base_version (the current_version you read) so a stale edit is flagged, space to place a new doc, and force to stage an identical body.",
    {
      slug: z.string(),
      section: z.string(),
      title: z.string().optional(),
      body: z.string(),
      change_summary: z.string(),
      confidence: z.enum(["high", "low"]),
      space: z.enum(["sapling", "canopy"]).optional(),
      base_version: z.number().optional(),
      force: z.boolean().optional(),
    },
    async (proposal) => runTool(() => ingestDocProposal(env.DB, proposal, principal.login, ephemeralLedger()))
  );

  server.tool(
    "get_roadmap",
    "Read the roadmap plan: admin narrative + milestones in target-date order with cached progress (no live GitHub).",
    {},
    async () => runTool(() => get_plan(env.DB))
  );

  server.tool(
    "get_my_work",
    "Your personal My Work projection from captured GitHub events (no live GitHub): previous-activity (summarized merged/closed PRs, last 14 days) and to-do (your open assigned issues). Read-only.",
    {},
    async () => runTool(() => getMyWork(env.DB, principal.login))
  );

  server.tool(
    "get_events",
    "Recent captured GitHub events (raw log behind My Work and roadmap progress). Filter by type/subject. Read-only.",
    { type: z.enum(["pr_merged", "pr_closed", "issue"]).optional(), subject: z.string().optional(), limit: z.number().optional() },
    async (args) => runTool(() => list_events(env.DB, args))
  );

  server.tool(
    "record_session",
    "Record a whole Claude Code session into Canopy in ONE reconciled batch: pass a full IngestPayload (session + feed_entries / doc_proposals / adr_drafts / needs_triage / events). Routes through the SAME gate as /ingest — drops no-ops, stages real deltas, classifies each doc change, and is replay-safe on session.id. The author is your authenticated bearer principal; session.author is advisory and ignored. Returns per-type outcome counts. Used by the record-session skill at session end; you only ever stage — humans confirm.",
    IngestPayload.shape,
    // Same reconciling path as the cookie /ingest route: forward the full payload to
    // consume() under the bearer principal already in scope. Re-parse with the contract
    // so defaults (empty arrays) are applied and the type is exactly IngestPayload —
    // the SDK already validated against IngestPayload.shape, so this never throws.
    async (payload) => runTool(() => consume(env.DB, IngestPayload.parse(payload), principal)),
  );

  server.tool(
    "update_plan",
    "ADMIN plan write: replace the roadmap narrative and create/update milestones (including status 'done') in one direct, non-destructively versioned write — same authored-write class as promote, NOT the ingestion gate. Milestones not listed are untouched. Use via the update-plan skill.",
    {
      narrative: z.string(),
      milestones: z.array(z.object({
        id: z.number().int().optional(),
        title: z.string(),
        description: z.string().nullable().optional(),
        phase: z.string().nullable().optional(),
        target_date: z.string(),
        status: z.enum(["upcoming", "in_progress", "done"]),
        github_ref: z.union([z.number(), z.array(z.number())]).nullable().optional(),
      })).default([]),
    },
    async (input) => runTool(() => write_plan(env.DB, input as PlanWrite, principal.login))
  );

  return server;
}

export function handleMcp(request: Request, env: Env, ctx: ExecutionContext, principal: Principal): Promise<Response> {
  const server = buildCanopyMcpServer(env, principal);
  // createMcpHandler wraps @modelcontextprotocol/sdk over Streamable HTTP, stateless (no McpAgent/DO).
  const handler = createMcpHandler(server, { route: "/mcp" });
  return handler(request, env, ctx);
}
