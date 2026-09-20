import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { IngestPayload } from "@shared/contract";
import type { AppEnv } from "./auth/principal";
import { sessionGate, isAdmin } from "./auth/principal";
import { authApp } from "./auth/routes";
import { notificationsApp } from "./notifications/routes";
import { consume } from "./consumer";
import { runBackfill, isFinalBackfillBatch } from "./tools/backfill";
import { get_doc, list_docs, get_feed, query, list_needs_triage, list_adrs, list_proposals, list_identity_tasks, list_tickets, get_ticket, ticket_badge } from "./tools/reads";
import {
  create_ticket, transition_ticket, toggle_assignee, add_ticket_link,
  set_ticket_sprint, set_ticket_parent, add_ticket_comment,
  TicketError, TICKET_ERROR_STATUS,
} from "./tools/tickets";
import {
  TicketCreate, TicketTransition, TicketAssigneeToggle, TicketLinkAdd,
  TicketSprintSet, TicketParentSet, TicketCommentAdd, TicketSeg, TicketAssigneeFilter, TicketCategory,
} from "@shared/tickets";
import { promote_doc, ratify_adr, reject_doc_version, reject_adr, resolve_triage, assign_triage, map_identity, type AssignType } from "./tools/writes";
import {
  create_sprint, set_sprint_active, complete_sprint, add_sprint_resource, list_sprints, get_sprint,
  SprintError, SPRINT_ERROR_STATUS,
} from "./tools/sprints";
import { SprintCreate, SprintActiveSet, SprintResourceAdd } from "@shared/sprints";
import { get_plan } from "./tools/plan";
import { getMyWork } from "./tools/mywork";
import { getRepoDashboard, emptyRepoDashboard } from "./tools/repo";
import { reconcileRepo } from "./repo/github";
import { repoEnvironments } from "./repo/config";
import type { DashboardData } from "@shared/dashboard";
import { first } from "./db";
import { createInvite, revokeInvite, listInvites } from "./auth/invites";
import { listPersons } from "./auth/persons";
import { sendInvite } from "./notifications/invite";
import type { InviteRow } from "@shared/rows";

export const app = new Hono<AppEnv>();

// Gate first: everything except /auth/login and /auth/callback requires a session.
// Fails closed with 401 (no data in the body).
app.use("*", sessionGate);

// Auth endpoints (login/callback public via the gate's allowlist; logout/mcp-token gated).
app.route("/auth", authApp);

// Email notification prefs/policy/settings/outbox (session-gated; admin routes
// re-check isAdmin inside). The signed one-click unsubscribe POST is NOT here —
// it lives in src/index.ts, outside the gate, and can only turn email off.
app.route("/api/notifications", notificationsApp);

app.post("/ingest", async (c) => {
  const json = await c.req.json().catch(() => null);
  const parsed = IngestPayload.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  }
  // SEAM: a Cloudflare Queue producer.send({ payload, principal }) would slot in here.
  const result = await consume(c.env.DB, parsed.data, c.get("principal"));
  return c.json({ ok: true, result });
});

app.get("/docs", async (c) => {
  const docs = await list_docs(c.env.DB, c.req.query("section"));
  return c.json({ docs });
});

app.get("/doc/:slug", async (c) => {
  const found = await get_doc(c.env.DB, c.req.param("slug"));
  if (!found) return c.json({ error: "not found" }, 404);
  return c.json(found);
});

app.get("/feed", async (c) => {
  const tags = c.req.query("tags");
  const limit = c.req.query("limit");
  const feed = await get_feed(c.env.DB, {
    author: c.req.query("author"),
    tags: tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
    since: c.req.query("since"),
    limit: limit ? Number(limit) : undefined,
  });
  return c.json({ feed });
});

// Human Search backs onto the same query() engine as MCP, but include_staged is
// false — the human screen surfaces only settled (live) context, never staged.
app.get("/search", async (c) => {
  const typesCsv = c.req.query("types");
  const types = typesCsv
    ? (typesCsv.split(",").map((t) => t.trim()).filter((t): t is "doc" | "decision" | "feed" | "sprint" =>
        t === "doc" || t === "decision" || t === "feed" || t === "sprint"))
    : undefined;
  const spaceRaw = c.req.query("space");
  const space = spaceRaw === "technical" || spaceRaw === "product" ? spaceRaw : undefined;
  const limit = c.req.query("limit");
  const result = await query(c.env.DB, {
    q: c.req.query("q") ?? "",
    types: types && types.length ? types : undefined,
    section: c.req.query("section"),
    space,
    include_staged: false,
    limit: limit ? Number(limit) : undefined,
  });
  return c.json({ result });
});

// SEAM: POST /ask — retrieve via query(), synthesize a grounded, slug-citing answer. Out of scope.

app.get("/needs-triage", async (c) => c.json({ items: await list_needs_triage(c.env.DB) }));

app.get("/adrs", async (c) => c.json({ adrs: await list_adrs(c.env.DB, c.req.query("status")) }));

// ── Review group (session-cookie only, NEVER MCP): Proposals (staged doc
// versions) + Decisions (ADR drafts) — GET /proposals, GET /adrs, and their
// promote/ratify/reject resolves. Agent produces, human confirms. ──────────

// The Proposals queue (Phase 3): staged doc versions newer than their live doc,
// not rejected, server-joined with both bodies + reconciler metadata. Kills the
// old web N+1 (audit G9) and is the data source Phase 4's detail pane renders.
app.get("/proposals", async (c) => c.json({ proposals: await list_proposals(c.env.DB) }));

// Human confirmation (session-gated): promote a staged doc version into the live doc.
app.post("/doc/:slug/promote", async (c) => {
  const body = await c.req.json().catch(() => null);
  const version = Number(body?.version);
  if (!Number.isInteger(version)) return c.json({ error: "version (integer) required" }, 400);
  try {
    const res = await promote_doc(c.env.DB, c.req.param("slug"), version, c.get("principal").handle);
    return c.json({ ok: true, ...res });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// Human write-back (session-gated): reject a staged doc version. Soft status flip
// to 'rejected' so it leaves the proposals queue; the row + body remain.
app.post("/doc/:slug/reject", async (c) => {
  const body = await c.req.json().catch(() => null);
  const version = Number(body?.version);
  if (!Number.isInteger(version)) return c.json({ error: "version (integer) required" }, 400);
  try {
    const res = await reject_doc_version(c.env.DB, c.req.param("slug"), version);
    return c.json({ ok: true, ...res });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// Human confirmation (session-gated): ratify an ADR draft.
app.post("/adr/:id/ratify", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
  try {
    const res = await ratify_adr(c.env.DB, id);
    return c.json({ ok: true, ...res });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// Human write-back (session-gated): reject an ADR draft. Soft flip to 'rejected'
// so it leaves the decisions queue; the row remains.
app.post("/adr/:id/reject", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
  try {
    const res = await reject_adr(c.env.DB, id);
    return c.json({ ok: true, ...res });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// Human write-back (session-gated): discard a triage item. Soft — sets the audit
// columns + resolved flag so it leaves the queue; never a hard-delete.
app.post("/needs-triage/:id/discard", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
  try {
    const res = await resolve_triage(c.env.DB, id, c.get("principal").handle, "discarded");
    return c.json({ ok: true, ...res });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// Human write-back (session-gated): assign-materialize a triage item. Re-runs the
// item's `raw` through the SAME gate for the chosen target type, then resolves it
// as 'assigned' with assigned_ref. The author is the authenticated principal.
app.post("/needs-triage/:id/assign", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as {
    type?: AssignType; section?: string; space?: "technical" | "product"; tags?: string[];
  } | null;
  try {
    const res = await assign_triage(c.env.DB, id, c.get("principal").handle, {
      type: body?.type,
      section: body?.section,
      space: body?.space,
      tags: body?.tags,
    });
    return c.json({ ok: true, ...res });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// ── Maintenance group (session-cookie only, NEVER MCP): Unplaced items
// (/needs-triage + assign/discard above) + Identity (below). ─────────────────

// Pending unknown-login identity tasks, each with a small LIVE activity sample
// pulled from `events` at read time — activity is never copied onto the task.
app.get("/identity-tasks", async (c) => c.json({ tasks: await list_identity_tasks(c.env.DB) }));

// Human placement (session-gated): link a login to an EXISTING person (by
// handle) as a github identity (a direct authored write, not a gate re-run),
// then a soft resolve of the task. My Work picks the mapping up at read time,
// so every already-captured event for this login surfaces with no backfill.
app.post("/identity-tasks/:login/map", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { person?: string } | null;
  const person = typeof body?.person === "string" ? body.person.trim() : "";
  if (!person) return c.json({ error: "person (non-empty string) required" }, 400);
  try {
    const res = await map_identity(c.env.DB, c.req.param("login"), person, c.get("principal").handle);
    return c.json({ ok: true, ...res });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// Person directory (session-gated): the avatar-chip source for every screen and the identity picker.
app.get("/persons", async (c) => c.json({ persons: await listPersons(c.env.DB) }));

// ── Maintenance › People: the invite list (admin, session-cookie only, NEVER MCP) ──
const InviteWrite = z.object({ email: z.string().trim().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "invalid email"), name: z.string().trim().max(120).optional() });
const adminGate = async (c: Context<AppEnv>, next: () => Promise<void>) =>
  isAdmin(c.env, c.get("principal").handle) ? next() : c.json({ error: "admin only" }, 403);
app.use("/invites", adminGate);
app.use("/invites/*", adminGate);
app.get("/invites", async (c) => c.json({ invites: await listInvites(c.env.DB) }));
app.post("/invites", async (c) => {
  const parsed = InviteWrite.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  let invite: InviteRow;
  try {
    invite = await createInvite(c.env.DB, { email: parsed.data.email, name: parsed.data.name ?? null, invitedBy: c.get("principal").handle });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "invite_exists" || msg === "already_a_person") return c.json({ error: msg }, 409);
    throw e;
  }
  const origin = c.env.PUBLIC_ORIGIN ?? new URL(c.req.url).origin;
  const email = await sendInvite(c.env, c.env.DB, { email: invite.email, inviteeName: invite.name, inviterHandle: c.get("principal").handle, origin });
  return c.json({ ok: true, invite: (await first<InviteRow>(c.env.DB, `SELECT * FROM invites WHERE email = ?`, invite.email))!, email });
});
app.post("/invites/:email/revoke", async (c) => {
  const ok = await revokeInvite(c.env.DB, decodeURIComponent(c.req.param("email")));
  return ok ? c.json({ ok: true }) : c.json({ error: "no such invite" }, 404);
});
app.post("/invites/:email/resend", async (c) => {
  const email = decodeURIComponent(c.req.param("email")).toLowerCase();
  const row = await first<InviteRow>(c.env.DB, `SELECT * FROM invites WHERE email = ?`, email);
  if (!row) return c.json({ error: "no such invite" }, 404);
  if (row.revoked_at || row.accepted_by) return c.json({ error: row.revoked_at ? "revoked" : "accepted" }, 409);
  const origin = c.env.PUBLIC_ORIGIN ?? new URL(c.req.url).origin;
  const result = await sendInvite(c.env, c.env.DB, { email: row.email, inviteeName: row.name, inviterHandle: c.get("principal").handle, origin });
  return c.json({ ok: true, email: result });
});

// Roadmap read (session-gated): admin narrative + sprints in target-date order,
// merged with cached progress from the plan store. No live GitHub, no per-user token.
app.get("/roadmap", async (c) => c.json(await get_plan(c.env.DB)));

// Personal dashboard (session-gated): the signed-in user's two-list My Work —
// previous activity (summarized merged/closed PRs) + open assigned issues,
// projected entirely from captured GitHub events. Stored nowhere; never 500s.
app.get("/me/dashboard", async (c) => {
  const login = c.get("principal").handle;
  try {
    const data: DashboardData = await getMyWork(c.env.DB, login);
    return c.json(data);
  } catch {
    // Absolute backstop: never 500. Anything unexpected (D1) → empty degraded payload.
    const empty: DashboardData = { person: null, previousActivity: [], todo: [], tickets: [], degraded: true };
    return c.json(empty);
  }
});

// The Repo dashboard — the same class of read as /me/dashboard: a D1-only
// projection over captured events, tickets and sprints (src/tools/repo.ts). No
// live GitHub; whatever Canopy has no capture path for is `not_connected`.
// Stored nowhere; never 500s.
app.get("/repo/dashboard", async (c) => {
  const repo = c.env.GITHUB_REPO ?? "";
  try {
    return c.json(await getRepoDashboard(c.env.DB, repo));
  } catch {
    return c.json(emptyRepoDashboard(repo, true));
  }
});

// ADMIN action (session-gated + admin-gated): server-side GitHub backfill.
// A computed/authored direct writer in the promote class — humans (admins)
// trigger it — but every captured event still funnels through the ingestEvent
// gate fn. Non-admins get 403; a missing service token/repo → 503 with the error.
app.post("/admin/backfill", async (c) => {
  const login = c.get("principal").handle;
  if (!isAdmin(c.env, login)) return c.json({ error: "admin only" }, 403);
  const res = await runBackfill(c.env, login);
  if (!res.ok) return c.json({ error: res.error }, 503);
  // Best-effort, and only on the FINAL batch of a Sync (web/src/main.ts
  // re-POSTs this route up to 10 times while the summary budget stays
  // exhausted): reconcileRepo redoes ~250 no-op statements on an
  // already-reconciled repo, so running it on every intermediate batch would
  // waste that work 9 times over for nothing. `repo` is present in the
  // response only when it actually ran.
  let repo: { written: number; unchanged: number } | undefined;
  if (isFinalBackfillBatch(res) && c.env.GITHUB_SERVICE_TOKEN && c.env.GITHUB_REPO) {
    repo = await reconcileRepo(c.env.DB, { token: c.env.GITHUB_SERVICE_TOKEN, repo: c.env.GITHUB_REPO }, repoEnvironments(c.env)).catch(() => undefined);
  }
  return c.json(repo ? { ...res, repo } : res);
});

// ── Tickets (session-cookie only, NEVER MCP): the one queue the whole org files
// into. Every route below is a DIRECT AUTHORED WRITE in the promote class — no
// consume(), no gate, no staged state, no proposals. The requester/actor/author
// is ALWAYS the authenticated principal; a client-supplied one is ignored. ────

/** Map a TicketError onto its status (404 unknown / 409 rule / 400 payload). */
const ticketFail = (c: Context<AppEnv>, e: unknown): Response => {
  if (e instanceof TicketError) return c.json({ error: e.message }, TICKET_ERROR_STATUS[e.code]);
  throw e; // not ours — a real 500
};

/** The id path param, or null when it is not an integer. */
const ticketId = (c: Context<AppEnv>): number | null => {
  const id = Number(c.req.param("id"));
  return Number.isInteger(id) ? id : null;
};

/** Every write answers with the freshly re-read detail DTO, so one round-trip repaints. */
const ticketDetailResponse = async (c: Context<AppEnv>, id: number): Promise<Response> => {
  const ticket = await get_ticket(c.env.DB, id);
  if (!ticket) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true, ticket });
};

app.post("/tickets", async (c) => {
  const parsed = TicketCreate.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  try {
    // The principal is the requester, full stop — parsed.data has no requester field.
    const id = await create_ticket(c.env.DB, parsed.data, c.get("principal").handle);
    return ticketDetailResponse(c, id);
  } catch (e) {
    return ticketFail(c, e);
  }
});

// The queue list. seg=open|closed|all (open = submitted + in_progress),
// assignee=anyone|me|unassigned (me = the principal), category = a vocab value
// ('all'/absent = every category). Sorted updated_at DESC.
app.get("/tickets", async (c) => {
  const segRaw = c.req.query("seg");
  const asgRaw = c.req.query("assignee");
  const catRaw = c.req.query("category");

  const seg = TicketSeg.safeParse(segRaw ?? "open");
  if (!seg.success) return c.json({ error: "invalid seg", issues: seg.error.issues }, 400);
  const assignee = TicketAssigneeFilter.safeParse(asgRaw ?? "anyone");
  if (!assignee.success) return c.json({ error: "invalid assignee", issues: assignee.error.issues }, 400);
  let category: TicketCategory | undefined;
  if (catRaw !== undefined && catRaw !== "" && catRaw !== "all") {
    const parsed = TicketCategory.safeParse(catRaw);
    if (!parsed.success) return c.json({ error: "invalid category", issues: parsed.error.issues }, 400);
    category = parsed.data;
  }

  const tickets = await list_tickets(c.env.DB, {
    seg: seg.data,
    assignee: assignee.data,
    category,
    me: c.get("principal").handle,
  });
  return c.json({ tickets });
});

// REGISTERED BEFORE /tickets/:id ON PURPOSE: Hono matches in registration order,
// so a later ':id' route would otherwise swallow the literal '/tickets/badge'.
app.get("/tickets/badge", async (c) => c.json({ count: await ticket_badge(c.env.DB) }));

app.get("/tickets/:id", async (c) => {
  const id = ticketId(c);
  if (id === null) return c.json({ error: "invalid id" }, 400);
  const ticket = await get_ticket(c.env.DB, id);
  if (!ticket) return c.json({ error: "not found" }, 404);
  return c.json(ticket);
});

// A status move. Legality is decided by the ONE shared transition table; an
// illegal move is a 409 and writes nothing at all (not even a history row).
app.post("/tickets/:id/status", async (c) => {
  const id = ticketId(c);
  if (id === null) return c.json({ error: "invalid id" }, 400);
  const parsed = TicketTransition.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  try {
    await transition_ticket(c.env.DB, id, parsed.data.to, c.get("principal").handle);
    return ticketDetailResponse(c, id);
  } catch (e) {
    return ticketFail(c, e);
  }
});

// Assignment is immediate and reversible, so it is a toggle with no confirm step.
app.post("/tickets/:id/assignees", async (c) => {
  const id = ticketId(c);
  if (id === null) return c.json({ error: "invalid id" }, 400);
  const parsed = TicketAssigneeToggle.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  try {
    await toggle_assignee(c.env.DB, id, parsed.data.login, parsed.data.on);
    return ticketDetailResponse(c, id);
  } catch (e) {
    return ticketFail(c, e);
  }
});

app.post("/tickets/:id/links", async (c) => {
  const id = ticketId(c);
  if (id === null) return c.json({ error: "invalid id" }, 400);
  const parsed = TicketLinkAdd.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  try {
    await add_ticket_link(c.env.DB, id, parsed.data.raw, c.get("principal").handle);
    return ticketDetailResponse(c, id);
  } catch (e) {
    return ticketFail(c, e);
  }
});

// sprint_id null = the backlog. An unknown sprint id is a 404, not a silent write.
app.post("/tickets/:id/sprint", async (c) => {
  const id = ticketId(c);
  if (id === null) return c.json({ error: "invalid id" }, 400);
  const parsed = TicketSprintSet.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  try {
    await set_ticket_sprint(c.env.DB, id, parsed.data.sprint_id);
    return ticketDetailResponse(c, id);
  } catch (e) {
    return ticketFail(c, e);
  }
});

// Nest child_id under :id. Tickets nest ONE level — the four rejections live in
// set_ticket_parent and come back as 409s with the database untouched.
app.post("/tickets/:id/parent", async (c) => {
  const id = ticketId(c);
  if (id === null) return c.json({ error: "invalid id" }, 400);
  const parsed = TicketParentSet.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  try {
    await set_ticket_parent(c.env.DB, id, parsed.data.child_id);
    return ticketDetailResponse(c, id);
  } catch (e) {
    return ticketFail(c, e);
  }
});

app.post("/tickets/:id/comment", async (c) => {
  const id = ticketId(c);
  if (id === null) return c.json({ error: "invalid id" }, 400);
  const parsed = TicketCommentAdd.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  try {
    await add_ticket_comment(c.env.DB, id, parsed.data.body, c.get("principal").handle);
    return ticketDetailResponse(c, id);
  } catch (e) {
    return ticketFail(c, e);
  }
});

// ── Sprints (session-cookie only, NEVER MCP): the Roadmap's containers. Direct
// authored writes in the promote class — no consume(), no gate, no staging. A
// sprint's TICKETS are set from the Tickets UI (POST /tickets/:id/sprint); its
// own fields come from here or from the admin plan write. ─────────────────────

/** Map a SprintError onto its status (404 unknown / 409 rule / 400 payload). */
const sprintFail = (c: Context<AppEnv>, e: unknown): Response => {
  if (e instanceof SprintError) return c.json({ error: e.message }, SPRINT_ERROR_STATUS[e.code]);
  throw e; // not ours — a real 500
};

/** The id path param, or null when it is not an integer. */
const sprintId = (c: Context<AppEnv>): number | null => {
  const id = Number(c.req.param("id"));
  return Number.isInteger(id) ? id : null;
};

// Created from the Roadmap's New sprint panel: always inactive ('upcoming') and,
// without a `due`, unscheduled. The creator is the authenticated principal.
app.post("/sprints", async (c) => {
  const parsed = SprintCreate.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  const sprint = await create_sprint(c.env.DB, parsed.data, c.get("principal").handle);
  return c.json({ ok: true, sprint });
});

// The roadmap's sprint list: each with its tickets-only progress, the separate
// cached GitHub issue counts, and members.
// Registered before /sprints/:id (Hono matches in registration order).
app.get("/sprints", async (c) => c.json({ sprints: await list_sprints(c.env.DB) }));

app.get("/sprints/:id", async (c) => {
  const id = sprintId(c);
  if (id === null) return c.json({ error: "invalid id" }, 400);
  const sprint = await get_sprint(c.env.DB, id);
  if (!sprint) return c.json({ error: "not found" }, 404);
  return c.json(sprint);
});

// The In Progress ↔ Upcoming toggle. `active` is derived from status, so this
// writes status; clearing active on a DONE sprint is a no-op (see set_sprint_active).
app.post("/sprints/:id/active", async (c) => {
  const id = sprintId(c);
  if (id === null) return c.json({ error: "invalid id" }, 400);
  const parsed = SprintActiveSet.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  try {
    const sprint = await set_sprint_active(c.env.DB, id, parsed.data.active);
    return c.json({ ok: true, sprint });
  } catch (e) {
    return sprintFail(c, e);
  }
});

// A resource on the sprint itself, parsed by the SHARED link parser (`#214`
// resolves the same way it does on a ticket). Answers with the full detail so
// one round-trip repaints the Resources list.
app.post("/sprints/:id/resources", async (c) => {
  const id = sprintId(c);
  if (id === null) return c.json({ error: "invalid id" }, 400);
  const parsed = SprintResourceAdd.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  try {
    const sprint = await add_sprint_resource(c.env.DB, id, parsed.data.raw);
    return c.json({ ok: true, sprint });
  } catch (e) {
    return sprintFail(c, e);
  }
});

// Human confirmation (session-gated): flip a live sprint to 'done'. Admin action
// in the promote class — 'done' is never inferred from issues or tickets closing.
app.post("/sprints/:id/complete", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
  try {
    const sprint = await complete_sprint(c.env.DB, id);
    return c.json({ ok: true, sprint });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});
