import { Hono } from "hono";
import { IngestPayload } from "@shared/contract";
import type { AppEnv } from "./auth/principal";
import { sessionGate } from "./auth/principal";
import { authApp } from "./auth/routes";
import { consume } from "./consumer";
import { get_doc, list_docs, get_feed, query, list_needs_triage, list_adrs, list_milestone_proposals, list_proposals } from "./tools/reads";
import { promote_doc, ratify_adr, promote_milestone_proposal, complete_milestone, reject_doc_version, reject_adr, resolve_triage, assign_triage, type AssignType } from "./tools/writes";
import { list_roadmap } from "./tools/roadmap";
import { getMyDashboard } from "./tools/dashboard";
import type { DashboardData } from "@shared/dashboard";
import { nowIso } from "./db";
import { getStoredToken } from "./auth/github";

export const app = new Hono<AppEnv>();

// Gate first: everything except /auth/login and /auth/callback requires a session.
// Fails closed with 401 (no data in the body).
app.use("*", sessionGate);

// Auth endpoints (login/callback public via the gate's allowlist; logout/mcp-token gated).
app.route("/auth", authApp);

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
    ? (typesCsv.split(",").map((t) => t.trim()).filter((t): t is "doc" | "decision" | "feed" =>
        t === "doc" || t === "decision" || t === "feed"))
    : undefined;
  const spaceRaw = c.req.query("space");
  const space = spaceRaw === "sapling" || spaceRaw === "canopy" ? spaceRaw : undefined;
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

app.get("/milestone-proposals", async (c) => c.json({ proposals: await list_milestone_proposals(c.env.DB) }));

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
    const res = await promote_doc(c.env.DB, c.req.param("slug"), version, c.get("principal").login);
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
    const res = await resolve_triage(c.env.DB, id, c.get("principal").login, "discarded");
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
    type?: AssignType; section?: string; space?: "sapling" | "canopy"; tags?: string[];
  } | null;
  try {
    const res = await assign_triage(c.env.DB, id, c.get("principal").login, {
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

// Roadmap read (session-gated): milestones in target-date order with live GitHub progress.
app.get("/roadmap", async (c) => {
  const token = await getStoredToken(c.env.DB, c.get("principal").login, c.env.COOKIE_SECRET);
  const milestones = await list_roadmap(c.env.DB, { token, repo: c.env.GITHUB_REPO, devSynthesize: !!c.env.DEV_LOGIN });
  return c.json({ milestones });
});

// Personal dashboard (session-gated): the signed-in user's focus, roadmap assignments,
// assigned issues, and recent feed — assembled live, stored nowhere. Never 500s.
app.get("/me/dashboard", async (c) => {
  const login = c.get("principal").login;
  try {
    const token = await getStoredToken(c.env.DB, login, c.env.COOKIE_SECRET);
    const data = await getMyDashboard({
      db: c.env.DB,
      login,
      token,
      repo: c.env.CONTENT_REPO ?? "SaplingLearn/sapling",
      today: nowIso(),
    });
    return c.json(data);
  } catch {
    // Absolute backstop: never 500. Anything unexpected (token decrypt, D1) → empty degraded payload.
    const empty: DashboardData = {
      person: null, role: null, owns: null, focus: null,
      workingNow: null, comingUp: [], assignedIssues: [], feed: [], degraded: true,
    };
    return c.json(empty);
  }
});

// Human confirmation (session-gated): promote a staged milestone proposal into a live milestone.
app.post("/milestone-proposals/:id/promote", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
  try {
    const milestone = await promote_milestone_proposal(c.env.DB, id, c.get("principal").login);
    return c.json({ ok: true, milestone });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// Human confirmation (session-gated): flip a live milestone to 'done'.
app.post("/milestones/:id/complete", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
  try {
    const milestone = await complete_milestone(c.env.DB, id);
    return c.json({ ok: true, milestone });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});
