// Typed fetch layer over the real (cookie-gated) Worker routes — the ONLY place
// that knows route URLs and response shapes. Row types come from @shared/rows;
// the route RESPONSE envelopes + SearchResult + progress live in src/tools/* (not
// @shared, and web/ can't import src/), so they are re-declared here atop the
// @shared rows. All requests carry the session cookie (credentials:"same-origin");
// the MCP bearer is for /mcp only and never appears here.
import type {
  FeedRow, DocRow, DocVersionRow, MilestoneRow, AdrRow, NeedsTriageRow, MilestoneProposalRow,
} from "@shared/rows";

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

export interface SearchResult { type: "doc" | "feed" | "adr"; id: string; title: string; snippet: string; }
export function search(q: string, section?: string): Promise<SearchResult[]> {
  const p = new URLSearchParams({ q });
  if (section) p.set("section", section);
  return getJson<{ results: SearchResult[] }>(`/search?${p}`).then((r) => r.results);
}

export type MilestoneWithProgress = MilestoneRow & { progress: { closed: number; total: number } | null };
export function getRoadmap(): Promise<MilestoneWithProgress[]> {
  return getJson<{ milestones: MilestoneWithProgress[] }>("/roadmap").then((r) => r.milestones);
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

export interface Me { login: string; name: string | null; avatar_url: string | null; org: string; }
export function getMe(): Promise<Me> {
  return getJson<Me>("/auth/me");
}

// The Triage "Proposals" queue = staged doc versions newer than the live doc. There is no
// single route for this (G9), so aggregate it from /docs + /doc/:slug (N+1 over docs). Each
// proposal carries both bodies so the detail pane can diff staged vs promoted.
export interface StagedProposal {
  slug: string;
  version: number;
  title: string;
  section: string;
  summary: string | null;
  author: string;
  confidence: string | null;
  stagedBody: string;
  promotedBody: string;
}
export async function listStagedProposals(): Promise<StagedProposal[]> {
  const docs = await listDocs();
  const out: StagedProposal[] = [];
  for (const d of docs) {
    const { doc, versions } = await getDoc(d.slug);
    for (const v of versions) {
      if (v.status === "staged" && v.version > doc.current_version) {
        out.push({
          slug: doc.slug, version: v.version, title: doc.title, section: doc.section,
          summary: v.summary, author: v.created_by, confidence: v.confidence,
          stagedBody: v.body, promotedBody: doc.body,
        });
      }
    }
  }
  return out;
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
export function logout(): Promise<{ ok: true }> {
  return postJson<{ ok: true }>("/auth/logout");
}
export function mintMcpToken(): Promise<{ token: string }> {
  return postJson<{ token: string }>("/auth/mcp-token");
}

// Re-export the row types the UI renders, so screens import shapes from one place.
export type { FeedRow, DocRow, DocVersionRow, MilestoneRow, AdrRow, NeedsTriageRow, MilestoneProposalRow };
