// The triage mapping layer: turns backend read shapes (api.ts) into the props
// the presentational Review/Maintenance components already expect. This is the
// reshape deferred during componentization — it lives HERE, in one place per
// surface, never inside components. Pure functions, no fetching, no state.

import type { StagedProposal, AdrRow } from "./api";
import type { ReviewItem } from "./review";
import { collapsedLineDiff } from "./diff";
import { initialsOf, relTime } from "./ui";

// ── shared derivations ───────────────────────────────────────────────────────
/** First non-empty line of a body — the card-summary fallback. */
function excerpt(body: string): string {
  return body.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
}

/** First sentence of a text (up to . ! or ?), for the ADR card summary. */
function firstSentence(text: string): string {
  const m = text.match(/^.*?[.!?](?=\s|$)/);
  return (m ? m[0] : text).trim();
}

// ── Review · Proposals ───────────────────────────────────────────────────────
/** Client-side diff of the two raw bodies the read carries (backend sends no diff). */
export function diffEntries(promotedBody: string, stagedBody: string): { t: "ctx" | "add" | "del" | "ellipsis"; s: string }[] {
  return collapsedLineDiff(promotedBody, stagedBody).map((r) => ({ t: r.t, s: r.text }));
}

export function proposalReviewItem(p: StagedProposal): ReviewItem {
  const stale = p.base_version !== null && p.base_version < p.current_version;
  return {
    id: `doc:${p.slug}@${p.version}`,
    kind: "proposal",
    eyebrow: `PROPOSAL · ${p.space.toUpperCase()} / ${p.section.toUpperCase()}`,
    badge: "STAGED",
    badgeColor: "var(--amber)",
    title: p.title,
    summary: p.summary ?? excerpt(p.stagedBody),
    agent: p.author,
    agentInitials: initialsOf(p.author),
    time: relTime(p.created_at),
    flagged: p.low_confidence === 1,
    stale,
    staleNote: stale
      ? `Proposed from v${p.base_version} — the live doc is now v${p.current_version}. Review against current content before promoting.`
      : undefined,
    liveVersion: `LIVE (v${p.current_version})`,
    diff: diffEntries(p.promotedBody, p.stagedBody),
  };
}

// ── Review · Decisions ───────────────────────────────────────────────────────
export function adrReviewItem(a: AdrRow): ReviewItem {
  const sections = [
    { h: "Context", p: a.context },
    { h: "Decision", p: a.decision },
    { h: "Rationale", p: a.rationale },
  ].filter((s): s is { h: string; p: string } => s.p !== null && s.p.trim() !== "");
  return {
    id: `adr:${a.id}`,
    kind: "decision",
    eyebrow: `DECISION · ADR-${String(a.id).padStart(3, "0")}`,
    badge: "DRAFT",
    badgeColor: "var(--blue)",
    title: a.title,
    summary: a.decision ? firstSentence(a.decision) : "",
    agent: a.created_by,
    agentInitials: initialsOf(a.created_by),
    time: relTime(a.created_at),
    adr: sections,
  };
}

/** The Review queue: both reads merged, newest first (ISO strings compare lexically). */
export function reviewItemsFromReads(proposals: StagedProposal[], adrs: AdrRow[]): ReviewItem[] {
  const merged = [
    ...proposals.map((p) => ({ at: p.created_at, item: proposalReviewItem(p) })),
    ...adrs.map((a) => ({ at: a.created_at, item: adrReviewItem(a) })),
  ];
  merged.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));
  return merged.map((m) => m.item);
}

// ── synthesized-id codec (write buttons decode back to route params) ─────────
export type ReviewRef = { kind: "doc"; slug: string; version: number } | { kind: "adr"; id: number };

export function decodeReviewId(id: string): ReviewRef | null {
  if (id.startsWith("doc:")) {
    const at = id.lastIndexOf("@");
    if (at < 4) return null;
    const version = Number(id.slice(at + 1));
    if (!Number.isInteger(version)) return null;
    return { kind: "doc", slug: id.slice(4, at), version };
  }
  if (id.startsWith("adr:")) {
    const n = Number(id.slice(4));
    return Number.isInteger(n) && id.length > 4 ? { kind: "adr", id: n } : null;
  }
  return null;
}
