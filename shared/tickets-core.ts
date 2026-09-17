// The ZOD-FREE core of the tickets contract: the controlled vocabulary tuples and
// the status machine. `shared/tickets.ts` builds its Zod schemas on top of these
// and RE-EXPORTS every one of them, so nothing outside this file has to know the
// split — `import { legalMoves } from "@shared/tickets"` keeps working.
//
// Why the split: the SPA needs the RULE (which moves are legal, what a status is
// called, which categories exist) as VALUES at runtime, and `web/` importing a
// module that evaluates `z.object(...)` at load time drags the whole of zod into
// the browser bundle (+70 kB minified, measured). Every other web ↔ shared seam is
// type-only for exactly that reason. This module has no imports at all, so the
// SPA gets the one shared definition of the status machine for free.
//
// The status machine is declared ONCE, here, and enforced everywhere: the routes
// (`transition_ticket`), the MCP reads, and the detail screen's transition buttons
// all read the same table.

// ── controlled vocabulary (must match the CHECK constraints in 0024_tickets.sql) ─

export const TICKET_CATEGORIES = ["bug", "request", "question", "access", "other"] as const;
export const TICKET_PRIORITIES = ["low", "normal", "high"] as const;
export const TICKET_STATUSES = ["submitted", "in_progress", "done", "declined"] as const;
export const TICKET_LINK_KINDS = ["github", "figma", "plain"] as const;

export type TicketCategory = (typeof TICKET_CATEGORIES)[number];
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type TicketLinkKind = (typeof TICKET_LINK_KINDS)[number];

// ── the status machine (ONE definition, enforced everywhere) ─────────────────
// A status is SET by a person, from the status control itself — there are no
// accept/reject action buttons, and assignment never implies a status (an
// assignee is assigned, full stop). The table is what the control may offer:
//
// submitted   → in_progress | declined
// in_progress → done | declined | submitted     (declined WITHOUT going back first)
// done, declined are terminal — a resolved ticket is not re-opened.
//
// The order here is the pipeline's, which is the order the control lists them in.

export const TICKET_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  submitted: ["in_progress", "declined"],
  in_progress: ["done", "declined", "submitted"],
  done: [],
  declined: [],
};

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return TICKET_TRANSITIONS[from].includes(to);
}

/** The moves the UI may offer from `status` (a copy — callers never mutate the table). */
export function legalMoves(status: TicketStatus): TicketStatus[] {
  return [...TICKET_TRANSITIONS[status]];
}

/** The DISPLAY vocabulary — the DB values never change. `submitted` reads
 *  "Triage" because that is what the state is for a reader: filed, waiting for
 *  a person to pick it up or decide against it. It is deliberately NOT called
 *  "Open" (the queue's `seg=open` covers `submitted` AND `in_progress`, so one
 *  status owning that word would contradict `isOpenStatus`) and not "Backlog"
 *  (a sprint-less ticket is already in the Backlog group). */
export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  submitted: "Triage",
  in_progress: "In progress",
  done: "Done",
  declined: "Declined",
};

/** Open = the `seg=open` segment = not yet resolved by a person. */
export function isOpenStatus(s: TicketStatus): boolean {
  return s === "submitted" || s === "in_progress";
}
