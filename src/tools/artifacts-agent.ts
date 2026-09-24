// The MCP artifact surface (issue #52 · Track C; spec:
// docs/superpowers/specs/2026-09-24-artifacts-implementation.md, contract:
// docs/artifact-contract.md) — thin adapters over the repository in ./artifacts.ts.
//
// Every rule lives in the repository and is enforced there with the BEARER
// principal's handle as the viewer: visibility (private pages are their author's
// alone), the one not_found (missing slug, private-to-someone-else and a version-0
// page are indistinguishable), caps, the sha no-op, the status machine. What this
// module adds is only the agent's SHAPE of it:
//
//   • absolute links — `url` (the SPA page `<origin>/#artifacts/<slug>`), an absolute
//     `upload_url` for the binary PUT, an absolute `raw_url`;
//   • `warnings: string[]` on EVERY result — non-empty when text content calls into
//     something only claude.ai provides (`CLAUDE_ONLY_MARKERS`). A warning, never a
//     rejection: the write has already happened;
//   • the input split between the text path (content / old_str+new_str) and the
//     binary path (size_bytes + sha256 → a single-use, 5-minute upload URL).
//
// There is deliberately NO ratify here and no path to `ratify()`: ratifying is a
// human act over a session-cookie route (POST /api/artifacts/:slug/ratify), exactly
// like /doc/:slug/promote and /adr/:id/ratify. Artifacts are authored writes in the
// promote class — nothing is staged, nothing goes through the ingestion gate.

import type { DB } from "../db";
import {
  ArtifactError, addLink, addTextVersion, createPage, getPage, listPages, mintUploadToken, writablePageKind,
} from "./artifacts";
import {
  claudeOnlyHits, isBinaryKind, isTextKind, parseSlugVersion,
  type ArtifactArea, type ArtifactDetailDTO, type ArtifactKind, type ArtifactLinkInput, type ArtifactLinkType,
  type ArtifactStatus, type ArtifactTextKind, type ArtifactVisibility,
} from "@shared/artifacts";

export interface ArtifactAgentCtx {
  db: DB;
  /** The bearer principal's handle — the author and the viewer of every call. */
  handle: string;
  /** Absolute origin for links (`env.PUBLIC_ORIGIN`, else the request's), no trailing slash. "" → relative. */
  origin: string;
}

/** `PUBLIC_ORIGIN` wins; else the request's own origin; else "" (relative links). */
export function artifactOrigin(publicOrigin: string | undefined, requestOrigin: string | undefined): string {
  return (publicOrigin || requestOrigin || "").replace(/\/+$/, "");
}

const pageUrl = (ctx: ArtifactAgentCtx, slug: string): string => `${ctx.origin}/#artifacts/${slug}`;
const absolute = (ctx: ArtifactAgentCtx, path: string): string => `${ctx.origin}${path}`;
const bad = (m: string): ArtifactError => new ArtifactError("bad_request", m);

/** One warning per CLAUDE_ONLY_MARKERS hit in text content. [] for binary / null content. */
export function artifactWarnings(content: string | null | undefined): string[] {
  if (typeof content !== "string") return [];
  return claudeOnlyHits(content).map(
    (m) => `content references \`${m}\`, which only exists inside claude.ai — it will not work in Canopy's viewer`
  );
}

const BINARY_FIELDS = ["size_bytes", "sha256", "content_type", "filename"] as const;

// ── artifact_create ──────────────────────────────────────────────────────────

export interface AgentCreateInput {
  title: string;
  kind: ArtifactKind;
  content?: string;
  area: ArtifactArea;
  repo: string;
  visibility: ArtifactVisibility;
  links?: ArtifactLinkInput[];
  summary?: string;
  size_bytes?: number;
  sha256?: string;
  content_type?: string;
  filename?: string;
}

export type AgentCreateResult =
  | { id: number; slug: string; url: string; version: number; warnings: string[] }
  | { id: number; slug: string; url: string; upload_url: string; expires_at: string; warnings: string[] };

export async function agentArtifactCreate(ctx: ArtifactAgentCtx, input: AgentCreateInput): Promise<AgentCreateResult> {
  const page = { title: input.title, area: input.area, repo: input.repo, visibility: input.visibility, links: input.links };
  if (isTextKind(input.kind)) {
    if (typeof input.content !== "string") throw bad(`a ${input.kind} artifact needs \`content\``);
    const extra = BINARY_FIELDS.filter((f) => input[f] !== undefined);
    if (extra.length) throw bad(`${extra.join(", ")} are for binary kinds (image, pdf, file) — a ${input.kind} artifact takes \`content\``);
    const d = await createPage(ctx.db, { ...page, kind: input.kind as ArtifactTextKind, content: input.content, summary: input.summary }, ctx.handle);
    return { id: d.id, slug: d.slug, url: pageUrl(ctx, d.slug), version: d.current_version, warnings: artifactWarnings(d.content) };
  }
  if (!isBinaryKind(input.kind)) throw bad("unknown kind");
  if (input.content !== undefined) throw bad(`a ${input.kind} artifact is uploaded, not inlined — pass size_bytes and sha256 instead of content`);
  if (input.size_bytes === undefined || input.sha256 === undefined) {
    throw bad(`a ${input.kind} artifact needs size_bytes and sha256 (e.g. \`shasum -a 256 <file>\`)`);
  }
  const t = await mintUploadToken(ctx.db, {
    ...page, kind: input.kind, size_bytes: input.size_bytes, sha256: input.sha256,
    content_type: input.content_type, filename: input.filename, summary: input.summary,
  }, ctx.handle);
  return { id: t.id, slug: t.slug, url: pageUrl(ctx, t.slug), upload_url: absolute(ctx, t.upload_url), expires_at: t.expires_at, warnings: [] };
}

// ── artifact_update ──────────────────────────────────────────────────────────

export interface AgentUpdateInput {
  slug: string;
  summary: string;
  content?: string;
  old_str?: string;
  new_str?: string;
  size_bytes?: number;
  sha256?: string;
  content_type?: string;
  filename?: string;
}

export type AgentUpdateResult =
  | { id: number; slug: string; url: string; version: number; unchanged: boolean; warnings: string[] }
  | { id: number; slug: string; url: string; upload_url: string; expires_at: string; warnings: string[] };

export async function agentArtifactUpdate(ctx: ArtifactAgentCtx, input: AgentUpdateInput): Promise<AgentUpdateResult> {
  // The page's kind decides the path. Resolved through the repository's visibility
  // rule FIRST, so a private / missing / pending-for-someone-else slug is the one
  // not_found before any input-shape error could hint at what the page is.
  const kind = await writablePageKind(ctx.db, input.slug, ctx.handle);
  const hasText = input.content !== undefined || input.old_str !== undefined || input.new_str !== undefined;
  if (isTextKind(kind)) {
    const extra = BINARY_FIELDS.filter((f) => input[f] !== undefined);
    if (extra.length) throw bad(`${extra.join(", ")} are for binary kinds — this is a ${kind} artifact; pass content, or old_str and new_str`);
    let edit: { content: string; summary: string } | { old_str: string; new_str: string; summary: string };
    if (input.content !== undefined) {
      if (input.old_str !== undefined || input.new_str !== undefined) throw bad("give content OR old_str and new_str, not both");
      edit = { content: input.content, summary: input.summary };
    } else if (input.old_str !== undefined && input.new_str !== undefined) {
      if (input.old_str === "") throw bad("old_str must not be empty");
      edit = { old_str: input.old_str, new_str: input.new_str, summary: input.summary };
    } else {
      throw bad("give content, or old_str and new_str (old_str must occur exactly once in the latest version)");
    }
    const r = await addTextVersion(ctx.db, input.slug, edit, ctx.handle);
    return {
      id: r.page.id, slug: r.page.slug, url: pageUrl(ctx, r.page.slug), version: r.version_no, unchanged: r.unchanged,
      warnings: artifactWarnings(r.page.content),
    };
  }
  if (!isBinaryKind(kind)) throw bad("unknown kind");
  if (hasText) throw bad(`this is a ${kind} artifact — upload a new file with size_bytes and sha256, not text`);
  if (input.size_bytes === undefined || input.sha256 === undefined) throw bad(`a new ${kind} version needs size_bytes and sha256`);
  const t = await mintUploadToken(ctx.db, {
    slug: input.slug, kind, size_bytes: input.size_bytes, sha256: input.sha256,
    content_type: input.content_type, filename: input.filename, summary: input.summary,
  }, ctx.handle);
  return { id: t.id, slug: t.slug, url: pageUrl(ctx, t.slug), upload_url: absolute(ctx, t.upload_url), expires_at: t.expires_at, warnings: [] };
}

// ── artifact_get ─────────────────────────────────────────────────────────────

export type AgentGetResult = ArtifactDetailDTO & { url: string; warnings: string[] };

/** `slug`, `slug@v3` or `slug/v3`; an explicit `version` must agree with an embedded one. */
export async function agentArtifactGet(ctx: ArtifactAgentCtx, input: { slug: string; version?: number }): Promise<AgentGetResult> {
  const parsed = parseSlugVersion(String(input.slug ?? "").trim());
  if (!parsed) throw new ArtifactError("not_found", "not_found");
  if (input.version !== undefined && parsed.version !== null && input.version !== parsed.version) {
    throw bad(`the slug names v${parsed.version} but version is ${input.version}`);
  }
  const d = await getPage(ctx.db, parsed.slug, input.version ?? parsed.version, ctx.handle);
  return { ...d, raw_url: absolute(ctx, d.raw_url), url: pageUrl(ctx, d.slug), warnings: artifactWarnings(d.content) };
}

// ── reads other tools borrow ─────────────────────────────────────────────────

export interface TicketArtifactRef { slug: string; title: string; kind: ArtifactKind; status: ArtifactStatus; version: number }

/** The pages linked to a ticket that `handle` can see (private ones only to their author). */
export async function artifactsForTicket(db: DB, ticketId: number, handle: string): Promise<TicketArtifactRef[]> {
  const pages = await listPages(db, { ticket: String(ticketId) }, handle);
  return pages.map((p) => ({ slug: p.slug, title: p.title, kind: p.kind, status: p.status, version: p.current_version }));
}

// ── record_session / /ingest: artifact_links ─────────────────────────────────

export interface ArtifactLinkRequest { slug: string; target_type: ArtifactLinkType; target_ref: string }
export type ArtifactLinkOutcome = ArtifactLinkRequest & (
  | { outcome: "linked" }
  | { outcome: "not_found" }
  | { outcome: "error"; error: string }
);

/**
 * Apply a batch's `artifact_links` AFTER the batch was reconciled. Each is a DIRECT
 * authored write through the repository's `addLink` under `handle` (the same read
 * check as the web: a page the caller cannot see is `not_found`) — not an ingested
 * item, so no ledger: `addLink` is idempotent, which is what makes a replay safe.
 * One failure never stops the rest.
 */
export async function applyArtifactLinks(db: DB, links: readonly ArtifactLinkRequest[], handle: string): Promise<ArtifactLinkOutcome[]> {
  const out: ArtifactLinkOutcome[] = [];
  for (const l of links) {
    const base = { slug: l.slug, target_type: l.target_type, target_ref: l.target_ref };
    try {
      await addLink(db, l.slug, { target_type: l.target_type, target_ref: l.target_ref }, handle);
      out.push({ ...base, outcome: "linked" });
    } catch (e) {
      if (e instanceof ArtifactError && e.code === "not_found") out.push({ ...base, outcome: "not_found" });
      else out.push({ ...base, outcome: "error", error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
