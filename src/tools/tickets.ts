// Ticket writers — DIRECT AUTHORED WRITES, in the promote class.
//
// Nothing here goes through `consume()` / the ingestion gate: a ticket is filed
// by a signed-in human through a cookie route, so there is no vocabulary to
// police, no confidence to weigh, no staged state to confirm. `done` / `declined`
// are set here only because a person asked for them — never inferred from a PR
// merging or an issue closing (the brief's fourth invariant).
//
// Two rules hold across every function in this file:
//   1. Every write bumps `tickets.updated_at` — the queue is sorted by it, so a
//      comment, an assignment or a link has to move the ticket the same way a
//      status change does.
//   2. Every person-bearing value is a person HANDLE (0023 identity root),
//      canonicalized through `persons.handle` so a case variant can never create
//      a second, unrenameable spelling of the same person.
//
// The status machine is NOT re-declared here: `canTransition` in shared/tickets.ts
// is the one table, shared with the SPA.

import type { TicketCreate, TicketStatus } from "@shared/tickets";
import { canTransition, parseTicketLink } from "@shared/tickets";
import type { TicketRow } from "@shared/rows";
import { type DB, first, run, nowIso } from "../db";
import { getPerson } from "../auth/persons";

/**
 * A typed failure the routes map onto an HTTP status:
 *   not_found   → 404 (unknown ticket / sprint / …)
 *   conflict    → 409 (an illegal status move, a nesting rule)
 *   bad_request → 400 (an unknown assignee handle, an unusable link, an empty comment)
 * Everything else is a real 500.
 */
export class TicketError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "bad_request", message: string) {
    super(message);
    this.name = "TicketError";
  }
}

export const TICKET_ERROR_STATUS = { not_found: 404, conflict: 409, bad_request: 400 } as const;

const getTicketRow = async (db: DB, id: number): Promise<TicketRow> => {
  const t = await first<TicketRow>(db, `SELECT * FROM tickets WHERE id = ?`, id);
  if (!t) throw new TicketError("not_found", `no such ticket: ${id}`);
  return t;
};

/** Bump `updated_at` on a ticket. Called by EVERY writer below — the queue's sort key. */
const touch = (db: DB, id: number, at: string) => run(db, `UPDATE tickets SET updated_at = ? WHERE id = ?`, at, id);

/** Resolve a handle to its canonical `persons.handle` spelling, or 400. */
async function requirePerson(db: DB, handle: string): Promise<string> {
  const p = await getPerson(db, handle);
  if (!p) throw new TicketError("bad_request", `no such person: ${handle}`);
  return p.handle;
}

/** An explicit sprint must exist (the column is a soft INTEGER ref — 0024 could not FK it). */
async function requireSprint(db: DB, sprintId: number): Promise<void> {
  const sp = await first<{ id: number }>(db, `SELECT id FROM sprints WHERE id = ?`, sprintId);
  if (!sp) throw new TicketError("not_found", `no such sprint: ${sprintId}`);
}

/** Parse a raw link input, or 400. A blank raw is the caller's business, not this helper's. */
function requireParsedLink(raw: string) {
  const parsed = parseTicketLink(raw);
  if (!parsed) throw new TicketError("bad_request", `unusable link: ${raw}`);
  return parsed;
}

/**
 * File a ticket. The requester is ALWAYS the authenticated principal — a
 * client-supplied requester is not read by this function at all.
 *
 * Writes, in one logical unit: the ticket row (status 'submitted'), its
 * assignees, the OPENING `ticket_events` row (from_status NULL → 'submitted',
 * which the detail screen renders as "opened · SUBMITTED"), and the parsed link
 * when one was given.
 */
export async function create_ticket(db: DB, input: TicketCreate, requester: string): Promise<number> {
  const author = await requirePerson(db, requester);
  // Validate everything BEFORE the first insert: a bad assignee or sprint must
  // not leave a half-built ticket behind (D1 has no transaction here).
  const assignees: string[] = [];
  for (const a of input.assignees) {
    const handle = await requirePerson(db, a);
    if (!assignees.includes(handle)) assignees.push(handle);
  }
  const sprintId = input.sprint_id ?? null;
  if (sprintId !== null) await requireSprint(db, sprintId);
  const rawLink = (input.link ?? "").trim();
  const link = rawLink ? requireParsedLink(rawLink) : null;

  const now = nowIso();
  const res = await run(
    db,
    `INSERT INTO tickets (title, body, category, priority, status, requester, parent_id, sprint_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'submitted', ?, NULL, ?, ?, ?)`,
    input.title,
    input.body,
    input.category,
    input.priority,
    author,
    sprintId,
    now,
    now
  );
  const id = res.meta.last_row_id as number;

  for (const handle of assignees) {
    await run(db, `INSERT OR IGNORE INTO ticket_assignees (ticket_id, login) VALUES (?, ?)`, id, handle);
  }

  // The opening history row. Every later status change appends one more.
  await run(
    db,
    `INSERT INTO ticket_events (ticket_id, actor, from_status, to_status, created_at) VALUES (?, ?, NULL, 'submitted', ?)`,
    id,
    author,
    now
  );

  if (link) {
    await run(
      db,
      `INSERT INTO ticket_links (ticket_id, url, kind, label, meta, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id, link.url, link.kind, link.label, link.meta, author, now
    );
  }

  return id;
}

/**
 * Move a ticket's status. The move must be legal per `canTransition` (the ONE
 * table in shared/tickets.ts) — an illegal one throws and writes NOTHING, not
 * even the history row.
 */
export async function transition_ticket(db: DB, id: number, to: TicketStatus, actor: string): Promise<void> {
  const t = await getTicketRow(db, id);
  const who = await requirePerson(db, actor);
  if (!canTransition(t.status, to)) {
    throw new TicketError("conflict", `illegal transition: ${t.status} → ${to}`);
  }
  const now = nowIso();
  await run(
    db,
    `INSERT INTO ticket_events (ticket_id, actor, from_status, to_status, created_at) VALUES (?, ?, ?, ?, ?)`,
    id, who, t.status, to, now
  );
  await run(db, `UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?`, to, now, id);
}

/**
 * Add or remove one assignee. Idempotent by construction (INSERT OR IGNORE on the
 * (ticket_id, login) PK / an unconditional DELETE), because the design's picker
 * toggles with no confirm step and may fire twice.
 */
export async function toggle_assignee(db: DB, id: number, login: string, on: boolean): Promise<void> {
  await getTicketRow(db, id);
  const handle = await requirePerson(db, login);
  if (on) {
    await run(db, `INSERT OR IGNORE INTO ticket_assignees (ticket_id, login) VALUES (?, ?)`, id, handle);
  } else {
    await run(db, `DELETE FROM ticket_assignees WHERE ticket_id = ? AND login = ?`, id, handle);
  }
  await touch(db, id, nowIso());
}

/** Attach one linked-work reference, parsed by the SHARED parser the SPA also uses. */
export async function add_ticket_link(db: DB, id: number, raw: string, by: string): Promise<number> {
  await getTicketRow(db, id);
  const who = await requirePerson(db, by);
  const link = requireParsedLink(raw);
  const now = nowIso();
  const res = await run(
    db,
    `INSERT INTO ticket_links (ticket_id, url, kind, label, meta, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id, link.url, link.kind, link.label, link.meta, who, now
  );
  await touch(db, id, now);
  return res.meta.last_row_id as number;
}

/** Move a ticket into a sprint, or back to the backlog (`null`). */
export async function set_ticket_sprint(db: DB, id: number, sprintId: number | null): Promise<void> {
  await getTicketRow(db, id);
  if (sprintId !== null) await requireSprint(db, sprintId);
  const now = nowIso();
  await run(db, `UPDATE tickets SET sprint_id = ?, updated_at = ? WHERE id = ?`, sprintId, now, id);
}

/**
 * Nest `childId` under `parentId`. Tickets nest EXACTLY ONE level, so four
 * rejections guard the write (plus the degenerate self-parent):
 *   - the parent itself has a parent      → that would be level two
 *   - the child already has a parent      → it is already nested somewhere
 *   - the child is done/declined          → closed work is not re-filed under a parent
 *   - the child has children of its own   → it is a parent, and would become level two
 * Every rejection leaves the database untouched.
 */
export async function set_ticket_parent(db: DB, parentId: number, childId: number): Promise<void> {
  const parent = await getTicketRow(db, parentId);
  const child = await getTicketRow(db, childId);

  if (parent.id === child.id) throw new TicketError("conflict", "a ticket cannot be its own sub-ticket");
  if (parent.parent_id !== null) throw new TicketError("conflict", "tickets nest one level: this ticket already has a parent");
  if (child.parent_id !== null) throw new TicketError("conflict", "that ticket already has a parent");
  if (child.status === "done" || child.status === "declined") throw new TicketError("conflict", "that ticket is closed");
  const kids = await first<{ n: number }>(db, `SELECT COUNT(*) AS n FROM tickets WHERE parent_id = ?`, child.id);
  if ((kids?.n ?? 0) > 0) throw new TicketError("conflict", "that ticket has sub-tickets of its own");

  const now = nowIso();
  await run(db, `UPDATE tickets SET parent_id = ?, updated_at = ? WHERE id = ?`, parent.id, now, child.id);
  // The parent's sub-ticket count changed, so it is a write on the parent too.
  await touch(db, parent.id, now);
}

/** Append one comment. The body is trimmed and must survive it (min 1 char). */
export async function add_ticket_comment(db: DB, id: number, body: string, author: string): Promise<number> {
  await getTicketRow(db, id);
  const who = await requirePerson(db, author);
  const text = body.trim();
  if (!text) throw new TicketError("bad_request", "comment body is empty");
  const now = nowIso();
  const res = await run(
    db,
    `INSERT INTO ticket_comments (ticket_id, author, body, created_at) VALUES (?, ?, ?, ?)`,
    id, who, text, now
  );
  await touch(db, id, now);
  return res.meta.last_row_id as number;
}
