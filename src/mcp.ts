import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import type { Env } from "./env";
import type { Principal } from "./auth/principal";
import { isAdmin } from "./auth/principal";
import { get_doc, list_docs, get_feed, query, list_tickets, get_ticket, list_sprints, get_sprint } from "./tools/reads";
import {
  TicketSeg, TicketAssigneeFilter, TicketCategory,
  TicketCreate, TicketTransition, TicketCommentAdd, TicketLinkAdd, TicketSprintSet, TicketParentSet,
} from "@shared/tickets";
import { TicketError } from "./tools/tickets";
import {
  SprintError, create_sprint, set_sprint_active, complete_sprint, add_sprint_resource,
} from "./tools/sprints";
import { SprintCreate } from "@shared/sprints";
import {
  agentCreateTicket, agentTransitionTicket, agentAddTicketComment,
  agentAddTicketLink, agentSetTicketSprint, agentSetTicketParent,
} from "./tools/tickets-agent";
import { getMyWork, list_events } from "./tools/mywork";
import { getRepoDashboardForAgent } from "./tools/repo-agent";
import { repoEnvironments } from "./repo/config";
import { REPO_RANGES, REPO_TAB_SECTIONS, type RepoTab } from "@shared/repo";
import { ingestFeedEntry, ingestDocProposal, consume } from "./consumer";
import { feedEntryFromMcpArgs } from "./mcp-args";
import { IngestPayload } from "@shared/contract";
import { write_plan, get_plan, type PlanWrite } from "./tools/plan";
import {
  listHandoffs, getHandoff, createHandoff, claimHandoff, expireHandoff, handoffAsTask, HandoffCreateInput, HandoffError,
} from "./tools/handoffs";
import { listPrompts, getPrompt, savePrompt, PromptSaveInput, PromptError } from "./tools/prompts";
import { detectVars, fillVars, firstLine, type HandoffView } from "@shared/handoffs";

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
    const message = err instanceof Error ? err.message : String(err);
    // A TicketError's CODE is the actionable half for an agent, so it travels with
    // the message: `forbidden` means "outside your lane — a person has to do this",
    // `conflict` means "the shared rule says no" (an illegal move, a nesting break),
    // `bad_request` means "your input is wrong". The cookie routes map the same
    // codes onto HTTP statuses; this is the MCP spelling of it.
    const code = err instanceof TicketError || err instanceof SprintError || err instanceof HandoffError || err instanceof PromptError ? err.code : undefined;
    return {
      content: [{ type: "text" as const, text: JSON.stringify(code ? { error: message, code } : { error: message }) }],
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
      types: z.array(z.enum(["doc", "decision", "feed", "sprint"])).optional(),
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
    "Read the roadmap plan: admin narrative + sprints in target-date order with their progress — `progress` is the sprint's TICKETS (done + declined over total), `issues` the cached GitHub issue counts behind it (no live GitHub). Each sprint carries label, summary, phase, dates, due, status, active, urgency, lead and domain.",
    {},
    async () => runTool(() => get_plan(env.DB))
  );

  // ── Tickets + sprints: READS, for every principal ──────────────────────────
  //
  // Not admin-gated — every bearer principal gets all four. The write counterpart
  // below is scoped (see the note there); these reads are not, because seeing the
  // org's queue is how an agent orients before it does anything.
  server.tool(
    "list_tickets",
    "Read-only: the org's ticket queue. Tickets are Canopy D1 rows the whole org files into — never GitHub issues (ADR-007); a ticket may LINK to GitHub or Figma work, it never is that work. Filter with seg ('open' = submitted + in_progress, the default / 'closed' = done + declined / 'all'), assignee ('anyone' default, 'me' = you, the bearer principal, 'unassigned') and category. Newest-updated first; each row carries its assignees, link/sub-ticket counts and sprint label. Reading is unscoped: you see the whole org's queue. WRITING is scoped to your own lane — see create_ticket and transition_ticket.",
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
    "Read-only: one whole ticket by id — body, category, priority, status, requester, assignees, linked work, comments, the full status history, its parent and sub-tickets, and its sprint. A ticket is a Canopy D1 row, never a GitHub issue (ADR-007). Read this BEFORE any write: its `assignees` tell you whether the ticket is in your lane at all.",
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
    "Read-only: every sprint in roadmap order. Sprints are the roadmap's containers — a sprint holds tickets, and its `progress` is its TICKETS only (closed/total/pct, where closed = done + declined). The GitHub issues behind a sprint are a separate `issues` field, the cached closed/total from its github_ref (null when it has no cache row); no live GitHub at read time. Each carries label, summary, phase, dates, due, status/active, urgency, lead, domain and members (the handles assigned to its tickets). Sprint WRITES are ADMIN-ONLY over MCP (create_sprint / set_sprint_active / complete_sprint / add_sprint_resource, plus the bulk plan write update_plan); a non-admin principal does not see those tools at all.",
    {},
    async () => runTool(() => list_sprints(env.DB)),
  );

  server.tool(
    "get_sprint",
    "Read-only: one sprint by id, with its tickets ordered roots-then-sub-tickets and its resources (the sprint's own links merged with its tickets', deduped by url), on top of everything list_sprints returns including the tickets-only `progress` and the separate cached `issues` counts. Sprint WRITES are ADMIN-ONLY over MCP; a sprint is completed by a person (complete_sprint), never inferred from its tickets resolving.",
    { id: z.number() },
    async ({ id }) =>
      runTool(async () => {
        const sprint = await get_sprint(env.DB, id);
        if (!sprint) throw new Error(`no such sprint: ${id}`);
        return sprint;
      }),
  );

  // ── Tickets: WRITES, scoped to the bearer's own lane ───────────────────────
  //
  // Every tool below is a thin adapter over src/tools/tickets-agent.ts, which is
  // the ONE place the lane rule is drawn: a ticket write is permitted exactly when
  // the bearer principal is already an assignee of that ticket. Filing (create_ticket)
  // is the one unscoped write. The actor is ALWAYS `principal.handle` — there is no
  // client-supplied writer, exactly as with /ingest's advisory session.author.
  //
  // These are DIRECT AUTHORED WRITES in the promote class, the same class the cookie
  // routes write in: no consume(), no gate, no staging, no proposals. The bearer token
  // IS the person, so inside the lane the parity with the ticket screen is total —
  // `done` and `declined` included. Nothing here INFERS a resolution; a person, through
  // their own token, asks for it.
  //
  // There is deliberately NO toggle_assignee tool. Assignment is the data the lane rule
  // is built on, so an agent that could edit it could edit its own permissions: after a
  // ticket is filed, assigning and unassigning are web-only, forever.

  /** Every write returns the whole ticket, exactly like the cookie routes do. */
  const ticketDetail = async (id: number) => {
    const ticket = await get_ticket(env.DB, id);
    if (!ticket) throw new TicketError("not_found", `no such ticket: ${id}`);
    return ticket;
  };

  server.tool(
    "create_ticket",
    "File a ticket. THE ONE UNSCOPED WRITE — you may file freely; every other ticket write requires the ticket to be assigned to you already. The requester is YOU (the bearer principal); a client-supplied requester is ignored. `assignees` (person handles) is the ONLY place an agent can assign anyone — after filing, assignment is web-only, so there is no tool to add or remove an assignee later. Optional `link` takes a bare issue number ('#214'), a GitHub/Figma URL, or any URL. `sprint_id` omitted = the backlog. Returns the whole ticket. Confirm the exact fields with the person before calling — a ticket is org-visible the moment it exists.",
    TicketCreate.shape,
    async (input) => runTool(async () => ticketDetail(await agentCreateTicket(env.DB, TicketCreate.parse(input), principal.handle))),
  );

  server.tool(
    "transition_ticket",
    "Move a ticket's status. SCOPED: only on a ticket already assigned to you, else `forbidden` and nothing is written. Legal moves are the one shared table — submitted → in_progress | declined; in_progress → done | declined | submitted; done and declined are TERMINAL (an illegal move is `conflict`, and writes nothing, not even history). `done`/`declined` resolve the ticket for the whole org and cannot be undone, so confirm with the person first. Appends a ticket_events row attributed to you.",
    { id: z.number(), ...TicketTransition.shape },
    async ({ id, to }) => runTool(async () => {
      await agentTransitionTicket(env.DB, env, id, to, principal.handle);
      return ticketDetail(id);
    }),
  );

  server.tool(
    "add_ticket_comment",
    "Append a comment to a ticket. SCOPED: only on a ticket already assigned to you. Raw text — mentions are a rendering concern, not a write one. Bumps the ticket's updated_at (the queue's sort key), and is attributed to you with nothing marking it as agent-written, so say so in the text if the team wants that.",
    { id: z.number(), ...TicketCommentAdd.shape },
    async ({ id, body }) => runTool(async () => {
      await agentAddTicketComment(env.DB, env, id, body, principal.handle);
      return ticketDetail(id);
    }),
  );

  server.tool(
    "add_ticket_link",
    "Attach linked work to a ticket (GitHub issue/PR, Figma file, or any URL). SCOPED: only on a ticket already assigned to you. `raw` is parsed by the same parser the web UI uses: a bare '#214' or '214' resolves against the default repo, github.com and figma.com URLs are labelled by kind, anything else is a plain link. An unusable input is `bad_request`.",
    { id: z.number(), ...TicketLinkAdd.shape },
    async ({ id, raw }) => runTool(async () => {
      await agentAddTicketLink(env.DB, env, id, raw, principal.handle);
      return ticketDetail(id);
    }),
  );

  server.tool(
    "set_ticket_sprint",
    "Move a ticket into a sprint, or back to the backlog with sprint_id null. SCOPED to a ticket assigned to you — with ONE exception: an ADMIN may re-home any ticket, because composing a sprint is sprint management. This is the only ticket verb an admin may use outside their own lane; it moves the ticket and nothing else. An unknown sprint is `not_found`, and nothing is written.",
    { id: z.number(), ...TicketSprintSet.shape },
    async ({ id, sprint_id }) => runTool(async () => {
      await agentSetTicketSprint(env.DB, env, id, sprint_id, principal.handle);
      return ticketDetail(id);
    }),
  );

  server.tool(
    "set_ticket_parent",
    "Nest `child_id` under ticket `id`. SCOPED on BOTH tickets — the call re-homes the child and changes the parent's shape, so both must already be assigned to you. Tickets nest EXACTLY ONE level: it is a `conflict` (writing nothing) if the parent already has a parent, the child already has a parent, the child is done/declined, or the child has sub-tickets of its own.",
    { id: z.number(), ...TicketParentSet.shape },
    async ({ id, child_id }) => runTool(async () => {
      await agentSetTicketParent(env.DB, env, id, child_id, principal.handle);
      return ticketDetail(id);
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

  // ── The Repo dashboard: a READ, for every principal ────────────────────────
  //
  // Not admin-gated, like the ticket/sprint reads: it exposes nothing a signed-in
  // member cannot already see at #repo, and nothing per-user. It is the SAME
  // projection GET /repo/dashboard serves (getRepoDashboard — D1 only, nothing on
  // that path fetches), reshaped for an agent's context in tools/repo-agent.ts.
  // READ-ONLY: "Poll now" (POST /admin/poll; the older POST /admin/poll-usage) and Sync GitHub
  // (POST /admin/backfill) stay session-cookie + admin routes, NEVER MCP tools.
  server.tool(
    "get_repo_dashboard",
    "The Repo dashboard for the org's main repository: environments and deploys, CI, code activity, usage (requests, errors, hosting, active users), the app's product metrics, and planning — read from Canopy's own database, never live GitHub. Every section is `ok`, `empty` (connected, nothing to show) or `not_connected` (never captured): treat anything not `ok` as unknown, never as zero. The same holds INSIDE an `ok` section: a `null` figure (`usage[].requests` / `errorRate` / `users`, a `product` value, `contributors[].reviews`, `ciFailures.rate`, a `null` or empty delta, a `null` sha or checks) is unknown / not captured — never zero — and `usage[].seen` says whether that source has EVER reported (`null` + not seen = not connected; `null` + seen = no recent reading). Optional `tab` (overview | code | ci | usage | planning) returns only the sections that tab shows; `range` (24h | 7d | 30d, default 7d) picks the one view the usage / cloudflare / product sections return; `include_trends` (default false) adds the sparkline `trend` arrays and the full drift breakdown — without it `drift.groups` is the first 20 groups, each with a `commitCount` instead of its commits, and `drift.groupCount` is the full number; with `include_trends: true` every group is returned with its commits. Leave it off unless you need the series. Returns { repo, generatedAt, degraded, tab, range, sections }; `degraded: true` means a database read failed and the sections fell back. Read-only and safe to call freely.",
    {
      tab: z.enum(Object.keys(REPO_TAB_SECTIONS) as [RepoTab, ...RepoTab[]]).optional(),
      range: z.enum(REPO_RANGES).optional(),
      include_trends: z.boolean().optional(),
    },
    async ({ tab, range, include_trends }) =>
      runTool(() =>
        getRepoDashboardForAgent(env.DB, env.GITHUB_REPO ?? "", repoEnvironments(env), {
          tab, range, includeTrends: include_trends,
        })
      ),
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
  // ── Handoffs (0028): addressed messages between sessions ──────────────────
  //
  // Direct writers in src/tools/handoffs.ts, NOT the ingestion gate — a handoff is
  // not knowledge. The bearer principal is the sender / claimer, never an input.
  // `session` on send_handoff is the replay key (processed_items, item index 0),
  // so a retried call returns the first call's handoff instead of a second row.
  const handoffUrl = (id: number) => `${(env.PUBLIC_ORIGIN ?? "").replace(/\/+$/, "")}/#handoffs/${id}`;
  const handoffLine = (h: HandoffView) => ({
    id: h.id, sender: h.sender, recipient: h.recipient, status: h.status, created_at: h.created_at,
    task: h.context.task, excerpt: firstLine(h.body),
  });

  server.tool(
    "send_handoff",
    "Leave a handoff for the next session: where a task stands when you stop mid-way (context running out, switching person, ending the session). Send exactly ONE per session and tell the person its id as #N. `recipient` is a person handle, or omit it for 'anyone' (the first session to claim it gets it). Keep `body` under 300 words — its first line is the title, the rest says where things stand. ALWAYS fill `context` with the fixed shape { repo, branch, task, done[], next[], files[] }: repo from the git remote (owner/name), branch from HEAD, task as one line, done/next as short items, files from `git diff --name-only` against main. Long step-by-step instructions for the claiming session go in `prompt.body` (with a `prompt.title`), not in body. Pass your session id as `session` so a retry does not send twice. Returns { id, url }.",
    {
      body: z.string().min(1),
      recipient: z.string().optional(),
      context: z.object({
        repo: z.string().optional(), branch: z.string().optional(), task: z.string().optional(),
        done: z.array(z.string()).optional(), next: z.array(z.string()).optional(), files: z.array(z.string()).optional(),
      }).optional(),
      prompt: z.object({ title: z.string(), body: z.string() }).optional(),
      session: z.string().optional(),
    },
    async (args) => runTool(async () => {
      const input = HandoffCreateInput.parse({ body: args.body, recipient: args.recipient, context: args.context, prompt: args.prompt ?? null });
      const ledger = args.session ? { sessionId: args.session, itemIndex: 0 } : undefined;
      const { handoff, replayed } = await createHandoff(env.DB, principal.handle, input, ledger);
      return { id: handoff.id, url: handoffUrl(handoff.id), ...(replayed ? { replayed: true } : {}) };
    }),
  );

  server.tool(
    "list_handoffs",
    "List handoffs waiting for you. With no `box`, returns the PENDING ones left for you ('me') plus open 'anyone' handoffs from other people — call this at session start and tell the person what is waiting; never claim one without asking. box: 'me' (left for you), 'anyone' (open to all, from others), 'mine' (sent by or left for you), 'sent' (what you sent — the only box that includes claimed and expired ones). Returns id, sender, recipient, status, created_at, task and a one-line excerpt. Read-only.",
    { box: z.enum(["mine", "me", "anyone", "sent"]).optional() },
    async ({ box }) => runTool(async () => {
      if (box === "sent") return (await listHandoffs(env.DB, principal.handle, "sent")).map(handoffLine);
      if (box) return (await listHandoffs(env.DB, principal.handle, box, ["pending"])).map(handoffLine);
      const [me, anyone] = await Promise.all([
        listHandoffs(env.DB, principal.handle, "me", ["pending"]),
        listHandoffs(env.DB, principal.handle, "anyone", ["pending"]),
      ]);
      return [...me, ...anyone].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map(handoffLine);
    }),
  );

  server.tool(
    "get_handoff",
    "Read one handoff in full by its numeric id (body, context, inline prompt, status). Read-only: it does NOT claim it — use claim_handoff once the person has chosen to pick it up.",
    { id: z.number().int() },
    async ({ id }) => runTool(async () => {
      const h = await getHandoff(env.DB, id);
      if (!h) throw new HandoffError("not_found", "handoff not found");
      return h;
    }),
  );

  server.tool(
    "claim_handoff",
    "Claim a pending handoff for this session — only after the person chose it. Atomic: if another session already took it you get an error naming its current status (tell the person someone else has it). Pass your session id as `session`. On success returns ONE markdown block to act on: the handoff's prompt (if any), then '## Handoff summary', then '## Context' (repo, branch, task, done, next, files). Treat it as your task and confirm the current git branch matches the context before touching code.",
    { id: z.number().int(), session: z.string().min(1) },
    async ({ id, session }) => {
      try {
        const h = await claimHandoff(env.DB, id, principal.handle, session);
        return { content: [{ type: "text" as const, text: `# Handoff #${h.id} — claimed\n\n${handoffAsTask(h)}` }] };
      } catch (err) {
        if (err instanceof HandoffError) {
          const current = await getHandoff(env.DB, id);
          const body = { error: err.message, code: err.code, ...(current ? { status: current.status, claimed_by: current.claimed_by } : {}) };
          return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError: true as const };
        }
        return runTool(async () => { throw err; });
      }
    },
  );

  server.tool(
    "expire_handoff",
    "Expire a PENDING handoff you sent or that was left for you, so nobody picks it up (the work was finished another way, or it no longer applies). Pending handoffs also expire on their own 7 days after they were sent. A claimed or already-expired handoff is an error naming its status.",
    { id: z.number().int() },
    async ({ id }) => runTool(() => expireHandoff(env.DB, id, principal.handle)),
  );

  // ── Prompt Library (0028) ──────────────────────────────────────────────────
  server.tool(
    "search_prompts",
    "Search the team's Prompt Library for a reusable prompt. `q` is full-text over slug, title, description, body and tags; `tags` must ALL match. Returns summaries (slug, title, tags, author, version, status, updated_at, excerpt) — prefer 'published' ones; 'staged' and 'draft' are not settled yet. Use get_prompt to read one. Read-only.",
    { q: z.string().optional(), tags: z.array(z.string()).optional() },
    async ({ q, tags }) => runTool(() => listPrompts(env.DB, { q, tags })),
  );

  server.tool(
    "get_prompt",
    "Read a library prompt by slug, with its {{variables}} filled from `vars`. The response lists `variables` (every one the prompt uses) and `unfilled` (the ones still left as {{placeholders}}) — ASK the person for any unfilled value instead of guessing it. Read-only.",
    { slug: z.string(), vars: z.record(z.string(), z.string()).optional() },
    async ({ slug, vars }) => runTool(async () => {
      const p = await getPrompt(env.DB, slug);
      if (!p) throw new PromptError("not_found", "prompt not found");
      const variables = detectVars(p.body);
      const values = vars ?? {};
      return { ...p, body: fillVars(p.body, values), variables, unfilled: variables.filter((v) => !values[v]?.trim()) };
    }),
  );

  server.tool(
    "save_prompt",
    "Stage a prompt in the team's Prompt Library — a new slug creates v1, an existing slug appends the next version. ALWAYS lands as 'staged' (whatever you intend): a human must publish it in Canopy before it is settled, and you cannot rename a slug. Only save instructions you have had to write out twice; the slug is 2–60 chars of a-z, 0-9 and '-'. Write {{name}} for anything the caller fills in. Pass `branch` (your git branch) for the default version note. Returns { slug, version, status }.",
    {
      slug: z.string(), title: z.string(), body: z.string(),
      tags: z.array(z.string()).optional(), summary: z.string().optional(), branch: z.string().optional(),
    },
    async ({ slug, title, body, tags, summary, branch }) => runTool(async () => {
      const p = await savePrompt(env.DB, principal.handle, PromptSaveInput.parse({ slug, title, body, tags, summary }), "agent", { branch });
      return { slug: p.slug, version: p.version, status: p.status };
    }),
  );

  if (isAdmin(env, principal.handle)) {
    // ── Sprints: WRITES, admin-only ──────────────────────────────────────────
    //
    // Thin adapters over the same writers the Roadmap's cookie routes call —
    // direct promote-class writes, never the ingestion gate, nothing staged.
    //
    // ONE deliberate delta from the web: POST /sprints/:id/complete sits under the
    // blanket sessionGate with no adminGate, so any signed-in member can complete a
    // sprint from the UI — over MCP, complete_sprint is admin-only like its three
    // neighbours. The surfaces disagree on purpose: a person clicking Confirm done
    // has seen the sprint; an agent holding a token has not.
    //
    // Inputs speak the DTO vocabulary (`label` / `due` / `active`), never the column
    // names (`title` / `target_date` / `status`) — only src/tools/ speaks columns.

    server.tool(
      "create_sprint",
      "ADMIN: create a sprint. It lands INACTIVE and unscheduled — status 'upcoming', phase 'Unscheduled' unless you pass one, and no `due` stores an empty target date that reads back as due: null (those sort last on the Roadmap). `label` is the sprint name; `lead` is a person handle. Which TICKETS are in the sprint is not set here — that is set_ticket_sprint. Direct promote-class write, not staged.",
      SprintCreate.shape,
      async (input) => runTool(() => create_sprint(env.DB, SprintCreate.parse(input), principal.handle)),
    );

    server.tool(
      "set_sprint_active",
      "ADMIN: move a sprint between the Roadmap's In Progress and Upcoming groups. `active` is DERIVED from status, never stored: true → 'in_progress' (from ANY status, including 'done' — that is re-opening a sprint that turned out not to be finished); false → 'upcoming', EXCEPT on a done sprint where it is a NO-OP, because clearing 'active' must never un-finish a sprint.",
      { id: z.number(), active: z.boolean() },
      async ({ id, active }) => runTool(() => set_sprint_active(env.DB, id, active)),
    );

    server.tool(
      "complete_sprint",
      "ADMIN: flip a sprint to 'done'. A sprint is completed by a PERSON — 'done' is NEVER inferred from its tickets resolving or its GitHub issues closing, not by the cron, not by the webhook, not by this tool being available. Confirm with the admin before calling: it is how the Roadmap reports the sprint finished. Already-done is an error, not a silent no-op.",
      { id: z.number() },
      async ({ id }) => runTool(() => complete_sprint(env.DB, id)),
    );

    server.tool(
      "add_sprint_resource",
      "ADMIN: attach a resource link to the sprint itself (as opposed to one of its tickets). `raw` goes through the SAME parser as ticket links, so '#214' means the same thing wherever it is typed. Idempotent on url. The sprint's read model merges these with its tickets' links, deduped by url.",
      { id: z.number(), raw: z.string().min(1) },
      async ({ id, raw }) => runTool(() => add_sprint_resource(env.DB, id, raw)),
    );

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
