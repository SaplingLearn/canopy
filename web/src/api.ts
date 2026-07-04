// Typed fetch layer over the real (cookie-gated) Worker routes — the ONLY place
// that knows route URLs and response shapes. Row types come from @shared/rows;
// the route RESPONSE envelopes + SearchResult + progress live in src/tools/* (not
// @shared, and web/ can't import src/), so they are re-declared here atop the
// @shared rows. All requests carry the session cookie (credentials:"same-origin");
// the MCP bearer is for /mcp only and never appears here.
import type {
  FeedRow, DocRow, DocVersionRow, MilestoneRow, AdrRow, NeedsTriageRow, MilestoneProposalRow,
} from "@shared/rows";
import type { DashboardData } from "@shared/dashboard";

export class Unauthorized extends Error {
  constructor() { super("unauthorized"); }
}
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export class NotFound extends Error {}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } });
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) throw new ApiError(res.status, `${path} -> ${res.status}`);
  return res.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new Unauthorized();
  if (!res.ok) {
    let msg = String(res.status);
    try { const j = (await res.json()) as { error?: string }; if (j.error) msg = j.error; } catch { /* non-JSON */ }
    throw new ApiError(res.status, msg);
  }
  return res.json() as Promise<T>;
}

// ── reads ────────────────────────────────────────────────────────────────────
export interface FeedQuery { author?: string; tags?: string[]; }
export function getFeed(q: FeedQuery = {}): Promise<FeedRow[]> {
  const p = new URLSearchParams();
  if (q.author) p.set("author", q.author);
  if (q.tags && q.tags.length) p.set("tags", q.tags.join(","));
  const qs = p.toString();
  return getJson<{ feed: FeedRow[] }>(`/feed${qs ? `?${qs}` : ""}`).then((r) => r.feed);
}

export function listDocs(): Promise<DocRow[]> {
  return getJson<{ docs: DocRow[] }>("/docs").then((r) => r.docs);
}

export function getDoc(slug: string): Promise<{ doc: DocRow; versions: DocVersionRow[] }> {
  return getJson<{ doc: DocRow; versions: DocVersionRow[] }>(`/doc/${encodeURIComponent(slug)}`).catch((e) => {
    if (e instanceof ApiError && e.status === 404) throw new NotFound(slug);
    throw e;
  });
}

// The read-side query envelope, re-declared here (web/ can't import the @shared
// contract's Zod module). Mirrors shared/contract.ts QueryResult exactly.
export type Authority = "live" | "staged_pending" | "unpromoted" | "draft";
export type QueryType = "doc" | "decision" | "feed" | "milestone";
export interface QueryPrimary {
  type: QueryType; id: string; title: string;
  section: string | null; space: string | null;
  body: string; authority: Authority;
  current_version: number | null; pending_version: number | null;
  staged_body: string | null; confidence: string | null;
  updated_at: string | null; updated_by: string | null; score: number;
}
export interface QueryPointer {
  type: QueryType; id: string; title: string; snippet: string; authority: Authority; score: number;
}
export interface QueryResult {
  primary: QueryPrimary[]; pointers: QueryPointer[]; meta: { engine: "fts5"; total: number };
}

// Human Search: the route forces include_staged:false, so results are live-only.
export function search(q: string, opts: { types?: QueryType[]; section?: string; space?: string; limit?: number } = {}): Promise<QueryResult> {
  const p = new URLSearchParams();
  if (q) p.set("q", q);
  if (opts.types && opts.types.length) p.set("types", opts.types.join(","));
  if (opts.section) p.set("section", opts.section);
  if (opts.space) p.set("space", opts.space);
  if (opts.limit) p.set("limit", String(opts.limit));
  const qs = p.toString();
  return getJson<{ result: QueryResult }>(`/search${qs ? `?${qs}` : ""}`).then((r) => r.result);
}

export type MilestoneWithProgress = MilestoneRow & { progress: { closed: number; total: number; computed_at: string } | null };

// The roadmap read is the ADMIN plan: an authored narrative + version metadata alongside
// the milestones (each merged with cached, event-derived progress — no live GitHub). Mirrors
// src/tools/plan.ts's PlanView exactly (web/ can't import src/, so it's re-declared here).
export interface PlanView {
  narrative: string;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
  milestones: MilestoneWithProgress[];
}
export function getRoadmap(): Promise<PlanView> {
  return getJson<PlanView>("/roadmap");
}

export function listNeedsTriage(): Promise<NeedsTriageRow[]> {
  return getJson<{ items: NeedsTriageRow[] }>("/needs-triage").then((r) => r.items);
}
export function listAdrs(status?: string): Promise<AdrRow[]> {
  return getJson<{ adrs: AdrRow[] }>(`/adrs${status ? `?status=${encodeURIComponent(status)}` : ""}`).then((r) => r.adrs);
}
export function listMilestoneProposals(): Promise<MilestoneProposalRow[]> {
  return getJson<{ proposals: MilestoneProposalRow[] }>("/milestone-proposals").then((r) => r.proposals);
}

export interface Me { login: string; name: string | null; avatar_url: string | null; org: string; admin: boolean; }
export function getMe(): Promise<Me> {
  return getJson<Me>("/auth/me");
}

// ADMIN action: trigger the server-side GitHub backfill (admin-only route). The
// worker holds the service token and fetches GitHub directly — no webhook secret.
export function adminBackfill(): Promise<{
  ok: boolean;
  captured: number;
  unchanged: number;
  summarized: number;
  summaryBudgetExhausted: boolean;
  prSummarizedCount: number;
  issueSummarizedCount: number;
  prs: number;
  issues: number;
  issuesToSummarize: number;
}> {
  return postJson("/admin/backfill", {});
}

export function getMyDashboard(): Promise<DashboardData> {
  return getJson<DashboardData>("/me/dashboard");
}

// The Triage "Proposals" queue = staged doc versions newer than the live doc.
// Backed by the single server-joined GET /proposals route (Phase 3, G9) — no more
// N+1 over /docs + /doc/:slug. Each proposal carries both bodies (so the detail
// pane diffs staged vs promoted without extra fetches) plus the Phase 2 reconciler
// metadata (change_kind / low_confidence / base_version) Phase 4 renders by shape.
export interface StagedProposal {
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
  created_at: string;
  stagedBody: string;
  promotedBody: string;
}
export function listStagedProposals(): Promise<StagedProposal[]> {
  return getJson<{ proposals: StagedProposal[] }>("/proposals").then((r) => r.proposals);
}

// ── confirms (cookie-authed) ─────────────────────────────────────────────────
export function promoteDoc(slug: string, version: number): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(`/doc/${encodeURIComponent(slug)}/promote`, { version });
}
export function ratifyAdr(id: number): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(`/adr/${id}/ratify`);
}
export function promoteMilestoneProposal(id: number): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(`/milestone-proposals/${id}/promote`);
}
export function completeMilestone(id: number): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(`/milestones/${id}/complete`);
}

// ── triage write-back (Phase 3): reject / discard / assign-materialize ─────────
export function rejectDoc(slug: string, version: number): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(`/doc/${encodeURIComponent(slug)}/reject`, { version });
}
export function rejectAdr(id: number): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(`/adr/${id}/reject`);
}
export function rejectMilestoneProposal(id: number): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(`/milestone-proposals/${id}/reject`);
}
export function discardTriage(id: number): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(`/needs-triage/${id}/discard`);
}
export interface AssignTarget { type?: "doc" | "adr" | "milestone" | "feed"; section?: string; space?: "sapling" | "canopy"; tags?: string[]; }
export function assignTriage(id: number, target: AssignTarget): Promise<{ ok: true }> {
  return postJson<{ ok: true }>(`/needs-triage/${id}/assign`, target);
}
export function logout(): Promise<{ ok: true }> {
  return postJson<{ ok: true }>("/auth/logout");
}
export function mintMcpToken(): Promise<{ token: string }> {
  return postJson<{ token: string }>("/auth/mcp-token");
}

// Re-export the row types the UI renders, so screens import shapes from one place.
export type { FeedRow, DocRow, DocVersionRow, MilestoneRow, AdrRow, NeedsTriageRow, MilestoneProposalRow };
export type { DashboardData };
