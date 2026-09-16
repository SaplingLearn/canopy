import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import type { Env } from "./env";
import type { Principal } from "./auth/principal";
import { isAdmin } from "./auth/principal";
import { get_doc, list_docs, get_feed, query, list_tickets, get_ticket, list_sprints, get_sprint } from "./tools/reads";
import { TicketSeg, TicketAssigneeFilter, TicketCategory } from "@shared/tickets";
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
      types: z.array(z.enum(["doc", "decision", "feed", "sprint", "ticket"])).optional(),
      section: z.string().optional(),
      space: z.enum(["technical", "product"]).optional(),
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
          principal.handle,
          ephemeralLedger()
        )
      )
  );

  server.tool(
    "propose_doc_update",
    "Propose a doc version through the reconciling gate. Out-of-vocab section or low confidence on a NEW slug routes to needs_triage; an unchanged body is dropped; otherwise staged non-destructively (current_version untouched) and classified new/edit/rewrite. Pass base_version (the current_version you read) so a stale edit is flagged, space ('technical' for engineering docs or 'product' for product docs; defaults 'technical') to place a new doc, and force to stage an identical body.",
    {
      slug: z.string(),
      section: z.string(),
      title: z.string().optional(),
      body: z.string(),
      change_summary: z.string(),
      confidence: z.enum(["high", "low"]),
      space: z.enum(["technical", "product"]).optional(),
      base_version: z.number().optional(),
      force: z.boolean().optional(),
    },
    async (proposal) => runTool(() => ingestDocProposal(env.DB, proposal, principal.handle, ephemeralLedger()))
  );

  server.tool(
    "get_roadmap",
    "Read the roadmap plan: admin narrative + sprints in target-date order with their progress (no live GitHub). Each sprint carries label, summary, phase, dates, due, status, active, urgency, lead and domain.",
    {},
    async () => runTool(() => get_plan(env.DB))
  );

  // ── Tickets + sprints: READ ONLY, for every principal ──────────────────────
  //
  // These four are the whole ticket/sprint MCP surface. There is deliberately NO
  // write counterpart: every ticket and sprint write is a human authored write
  // over a session-cookie route in the web app (§A Invariants — "MCP gets read
  // tools only"), so an agent can see what has been asked for and what is in a
  // sprint but can never file, assign, resolve or re-home any of it. They are
  // NOT admin-gated — every bearer principal gets all four.
  server.tool(
    "list_tickets",
    "Read-only: the org's ticket queue. Tickets are Canopy D1 rows the whole org files into — never GitHub issues (ADR-007); a ticket may LINK to GitHub or Figma work, it never is that work. Filter with seg ('open' = submitted + in_progress, the default / 'closed' = done + declined / 'all'), assignee ('anyone' default, 'me' = you, the bearer principal, 'unassigned') and category. Newest-updated first; each row carries its assignees, link/sub-ticket counts and sprint label. Ticket WRITES are human-only in the web UI — there is no MCP write path, and done/declined are set by a person, never inferred.",
    {
      seg: TicketSeg.optional(),
      assignee: TicketAssigneeFilter.optional(),
      category: TicketCategory.optional(),
    },
    // `me` is bound to the authenticated bearer principal, never a client
    // argument — the same rule the cookie route applies to its session.
    async (args) => runTool(() => list_tickets(env.DB, { ...args, me: principal.handle })),
  );

  server.tool(
    "get_ticket",
    "Read-only: one whole ticket by id — body, category, priority, status, requester, assignees, linked work, comments, the full status history, its parent and sub-tickets, and its sprint. A ticket is a Canopy D1 row, never a GitHub issue (ADR-007). Ticket WRITES are human-only in the web UI — there is no MCP write path.",
    { id: z.number() },
    async ({ id }) =>
      runTool(async () => {
        const ticket = await get_ticket(env.DB, id);
        if (!ticket) throw new Error(`no such ticket: ${id}`);
        return ticket;
      }),
  );

  server.tool(
    "list_sprints",
    "Read-only: every sprint in roadmap order. Sprints are the roadmap's containers — a sprint holds tickets, and its progress is ticket-inclusive (closed/total/pct = the sprint's tickets PLUS its cached GitHub issue counts; no live GitHub at read time). Each carries label, summary, phase, dates, due, status/active, urgency, lead, domain and members (the handles assigned to its tickets). Sprint WRITES are human-only in the web UI — there is no MCP write path (the admin plan write, update_plan, is the one exception and is admin-gated).",
    {},
    async () => runTool(() => list_sprints(env.DB)),
  );

  server.tool(
    "get_sprint",
    "Read-only: one sprint by id, with its tickets ordered roots-then-sub-tickets and its resources (the sprint's own links merged with its tickets', deduped by url), on top of everything list_sprints returns including the ticket-inclusive progress. Sprint WRITES are human-only in the web UI — there is no MCP write path; a sprint is completed by an admin, never inferred from tickets resolving.",
    { id: z.number() },
    async ({ id }) =>
      runTool(async () => {
        const sprint = await get_sprint(env.DB, id);
        if (!sprint) throw new Error(`no such sprint: ${id}`);
        return sprint;
      }),
  );

  server.tool(
    "get_my_work",
    "Your personal My Work projection from captured GitHub events (no live GitHub): previous-activity (your 5 most recent summarized merged/closed PRs) and to-do (your open assigned issues). Read-only.",
    {},
    async () => runTool(() => getMyWork(env.DB, principal.handle))
  );

  server.tool(
    "get_events",
    "Recent captured GitHub events (raw log behind My Work and roadmap progress). Filter by type/subject. Read-only.",
    { type: z.enum(["pr_merged", "pr_closed", "issue"]).optional(), subject: z.string().optional(), limit: z.number().optional() },
    async (args) => runTool(() => list_events(env.DB, args))
  );

  server.tool(
    "record_session",
    "Record a whole Claude Code session into Canopy in ONE reconciled batch: pass a full IngestPayload (session + feed_entries / doc_proposals / adr_drafts / needs_triage). Routes through the SAME gate as /ingest — drops no-ops, stages real deltas, classifies each doc change, and is replay-safe on session.id. The author is your authenticated bearer principal; session.author is advisory and ignored. Returns per-type outcome counts. Used by the record-session skill at session end; you only ever stage — humans confirm.",
    IngestPayload.shape,
    // Same reconciling path as the cookie /ingest route: forward the full payload to
    // consume() under the bearer principal already in scope. Re-parse with the contract
    // so defaults (empty arrays) are applied and the type is exactly IngestPayload —
    // the SDK already validated against IngestPayload.shape, so this never throws.
    async (payload) => runTool(() => consume(env.DB, IngestPayload.parse(payload), principal)),
  );

  // ADMIN-only: the plan write surface — non-admin principals don't even see the tool
  // (conditional registration means it's absent from tools/list and calling it by
  // name errors tool-not-found, since a fresh server is built per request with the
  // principal already in scope).
  if (isAdmin(env, principal.handle)) {
    server.tool(
      "update_plan",
      "ADMIN plan write: replace the roadmap narrative and create/update sprints (including status 'done') in one direct, non-destructively versioned write — same authored-write class as promote, NOT the ingestion gate. Sprints not listed are untouched. `label` is the sprint name and `due` its target date. Which tickets are IN a sprint is set from the Tickets UI, not here. Use via the update-plan skill.",
      {
        narrative: z.string(),
        sprints: z.array(z.object({
          id: z.number().int().optional(),
          label: z.string(),
          summary: z.string().nullable().optional(),
          description: z.string().nullable().optional(),
          phase: z.string().nullable().optional(),
          dates: z.string().nullable().optional(),
          due: z.string(),
          status: z.enum(["upcoming", "in_progress", "done"]),
          urgency: z.enum(["low", "normal", "high"]).optional(),
          lead: z.string().nullable().optional(),
          domain: z.enum(["notifications", "tickets", "gate", "feed", "search", "infra"]).nullable().optional(),
          github_ref: z.union([z.number(), z.array(z.number())]).nullable().optional(),
        })).default([]),
      },
      async (input) => runTool(() => write_plan(env.DB, input as PlanWrite, principal.handle))
    );
  }

  return server;
}

export function handleMcp(request: Request, env: Env, ctx: ExecutionContext, principal: Principal): Promise<Response> {
  const server = buildCanopyMcpServer(env, principal);
  // createMcpHandler wraps @modelcontextprotocol/sdk over Streamable HTTP, stateless (no McpAgent/DO).
  const handler = createMcpHandler(server, { route: "/mcp" });
  return handler(request, env, ctx);
}
