// The MCP ticket WRITE surface — the agent's lane, and the one place it is drawn.
//
// Tickets are authored writes in the promote class (see ./tickets.ts). Nothing
// here changes that: every function below delegates to the SAME writer the cookie
// route calls, so the transition table, the nesting rules, handle validation and
// the `ticket_events` audit rows are shared with the web UI. What this module adds
// — and all it adds — is SCOPE:
//
//   An agent writes only inside its principal's own lane. A ticket write over MCP
//   is permitted exactly when the bearer principal is already an assignee of that
//   ticket. Filing a new ticket is the one unscoped write.
//
// Why assignment is the boundary (design D2): the queue already states "this is
// yours" by assigning it, by hand, in the web UI. Scoping to that needs no new
// concept, no new column and no new screen — and it is why there is deliberately
// NO `toggle_assignee` here (design D3). An agent that could edit the assignee
// list could edit its own permissions; assignment stays a human act, reachable
// only through `create_ticket`'s `assignees` at filing time.
//
// The bearer token IS the person (design D1), so inside that lane the parity with
// the ticket screen is total — `done` and `declined` included. The fourth tickets
// invariant is untouched by that: it says nothing INFERS a resolution (not a PR
// merging, not an issue closing, not the cron), and an agent calling
// transition_ticket under a person's token on that person's ticket is the person
// saying so.
//
// TWO rules hold across every function here:
//   1. Scope is asserted BEFORE the first mutation, never between two. D1 has no
//      transaction on this path, so a refusal must leave the database untouched.
//   2. 404 before 403 — an unknown ticket id is `not_found`, never `forbidden`.
//      The scope check must not double as an existence oracle.

import type { Env } from "../env";
import { isAdmin } from "../auth/principal";
import { type DB, first } from "../db";
import {
  TicketError,
  create_ticket, transition_ticket, add_ticket_comment, add_ticket_link,
  set_ticket_sprint, set_ticket_parent,
} from "./tickets";
import type { TicketCreate, TicketStatus } from "@shared/tickets";

/** The scoped verbs. `create_ticket` is absent on purpose — it is the unscoped write. */
export type AgentVerb =
  | "transition_ticket"
  | "add_ticket_comment"
  | "add_ticket_link"
  | "set_ticket_sprint"
  | "set_ticket_parent";

/**
 * The lane rule, in one function.
 *
 * Throws `not_found` for an unknown ticket (checked FIRST, so a non-assignee
 * cannot use a 403 to learn that an id exists), then `forbidden` unless the
 * handle is among the ticket's assignees.
 *
 * ONE exception (design D6): an admin may `set_ticket_sprint` on any ticket.
 * Composing a sprint is sprint management, which is admin territory already
 * (the plan write and the four sprint verbs), and without it "edit sprints over
 * MCP" is half a feature — an admin could create the container and never fill
 * it. It is a `sprint_id` move and nothing else: it never resolves, comments on,
 * re-assigns or re-parents someone else's ticket. Deleting the exception is
 * deleting the one `if` below.
 *
 * Handles compare COLLATE NOCASE, matching `persons.handle` and the ticket reads,
 * so a case variant can never widen or narrow a lane.
 */
export async function assertTicketWritable(
  db: DB,
  env: Env,
  id: number,
  handle: string,
  verb: AgentVerb,
): Promise<void> {
  const exists = await first<{ id: number }>(db, `SELECT id FROM tickets WHERE id = ?`, id);
  if (!exists) throw new TicketError("not_found", `no such ticket: ${id}`);

  if (verb === "set_ticket_sprint" && isAdmin(env, handle)) return;

  const mine = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM ticket_assignees WHERE ticket_id = ? AND login = ? COLLATE NOCASE`,
    id,
    handle,
  );
  if (!(mine?.n ?? 0)) {
    throw new TicketError("forbidden", `ticket ${id} is not assigned to you — assignment is done by a person in the web UI`);
  }
}

// ── the six wrappers: assert, then delegate ──────────────────────────────────
//
// Each is one line of scope and one line of work. `src/mcp.ts` imports ONLY from
// this module for ticket writes, so a verb cannot reach the MCP surface without
// passing through the assertion above.

/**
 * File a ticket — THE ONE UNSCOPED WRITE (design D2). It asserts nothing because
 * there is no ticket yet to be assigned to anyone.
 *
 * `input.assignees` is the only agent-reachable assignment in Canopy (design D3).
 * An agent MAY name its own principal there and thereby unlock every scoped verb
 * on the ticket it just filed (design D10, accepted): every field it could later
 * change it could have set here, and the ticket is one it opened. That is the
 * whole of the escalation, and it is named rather than hidden.
 */
export function agentCreateTicket(db: DB, input: TicketCreate, requester: string): Promise<number> {
  return create_ticket(db, input, requester);
}

export async function agentTransitionTicket(db: DB, env: Env, id: number, to: TicketStatus, actor: string): Promise<void> {
  await assertTicketWritable(db, env, id, actor, "transition_ticket");
  await transition_ticket(db, id, to, actor);
}

export async function agentAddTicketComment(db: DB, env: Env, id: number, body: string, author: string): Promise<number> {
  await assertTicketWritable(db, env, id, author, "add_ticket_comment");
  return add_ticket_comment(db, id, body, author);
}

export async function agentAddTicketLink(db: DB, env: Env, id: number, raw: string, by: string): Promise<number> {
  await assertTicketWritable(db, env, id, by, "add_ticket_link");
  return add_ticket_link(db, id, raw, by);
}

export async function agentSetTicketSprint(db: DB, env: Env, id: number, sprintId: number | null, actor: string): Promise<void> {
  await assertTicketWritable(db, env, id, actor, "set_ticket_sprint");
  await set_ticket_sprint(db, id, sprintId);
}

/**
 * Nest one ticket under another. The lane is required on BOTH ids: the call writes
 * `child.parent_id` AND bumps the parent's `updated_at` (its sub-ticket count
 * changed), so both rows are the subject of the write. The conservative reading,
 * and the easy one to relax — drop the second assertion.
 */
export async function agentSetTicketParent(db: DB, env: Env, parentId: number, childId: number, actor: string): Promise<void> {
  await assertTicketWritable(db, env, parentId, actor, "set_ticket_parent");
  await assertTicketWritable(db, env, childId, actor, "set_ticket_parent");
  await set_ticket_parent(db, parentId, childId);
}
