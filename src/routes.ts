import { Hono } from "hono";
import { IngestPayload } from "@shared/contract";
import type { AppEnv } from "./auth/principal";
import { sessionGate } from "./auth/principal";
import { authApp } from "./auth/routes";
import { consume } from "./consumer";
import { get_doc, list_docs, get_feed, search_context, list_needs_triage, list_adrs, list_milestone_proposals } from "./tools/reads";
import { promote_doc, ratify_adr, promote_milestone_proposal, complete_milestone } from "./tools/writes";
import { list_roadmap } from "./tools/roadmap";
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

app.get("/search", async (c) => {
  const limit = c.req.query("limit");
  const results = await search_context(c.env.DB, c.req.query("q") ?? "", {
    section: c.req.query("section"),
    limit: limit ? Number(limit) : undefined,
  });
  return c.json({ results });
});

app.get("/needs-triage", async (c) => c.json({ items: await list_needs_triage(c.env.DB) }));

app.get("/adrs", async (c) => c.json({ adrs: await list_adrs(c.env.DB, c.req.query("status")) }));

app.get("/milestone-proposals", async (c) => c.json({ proposals: await list_milestone_proposals(c.env.DB) }));

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

// Roadmap read (session-gated): milestones in target-date order with live GitHub progress.
app.get("/roadmap", async (c) => {
  const token = await getStoredToken(c.env.DB, c.get("principal").login, c.env.COOKIE_SECRET);
  const milestones = await list_roadmap(c.env.DB, { token, repo: c.env.GITHUB_REPO, devSynthesize: !!c.env.DEV_LOGIN });
  return c.json({ milestones });
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
