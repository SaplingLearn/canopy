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
// submitted → in_progress (Start) | declined
// in_progress → done | submitted (Back)
// done, declined are terminal.

export const TICKET_TRANSITIONS: Record<TicketStatus, TicketStatus[]> = {
  submitted: ["in_progress", "declined"],
  in_progress: ["done", "submitted"],
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

export const TICKET_STATUS_LABEL: Record<TicketStatus, string> = {
  submitted: "Submitted",
  in_progress: "In progress",
  done: "Done",
  declined: "Declined",
};

/** Open = the `seg=open` segment = not yet resolved by a person. */
export function isOpenStatus(s: TicketStatus): boolean {
  return s === "submitted" || s === "in_progress";
}
