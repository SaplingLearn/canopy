import type { IngestPayload, FeedEntry, DocProposal, AdrDraft, MilestoneProposal } from "@shared/contract";
import { isSection, isTag } from "@shared/vocabulary";
import { type DB } from "./db";
import { append_feed, propose_doc_update, stage_adr, route_triage, stage_milestone_proposal } from "./tools/writes";
import type { Principal } from "./auth/principal";

export interface IngestResult {
  feed: number;
  docs: number;
  adrs: number;
  milestones: number;
  triaged: number;
}

// The gate's verdict for a single entry. Either it was written (with the
// writer's result) or it was routed to needs_triage (with the reason).
export type FeedIngestResult =
  | { outcome: "written"; id: number }
  | { outcome: "triaged"; reason: string };
export type DocIngestResult =
  | { outcome: "written"; slug: string; version: number; status: "staged" }
  | { outcome: "triaged"; reason: string };
export type AdrIngestResult =
  | { outcome: "written"; id: number }
  | { outcome: "triaged"; reason: string };
export type MilestoneIngestResult =
  | { outcome: "written"; id: number }
  | { outcome: "triaged"; reason: string };

// ---------------------------------------------------------------------------
// The gate. ONE place per entry-type decides vocab/confidence → write-or-triage.
// Every write path (the /ingest consumer below AND the MCP write tools) funnels
// through these, so the invariant holds identically regardless of entry point.
// The author is always the authenticated principal, passed in by the caller.
// ---------------------------------------------------------------------------

/** Feed: append-only, but any out-of-vocab tag routes the WHOLE entry to triage. */
export async function ingestFeedEntry(db: DB, entry: FeedEntry, author: string): Promise<FeedIngestResult> {
  const unknown = entry.tags.filter((t) => !isTag(t));
  if (unknown.length > 0) {
    const reason = `unknown tag: ${unknown.join(", ")}`;
    await route_triage(db, { raw: entry, reason, source_author: author });
    return { outcome: "triaged", reason };
  }
  const id = await append_feed(db, {
    author,
    summary: entry.summary,
    body: entry.body,
    artifacts: entry.artifacts,
    tags: entry.tags,
  });
  return { outcome: "written", id };
}

/** Docs: section must be in-vocab AND confidence high; otherwise triage. Staged non-destructively. */
export async function ingestDocProposal(db: DB, proposal: DocProposal, author: string): Promise<DocIngestResult> {
  if (!isSection(proposal.section)) {
    const reason = `out-of-vocab section: ${proposal.section}`;
    await route_triage(db, { raw: proposal, reason, source_author: author });
    return { outcome: "triaged", reason };
  }
  if (proposal.confidence === "low") {
    const reason = "low confidence doc proposal";
    await route_triage(db, { raw: proposal, reason, source_author: author });
    return { outcome: "triaged", reason };
  }
  const res = await propose_doc_update(db, proposal, author);
  return { outcome: "written", ...res };
}

/** ADRs: confidence high; otherwise triage. Staged as 'draft' for human ratification. */
export async function ingestAdrDraft(db: DB, draft: AdrDraft, author: string): Promise<AdrIngestResult> {
  if (draft.confidence === "low") {
    const reason = "low confidence adr draft";
    await route_triage(db, { raw: draft, reason, source_author: author });
    return { outcome: "triaged", reason };
  }
  const id = await stage_adr(db, draft, author);
  return { outcome: "written", id };
}

/** Milestones: 'done' (completion is a human action) and low confidence route to triage; otherwise staged for human promotion. */
export async function ingestMilestoneProposal(
  db: DB,
  proposal: MilestoneProposal,
  author: string
): Promise<MilestoneIngestResult> {
  if (proposal.status === "done") {
    const reason = "milestone completion is a human action";
    await route_triage(db, { raw: proposal, reason, source_author: author });
    return { outcome: "triaged", reason };
  }
  if (proposal.confidence === "low") {
    const reason = "low confidence milestone proposal";
    await route_triage(db, { raw: proposal, reason, source_author: author });
    return { outcome: "triaged", reason };
  }
  const id = await stage_milestone_proposal(db, proposal, author);
  return { outcome: "written", id };
}

/**
 * Validate-and-write the (already structurally-validated) /ingest payload.
 * The Worker verifies structure; the gate functions above verify vocabulary and
 * confidence. Nothing out-of-vocab or low-confidence is guessed — it goes to needs_triage.
 */
export async function consume(db: DB, payload: IngestPayload, principal: Principal): Promise<IngestResult> {
  const author = principal.login; // authenticated principal; payload.session.author is advisory and ignored
  const result: IngestResult = { feed: 0, docs: 0, adrs: 0, milestones: 0, triaged: 0 };

  for (const entry of payload.feed_entries) {
    const r = await ingestFeedEntry(db, entry, author);
    if (r.outcome === "written") result.feed++;
    else result.triaged++;
  }

  for (const proposal of payload.doc_proposals) {
    const r = await ingestDocProposal(db, proposal, author);
    if (r.outcome === "written") result.docs++;
    else result.triaged++;
  }

  for (const draft of payload.adr_drafts) {
    const r = await ingestAdrDraft(db, draft, author);
    if (r.outcome === "written") result.adrs++;
    else result.triaged++;
  }

  for (const proposal of payload.milestone_proposals) {
    const r = await ingestMilestoneProposal(db, proposal, author);
    if (r.outcome === "written") result.milestones++;
    else result.triaged++;
  }

  // Explicit triage items: written directly (already a triage request).
  for (const item of payload.needs_triage) {
    await route_triage(db, { raw: item.raw, reason: item.reason, source_author: author });
    result.triaged++;
  }

  return result;
}
