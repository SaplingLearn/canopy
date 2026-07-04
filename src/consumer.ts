import type { IngestPayload, FeedEntry, DocProposal, AdrDraft, MilestoneProposal, CapturedEvent } from "@shared/contract";
// NOTE: CapturedEvent is imported for ingestEvent's signature only — the webhook
// (src/webhook.ts) calls ingestEvent directly. There is no `events` arm on
// IngestPayload: subject_login is trustworthy only once the webhook has verified
// the delivery's HMAC, so no bearer/cookie payload may route events through here.
import { isSection, isTag } from "@shared/vocabulary";
import type { DocRow, DocVersionRow, AdrRow, MilestoneProposalRow, ProcessedItemRow } from "@shared/rows";
import { type DB, first, run, nowIso } from "./db";
import { append_feed, propose_doc_update, stage_adr, route_triage, stage_milestone_proposal, ensure_identity_task } from "./tools/writes";
import { contentHash } from "./hash";
import { changeKind } from "./diff";
import type { Principal } from "./auth/principal";

// Per-type, per-outcome counts surfaced on /ingest so a re-run reads, e.g.,
// "3 docs: 1 staged, 2 unchanged".
export interface IngestResult {
  feed: { written: number; unchanged: number; triaged: number };
  docs: { staged: number; unchanged: number; triaged: number };
  adrs: { staged: number; unchanged: number; triaged: number };
  triage: { recorded: number; unchanged: number };
}

// The replay key for one item. The worker assigns item_index by stable
// enumeration across the payload's typed arrays, so the SAME payload always maps
// an item to the SAME (sessionId, itemIndex).
export interface LedgerRef {
  sessionId: string;
  itemIndex: number;
}

// The gate's verdict for a single entry. "unchanged" is the reconciler's no-op
// drop (a content-hash dedupe hit or a ledger replay) — nothing was written.
export type FeedIngestResult =
  | { outcome: "written"; id: number }
  | { outcome: "unchanged" }
  | { outcome: "triaged"; reason: string };
export type DocIngestResult =
  | { outcome: "written"; slug: string; version: number; status: "staged"; change_kind: "new" | "edit" | "rewrite"; base_version: number | null; low_confidence: boolean }
  | { outcome: "unchanged"; slug?: string }
  | { outcome: "triaged"; reason: string };
export type AdrIngestResult =
  | { outcome: "written"; id: number }
  | { outcome: "unchanged"; id?: number }
  | { outcome: "triaged"; reason: string };
export type MilestoneIngestResult =
  | { outcome: "written"; id: number }
  | { outcome: "unchanged"; id?: number }
  | { outcome: "triaged"; reason: string };
export type EventIngestResult = { outcome: "written"; id: number } | { outcome: "unchanged" };

// ---------------------------------------------------------------------------
// The replay ledger. ledger-first per item: a (sessionId, itemIndex) already in
// processed_items means the worker has handled this exact item before (a re-POST
// of the same payload), so it is DROPPED — nothing new is written.
// ---------------------------------------------------------------------------
async function ledgerLookup(db: DB, ledger: LedgerRef): Promise<ProcessedItemRow | null> {
  return first<ProcessedItemRow>(
    db,
    `SELECT * FROM processed_items WHERE session_id = ? AND item_index = ?`,
    ledger.sessionId,
    ledger.itemIndex
  );
}

async function ledgerRecord(
  db: DB,
  ledger: LedgerRef,
  item_type: ProcessedItemRow["item_type"],
  outcome: string,
  ref: string | null
): Promise<void> {
  // INSERT OR IGNORE: the PK guards against a double-record under a race.
  await run(
    db,
    `INSERT OR IGNORE INTO processed_items (session_id, item_index, item_type, outcome, ref, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ledger.sessionId,
    ledger.itemIndex,
    item_type,
    outcome,
    ref,
    nowIso()
  );
}

// ---------------------------------------------------------------------------
// The gate. ONE place per entry-type decides ledger/vocab/confidence/dedupe →
// write-or-stage-or-triage-or-drop. Every write path (the /ingest consumer below
// AND the MCP write tools) funnels through these, so the invariant holds
// identically regardless of entry point. The author is always the authenticated
// principal, passed in by the caller. A `ledger` makes the entry replay-safe.
// ---------------------------------------------------------------------------

/** Feed: append-only. Out-of-vocab tag → triage; the ledger is the only replay guard
 *  (content repeats are legal, which is exactly why feed needs the ledger). */
export async function ingestFeedEntry(db: DB, entry: FeedEntry, author: string, ledger?: LedgerRef): Promise<FeedIngestResult> {
  if (ledger && (await ledgerLookup(db, ledger))) return { outcome: "unchanged" };

  const unknown = entry.tags.filter((t) => !isTag(t));
  if (unknown.length > 0) {
    const reason = `unknown tag: ${unknown.join(", ")}`;
    await route_triage(db, { raw: entry, reason, source_author: author });
    if (ledger) await ledgerRecord(db, ledger, "feed", "triaged", null);
    return { outcome: "triaged", reason };
  }
  const id = await append_feed(db, {
    author,
    summary: entry.summary,
    body: entry.body,
    artifacts: entry.artifacts,
    tags: entry.tags,
  });
  if (ledger) await ledgerRecord(db, ledger, "feed", "written", String(id));
  return { outcome: "written", id };
}

/** Docs: reconcile against the KB. Out-of-vocab section or low-confidence-new → triage;
 *  low-confidence-existing → stage-and-flag; unchanged body → drop; else stage a typed delta. */
export async function ingestDocProposal(db: DB, proposal: DocProposal, author: string, ledger?: LedgerRef): Promise<DocIngestResult> {
  if (ledger && (await ledgerLookup(db, ledger))) return { outcome: "unchanged" };

  if (!isSection(proposal.section)) {
    const reason = `out-of-vocab section: ${proposal.section}`;
    await route_triage(db, { raw: proposal, reason, source_author: author });
    if (ledger) await ledgerRecord(db, ledger, "doc", "triaged", null);
    return { outcome: "triaged", reason };
  }

  const existing = await first<DocRow>(db, `SELECT * FROM docs WHERE slug = ?`, proposal.slug);
  const lowConf = proposal.confidence === "low";

  // Low confidence: a NEW slug is too uncertain to even create — triage. An
  // EXISTING slug stages but is flagged for human scrutiny.
  if (lowConf && !existing) {
    const reason = "low confidence doc proposal";
    await route_triage(db, { raw: proposal, reason, source_author: author });
    if (ledger) await ledgerRecord(db, ledger, "doc", "triaged", null);
    return { outcome: "triaged", reason };
  }

  const hash = await contentHash(proposal.body);

  // No-op dedupe (existing slug): identical to the promoted body OR the latest
  // staged body means there is nothing new to stage — drop, unless `force`.
  if (existing) {
    const promotedBody = existing.current_version > 0 ? existing.body : null;
    const promotedHash = promotedBody !== null ? await contentHash(promotedBody) : null;
    const latestStaged = await first<DocVersionRow>(
      db,
      `SELECT * FROM doc_versions WHERE slug = ? AND status = 'staged' ORDER BY version DESC LIMIT 1`,
      proposal.slug
    );
    const latestStagedHash = latestStaged ? (latestStaged.content_hash ?? (await contentHash(latestStaged.body))) : null;
    if (!proposal.force && (hash === promotedHash || hash === latestStagedHash)) {
      if (ledger) await ledgerRecord(db, ledger, "doc", "unchanged", proposal.slug);
      return { outcome: "unchanged", slug: proposal.slug };
    }
  }

  // change_kind: `new` when there is no promoted body to diff against; else a
  // line diff vs the current promoted body — changed/max(old,new) < 0.5 → edit.
  let change_kind: "new" | "edit" | "rewrite";
  let base_version: number | null;
  if (!existing || existing.current_version === 0) {
    change_kind = "new";
    base_version = existing ? (proposal.base_version ?? existing.current_version) : (proposal.base_version ?? null);
  } else {
    change_kind = changeKind(existing.body, proposal.body);
    base_version = proposal.base_version ?? existing.current_version;
  }

  const res = await propose_doc_update(
    db,
    {
      slug: proposal.slug,
      section: proposal.section,
      title: proposal.title,
      body: proposal.body,
      change_summary: proposal.change_summary,
      confidence: proposal.confidence,
      space: proposal.space ?? "canopy",
      content_hash: hash,
      base_version,
      change_kind,
      low_confidence: lowConf, // true only for low-confidence on an EXISTING slug (new+low triaged above)
    },
    author
  );
  if (ledger) await ledgerRecord(db, ledger, "doc", "staged", `${res.slug}@${res.version}`);
  return { outcome: "written", ...res, change_kind, base_version, low_confidence: lowConf };
}

/** ADRs: low confidence → triage; content-hash dedupe on title+context+decision+rationale →
 *  identical exists → drop; else stage a 'draft' carrying its content_hash. */
export async function ingestAdrDraft(db: DB, draft: AdrDraft, author: string, ledger?: LedgerRef): Promise<AdrIngestResult> {
  if (ledger && (await ledgerLookup(db, ledger))) return { outcome: "unchanged" };

  if (draft.confidence === "low") {
    const reason = "low confidence adr draft";
    await route_triage(db, { raw: draft, reason, source_author: author });
    if (ledger) await ledgerRecord(db, ledger, "adr", "triaged", null);
    return { outcome: "triaged", reason };
  }

  // NUL separator — it cannot appear in the joined fields, preventing boundary
  // collisions (["ab","c"] vs ["a","bc"]). Written as an escape sequence so the
  // file isn't treated as binary by grep. Stored content_hash values (adrs,
  // milestone_proposals) were computed with this separator — do not change it.
  const hash = await contentHash([draft.title, draft.context, draft.decision, draft.rationale].join("\u0000"));
  const dup = await first<AdrRow>(db, `SELECT * FROM adrs WHERE content_hash = ? AND status != 'rejected' LIMIT 1`, hash);
  if (dup) {
    if (ledger) await ledgerRecord(db, ledger, "adr", "unchanged", String(dup.id));
    return { outcome: "unchanged", id: dup.id };
  }

  const id = await stage_adr(db, draft, author, hash);
  if (ledger) await ledgerRecord(db, ledger, "adr", "staged", String(id));
  return { outcome: "written", id };
}

/** Milestones: 'done' (a human action) and low confidence → triage; identity by title or
 *  github_ref already present among staged proposals → drop; else stage with content_hash. */
export async function ingestMilestoneProposal(
  db: DB,
  proposal: MilestoneProposal,
  author: string,
  ledger?: LedgerRef
): Promise<MilestoneIngestResult> {
  if (ledger && (await ledgerLookup(db, ledger))) return { outcome: "unchanged" };

  if (proposal.status === "done") {
    const reason = "milestone completion is a human action";
    await route_triage(db, { raw: proposal, reason, source_author: author });
    if (ledger) await ledgerRecord(db, ledger, "milestone", "triaged", null);
    return { outcome: "triaged", reason };
  }
  if (proposal.confidence === "low") {
    const reason = "low confidence milestone proposal";
    await route_triage(db, { raw: proposal, reason, source_author: author });
    if (ledger) await ledgerRecord(db, ledger, "milestone", "triaged", null);
    return { outcome: "triaged", reason };
  }

  const github_ref = proposal.github_ref === undefined ? null : JSON.stringify(proposal.github_ref);
  const dup = await first<MilestoneProposalRow>(
    db,
    `SELECT * FROM milestone_proposals
       WHERE staged_status = 'staged' AND (title = ? OR (github_ref IS NOT NULL AND github_ref = ?)) LIMIT 1`,
    proposal.title,
    github_ref
  );
  if (dup) {
    if (ledger) await ledgerRecord(db, ledger, "milestone", "unchanged", String(dup.id));
    return { outcome: "unchanged", id: dup.id };
  }

  // NUL separator as an escape sequence — see the note on ingestAdrDraft's hash.
  const hash = await contentHash(
    [proposal.title, proposal.target_date, proposal.status, github_ref ?? "", proposal.change_summary].join("\u0000")
  );
  const id = await stage_milestone_proposal(db, proposal, author, hash);
  if (ledger) await ledgerRecord(db, ledger, "milestone", "staged", String(id));
  return { outcome: "written", id };
}

/** Captured events: dedupe is the UNIQUE semantic_key (INSERT OR IGNORE) — a
 *  redelivery or backfill overlap drops as unchanged. No vocab/confidence checks:
 *  the event is external fact, captured verbatim. The writer is the authenticated
 *  principal; subject_login is the event's own identity (trusted post-HMAC). */
export async function ingestEvent(db: DB, event: CapturedEvent, recordedBy: string, ledger?: LedgerRef): Promise<EventIngestResult> {
  if (ledger && (await ledgerLookup(db, ledger))) return { outcome: "unchanged" };
  const res = await run(
    db,
    `INSERT OR IGNORE INTO events (semantic_key, event_type, ref_number, subject_login, raw, provenance, occurred_at, recorded_at, recorded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    event.semantic_key, event.event_type, event.ref_number, event.subject_login,
    event.raw, event.provenance, event.occurred_at ?? null, nowIso(), recordedBy
  );
  const written = (res.meta.changes ?? 0) > 0;
  // Identity intake AFTER the event write: an unmapped subject_login raises one
  // pending identity task (login PK, INSERT OR IGNORE). Runs on unchanged
  // deliveries too, so events captured before the task store existed still
  // surface on their next redelivery/backfill overlap. The event above has
  // already landed either way — capture never depends on this.
  await ensure_identity_task(db, event.subject_login);
  if (ledger) await ledgerRecord(db, ledger, "event", written ? "written" : "unchanged", event.semantic_key);
  return written ? { outcome: "written", id: res.meta.last_row_id as number } : { outcome: "unchanged" };
}

/**
 * Validate-and-reconcile the (already structurally-validated) /ingest payload.
 * The Worker verifies structure; the gate functions above verify vocabulary,
 * confidence, content-hash identity, and the replay ledger. item_index is
 * assigned by stable enumeration across the typed arrays — feed, docs, adrs,
 * THEN needs_triage — so a re-POST of the same payload replays to all-`unchanged`
 * and existing indices never shift. There is no events arm here: captured events
 * only ever reach the gate via the HMAC-verified webhook calling ingestEvent
 * directly (src/webhook.ts), never through this bearer/cookie-authenticated path.
 */
export async function consume(db: DB, payload: IngestPayload, principal: Principal): Promise<IngestResult> {
  const author = principal.login; // authenticated principal; payload.session.author is advisory and ignored
  const sessionId = payload.session.id;
  const result: IngestResult = {
    feed: { written: 0, unchanged: 0, triaged: 0 },
    docs: { staged: 0, unchanged: 0, triaged: 0 },
    adrs: { staged: 0, unchanged: 0, triaged: 0 },
    triage: { recorded: 0, unchanged: 0 },
  };
  let idx = 0;

  for (const entry of payload.feed_entries) {
    const r = await ingestFeedEntry(db, entry, author, { sessionId, itemIndex: idx++ });
    if (r.outcome === "written") result.feed.written++;
    else if (r.outcome === "unchanged") result.feed.unchanged++;
    else result.feed.triaged++;
  }

  for (const proposal of payload.doc_proposals) {
    const r = await ingestDocProposal(db, proposal, author, { sessionId, itemIndex: idx++ });
    if (r.outcome === "written") result.docs.staged++;
    else if (r.outcome === "unchanged") result.docs.unchanged++;
    else result.docs.triaged++;
  }

  for (const draft of payload.adr_drafts) {
    const r = await ingestAdrDraft(db, draft, author, { sessionId, itemIndex: idx++ });
    if (r.outcome === "written") result.adrs.staged++;
    else if (r.outcome === "unchanged") result.adrs.unchanged++;
    else result.adrs.triaged++;
  }

  // Explicit triage items: already a triage request — written directly, but
  // ledger-guarded so a re-POST does not duplicate the queue row.
  for (const item of payload.needs_triage) {
    const ledger: LedgerRef = { sessionId, itemIndex: idx++ };
    if (await ledgerLookup(db, ledger)) {
      result.triage.unchanged++;
      continue;
    }
    await route_triage(db, { raw: item.raw, reason: item.reason, source_author: author });
    await ledgerRecord(db, ledger, "triage", "triaged", null);
    result.triage.recorded++;
  }

  return result;
}
