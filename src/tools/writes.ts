import type { DocRow, DocVersionRow, AdrRow, MilestoneRow, MilestoneProposalRow, NeedsTriageRow, PersonRow, IdentityTaskRow } from "@shared/rows";
import { DocProposal, AdrDraft, MilestoneProposal, FeedEntry } from "@shared/contract";
import { isSection, isTag } from "@shared/vocabulary";
import { type DB, first, run, nowIso } from "../db";
// NOTE: writes.ts ↔ consumer.ts is a deliberate circular import. consumer.ts
// imports the low-level writers below; assign_triage imports the gate functions.
// It is safe because every reference is INSIDE a function body (resolved lazily
// at call time, long after both modules finish initializing) — never at module
// init. assign_triage MUST reuse the gate so an assigned item is vocab-checked
// and reconciled exactly like any other write; it never hand-inserts.
import { ingestDocProposal, ingestAdrDraft, ingestMilestoneProposal, ingestFeedEntry } from "../consumer";

const humanizeSlug = (slug: string): string =>
  slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export async function append_feed(
  db: DB,
  entry: { author: string; summary: string; body?: string; artifacts?: unknown; tags?: string[] }
): Promise<number> {
  const created_at = nowIso();
  const res = await run(
    db,
    `INSERT INTO feed (author, summary, body, artifacts, created_at) VALUES (?, ?, ?, ?, ?)`,
    entry.author,
    entry.summary,
    entry.body ?? null,
    entry.artifacts !== undefined ? JSON.stringify(entry.artifacts) : null,
    created_at
  );
  const id = res.meta.last_row_id as number;
  for (const tag of entry.tags ?? []) {
    await run(
      db,
      `INSERT OR IGNORE INTO entry_tags (tag, entry_type, entry_id) VALUES (?, 'feed', ?)`,
      tag,
      String(id)
    );
  }
  return id;
}

export async function propose_doc_update(
  db: DB,
  proposal: {
    slug: string;
    section: string;
    title?: string;
    body: string;
    change_summary: string;
    confidence: "high" | "low";
    // Reconciler-computed metadata (set by the gate; defaulted for direct callers).
    space?: "technical" | "product";
    content_hash?: string | null;
    base_version?: number | null;
    change_kind?: "new" | "edit" | "rewrite" | null;
    low_confidence?: boolean;
  },
  author: string
): Promise<{ slug: string; version: number; status: "staged" }> {
  const created_at = nowIso();
  const existing = await first<DocRow>(db, `SELECT * FROM docs WHERE slug = ?`, proposal.slug);

  if (!existing) {
    // Title resolution on first creation only: proposal.title ?? humanizeSlug(slug).
    // (On an existing doc we never rewrite title/section — a human may have set them.)
    // `space` (audit F4) is persisted on the INSERT, defaulting to 'technical'.
    const title = proposal.title ?? humanizeSlug(proposal.slug);
    await run(
      db,
      `INSERT INTO docs (slug, section, title, body, current_version, updated_at, updated_by, space)
       VALUES (?, ?, ?, '', 0, ?, ?, ?)`,
      proposal.slug,
      proposal.section,
      title,
      created_at,
      author,
      proposal.space ?? "technical"
    );
  }

  const max = await first<{ v: number | null }>(
    db,
    `SELECT MAX(version) AS v FROM doc_versions WHERE slug = ?`,
    proposal.slug
  );
  const version = (max?.v ?? 0) + 1;

  await run(
    db,
    `INSERT INTO doc_versions
       (slug, version, body, summary, status, confidence, created_at, created_by,
        content_hash, base_version, change_kind, low_confidence)
     VALUES (?, ?, ?, ?, 'staged', ?, ?, ?, ?, ?, ?, ?)`,
    proposal.slug,
    version,
    proposal.body,
    proposal.change_summary,
    proposal.confidence,
    created_at,
    author,
    proposal.content_hash ?? null,
    proposal.base_version ?? null,
    proposal.change_kind ?? null,
    proposal.low_confidence ? 1 : 0
  );

  // docs.current_version intentionally untouched — promotion is a human action (out of scope).
  return { slug: proposal.slug, version, status: "staged" };
}

export async function stage_adr(
  db: DB,
  draft: { title: string; context: string; decision: string; rationale: string; confidence: "high" | "low" },
  author: string,
  contentHash?: string | null
): Promise<number> {
  const created_at = nowIso();
  const res = await run(
    db,
    `INSERT INTO adrs (title, context, decision, rationale, status, confidence, created_at, created_by, content_hash)
     VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
    draft.title,
    draft.context,
    draft.decision,
    draft.rationale,
    draft.confidence,
    created_at,
    author,
    contentHash ?? null
  );
  return res.meta.last_row_id as number;
}

export async function route_triage(
  db: DB,
  item: { raw: unknown; reason: string; source_author?: string }
): Promise<number> {
  const created_at = nowIso();
  const raw = typeof item.raw === "string" ? item.raw : JSON.stringify(item.raw);
  const res = await run(
    db,
    `INSERT INTO needs_triage (raw, reason, source_author, resolved, created_at)
     VALUES (?, ?, ?, 0, ?)`,
    raw,
    item.reason,
    item.source_author ?? null,
    created_at
  );
  return res.meta.last_row_id as number;
}

/**
 * Identity intake (Maintenance group): ensure one pending identity task exists
 * for an unmapped GitHub login. Called by ingestEvent AFTER the event row lands,
 * so capture never depends on this. login is the PK — INSERT OR IGNORE collapses
 * many events from one unknown person into one task and never re-raises a
 * resolved one. A login already in `people` raises nothing. NEVER throws: like
 * storePrSummary, this is a post-capture side-task, and a failure here (e.g.
 * migration 0016 not yet applied) must not break event capture or the caller's
 * downstream summary/progress seams.
 */
export async function ensure_identity_task(db: DB, login: string): Promise<void> {
  try {
    // GitHub reserves the "[bot]" suffix for app identities — bot activity is
    // captured in events but never raises an identity task (nobody maps a bot).
    if (login.endsWith("[bot]")) return;
    const known = await first<PersonRow>(db, `SELECT * FROM people WHERE login = ?`, login);
    if (known) return;
    await run(
      db,
      `INSERT OR IGNORE INTO identity_tasks (login, first_seen, status) VALUES (?, ?, 'pending')`,
      login,
      nowIso()
    );
  } catch {
    // Never throw — see doc comment.
  }
}

/**
 * Human placement (Maintenance group): resolve an identity task by mapping the
 * login to a person. Performs the `people` table's ONLY runtime write (an
 * upsert over the 0012 seed), then soft-resolves the task with the audit
 * columns. A direct authored write in the human-placement class — never a gate
 * re-run. My Work resolves login→person at read time, so the mapping
 * retroactively surfaces every already-captured event for this login with no
 * backfill. Idempotent-safe: mapping an already-resolved task surfaces the
 * recorded mapping without re-writing anything.
 */
export async function map_identity(
  db: DB,
  login: string,
  person: string,
  by: string
): Promise<{ login: string; person: string; status: "resolved" }> {
  const task = await first<IdentityTaskRow>(db, `SELECT * FROM identity_tasks WHERE login = ?`, login);
  if (!task) throw new Error(`no such identity task: ${login}`);
  if (task.status === "resolved") {
    // Already resolved — idempotent no-op, surface the recorded mapping.
    const existing = await first<PersonRow>(db, `SELECT * FROM people WHERE login = ?`, login);
    return { login, person: existing?.person ?? person, status: "resolved" };
  }
  await run(
    db,
    `INSERT INTO people (login, person) VALUES (?, ?)
     ON CONFLICT(login) DO UPDATE SET person = excluded.person`,
    login,
    person
  );
  await run(
    db,
    `UPDATE identity_tasks SET status = 'resolved', resolved_at = ?, resolved_by = ? WHERE login = ?`,
    nowIso(),
    by,
    login
  );
  return { login, person, status: "resolved" };
}

/**
 * Human confirmation: promote a staged doc version into the live doc.
 * Non-destructive — prior versions remain. Rejects if the version is missing or not staged.
 */
export async function promote_doc(
  db: DB,
  slug: string,
  version: number,
  author: string
): Promise<{ slug: string; version: number; status: "promoted" }> {
  const ver = await first<DocVersionRow>(
    db,
    `SELECT * FROM doc_versions WHERE slug = ? AND version = ?`,
    slug,
    version
  );
  if (!ver) throw new Error(`no such doc version: ${slug} v${version}`);
  if (ver.status !== "staged") throw new Error(`doc version not staged: ${slug} v${version} is ${ver.status}`);

  const updated_at = nowIso();
  await run(db, `UPDATE doc_versions SET status = 'promoted' WHERE slug = ? AND version = ?`, slug, version);
  await run(
    db,
    `UPDATE docs SET body = ?, current_version = ?, updated_at = ?, updated_by = ? WHERE slug = ?`,
    ver.body,
    version,
    updated_at,
    author,
    slug
  );
  return { slug, version, status: "promoted" };
}

/** Stage an agent-proposed milestone create/update for human review (mirrors doc_versions). */
export async function stage_milestone_proposal(
  db: DB,
  proposal: { title: string; target_date: string; status: string; github_ref?: number | number[]; change_summary: string; confidence: "high" | "low" },
  author: string,
  contentHash?: string | null
): Promise<number> {
  const github_ref = proposal.github_ref === undefined ? null : JSON.stringify(proposal.github_ref);
  const res = await run(
    db,
    `INSERT INTO milestone_proposals (title, target_date, status, github_ref, change_summary, confidence, staged_status, created_at, created_by, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, 'staged', ?, ?, ?)`,
    proposal.title,
    proposal.target_date,
    proposal.status,
    github_ref,
    proposal.change_summary,
    proposal.confidence,
    nowIso(),
    author,
    contentHash ?? null
  );
  return res.meta.last_row_id as number;
}

/** Human confirmation: ratify an ADR draft. Rejects if missing or already ratified. */
export async function ratify_adr(db: DB, id: number): Promise<{ id: number; status: "ratified" }> {
  const adr = await first<AdrRow>(db, `SELECT * FROM adrs WHERE id = ?`, id);
  if (!adr) throw new Error(`no such adr: ${id}`);
  if (adr.status === "ratified") throw new Error(`adr already ratified: ${id}`);
  await run(db, `UPDATE adrs SET status = 'ratified' WHERE id = ?`, id);
  return { id, status: "ratified" };
}

/** Human confirmation: turn a staged milestone proposal into a live roadmap milestone. */
export async function promote_milestone_proposal(db: DB, id: number, author: string): Promise<MilestoneRow> {
  const p = await first<MilestoneProposalRow>(db, `SELECT * FROM milestone_proposals WHERE id = ?`, id);
  if (!p) throw new Error(`no such milestone proposal: ${id}`);
  if (p.staged_status === "promoted") throw new Error(`milestone proposal already promoted: ${id}`);

  // Atomically claim the proposal: the conditional UPDATE is the gate, so two
  // concurrent promotes cannot both pass and create duplicate live milestones.
  const claim = await run(
    db,
    `UPDATE milestone_proposals SET staged_status = 'promoted' WHERE id = ? AND staged_status = 'staged'`,
    id
  );
  if ((claim.meta.changes ?? 0) === 0) throw new Error(`milestone proposal already promoted: ${id}`);

  const now = nowIso();
  const res = await run(
    db,
    `INSERT INTO milestones (title, description, target_date, status, github_ref, created_at, created_by, updated_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
    p.title,
    p.target_date,
    p.status,        // the gate guarantees this is never 'done'
    p.github_ref,
    now,
    author,
    now
  );
  const milestoneId = res.meta.last_row_id as number;
  return (await first<MilestoneRow>(db, `SELECT * FROM milestones WHERE id = ?`, milestoneId))!;
}

/** Human confirmation: flip a live milestone to 'done'. Rejects if missing or already done. */
export async function complete_milestone(db: DB, id: number): Promise<MilestoneRow> {
  const m = await first<MilestoneRow>(db, `SELECT * FROM milestones WHERE id = ?`, id);
  if (!m) throw new Error(`no such milestone: ${id}`);
  if (m.status === "done") throw new Error(`milestone already done: ${id}`);
  const updated_at = nowIso();
  await run(db, `UPDATE milestones SET status = 'done', updated_at = ? WHERE id = ?`, updated_at, id);
  return { ...m, status: "done", updated_at };
}

// ── Phase 3 — triage write-back (soft only; nothing here hard-deletes) ─────────

/**
 * Reject a staged doc version: soft status flip to 'rejected' so it leaves the
 * proposals queue. Non-destructive (the row and its body remain) and
 * idempotent-safe: a second reject on an already-rejected version is a no-op.
 */
export async function reject_doc_version(
  db: DB,
  slug: string,
  version: number
): Promise<{ slug: string; version: number; status: "rejected" }> {
  const ver = await first<DocVersionRow>(
    db,
    `SELECT * FROM doc_versions WHERE slug = ? AND version = ?`,
    slug,
    version
  );
  if (!ver) throw new Error(`no such doc version: ${slug} v${version}`);
  if (ver.status === "rejected") return { slug, version, status: "rejected" }; // idempotent
  if (ver.status !== "staged") throw new Error(`cannot reject ${slug} v${version}: it is ${ver.status}`);
  await run(db, `UPDATE doc_versions SET status = 'rejected' WHERE slug = ? AND version = ?`, slug, version);
  return { slug, version, status: "rejected" };
}

/**
 * Reject an ADR draft: soft status flip to 'rejected' so it leaves the decisions
 * queue. Idempotent-safe: a second reject on an already-rejected draft is a no-op.
 */
export async function reject_adr(db: DB, id: number): Promise<{ id: number; status: "rejected" }> {
  const adr = await first<AdrRow>(db, `SELECT * FROM adrs WHERE id = ?`, id);
  if (!adr) throw new Error(`no such adr: ${id}`);
  if (adr.status === "rejected") return { id, status: "rejected" }; // idempotent
  if (adr.status !== "draft") throw new Error(`cannot reject adr ${id}: it is ${adr.status}`);
  await run(db, `UPDATE adrs SET status = 'rejected' WHERE id = ?`, id);
  return { id, status: "rejected" };
}

/** Soft-reject a staged milestone proposal (mirrors reject_adr): flip staged_status to
 *  'rejected' so it leaves the queue (list_milestone_proposals filters to 'staged'); the
 *  row remains. Idempotent; a promoted proposal cannot be rejected. */
export async function reject_milestone_proposal(db: DB, id: number): Promise<{ id: number; status: "rejected" }> {
  const p = await first<MilestoneProposalRow>(db, `SELECT * FROM milestone_proposals WHERE id = ?`, id);
  if (!p) throw new Error(`no such milestone proposal: ${id}`);
  if (p.staged_status === "rejected") return { id, status: "rejected" }; // idempotent
  if (p.staged_status !== "staged") throw new Error(`cannot reject milestone proposal ${id}: it is ${p.staged_status}`);
  await run(db, `UPDATE milestone_proposals SET staged_status = 'rejected' WHERE id = ?`, id);
  return { id, status: "rejected" };
}

/**
 * Resolve a triage item: set the audit columns + flip `resolved` so it leaves the
 * queue. Soft only — the row remains. Idempotent-safe: resolving an
 * already-resolved item returns its recorded resolution without re-writing.
 */
export async function resolve_triage(
  db: DB,
  id: number,
  by: string,
  resolution: "assigned" | "discarded" = "discarded",
  assigned_ref: string | null = null
): Promise<{ id: number; resolution: "assigned" | "discarded"; assigned_ref: string | null }> {
  const row = await first<NeedsTriageRow>(db, `SELECT * FROM needs_triage WHERE id = ?`, id);
  if (!row) throw new Error(`no such triage item: ${id}`);
  if (row.resolved) {
    // Already resolved — idempotent no-op, surface what it became.
    return { id, resolution: row.resolution ?? resolution, assigned_ref: row.assigned_ref };
  }
  await run(
    db,
    `UPDATE needs_triage SET resolved = 1, resolved_at = ?, resolved_by = ?, resolution = ?, assigned_ref = ? WHERE id = ?`,
    nowIso(),
    by,
    resolution,
    assigned_ref,
    id
  );
  return { id, resolution, assigned_ref };
}

export type AssignType = "doc" | "adr" | "milestone" | "feed";
export interface AssignTarget {
  type?: AssignType;
  section?: string;          // doc: the corrected section (the human's placement)
  space?: "technical" | "product";
  tags?: string[];           // feed: corrected tags
}

/**
 * Assign-materialize a triaged item: parse its `raw`, re-run it through the SAME
 * gate path for the target type (so it is vocab-checked + reconciled exactly like
 * a normal write — never hand-inserted), then resolve the triage item as
 * 'assigned' with assigned_ref pointing at what it became.
 *
 * The author is the authenticated principal (`by`). Confidence is forced 'high'
 * because the human's act of assigning vouches for the item. The cheap pre-checks
 * mirror the gate's only triage triggers (so a high-confidence assign cannot loop
 * back into the queue and leave a stray duplicate triage row). Idempotent-safe: a
 * second assign on an already-resolved item materializes nothing new.
 */
export async function assign_triage(
  db: DB,
  id: number,
  by: string,
  target: AssignTarget = {}
): Promise<{ id: number; resolution: "assigned" | "discarded"; assigned_ref: string }> {
  const row = await first<NeedsTriageRow>(db, `SELECT * FROM needs_triage WHERE id = ?`, id);
  if (!row) throw new Error(`no such triage item: ${id}`);
  if (row.resolved) {
    // Idempotent: surface the ACTUAL recorded resolution, stage nothing new.
    return { id, resolution: row.resolution ?? "assigned", assigned_ref: row.assigned_ref ?? "" };
  }

  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    raw = parsed as Record<string, unknown>;
  } catch {
    throw new Error("cannot assign a free-form triage item; discard it instead");
  }

  const type: AssignType = target.type ?? "doc";
  // A fresh ledger so the materialization is reconciled on its own merits (never a replay).
  const ledger = { sessionId: crypto.randomUUID(), itemIndex: 0 };
  let assigned_ref: string;

  if (type === "doc") {
    const section = target.section ?? (raw.section as string | undefined);
    if (!section || !isSection(section)) throw new Error("a valid section is required to place this as a doc");
    const proposal = DocProposal.parse({
      ...raw,
      section,
      confidence: "high",            // human-vouched on assign
      space: target.space ?? (raw.space as "technical" | "product" | undefined),
    });
    const r = await ingestDocProposal(db, proposal, by, ledger);
    if (r.outcome === "triaged") throw new Error(`could not place doc: ${r.reason}`);
    assigned_ref = r.outcome === "written" ? `doc:${r.slug}@${r.version}` : `doc:${r.slug ?? proposal.slug}`;
  } else if (type === "adr") {
    const draft = AdrDraft.parse({ ...raw, confidence: "high" });
    const r = await ingestAdrDraft(db, draft, by, ledger);
    if (r.outcome === "triaged") throw new Error(`could not place decision: ${r.reason}`);
    assigned_ref = `adr:${r.id}`;
  } else if (type === "milestone") {
    if (raw.status === "done") throw new Error("completing a milestone is a separate action, not an assignment");
    const proposal = MilestoneProposal.parse({ ...raw, confidence: "high" });
    const r = await ingestMilestoneProposal(db, proposal, by, ledger);
    if (r.outcome === "triaged") throw new Error(`could not place milestone: ${r.reason}`);
    assigned_ref = `milestone:${r.id}`;
  } else {
    const entry = FeedEntry.parse({ ...raw, tags: target.tags ?? (raw.tags as string[] | undefined) ?? [] });
    const unknown = entry.tags.filter((t) => !isTag(t));
    if (unknown.length > 0) throw new Error(`unknown tag: ${unknown.join(", ")} — pick valid tags to place this`);
    const r = await ingestFeedEntry(db, entry, by, ledger);
    if (r.outcome === "triaged") throw new Error(`could not place feed entry: ${r.reason}`);
    assigned_ref = r.outcome === "written" ? `feed:${r.id}` : "feed:unchanged";
  }

  await resolve_triage(db, id, by, "assigned", assigned_ref);
  return { id, resolution: "assigned", assigned_ref };
}
