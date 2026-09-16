// The tickets contract — the ONE place the Worker (src/) and the SPA (web/) agree
// on ticket shapes, the status machine, and link parsing. Zod only: no DOM, no
// node built-ins, so it imports cleanly into both builds.
//
// Authority: tickets are human authored writes in the promote class. Nothing here
// is staged and nothing here is inferred — `done` / `declined` are set by a person.
// Person-bearing fields (`requester`, assignee `login`, `created_by`, `author`,
// `actor`) hold a person HANDLE (0023 identity root), never a GitHub login.

import { z } from "zod";

// ── controlled vocabulary (must match the CHECK constraints in 0024_tickets.sql) ─

export const TICKET_CATEGORIES = ["bug", "request", "question", "access", "other"] as const;
export const TICKET_PRIORITIES = ["low", "normal", "high"] as const;
export const TICKET_STATUSES = ["submitted", "in_progress", "done", "declined"] as const;
export const TICKET_LINK_KINDS = ["github", "figma", "plain"] as const;

export const TicketCategory = z.enum(TICKET_CATEGORIES);
export const TicketPriority = z.enum(TICKET_PRIORITIES);
export const TicketStatus = z.enum(TICKET_STATUSES);
export const TicketLinkKind = z.enum(TICKET_LINK_KINDS);

export type TicketCategory = z.infer<typeof TicketCategory>;
export type TicketPriority = z.infer<typeof TicketPriority>;
export type TicketStatus = z.infer<typeof TicketStatus>;
export type TicketLinkKind = z.infer<typeof TicketLinkKind>;

// ── rows (one schema per D1 table in 0024_tickets.sql) ───────────────────────

export const TicketRow = z.object({
  id: z.number(),
  title: z.string(),
  body: z.string(),
  category: TicketCategory,
  priority: TicketPriority,
  status: TicketStatus,
  requester: z.string(),              // person handle
  parent_id: z.number().nullable(),   // one level only (enforced in the route)
  sprint_id: z.number().nullable(),   // NULL = backlog
  created_at: z.string(),
  updated_at: z.string(),
});

export const TicketAssigneeRow = z.object({
  ticket_id: z.number(),
  login: z.string(),                  // person handle (column name kept from the brief)
});

export const TicketLinkRow = z.object({
  id: z.number(),
  ticket_id: z.number(),
  url: z.string(),
  kind: TicketLinkKind,
  label: z.string(),
  meta: z.string(),
  created_by: z.string(),             // person handle
  created_at: z.string(),
});

export const TicketCommentRow = z.object({
  id: z.number(),
  ticket_id: z.number(),
  author: z.string(),                 // person handle
  body: z.string(),
  created_at: z.string(),
});

export const TicketEventRow = z.object({
  id: z.number(),
  ticket_id: z.number(),
  actor: z.string(),                  // person handle
  from_status: TicketStatus.nullable(),  // NULL on the opening row
  to_status: TicketStatus,
  created_at: z.string(),
});

export type TicketRow = z.infer<typeof TicketRow>;
export type TicketAssigneeRow = z.infer<typeof TicketAssigneeRow>;
export type TicketLinkRow = z.infer<typeof TicketLinkRow>;
export type TicketCommentRow = z.infer<typeof TicketCommentRow>;
export type TicketEventRow = z.infer<typeof TicketEventRow>;

// ── DTOs (what the routes return) ────────────────────────────────────────────

/** One row of the queue list. Counts are server-joined — the UI never N+1s. */
export type TicketListItem = TicketRow & {
  assignees: string[];                // person handles
  link_count: number;
  sub_count: number;                  // direct children
  sprint_label: string | null;        // NULL = backlog
};

/** A ticket referenced from another ticket (parent line / sub-ticket list). */
export interface TicketRef {
  id: number;
  title: string;
  status: TicketStatus;
}

export type TicketDetail = TicketRow & {
  assignees: string[];
  links: TicketLinkRow[];
  comments: TicketCommentRow[];
  events: TicketEventRow[];
  parent: TicketRef | null;
  children: TicketRef[];
  sprint: { id: number; label: string } | null;
};

// ── payloads (request bodies; the routes validate with these) ────────────────

export const TicketCreate = z.object({
  title: z.string().min(1),           // the only required field
  body: z.string().default(""),
  category: TicketCategory.default("other"),
  priority: TicketPriority.default("normal"),
  assignees: z.array(z.string()).default([]),
  sprint_id: z.number().nullable().optional(),   // absent/null = backlog
  link: z.string().optional(),        // raw; parsed with parseTicketLink on create
});

export const TicketTransition = z.object({ to: TicketStatus });
export const TicketAssigneeToggle = z.object({ login: z.string().min(1), on: z.boolean() });
export const TicketLinkAdd = z.object({ raw: z.string().min(1) });
export const TicketSprintSet = z.object({ sprint_id: z.number().nullable() });
export const TicketParentSet = z.object({ child_id: z.number() });
export const TicketCommentAdd = z.object({ body: z.string().trim().min(1) });

export type TicketCreate = z.infer<typeof TicketCreate>;
export type TicketTransition = z.infer<typeof TicketTransition>;
export type TicketAssigneeToggle = z.infer<typeof TicketAssigneeToggle>;
export type TicketLinkAdd = z.infer<typeof TicketLinkAdd>;
export type TicketSprintSet = z.infer<typeof TicketSprintSet>;
export type TicketParentSet = z.infer<typeof TicketParentSet>;
export type TicketCommentAdd = z.infer<typeof TicketCommentAdd>;

// ── list filters ─────────────────────────────────────────────────────────────

export const TicketSeg = z.enum(["open", "closed", "all"]);
export const TicketAssigneeFilter = z.enum(["anyone", "me", "unassigned"]);

export type TicketSeg = z.infer<typeof TicketSeg>;
export type TicketAssigneeFilter = z.infer<typeof TicketAssigneeFilter>;

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

// ── link parsing (shared so the SPA and the server agree) ────────────────────

export const DEFAULT_TICKET_REPO = "SaplingLearn/sapling";

export interface ParsedLink {
  url: string;
  kind: TicketLinkKind;
  label: string;
  meta: string;
}

/**
 * Resolve one raw link input into the stored {url, kind, label, meta}.
 *
 * Behaviorally the locked design's `parseLink` (Canopy Tickets.dc.html), shape
 * for shape:
 *   - trims; empty → null
 *   - no http(s) prefix → a bare issue ref: `https://github.com/<repo>/issues/<n>`
 *     (a leading `#` is stripped, so `#214` and `214` are the same input)
 *   - github.com/<owner>/<repo>/(issues|pull)/<n> → kind github, label `<repo> #<n>`,
 *     meta `GITHUB · ISSUE` / `GITHUB · PULL REQUEST`
 *   - any other github.com URL → kind github, label = the path after github.com/
 *     (40 chars), meta `GITHUB`
 *   - figma.com → kind figma, label = the last path segment humanized, meta `FIGMA · DESIGN`
 *   - anything else → kind plain, label = the hostname sans `www.`, meta `LINK`
 *
 * TWO deliberate deltas from the design, both additions rather than changes:
 *   1. an absolute URI with any scheme other than http/https (`javascript:`,
 *      `data:`, `mailto:` …) returns null instead of being pasted into an issue
 *      URL — the design ran in a sandbox, this value reaches an href;
 *   2. the http(s) test is case-insensitive, so `HTTPS://…` is treated as the URL
 *      it obviously is rather than as an issue ref.
 */
export function parseTicketLink(raw: string, repo: string = DEFAULT_TICKET_REPO): ParsedLink | null {
  const v = raw.trim();
  if (!v) return null;

  let url: string;
  if (/^https?:/i.test(v)) url = v;
  else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(v)) return null;   // some other scheme — never dereference it
  else url = `https://github.com/${repo}/issues/${v.replace(/^#/, "")}`;

  const m = url.match(/github\.com\/[^/]+\/([^/]+)\/(issues|pull)\/(\d+)/);
  if (m) {
    return {
      url,
      kind: "github",
      label: `${m[1]} #${m[3]}`,
      meta: `GITHUB · ${m[2] === "pull" ? "PULL REQUEST" : "ISSUE"}`,
    };
  }

  if (url.includes("github.com")) {
    return {
      url,
      kind: "github",
      label: url.replace(/^https?:\/\/github\.com\//, "").slice(0, 40) || "GitHub",
      meta: "GITHUB",
    };
  }

  if (url.includes("figma.com")) {
    const seg = (url.split("/").filter(Boolean).pop() || "Design file").split("?")[0].replace(/[-_]+/g, " ");
    return { url, kind: "figma", label: seg.charAt(0).toUpperCase() + seg.slice(1), meta: "FIGMA · DESIGN" };
  }

  let host = "link";
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* unparseable — keep the fallback */ }
  return { url, kind: "plain", label: host, meta: "LINK" };
}
