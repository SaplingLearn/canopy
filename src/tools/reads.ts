import type { DocRow, DocVersionRow, FeedRow, AdrRow, NeedsTriageRow, MilestoneProposalRow, MilestoneRow, MilestoneProgressRow, PlanRow, EventRow, IdentityTaskRow } from "@shared/rows";
import type { QueryRequest, QueryResult, QueryPrimary, QueryPointer, Authority } from "@shared/contract";
import { type DB, first, all } from "../db";
import { getProgress } from "./progress";

export async function get_doc(
  db: DB,
  slug: string
): Promise<{ doc: DocRow; versions: DocVersionRow[] } | null> {
  const doc = await first<DocRow>(db, `SELECT * FROM docs WHERE slug = ?`, slug);
  if (!doc) return null;
  const versions = await all<DocVersionRow>(
    db,
    `SELECT * FROM doc_versions WHERE slug = ? ORDER BY version ASC`,
    slug
  );
  return { doc, versions };
}

export async function list_docs(db: DB, section?: string): Promise<DocRow[]> {
  if (section) {
    return all<DocRow>(db, `SELECT * FROM docs WHERE section = ? ORDER BY slug ASC`, section);
  }
  return all<DocRow>(db, `SELECT * FROM docs ORDER BY slug ASC`);
}

export interface FeedFilter {
  author?: string;
  tags?: string[];
  since?: string;
  limit?: number;
}

export async function get_feed(db: DB, filter: FeedFilter = {}): Promise<FeedRow[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let join = "";

  if (filter.author) {
    clauses.push(`f.author = ?`);
    params.push(filter.author);
  }
  if (filter.since) {
    clauses.push(`f.created_at >= ?`);
    params.push(filter.since);
  }
  if (filter.tags && filter.tags.length > 0) {
    const placeholders = filter.tags.map(() => "?").join(", ");
    join = `JOIN entry_tags et ON et.entry_type = 'feed'
            AND et.entry_id = CAST(f.id AS TEXT) AND et.tag IN (${placeholders})`;
    params.push(...filter.tags);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  // Clamp to a safe integer; interpolated (not bound) because SQLite rejects bound LIMIT in some drivers.
  const limit = Math.trunc(Math.min(Math.max(filter.limit ?? 50, 1), 500));

  return all<FeedRow>(
    db,
    `SELECT DISTINCT f.* FROM feed f ${join} ${where} ORDER BY f.created_at DESC, f.id DESC LIMIT ${limit}`,
    ...params
  );
}

// NOTE: the old flat-LIKE search_context was replaced by query() (below) — one
// engine. /search and the MCP `query` tool both back onto it.

export async function list_needs_triage(db: DB): Promise<NeedsTriageRow[]> {
  return all<NeedsTriageRow>(db, `SELECT * FROM needs_triage WHERE resolved = 0 ORDER BY created_at DESC, id DESC`);
}

export async function list_adrs(db: DB, status?: string): Promise<AdrRow[]> {
  // Decision reads exclude 'rejected' (Phase 3): a rejected draft leaves the queue.
  // With an explicit status filter the caller already constrains it (the UI asks
  // for 'draft' / 'ratified', never 'rejected').
  return status
    ? all<AdrRow>(db, `SELECT * FROM adrs WHERE status = ? ORDER BY created_at DESC, id DESC`, status)
    : all<AdrRow>(db, `SELECT * FROM adrs WHERE status != 'rejected' ORDER BY created_at DESC, id DESC`);
}

// The Proposals queue, server-joined (Phase 3, audit G9): every staged doc version
// newer than the live doc, not rejected, joined to its doc — carrying both bodies
// (live promoted + staged) and the Phase 2 reconciler metadata so Phase 4 can chip
// and diff the queue without the old per-doc N+1.
export interface ProposalRow {
  slug: string;
  version: number;
  title: string;
  section: string;
  space: string;
  summary: string | null;
  author: string;
  confidence: string | null;
  status: string;
  change_kind: "new" | "edit" | "rewrite" | null;
  low_confidence: number;
  base_version: number | null;
  current_version: number;
  created_at: string;    // doc_versions.created_at (when the proposal was staged)
  stagedBody: string;    // doc_versions.body (the proposed body)
  promotedBody: string;  // docs.body (the current live body)
}

export async function list_proposals(db: DB): Promise<ProposalRow[]> {
  return all<ProposalRow>(
    db,
    `SELECT v.slug AS slug, v.version AS version, d.title AS title, d.section AS section, d.space AS space,
            v.summary AS summary, v.created_by AS author, v.confidence AS confidence, v.status AS status,
            v.change_kind AS change_kind, v.low_confidence AS low_confidence, v.base_version AS base_version,
            d.current_version AS current_version, v.created_at AS created_at,
            v.body AS stagedBody, d.body AS promotedBody
       FROM doc_versions v JOIN docs d ON d.slug = v.slug
      WHERE v.status = 'staged' AND v.version > d.current_version
      ORDER BY v.created_at DESC, v.id DESC`
  );
}

export async function list_milestone_proposals(db: DB): Promise<MilestoneProposalRow[]> {
  return all<MilestoneProposalRow>(db, `SELECT * FROM milestone_proposals WHERE staged_status = 'staged' ORDER BY created_at DESC, id DESC`);
}

// ── Identity triage (Maintenance group) ───────────────────────────────────────

// One sampled event on an identity task: enough for a human to recognize whose
// work this login is. `title` comes from the event's own raw snapshot (PR or
// issue); a malformed raw yields null rather than failing the list.
export interface IdentitySample {
  semantic_key: string;
  event_type: string;
  ref_number: number;
  title: string | null;
  occurred_at: string | null;
}
export interface IdentityTaskWithSample extends IdentityTaskRow {
  sample: IdentitySample[];
}

const IDENTITY_SAMPLE_LIMIT = 3;

function titleFromRaw(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { pr?: { title?: string }; issue?: { title?: string } };
    return parsed.pr?.title ?? parsed.issue?.title ?? null;
  } catch {
    return null;
  }
}

/**
 * Pending identity tasks, each with a small LIVE activity sample. Activity is
 * never copied onto the task — events are already stored by raw login, so the
 * sample is just a per-login SELECT at read time (the queue is human-scale).
 */
export async function list_identity_tasks(db: DB): Promise<IdentityTaskWithSample[]> {
  const tasks = await all<IdentityTaskRow>(
    db,
    `SELECT * FROM identity_tasks WHERE status = 'pending' ORDER BY first_seen DESC, login ASC`
  );
  const out: IdentityTaskWithSample[] = [];
  for (const t of tasks) {
    const rows = await all<EventRow>(
      db,
      `SELECT * FROM events WHERE subject_login = ? ORDER BY occurred_at DESC, id DESC LIMIT ${IDENTITY_SAMPLE_LIMIT}`,
      t.login
    );
    out.push({
      ...t,
      sample: rows.map((e) => ({
        semantic_key: e.semantic_key,
        event_type: e.event_type,
        ref_number: e.ref_number,
        title: titleFromRaw(e.raw),
        occurred_at: e.occurred_at,
      })),
    });
  }
  return out;
}

// ── query(): ranked, assembled FTS5 retrieval (Phase 1 read-side brain) ───────
//
// One engine. Per requested type, bm25-ranked FTS5 (title/summary weighted above
// body) yields candidates; the global top-`limit` by score become `primary`
// (hydrated from base rows with the FULL authoritative body + an authority flag),
// the remainder up to `pointer_limit` become `pointers` (fts5 snippet()). Empty
// `q` degrades to a filtered browse ordered by recency.
//
// SEAM: when Vectorize lands, a second (semantic) candidate stream merges here via
// RRF (Reciprocal Rank Fusion). The QueryResult envelope is the stable contract;
// this normalize-bm25-then-global-sort is the FTS-only special case of that merge.

type QueryType = "doc" | "decision" | "feed" | "milestone";

// Internal assembled record: a superset carrying everything both a primary
// (full body) and a pointer (snippet) need, so we hydrate once per candidate.
interface Assembled {
  type: QueryType;
  id: string;
  title: string;
  section: string | null;
  space: string | null;
  body: string;
  authority: Authority;
  current_version: number | null;
  pending_version: number | null;
  staged_body: string | null;
  confidence: string | null;
  updated_at: string | null;
  updated_by: string | null;
  score: number;
  snippet: string;
}

// A raw candidate from one type's FTS (or browse) pass, before hydration.
interface Candidate {
  type: QueryType;
  key: string;      // doc slug | feed id | adr id (as text) | roadmap ref ('milestone:<id>' | 'plan')
  score: number;    // normalized so higher = better
  snippet: string;  // fts5 snippet() or a browse body slice
}

const SNIPPET = `'', '', '…', 12`; // open, close, ellipsis, tokens — no markup (raw text)

// Build a syntactically-safe FTS5 MATCH expression: keep only word characters,
// quote each token as a phrase, OR them together. Returns null when nothing is
// left to match (caller degrades to browse). Quoting every token guarantees we
// never feed FTS5 its own operator/syntax characters.
function buildMatch(q: string): string | null {
  const cleaned = q.replace(/[^\p{L}\p{N}_]+/gu, " ").trim();
  if (!cleaned) return null;
  return cleaned.split(/\s+/).map((t) => `"${t}"`).join(" OR ");
}

const browseSnippet = (body: string | null): string => {
  const s = (body ?? "").replace(/\s+/g, " ").trim();
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
};

function assembleAdrBody(a: AdrRow): string {
  const parts: string[] = [];
  if (a.context) parts.push(`## Context\n${a.context}`);
  if (a.decision) parts.push(`## Decision\n${a.decision}`);
  if (a.rationale) parts.push(`## Rationale\n${a.rationale}`);
  return parts.join("\n\n");
}

// The hydrated milestone body: description + phase + (when cached) a live progress
// line. The progress cache is read once per query() call and passed in here.
function assembleMilestoneBody(m: MilestoneRow, progress: MilestoneProgressRow | undefined): string {
  const parts: string[] = [];
  if (m.description) parts.push(m.description);
  if (m.phase) parts.push(m.phase);
  if (progress) parts.push(`Progress: ${progress.closed}/${progress.total} closed`);
  return parts.join("\n");
}

export async function query(db: DB, req: QueryRequest): Promise<QueryResult> {
  const types: QueryType[] = req.types ?? ["doc", "decision", "feed", "milestone"];
  const limit = Math.trunc(Math.min(Math.max(req.limit ?? 6, 0), 50));
  const pointerLimit = Math.trunc(Math.min(Math.max(req.pointer_limit ?? 20, 0), 100));
  const includeStaged = req.include_staged ?? false;
  const section = req.section;
  const space = req.space;
  // A section/space filter only makes sense for docs (feed/adrs carry neither),
  // so those types drop out when either is set — mirroring the old engine.
  const docsOnly = section !== undefined || space !== undefined;
  const fetchCap = limit + pointerLimit;

  const match = buildMatch(req.q ?? "");

  // 1. Gather raw candidates per requested type (FTS when we have a match
  //    expression, else a recency browse).
  const candidates: Candidate[] = [];

  if (types.includes("doc")) {
    if (match) {
      const clauses = ["docs_fts MATCH ?"];
      const params: unknown[] = [match];
      if (section !== undefined) { clauses.push("docs.section = ?"); params.push(section); }
      if (space !== undefined) { clauses.push("docs.space = ?"); params.push(space); }
      const rows = await all<{ key: string; rank: number; snip: string }>(
        db,
        `SELECT docs_fts.slug AS key, bm25(docs_fts, 1.0, 5.0, 1.0, 1.0) AS rank,
                snippet(docs_fts, -1, ${SNIPPET}) AS snip
         FROM docs_fts JOIN docs ON docs.slug = docs_fts.slug
         WHERE ${clauses.join(" AND ")} ORDER BY rank LIMIT ${fetchCap}`,
        ...params
      );
      for (const r of rows) candidates.push({ type: "doc", key: String(r.key), score: -r.rank, snippet: r.snip });
    } else {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (section !== undefined) { clauses.push("section = ?"); params.push(section); }
      if (space !== undefined) { clauses.push("space = ?"); params.push(space); }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = await all<{ key: string; ts: string | null }>(
        db,
        `SELECT slug AS key, updated_at AS ts FROM docs ${where}
         ORDER BY (updated_at IS NULL), updated_at DESC, slug DESC LIMIT ${fetchCap}`,
        ...params
      );
      for (const r of rows) candidates.push({ type: "doc", key: String(r.key), score: 0, snippet: "" });
    }
  }

  if (types.includes("feed") && !docsOnly) {
    if (match) {
      const rows = await all<{ key: string; rank: number; snip: string }>(
        db,
        `SELECT feed_id AS key, bm25(feed_fts, 1.0, 5.0, 1.0) AS rank,
                snippet(feed_fts, -1, ${SNIPPET}) AS snip
         FROM feed_fts WHERE feed_fts MATCH ? ORDER BY rank LIMIT ${fetchCap}`,
        match
      );
      for (const r of rows) candidates.push({ type: "feed", key: String(r.key), score: -r.rank, snippet: r.snip });
    } else {
      const rows = await all<{ key: string }>(
        db,
        `SELECT id AS key FROM feed ORDER BY created_at DESC, id DESC LIMIT ${fetchCap}`
      );
      for (const r of rows) candidates.push({ type: "feed", key: String(r.key), score: 0, snippet: "" });
    }
  }

  if (types.includes("decision") && !docsOnly) {
    if (match) {
      const rows = await all<{ key: string; rank: number; snip: string }>(
        db,
        `SELECT adr_id AS key, bm25(adrs_fts, 1.0, 5.0, 1.0, 1.0, 1.0) AS rank,
                snippet(adrs_fts, -1, ${SNIPPET}) AS snip
         FROM adrs_fts WHERE adrs_fts MATCH ? ORDER BY rank LIMIT ${fetchCap}`,
        match
      );
      for (const r of rows) candidates.push({ type: "decision", key: String(r.key), score: -r.rank, snippet: r.snip });
    } else {
      const rows = await all<{ key: string }>(
        db,
        `SELECT id AS key FROM adrs ORDER BY created_at DESC, id DESC LIMIT ${fetchCap}`
      );
      for (const r of rows) candidates.push({ type: "decision", key: String(r.key), score: 0, snippet: "" });
    }
  }

  // Roadmap: one FTS pass over roadmap_fts (plan + milestones, keyed by `ref`).
  // section/space filters are doc-only, so milestone drops out under docsOnly.
  if (types.includes("milestone") && !docsOnly) {
    if (match) {
      const rows = await all<{ key: string; rank: number; snip: string }>(
        db,
        `SELECT ref AS key, bm25(roadmap_fts, 1.0, 5.0, 1.0) AS rank,
                snippet(roadmap_fts, -1, ${SNIPPET}) AS snip
         FROM roadmap_fts WHERE roadmap_fts MATCH ? ORDER BY rank LIMIT ${fetchCap}`,
        match
      );
      for (const r of rows) candidates.push({ type: "milestone", key: String(r.key), score: -r.rank, snippet: r.snip });
    } else {
      // Browse: the plan row first (only when it carries a narrative), then
      // milestones by recency (updated_at, then created_at).
      const planRow = await first<PlanRow>(db, `SELECT * FROM plan WHERE id = 1`);
      if (planRow && planRow.narrative.trim() !== "") {
        candidates.push({ type: "milestone", key: "plan", score: 0, snippet: "" });
      }
      const rows = await all<{ key: number }>(
        db,
        `SELECT id AS key FROM milestones
         ORDER BY (updated_at IS NULL), updated_at DESC, created_at DESC, id DESC LIMIT ${fetchCap}`
      );
      for (const r of rows) candidates.push({ type: "milestone", key: `milestone:${r.key}`, score: 0, snippet: "" });
    }
  }

  // 2. Hydrate base rows in bulk (one round-trip per type), then assemble.
  const docKeys = candidates.filter((c) => c.type === "doc").map((c) => c.key);
  const feedKeys = candidates.filter((c) => c.type === "feed").map((c) => Number(c.key));
  const adrKeys = candidates.filter((c) => c.type === "decision").map((c) => Number(c.key));

  const docMap = new Map<string, DocRow>();
  const stagedMap = new Map<string, DocVersionRow[]>();
  if (docKeys.length) {
    const ph = docKeys.map(() => "?").join(", ");
    for (const d of await all<DocRow>(db, `SELECT * FROM docs WHERE slug IN (${ph})`, ...docKeys)) docMap.set(d.slug, d);
    for (const v of await all<DocVersionRow>(
      db,
      `SELECT * FROM doc_versions WHERE status = 'staged' AND slug IN (${ph}) ORDER BY version ASC`,
      ...docKeys
    )) {
      const list = stagedMap.get(v.slug) ?? [];
      list.push(v);
      stagedMap.set(v.slug, list);
    }
  }

  const feedMap = new Map<string, FeedRow>();
  if (feedKeys.length) {
    const ph = feedKeys.map(() => "?").join(", ");
    for (const f of await all<FeedRow>(db, `SELECT * FROM feed WHERE id IN (${ph})`, ...feedKeys)) feedMap.set(String(f.id), f);
  }

  const adrMap = new Map<string, AdrRow>();
  if (adrKeys.length) {
    const ph = adrKeys.map(() => "?").join(", ");
    for (const a of await all<AdrRow>(db, `SELECT * FROM adrs WHERE id IN (${ph})`, ...adrKeys)) adrMap.set(String(a.id), a);
  }

  // Roadmap hydration: milestone ids (from 'milestone:<id>' refs) + the plan flag.
  const milestoneIds = candidates
    .filter((c) => c.type === "milestone" && c.key.startsWith("milestone:"))
    .map((c) => Number(c.key.slice("milestone:".length)));
  const needPlan = candidates.some((c) => c.type === "milestone" && c.key === "plan");

  const milestoneMap = new Map<string, MilestoneRow>();
  if (milestoneIds.length) {
    const ph = milestoneIds.map(() => "?").join(", ");
    for (const m of await all<MilestoneRow>(db, `SELECT * FROM milestones WHERE id IN (${ph})`, ...milestoneIds)) {
      milestoneMap.set(`milestone:${m.id}`, m);
    }
  }
  const progressMap = milestoneIds.length ? await getProgress(db) : new Map<number, MilestoneProgressRow>();
  const planRow = needPlan ? await first<PlanRow>(db, `SELECT * FROM plan WHERE id = 1`) : null;

  // Browse mode carries no per-row score, so order is by the merged recency from
  // step 1; FTS mode already has a normalized score. Sort once by score desc and,
  // for browse ties (all 0), keep the stable per-type recency order via index.
  const ordered = candidates
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (b.c.score - a.c.score) || (a.i - b.i));

  const assembled: Assembled[] = [];
  for (const { c } of ordered) {
    let a: Assembled | null = null;
    if (c.type === "doc") {
      const doc = docMap.get(c.key);
      if (!doc) continue;
      const staged = stagedMap.get(c.key) ?? [];
      const latest = staged.length ? staged[staged.length - 1] : null;
      let authority: Authority;
      let body = doc.body;
      let pendingVersion: number | null = null;
      let stagedBody: string | null = null;
      let confidence: string | null = null;
      if (doc.current_version === 0) {
        authority = "unpromoted"; // never promoted — its only content lives in a staged version
        if (latest) { body = latest.body; confidence = latest.confidence; }
      } else {
        const pending = staged.filter((v) => v.version > doc.current_version);
        const top = pending.length ? pending[pending.length - 1] : null;
        if (top) {
          authority = "staged_pending"; // live body stands; a newer version awaits promotion
          pendingVersion = top.version;
          confidence = top.confidence;
          stagedBody = includeStaged ? top.body : null;
        } else {
          authority = "live";
        }
      }
      a = {
        type: "doc", id: doc.slug, title: doc.title, section: doc.section, space: doc.space,
        body, authority, current_version: doc.current_version, pending_version: pendingVersion,
        staged_body: stagedBody, confidence, updated_at: doc.updated_at, updated_by: doc.updated_by,
        score: c.score, snippet: c.snippet || browseSnippet(body),
      };
    } else if (c.type === "feed") {
      const f = feedMap.get(c.key);
      if (!f) continue;
      a = {
        type: "feed", id: String(f.id), title: f.summary, section: null, space: null,
        body: f.body ?? "", authority: "live", current_version: null, pending_version: null,
        staged_body: null, confidence: null, updated_at: f.created_at, updated_by: f.author,
        score: c.score, snippet: c.snippet || browseSnippet(f.body),
      };
    } else if (c.type === "decision") {
      const adr = adrMap.get(c.key);
      if (!adr) continue;
      const body = assembleAdrBody(adr);
      a = {
        type: "decision", id: String(adr.id), title: adr.title, section: null, space: null,
        body, authority: adr.status === "ratified" ? "live" : "draft",
        current_version: null, pending_version: null, staged_body: null, confidence: adr.confidence,
        updated_at: adr.created_at, updated_by: adr.created_by,
        score: c.score, snippet: c.snippet || browseSnippet(body),
      };
    } else {
      // milestone: either the plan singleton (ref 'plan') or a milestone row.
      // Both are direct/authored writes, so always authority "live".
      if (c.key === "plan") {
        if (!planRow) continue;
        a = {
          type: "milestone", id: "plan", title: "Roadmap plan", section: null, space: null,
          body: planRow.narrative, authority: "live", current_version: null, pending_version: null,
          staged_body: null, confidence: null, updated_at: planRow.updated_at, updated_by: planRow.updated_by,
          score: c.score, snippet: c.snippet || browseSnippet(planRow.narrative),
        };
      } else {
        const m = milestoneMap.get(c.key);
        if (!m) continue;
        const body = assembleMilestoneBody(m, progressMap.get(m.id));
        a = {
          type: "milestone", id: `milestone:${m.id}`, title: m.title, section: null, space: null,
          body, authority: "live", current_version: null, pending_version: null,
          staged_body: null, confidence: null, updated_at: m.updated_at ?? m.created_at, updated_by: m.created_by,
          score: c.score, snippet: c.snippet || browseSnippet(body),
        };
      }
    }
    // Human (include_staged false) never surfaces not-yet-settled content: drop
    // unpromoted (empty-live) docs and unratified (draft) decisions entirely.
    if (!includeStaged && (a.authority === "unpromoted" || a.authority === "draft")) continue;
    assembled.push(a);
  }

  const primary: QueryPrimary[] = assembled.slice(0, limit).map((a) => ({
    type: a.type, id: a.id, title: a.title, section: a.section, space: a.space,
    body: a.body, authority: a.authority, current_version: a.current_version,
    pending_version: a.pending_version, staged_body: a.staged_body, confidence: a.confidence,
    updated_at: a.updated_at, updated_by: a.updated_by, score: a.score,
  }));

  const pointers: QueryPointer[] = assembled.slice(limit, limit + pointerLimit).map((a) => ({
    type: a.type, id: a.id, title: a.title, snippet: a.snippet, authority: a.authority, score: a.score,
  }));

  return { primary, pointers, meta: { engine: "fts5", total: primary.length + pointers.length } };
}
