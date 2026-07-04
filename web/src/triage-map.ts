// The triage mapping layer: turns backend read shapes (api.ts) into the props
// the presentational Review/Maintenance components already expect. This is the
// reshape deferred during componentization — it lives HERE, in one place per
// surface, never inside components. Pure functions, no fetching, no state.

import type { StagedProposal, AdrRow, NeedsTriageRow, IdentityTask } from "./api";
import type { ReviewItem } from "./review";
import type { AssignOptions, UnplacedItem, IdentityGroup, Person } from "./maintenance";
import { collapsedLineDiff } from "./diff";
import { initialsOf, relTime } from "./ui";
import { SECTIONS, TAGS } from "@shared/vocabulary";

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

// ── Maintenance · assign vocabulary ──────────────────────────────────────────
/** The real assign options: gate types × @shared/vocabulary targets.
 *  'needs-triage' is the queue itself, never an assignable section. */
export const ASSIGN_OPTIONS: AssignOptions = {
  kinds: [
    { key: "doc", label: "Doc section" },
    { key: "adr", label: "Decision record" },
    { key: "milestone", label: "Roadmap note" },
    { key: "feed", label: "Feed update" },
  ],
  sections: SECTIONS.filter((s) => s !== "needs-triage"),
  spaces: ["sapling", "canopy"],
  tags: [...TAGS],
};

// ── Maintenance · Unplaced ───────────────────────────────────────────────────
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Derive the card fields from the stored gate payload: JSON of the gated item
 *  (DocProposal / AdrDraft / MilestoneProposal / FeedEntry) OR a free-form
 *  string for agent-flagged batch items. The two-bucket chip is a lossy
 *  convenience — the verbatim gate reason always rides in reasonNote. */
export function unplacedFromRow(r: NeedsTriageRow): UnplacedItem {
  let parsed: Record<string, unknown> | null = null;
  try {
    const p: unknown = JSON.parse(r.raw);
    if (p !== null && typeof p === "object" && !Array.isArray(p)) parsed = p as Record<string, unknown>;
  } catch { /* free-form string raw — stays null */ }
  const str = (k: string): string | null => {
    const v = parsed?.[k];
    return typeof v === "string" && v.trim() !== "" ? v : null;
  };
  const title = parsed
    ? str("title") ?? str("summary") ?? str("slug") ?? "Untitled item"
    : clip(r.raw, 80);
  const snippet = parsed
    ? str("body") ?? str("summary") ?? str("decision") ?? str("change_summary") ?? r.raw
    : r.raw;
  return {
    id: String(r.id),
    title,
    snippet: clip(snippet, 280),
    reason: r.reason.toLowerCase().startsWith("low confidence") ? "LOW CONFIDENCE" : "AGENT FLAGGED",
    meta: `${r.source_author ?? "unknown"} · ${relTime(r.created_at)}`,
    reasonNote: r.reason,
  };
}

// ── Maintenance · Identity ───────────────────────────────────────────────────
/** Real sample kinds are only pr_merged / pr_closed / issue — commits are never
 *  captured events. The read returns samples, not a total, so the accent line
 *  says "recent activity" instead of fabricating a count. */
export function identityFromTask(t: IdentityTask): IdentityGroup {
  return {
    id: t.login,
    login: t.login,
    meta: `first seen ${relTime(t.first_seen)}`,
    countLabel: "recent activity",
    sample: t.sample.map((s) => ({
      kind: s.event_type === "issue" ? "ISSUE" : "PR",
      text: `#${s.ref_number} ${s.title ?? "(no title)"}`,
      when: relTime(s.occurred_at),
    })),
  };
}

/** The person picker's source: the logins the app already knows (feed authors +
 *  the signed-in user). The picked value — a GitHub login — is posted as the map
 *  route's free-string `person`. */
export function peopleFromLogins(logins: string[]): Person[] {
  return [...new Set(logins.filter((l) => l.trim() !== ""))]
    .sort()
    .map((l) => ({ id: l, name: l, initials: initialsOf(l) }));
}
