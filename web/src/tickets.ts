// Tickets surface — componentized from `Canopy Tickets.dc.html` (the locked
// design): the queue (table + board), the new-ticket form, and the ticket detail.
//
// Every function here is PURELY presentational: data arrives through props and
// renders to an HTML string in the app's template-string idiom (inline styles
// over the canopy.css custom properties). Interactions dispatch via
// data-act / data-arg, handled in main.ts. No fetching, no state, no inline data
// — same contract as review.ts / maintenance.ts.
//
// The status machine is NOT re-declared here: `legalMoves` / TICKET_STATUS_LABEL
// come from @shared/tickets-core, the one definition the routes enforce too.
// (Values are imported from `tickets-core` rather than `@shared/tickets` on
// purpose — the latter evaluates zod schemas at module load and would drag the
// whole of zod into the browser bundle. Types still come from @shared/tickets.)

import {
  legalMoves, isOpenStatus, TICKET_STATUS_LABEL, TICKET_CATEGORIES, TICKET_PRIORITIES,
  type TicketStatus, type TicketCategory, type TicketPriority,
} from "@shared/tickets-core";
import type { TicketListItem, TicketDetail, TicketSeg, TicketAssigneeFilter } from "@shared/tickets";
import type { SprintView } from "@shared/sprints";
import type { PersonSummary } from "./api";
import { esc, attr, relTime, primaryBtn } from "./ui";
import { personChip } from "./people";
import { mentionCandidates } from "./mentions";

// ── shared atoms ─────────────────────────────────────────────────────────────

/** The design's `pill()` / `prioSt()` base: mono, 10px, bordered, non-shrinking. */
const CHIP_BASE =
  "font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.04em;border-radius:5px;padding:2px 6px;white-space:nowrap;flex:none;";

/** Tinted pill styling for one status — design call #5: Submitted blue,
 *  In progress green (accent), Done muted, Declined red at reduced opacity. */
function ticketPillStyle(status: TicketStatus): string {
  const tint = (c: string) =>
    `${CHIP_BASE}color:${c};border:1px solid color-mix(in srgb,${c} 45%,transparent);background:color-mix(in srgb,${c} 12%,transparent)`;
  if (status === "in_progress") return tint("var(--accent)");
  if (status === "submitted") return tint("var(--blue)");
  if (status === "done") return `${CHIP_BASE}color:var(--fg-55);border:1px solid var(--border-strong)`;
  return `${CHIP_BASE}color:var(--red);border:1px solid color-mix(in srgb,var(--red) 35%,transparent);opacity:.75`;
}

/** The status pill (design call #5). The ONE place a ticket status is painted. */
export function ticketPill(status: TicketStatus): string {
  return `<span style="${ticketPillStyle(status)}">${esc(TICKET_STATUS_LABEL[status].toUpperCase())}</span>`;
}

/** The priority chip — MONOCHROME by design call #5 (weight, not hue, carries it). */
export function priorityChip(p: TicketPriority): string {
  const st = p === "high"
    ? `${CHIP_BASE}color:var(--fg);border:1px solid var(--border-strong)`
    : p === "normal"
      ? `${CHIP_BASE}color:var(--fg-55);border:1px solid var(--border)`
      : `${CHIP_BASE}color:var(--fg-40);border:1px solid var(--border)`;
  return `<span style="${st}">${esc(p.toUpperCase())}</span>`;
}

/** A small mono chip (category / sprint tag / relation marker). */
export function tagChip(
  text: string,
  opts: { color?: string; border?: string; size?: number; spacing?: string; pad?: string } = {}
): string {
  const { color = "var(--fg-40)", border = "var(--border)", size = 10, spacing = ".05em", pad = "2px 6px" } = opts;
  return `<span style="font-family:var(--mono);font-size:${size}px;font-weight:600;letter-spacing:${spacing};color:${color};border:1px solid ${border};border-radius:5px;padding:${pad};white-space:nowrap;flex:none">${esc(text)}</span>`;
}

const categoryChip = (c: string) => tagChip(c, { color: "var(--fg-55)", border: "var(--border-strong)" });
const sprintTag = (label: string) => tagChip(label);

/** Short age from an ISO timestamp: "42m" / "6h" / "3d" (the design's `age()`).
 *  Distinct from ui.relTime, which is the "…ago" form used for timestamps. */
export function age(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 60) return `${mins}m`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** Directory lookup for a stored handle (case-insensitive, like personFor in render.ts). */
function person(persons: PersonSummary[], handle: string): PersonSummary | null {
  return persons.find((p) => p.handle.toLowerCase() === handle.toLowerCase()) ?? null;
}
const nameOf = (persons: PersonSummary[], handle: string): string => person(persons, handle)?.name || handle;
const firstNameOf = (persons: PersonSummary[], handle: string): string => nameOf(persons, handle).split(" ")[0];

/** Overlapping avatar row (-7px, ring in the page background) — the design's `asgAvs`. */
export function avatarStack(handles: string[], persons: PersonSummary[], size = 20): string {
  return `<div style="display:flex;flex:none">${handles.map((h, i) =>
    `<span style="display:flex;flex:none;border-radius:50%;box-shadow:0 0 0 2px var(--bg);${i > 0 ? "margin-left:-7px;" : ""}z-index:${9 - i}">${personChip(person(persons, h), size, h)}</span>`
  ).join("")}</div>`;
}

/** The assignee cell's text: italic "Unassigned", one full name, or "First +N". */
function assigneeLabel(handles: string[], persons: PersonSummary[]): string {
  if (handles.length === 0) return "Unassigned";
  if (handles.length === 1) return nameOf(persons, handles[0]);
  return `${firstNameOf(persons, handles[0])} +${handles.length - 1}`;
}

/** The statuses a segment covers — also the board's columns, in this order. */
export const SEG_STATUSES: Record<TicketSeg, TicketStatus[]> = {
  open: ["submitted", "in_progress"],
  closed: ["done", "declined"],
  all: ["submitted", "in_progress", "done", "declined"],
};

/** Design call #6 — "needs attention" = unassigned AND Submitted. Rendered as the
 *  selected-card idiom (2px inset left rule + faint fill), never a new color. */
export function needsAttention(t: { assignees: string[]; status: TicketStatus }): boolean {
  return t.assignees.length === 0 && t.status === "submitted";
}
/** The 2px inset rule stays inline; the faint fill moves to `.cnpy-attn` in
 *  canopy.css so `.cnpy-trow:hover` (class + pseudo-class) still outranks it and
 *  a needs-attention row keeps its hover background. */
const NEEDS_ATTENTION_STYLE = "box-shadow:inset 2px 0 0 var(--accent);";
const NEEDS_ATTENTION_CLASS = " cnpy-attn";

const segBtnStyle = (on: boolean) =>
  `padding:4px 14px;border-radius:7px;font-size:12.5px;font-weight:500;white-space:nowrap;transition:all .12s ease;color:${on ? "var(--fg);background:var(--hover)" : "var(--fg-55);background:transparent"}`;
const chipStyle = (on: boolean) =>
  `padding:5px 12px;border-radius:7px;font-size:12.5px;font-weight:500;white-space:nowrap;transition:all .12s ease;border:1px solid ${on ? "var(--accent);color:var(--accent);background:var(--accent-soft)" : "var(--border);color:var(--fg-55);background:transparent"}`;

const MONO_EYEBROW =
  "font-family:var(--mono);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40);white-space:nowrap";

// The table's column template — shared by the header row and every ticket row so
// the two can never drift apart.
const TABLE_COLS = "minmax(0,2.4fr) 1.15fr .75fr .7fr 1fr 1.05fr .5fr";

// ── the queue ────────────────────────────────────────────────────────────────

export interface QueueProps {
  /** The rows to show — already filtered server-side by seg / assignee / category. */
  tickets: TicketListItem[];
  /** Sprint order drives the table's group order (BACKLOG is always appended last). */
  sprints: SprintView[];
  persons: PersonSummary[];
  seg: TicketSeg;
  assignee: TicketAssigneeFilter;
  category: "all" | TicketCategory;
  view: "table" | "board";
  /** Unassigned + open across the WHOLE queue (= the sidebar badge), not this page. */
  unassignedCount: number;
}

const ASSIGNEE_OPTIONS: [TicketAssigneeFilter, string][] = [
  ["anyone", "Any assignee"],
  ["me", "Assigned to me"],
  ["unassigned", "Unassigned"],
];

function filterRow(p: QueueProps): string {
  const segs: [TicketSeg, string][] = [["open", "Open"], ["closed", "Closed"], ["all", "All"]];
  const segment = `<div style="display:inline-flex;align-items:center;gap:2px;border:1px solid var(--border);border-radius:9px;padding:2px">${segs.map(([k, label]) =>
    `<button data-act="queueSeg" data-arg="${k}" style="${segBtnStyle(p.seg === k)}">${label}</button>`).join("")}</div>`;

  const assigneeSelect = `<select data-act="queueAssignee" class="cnpy-select">${ASSIGNEE_OPTIONS.map(([k, label]) =>
    `<option value="${k}"${p.assignee === k ? " selected" : ""}>${label}</option>`).join("")}</select>`;

  const categorySelect = `<select data-act="queueCategory" class="cnpy-select"><option value="all"${p.category === "all" ? " selected" : ""}>All categories</option>${TICKET_CATEGORIES.map((c) =>
    `<option value="${c}"${p.category === c ? " selected" : ""}>${c}</option>`).join("")}</select>`;

  // "N shown · M unassigned" — M is the org-wide unassigned+open count (the same
  // number as the sidebar badge), NOT the filtered page's.
  const count = `${p.tickets.length} shown · ${p.unassignedCount} unassigned`;

  return `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0 0 4px">
    ${segment}
    <span style="width:1px;height:20px;background:var(--border);margin:0 6px"></span>
    ${assigneeSelect}
    ${categorySelect}
    <span style="flex:1"></span>
    <span style="font-family:var(--mono);font-size:10.5px;font-weight:600;color:var(--fg-40);white-space:nowrap">${esc(count)}</span>
  </div>`;
}

/** The relation marker: "N sub" on a parent, "↳ sub-ticket" on a child, else nothing. */
function relationChip(t: TicketListItem): string {
  if (t.sub_count > 0) return tagChip(`${t.sub_count} sub`, { size: 9.5, pad: "1px 6px" });
  if (t.parent_id !== null) return tagChip("↳ sub-ticket", { size: 9.5, pad: "1px 6px" });
  return "";
}

function tableRow(t: TicketListItem, persons: PersonSummary[]): string {
  const attn = needsAttention(t);
  const rowStyle = attn ? NEEDS_ATTENTION_STYLE : "";
  const asgText = assigneeLabel(t.assignees, persons);
  const asgStyle = t.assignees.length ? "color:var(--fg-70)" : "color:var(--fg-55);font-style:italic";
  return `<button data-act="openTicket" data-arg="${t.id}" class="cnpy-trow${attn ? NEEDS_ATTENTION_CLASS : ""}" style="display:grid;grid-template-columns:${TABLE_COLS};gap:12px;align-items:center;width:100%;text-align:left;padding:12px 10px;border-bottom:1px solid var(--border);transition:background .12s ease;${rowStyle}">
    <div style="display:flex;align-items:center;gap:7px;min-width:0"><span style="min-width:0;font-size:13.5px;font-weight:600;letter-spacing:-0.005em;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.title)}</span>${relationChip(t)}</div>
    <div style="display:flex;align-items:center;gap:7px;min-width:0">${personChip(person(persons, t.requester), 20, t.requester)}<span style="font-size:12.5px;color:var(--fg-70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(nameOf(persons, t.requester))}</span></div>
    <div>${categoryChip(t.category)}</div>
    <div>${priorityChip(t.priority)}</div>
    <div>${ticketPill(t.status)}</div>
    <div style="display:flex;align-items:center;gap:7px;min-width:0">${avatarStack(t.assignees, persons)}<span style="font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${asgStyle}">${esc(asgText)}</span></div>
    <div style="font-size:11.5px;color:var(--fg-40);text-align:right;font-family:var(--mono)">${esc(age(t.created_at))}</div>
  </button>`;
}

interface QueueGroup {
  key: number | null;
  label: string;
  dates: string;
  active: boolean;
  rows: TicketListItem[];
}

/** Table groups: one per sprint in `sprints` order, BACKLOG always last. Empty
 *  groups are dropped (the design hides them rather than showing "0 tickets").
 *
 *  NOTHING IS EVER DROPPED. A ticket whose `sprint_id` matches no loaded sprint
 *  — `GET /sprints` failed or is still in flight, or the sprint row was removed
 *  by hand behind the soft ref — folds into BACKLOG rather than vanishing from
 *  the table while the footer still counts it. */
export function queueGroups(tickets: TicketListItem[], sprints: SprintView[]): QueueGroup[] {
  const known = new Set(sprints.map((sp) => sp.id));
  const defs: QueueGroup[] = sprints.map((sp) => ({
    key: sp.id,
    label: sp.label.toUpperCase(),
    dates: sp.dates ?? sp.due ?? "",
    active: sp.active,
    rows: tickets.filter((t) => t.sprint_id === sp.id),
  }));
  defs.push({
    key: null,
    label: "BACKLOG",
    dates: "NO SPRINT",
    active: false,
    rows: tickets.filter((t) => t.sprint_id === null || !known.has(t.sprint_id)),
  });
  return defs.filter((g) => g.rows.length > 0);
}

function groupHeader(g: QueueGroup): string {
  const openLink = g.key !== null
    ? `<button data-act="openSprint" data-arg="${g.key}" title="Open sprint screen" style="display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:500;color:var(--fg-55);white-space:nowrap;flex:none;padding:2px 4px">Open sprint →</button>`
    : "";
  const meta = `<span style="font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.06em;color:var(--fg-40);white-space:nowrap">${esc(g.dates)}${g.active ? `<span style="color:var(--accent)"> · ACTIVE</span>` : ""}</span>`;
  return `<div style="display:flex;align-items:center;gap:9px;padding:18px 10px 8px">
    <span style="width:7px;height:7px;border-radius:50%;flex:none;background:${g.active ? "var(--accent)" : "var(--border-strong)"}"></span>
    <span style="font-family:var(--mono);font-size:10.5px;font-weight:600;letter-spacing:.08em;white-space:nowrap;color:${g.active ? "var(--accent)" : "var(--fg-55)"}">${esc(g.label)}</span>
    ${meta}
    ${openLink}
    <div style="flex:1;height:1px;background:var(--border)"></div>
    <span style="font-family:var(--mono);font-size:10px;font-weight:600;color:var(--fg-40);white-space:nowrap;flex:none">${g.rows.length} ${g.rows.length === 1 ? "ticket" : "tickets"}</span>
  </div>`;
}

function tableView(p: QueueProps): string {
  const head = `<div style="display:grid;grid-template-columns:${TABLE_COLS};gap:12px;padding:12px 10px 8px;border-bottom:1px solid var(--border-strong);font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.08em;color:var(--fg-40)">
    <div>TITLE</div><div>OPENED BY</div><div>CATEGORY</div><div>PRIORITY</div><div>STATUS</div><div>ASSIGNEE</div><div style="text-align:right">AGE</div>
  </div>`;
  const groups = queueGroups(p.tickets, p.sprints)
    .map((g) => `<div>${groupHeader(g)}${g.rows.map((t) => tableRow(t, p.persons)).join("")}</div>`)
    .join("");
  const empty = p.tickets.length === 0
    ? `<div style="text-align:center;padding:60px;color:var(--fg-40);font-size:13px">Nothing in this view.</div>`
    : "";
  return `${head}${groups}${empty}`;
}

function boardCard(t: TicketListItem, persons: PersonSummary[]): string {
  const asgStyle = t.assignees.length ? "color:var(--fg-70)" : "color:var(--fg-55);font-style:italic";
  return `<button data-act="openTicket" data-arg="${t.id}" class="cnpy-card${needsAttention(t) ? NEEDS_ATTENTION_CLASS : ""}" style="display:block;width:100%;text-align:left;padding:12px 13px;border-radius:11px;border:1px solid var(--border);margin-bottom:8px;transition:all .12s ease;${needsAttention(t) ? NEEDS_ATTENTION_STYLE : ""}">
    <div style="font-size:13.5px;font-weight:600;letter-spacing:-0.005em;line-height:1.4;color:var(--fg)">${esc(t.title)}</div>
    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:9px">${categoryChip(t.category)}${priorityChip(t.priority)}${t.sprint_label ? sprintTag(t.sprint_label) : ""}</div>
    <div style="display:flex;align-items:center;gap:7px;margin-top:11px;padding-top:10px;border-top:1px solid var(--border)">
      ${avatarStack(t.assignees, persons)}
      <span style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${asgStyle}">${esc(assigneeLabel(t.assignees, persons))}</span>
      <span style="font-size:11px;color:var(--fg-40);font-family:var(--mono);margin-left:auto;flex:none">${esc(age(t.created_at))}</span>
    </div>
  </button>`;
}

function boardView(p: QueueProps): string {
  const statuses = SEG_STATUSES[p.seg];
  const cols = statuses.map((st) => {
    const cards = p.tickets.filter((t) => t.status === st);
    const headColor = st === "in_progress" ? "color:var(--accent)" : st === "submitted" ? "color:var(--blue)" : "color:var(--fg-40)";
    const empty = cards.length === 0
      ? `<div style="border:1px dashed var(--border);border-radius:11px;padding:16px;text-align:center;font-size:12px;color:var(--fg-40)">Nothing here</div>`
      : "";
    return `<div style="min-width:0">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding-bottom:9px;border-bottom:1px solid var(--border-strong);margin-bottom:10px">
        <span style="font-family:var(--mono);font-size:10.5px;font-weight:600;letter-spacing:.08em;white-space:nowrap;${headColor}">${esc(TICKET_STATUS_LABEL[st].toUpperCase())}</span>
        <span style="font-family:var(--mono);font-size:10.5px;font-weight:600;color:var(--fg-40);white-space:nowrap;flex:none">${cards.length}</span>
      </div>
      ${cards.map((t) => boardCard(t, p.persons)).join("")}
      ${empty}
    </div>`;
  }).join("");
  return `<div style="display:grid;gap:14px;align-items:start;margin-top:12px;grid-template-columns:repeat(${Math.max(statuses.length, 1)},minmax(0,1fr))">${cols}</div>`;
}

/** The whole queue screen: filter row + Table or Board. */
export function queueView(p: QueueProps): string {
  return `<div style="max-width:1080px;margin:0 auto;padding:26px 32px 100px">
    ${filterRow(p)}
    ${p.view === "board" ? boardView(p) : tableView(p)}
  </div>`;
}

// ── new ticket ───────────────────────────────────────────────────────────────

export interface NewTicketProps {
  title: string;
  /** null = nothing picked = filed as `other` (the design's `fCat ?? "other"`). */
  category: TicketCategory | null;
  priority: TicketPriority;
  description: string;
  assignees: string[];
  /** Raw link input; parsed server-side by the SHARED parser on create. */
  link: string;
  /** null = Backlog. */
  sprintId: number | null;
  sprints: SprintView[];
  persons: PersonSummary[];
}

const FIELD_LABEL = "display:block;font-size:13px;font-weight:500;margin-bottom:8px";
const TEXT_INPUT =
  "width:100%;height:40px;padding:0 13px;border:1px solid var(--border-strong);border-radius:9px;background:transparent;color:var(--fg);font-size:14px;outline:none";

function personChipButton(act: string, arg: string, label: string, on: boolean, avatar: string): string {
  return `<button data-act="${attr(act)}" data-arg="${attr(arg)}" style="display:inline-flex;align-items:center;gap:7px;padding:5px 12px 5px 6px;border-radius:7px;font-size:12.5px;font-weight:500;transition:all .12s ease;border:1px solid ${on ? "var(--accent);color:var(--accent);background:var(--accent-soft)" : "var(--border);color:var(--fg-55);background:transparent"}">${avatar}${esc(label)}</button>`;
}

export function newTicketView(p: NewTicketProps): string {
  const canSubmit = p.title.trim().length > 0;

  const catChips = TICKET_CATEGORIES.map((c) =>
    `<button data-act="ntCategory" data-arg="${c}" style="${chipStyle(p.category === c)};font-family:var(--mono)">${c}</button>`).join("");

  const prioSegs = TICKET_PRIORITIES.map((v) =>
    `<button data-act="ntPriority" data-arg="${v}" style="${segBtnStyle(p.priority === v)}">${v.charAt(0).toUpperCase() + v.slice(1)}</button>`).join("");

  const sprintChips = [`<button data-act="ntSprint" data-arg="" style="${chipStyle(p.sprintId === null)}">Backlog</button>`]
    .concat(p.sprints.map((sp) => `<button data-act="ntSprint" data-arg="${sp.id}" style="${chipStyle(p.sprintId === sp.id)}">${esc(sp.label)}</button>`))
    .join("");

  const dashedAvatar = `<span style="width:20px;height:20px;border-radius:50%;border:1px dashed var(--border-strong);display:grid;place-items:center;font-size:8px;font-weight:600;flex:none;color:var(--fg-40)">–</span>`;
  const asgChips = [personChipButton("ntAssignee", "", "Unassigned", p.assignees.length === 0, dashedAvatar)]
    .concat(p.persons.map((pp) =>
      personChipButton("ntAssignee", pp.handle, pp.name || pp.handle, p.assignees.includes(pp.handle), personChip(pp, 20, pp.handle))))
    .join("");

  return `<div style="max-width:960px;margin:0 auto;padding:28px 32px 100px">
    <div style="border:1px solid var(--border);border-radius:13px;padding:26px 28px">
      <div class="cnpy-nt-grid" style="display:grid;grid-template-columns:minmax(0,1.6fr) minmax(240px,1fr);gap:28px">
        <div style="min-width:0">
          <label style="${FIELD_LABEL}">Title</label>
          <input data-act="ntTitle" data-field="ntTitle" value="${attr(p.title)}" placeholder="One line: what do you need?" style="${TEXT_INPUT}" />
          <label style="${FIELD_LABEL};margin:20px 0 8px">Description</label>
          <textarea data-act="ntDescription" data-field="ntDescription" placeholder="What's happening, and what would good look like?" style="width:100%;min-height:190px;padding:10px 13px;border:1px solid var(--border-strong);border-radius:9px;background:transparent;color:var(--fg);font-size:13.5px;line-height:1.6;outline:none;resize:vertical">${esc(p.description)}</textarea>
          <label style="${FIELD_LABEL};margin:20px 0 8px">Linked work <span style="font-weight:400;color:var(--fg-40)">— optional</span></label>
          <input data-act="ntLink" data-field="ntLink" value="${attr(p.link)}" placeholder="GitHub or Figma URL, or #issue-number" style="${TEXT_INPUT};height:38px;font-size:12.5px;font-family:var(--mono)" />
        </div>
        <div style="min-width:0;border-left:1px solid var(--border);padding-left:26px">
          <label style="${FIELD_LABEL}">Category</label>
          <div style="display:flex;gap:6px;flex-wrap:wrap">${catChips}</div>
          <label style="${FIELD_LABEL};margin:20px 0 8px">Priority</label>
          <div style="display:inline-flex;align-items:center;gap:2px;border:1px solid var(--border);border-radius:9px;padding:2px">${prioSegs}</div>
          <label style="${FIELD_LABEL};margin:20px 0 8px">Sprint</label>
          <div style="display:flex;gap:6px;flex-wrap:wrap">${sprintChips}</div>
          <label style="${FIELD_LABEL};margin:20px 0 8px">Assignees <span style="font-weight:400;color:var(--fg-40)">— optional</span></label>
          <div style="display:flex;gap:6px;flex-wrap:wrap">${asgChips}</div>
          <div style="font-size:11.5px;color:var(--fg-40);margin-top:8px">Leave unassigned to let the queue pick it up.</div>
        </div>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:24px;padding-top:16px;border-top:1px solid var(--border)">
        <button data-act="ticketsBack" class="cnpy-outlinebtn" style="padding:8px 15px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70);transition:all .12s ease">Cancel</button>
        ${primaryBtn("Submit ticket", canSubmit, "ntSubmit", "", "padding:8px 16px")}
      </div>
    </div>
  </div>`;
}

// ── ticket detail ────────────────────────────────────────────────────────────

export interface TicketDetailProps {
  ticket: TicketDetail;
  /** The queue list, used ONLY for the sub-ticket candidate filter. */
  allTickets: TicketListItem[];
  sprints: SprintView[];
  persons: PersonSummary[];
  commentDraft: string;
  linkDraft: string;
  /** Re-opens the link field after at least one link exists (design call #8). */
  linkOpen: boolean;
  asgMenu: boolean;
  sprMenu: boolean;
  relMenu: boolean;
  /**
   * The open @mention token in the comment box (main.ts computes it from the
   * textarea's value + caret). null = the picker is closed. Candidates are
   * derived here, so "no candidates" also renders nothing.
   */
  mention: { query: string; start: number; index: number } | null;
}

/**
 * Which tickets may be attached as a sub-ticket of `d` — the design's
 * `relCandidates`, and §A's rule: exclude self, its parent, anything that
 * already has a parent (tickets nest ONE level), anything that already has
 * children, and anything closed.
 */
export function relCandidates(
  all: TicketListItem[],
  d: { id: number; parent_id: number | null }
): TicketListItem[] {
  return all.filter((x) =>
    x.id !== d.id &&
    x.id !== d.parent_id &&
    x.parent_id === null &&
    x.sub_count === 0 &&
    isOpenStatus(x.status));
}

/** Legal-move button copy. `submitted` as a TARGET is the "Back" move. */
const MOVE_LABEL: Record<TicketStatus, string> = {
  in_progress: "Start",
  declined: "Decline",
  done: "Done",
  submitted: "Back to submitted",
};

/** Escape, then paint `@mentions` that resolve to a person (design's `mention()`). */
function mentionize(text: string, persons: PersonSummary[]): string {
  const known = new Map<string, string>();
  for (const p of persons) {
    known.set(p.handle.toLowerCase(), p.handle);
    const first = (p.name || p.handle).split(" ")[0];
    known.set(first.toLowerCase(), p.handle);
  }
  return esc(text).replace(/@([A-Za-z0-9_-]+)/g, (whole, name: string) => {
    const handle = known.get(name.toLowerCase());
    if (!handle) return whole;
    return `<span style="color:var(--accent);font-weight:600;background:var(--accent-soft);border-radius:4px;padding:0 4px">@${esc(firstNameOf(persons, handle))}</span>`;
  });
}

const LINK_ICON: Record<string, string> = {
  github: `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"></path></svg>`,
  figma: `<svg width="12" height="17" viewBox="0 0 38 57" aria-hidden="true"><path fill="#1abcfe" d="M19 28.5a9.5 9.5 0 1 1 19 0 9.5 9.5 0 0 1-19 0z"></path><path fill="#0acf83" d="M0 47.5A9.5 9.5 0 0 1 9.5 38H19v9.5a9.5 9.5 0 1 1-19 0z"></path><path fill="#ff7262" d="M19 0v19h9.5a9.5 9.5 0 1 0 0-19H19z"></path><path fill="#f24e1e" d="M0 9.5A9.5 9.5 0 0 0 9.5 19H19V0H9.5A9.5 9.5 0 0 0 0 9.5z"></path><path fill="#a259ff" d="M0 28.5A9.5 9.5 0 0 0 9.5 38H19V19H9.5A9.5 9.5 0 0 0 0 28.5z"></path></svg>`,
  plain: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"></path><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"></path></svg>`,
};
const EXTERNAL_ARROW = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="flex:none;color:var(--fg-40);margin-left:2px"><path d="M7 17 17 7"></path><path d="M9 7h8v8"></path></svg>`;
const RAIL_ARROW = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="flex:none;color:var(--fg-40)"><path d="M7 17 17 7"></path><path d="M9 7h8v8"></path></svg>`;
const PLUS_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"></path></svg>`;
/** Menu tick — accent when this row is the current choice, invisible otherwise
 *  (kept in flow so the labels don't shift, exactly like the design's checkSt). */
const checkMark = (on: boolean): string =>
  `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" style="flex:none;${on ? "color:var(--accent)" : "visibility:hidden"}"><path d="M20 6 9 17l-5-5"></path></svg>`;

/** Defense in depth: a stored link url must be http(s) before it reaches an href. */
const safeHref = (u: string): string => (/^https?:\/\//i.test(u) ? u : "#");

const MENU_BOX = "position:absolute;top:calc(100% + 6px);right:0;z-index:30;background:var(--bg);border:1px solid var(--border-strong);border-radius:11px;padding:5px;box-shadow:0 14px 38px rgba(0,0,0,.38)";
const MENU_BACKDROP = `<div data-act="closeTicketMenus" style="position:fixed;inset:0;z-index:29"></div>`;
const RAIL_ROW = "display:flex;align-items:center;gap:10px;width:100%;text-align:left;height:38px;padding:0";
const RAIL_BOX = "width:24px;height:24px;border-radius:6px;border:1px solid var(--border-strong);display:grid;place-items:center;color:var(--fg-55);font-size:11px;flex:none";
const RAIL_TITLE = "display:block;font-size:13px;font-weight:500;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
const RAIL_META = "display:block;font-family:var(--mono);font-size:9.5px;font-weight:600;letter-spacing:.04em;color:var(--fg-40);white-space:nowrap;margin-top:2px";
const ICON_BTN = "width:22px;height:22px;border-radius:6px;display:grid;place-items:center;color:var(--fg-40);transition:all .12s ease";
const RAIL_SECTION_HEAD = "display:flex;align-items:center;justify-content:space-between;gap:8px;height:22px;margin-bottom:6px";
const PROP_ROW = "display:grid;grid-template-columns:76px 1fr;gap:10px;align-items:center;height:30px";
const PROP_LABEL = "font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.06em;color:var(--fg-40)";

function transitionButtons(status: TicketStatus): string {
  const moves = legalMoves(status);
  if (moves.length === 0) return "";
  const [primary, ...rest] = moves;
  const secondary = rest.map((to) =>
    `<button data-act="ticketStatus" data-arg="${to}" class="cnpy-outlinebtn" style="background:transparent;border:1px solid var(--border-strong);border-radius:8px;padding:8px 14px;font-size:12.5px;font-weight:500;color:var(--fg-70);white-space:nowrap;transition:all .12s ease">${MOVE_LABEL[to]}</button>`).join("");
  const prim = `<button data-act="ticketStatus" data-arg="${primary}" class="cnpy-accentbtn" style="background:var(--accent);color:var(--accent-fg);border-radius:8px;padding:9px 17px;font-size:13px;font-weight:600;white-space:nowrap;transition:filter .12s ease">${MOVE_LABEL[primary]}</button>`;
  return `${secondary}${prim}`;
}

function linkedWorkBlock(p: TicketDetailProps): string {
  const links = p.ticket.links;
  const hasLinks = links.length > 0;
  // Design call #8: the link field shows until a link exists; after that the
  // plain "Linked to engineering work" line (the field is still reachable
  // through the Add link toggle, which only appears once a link is there).
  const addToggle = hasLinks
    ? `<button data-act="ticketLinkToggle" style="display:inline-flex;align-items:center;gap:4px;font-size:11.5px;font-weight:500;color:var(--fg-40);white-space:nowrap;opacity:.7;transition:all .12s ease"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"></path></svg>Add link</button>`
    : "";
  const chips = hasLinks
    ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">${links.map((lk) =>
        `<a href="${attr(safeHref(lk.url))}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:9px;padding:7px 13px 7px 10px;border:1px solid var(--border);border-radius:9px;text-decoration:none;background:color-mix(in srgb,var(--fg) 2.5%,transparent)">
          <span style="flex:none;display:grid;place-items:center;width:22px;height:22px;border-radius:6px;color:var(--fg-70);background:color-mix(in srgb,var(--fg) 6%,transparent)">${LINK_ICON[lk.kind] ?? LINK_ICON.plain}</span>
          <span style="min-width:0">
            <span style="display:block;font-size:12.5px;font-weight:600;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px">${esc(lk.label)}</span>
            <span style="display:block;font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.04em;color:var(--fg-40);margin-top:1px;white-space:nowrap">${esc(lk.meta)}</span>
          </span>${EXTERNAL_ARROW}
        </a>`).join("")}</div>`
    : "";
  const linkedLine = hasLinks
    ? `<div style="font-size:12px;color:var(--fg-40);margin-top:10px">Linked to engineering work</div>`
    : "";
  const field = !hasLinks || p.linkOpen
    ? `<div style="display:flex;gap:8px;margin-top:10px">
        <input data-act="ticketLinkDraft" data-field="ticketLinkDraft" value="${attr(p.linkDraft)}" placeholder="Paste a GitHub or Figma URL, or #issue" style="flex:1;height:36px;padding:0 12px;border:1px solid var(--border-strong);border-radius:8px;background:transparent;color:var(--fg);font-size:12.5px;font-family:var(--mono);outline:none" />
        <button data-act="ticketLinkAdd" class="cnpy-outlinebtn" style="padding:0 14px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70);transition:all .12s ease">Link</button>
      </div>`
    : "";
  return `<div style="display:flex;align-items:baseline;gap:10px;margin-top:26px">
      <div style="${MONO_EYEBROW};flex:none">Linked work</div>${addToggle}
    </div>${chips}${linkedLine}${field}`;
}

/**
 * The @mention autocomplete list, hung under the comment textarea. Beyond the
 * locked design (which has no picker), so it borrows the design's own popover
 * skin: bordered card on `--bg`, soft shadow, `--hover` on the active row.
 *
 * Renders "" when the picker is closed OR when nothing matches — the caller
 * never has to check twice. Rows dispatch `mentionPick` with the handle.
 */
function mentionPicker(p: TicketDetailProps): string {
  if (!p.mention) return "";
  const cands = mentionCandidates(p.persons, p.mention.query);
  if (!cands.length) return "";
  // main.ts wraps the index as it moves, but a stale index (the query narrowed
  // the list between keystrokes) must never paint an out-of-range row.
  const active = ((p.mention.index % cands.length) + cands.length) % cands.length;
  const rows = cands.map((c, i) =>
    `<button data-act="mentionPick" data-arg="${attr(c.handle)}" role="option" aria-selected="${i === active}" style="display:flex;align-items:center;gap:9px;width:100%;text-align:left;padding:6px 9px;border-radius:7px;background:${i === active ? "var(--hover)" : "transparent"}">
      ${personChip(c, 20, c.handle)}
      <span style="font-size:13px;color:var(--fg);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.name || c.handle)}</span>
      <span style="font-family:var(--mono);font-size:11.5px;color:var(--fg-55);margin-left:auto;flex:none">@${esc(c.handle)}</span>
    </button>`).join("");
  return `<div role="listbox" aria-label="Mention someone" style="position:absolute;top:calc(100% + 6px);left:0;right:0;z-index:30;background:var(--bg);border:1px solid var(--border-strong);border-radius:9px;box-shadow:0 8px 30px rgba(0,0,0,.35);padding:5px">
    ${rows}
    <div style="font-family:var(--mono);font-size:10.5px;color:var(--fg-40);padding:5px 9px 3px;border-top:1px solid var(--border);margin-top:4px">↑↓ to move · Enter to mention · Esc to close</div>
  </div>`;
}

interface ThreadRow { ts: number; html: string }

function threadBlock(p: TicketDetailProps): string {
  const t = p.ticket;
  const rows: ThreadRow[] = [];
  for (const c of t.comments) {
    rows.push({
      ts: new Date(c.created_at).getTime(),
      html: `<div style="display:flex;align-items:flex-start;gap:11px;padding:14px 0;border-bottom:1px solid var(--border)">
        <div style="margin-top:1px">${personChip(person(p.persons, c.author), 26, c.author)}</div>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:7px"><span style="font-size:12.5px;font-weight:600;white-space:nowrap">${esc(nameOf(p.persons, c.author))}</span><span style="font-size:11px;color:var(--fg-40);white-space:nowrap">${esc(relTime(c.created_at))}</span></div>
          <div style="font-size:13px;line-height:1.6;color:var(--fg-70);margin-top:4px">${mentionize(c.body, p.persons)}</div>
        </div>
      </div>`,
    });
  }
  for (const ev of t.events) {
    // The opening row reads "opened this ticket" (the design's `dThread.move`);
    // every later row is "from → to".
    const move = ev.from_status === null
      ? "opened this ticket"
      : `${TICKET_STATUS_LABEL[ev.from_status]} → ${TICKET_STATUS_LABEL[ev.to_status]}`;
    rows.push({
      ts: new Date(ev.created_at).getTime(),
      html: `<div style="display:flex;align-items:center;gap:9px;padding:8px 0 8px 8px;border-bottom:1px solid var(--border)">
        <span style="width:6px;height:6px;border-radius:50%;background:var(--border-strong);flex:none;margin:0 6px"></span>
        <span style="font-family:var(--mono);font-size:11px;font-weight:600;color:var(--fg-55);white-space:nowrap">${esc(ev.actor)}</span>
        <span style="font-size:12px;color:var(--fg-40);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(move)}</span>
        <span style="font-size:11px;color:var(--fg-40);margin-left:auto;flex:none;white-space:nowrap">${esc(relTime(ev.created_at))}</span>
      </div>`,
    });
  }
  rows.sort((a, b) => a.ts - b.ts);

  const canPost = p.commentDraft.trim().length > 0;
  return `<div style="display:flex;align-items:baseline;justify-content:space-between;margin-top:30px;padding-bottom:9px;border-bottom:1px solid var(--border-strong)">
      <div style="font-family:var(--mono);font-size:11px;font-weight:600;letter-spacing:.08em;color:var(--fg-55);white-space:nowrap;flex:none">THREAD</div>
      <div style="font-family:var(--mono);font-size:10.5px;font-weight:600;color:var(--fg-40);white-space:nowrap;flex:none">${t.comments.length} ${t.comments.length === 1 ? "comment" : "comments"}</div>
    </div>
    ${rows.map((r) => r.html).join("")}
    <div style="position:relative;border:1px solid var(--border);border-radius:11px;padding:12px;margin-top:16px">
      <div style="position:relative">
        <textarea data-act="ticketComment" data-field="ticketComment" placeholder="Write a comment — @mention to loop someone in…" style="width:100%;min-height:60px;border:none;outline:none;background:transparent;color:var(--fg);font-size:13.5px;line-height:1.6;resize:vertical">${esc(p.commentDraft)}</textarea>
        ${mentionPicker(p)}
      </div>
      <div style="display:flex;justify-content:flex-end;margin-top:8px">${primaryBtn("Comment", canPost, "ticketCommentPost", "")}</div>
    </div>`;
}

function assigneeRail(p: TicketDetailProps): string {
  const assigned = p.ticket.assignees;
  const addable = p.persons.filter((pp) => !assigned.includes(pp.handle));
  const addBtn = addable.length
    ? `<button data-act="ticketAsgMenu" title="Add assignee" style="${ICON_BTN}">${PLUS_SVG}</button>`
    : "";
  const menu = p.asgMenu && addable.length
    ? `${MENU_BACKDROP}<div style="${MENU_BOX};width:200px">${addable.map((pp) =>
        `<button data-act="ticketAsgAdd" data-arg="${attr(pp.handle)}" style="display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:7px 10px;border-radius:7px;font-size:12.5px;font-weight:500;color:var(--fg-70)">${personChip(pp, 20, pp.handle)}<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(pp.name || pp.handle)}</span></button>`).join("")}</div>`
    : "";
  const list = assigned.length
    ? assigned.map((h) => `<div style="display:flex;align-items:center;gap:10px;height:34px">
        ${personChip(person(p.persons, h), 24, h)}
        <span style="flex:1;min-width:0;font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(nameOf(p.persons, h))}</span>
        <button data-act="ticketAsgRemove" data-arg="${attr(h)}" title="Remove" style="flex:none;${ICON_BTN};opacity:.45"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 6 6 18M6 6l12 12"></path></svg></button>
      </div>`).join("")
    : `<div style="display:flex;align-items:center;gap:10px;height:34px">
        <div style="width:24px;height:24px;border-radius:50%;border:1px dashed var(--border-strong);flex:none"></div>
        <span style="font-size:12.5px;color:var(--fg-40);font-style:italic">Unassigned</span>
      </div>`;
  return `<div>
    <div style="${RAIL_SECTION_HEAD}">
      <div style="${MONO_EYEBROW}">Assignees</div>
      <div style="position:relative;display:flex;align-items:center">${addBtn}${menu}</div>
    </div>${list}
  </div>`;
}

function sprintRail(p: TicketDetailProps): string {
  const cur = p.ticket.sprint;
  const curSprint = cur ? p.sprints.find((s) => s.id === cur.id) ?? null : null;
  const options: { id: number | null; label: string }[] = [
    { id: null, label: "Backlog" },
    ...p.sprints.map((s) => ({ id: s.id, label: s.label })),
  ];
  const menu = p.sprMenu
    ? `${MENU_BACKDROP}<div style="${MENU_BOX};width:230px">${options.map((o) => {
        const on = (cur?.id ?? null) === o.id;
        return `<button data-act="ticketSprintSet" data-arg="${o.id ?? ""}" style="display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;text-align:left;padding:7px 10px;border-radius:7px;font-size:12.5px;font-weight:500;white-space:nowrap;color:${on ? "var(--fg)" : "var(--fg-70)"}"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(o.label)}</span>${checkMark(on)}</button>`;
      }).join("")}</div>`
    : "";
  const openAttr = cur ? ` data-act="openSprint" data-arg="${cur.id}"` : "";
  return `<div>
    <div style="${RAIL_SECTION_HEAD}">
      <div style="${MONO_EYEBROW}">Sprint</div>
      <div style="position:relative;display:flex;align-items:center">
        <button data-act="ticketSprintMenu" title="Change sprint" style="${ICON_BTN}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"></path><path d="M18.4 2.6a2.1 2.1 0 0 1 3 3L13 14l-4 1 1-4z"></path></svg></button>${menu}
      </div>
    </div>
    <button${openAttr} style="${RAIL_ROW};${cur ? "cursor:pointer" : "cursor:default"}">
      <span style="width:24px;height:24px;border-radius:6px;border:1px solid var(--border-strong);display:grid;place-items:center;color:var(--fg-55);flex:none"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 21V4"></path><path d="M5 4.5C7 3 9 3 12 4.5s5 1.5 7 0V13c-2 1.5-4 1.5-7 0s-5-1.5-7 0"></path></svg></span>
      <span style="flex:1;min-width:0">
        <span style="${RAIL_TITLE}">${esc(cur ? cur.label : "Backlog")}</span>
        <span style="${RAIL_META}">${esc(curSprint ? (curSprint.dates ?? curSprint.due ?? "SPRINT") : "NO SPRINT")}</span>
      </span>
      ${cur ? RAIL_ARROW : ""}
    </button>
  </div>`;
}

function relationsRail(p: TicketDetailProps): string {
  const t = p.ticket;
  // A ticket that already has a parent can never become one (tickets nest ONE
  // level, and POST /tickets/:id/parent rejects it), so the add affordance is
  // hidden there rather than offered and 409'd.
  const candidates = t.parent_id === null ? relCandidates(p.allTickets, t) : [];
  const addBtn = candidates.length
    ? `<button data-act="ticketRelMenu" title="Add sub-ticket" style="${ICON_BTN}">${PLUS_SVG}</button>`
    : "";
  const menu = p.relMenu && candidates.length
    ? `${MENU_BACKDROP}<div style="${MENU_BOX};width:270px">
        <div style="font-size:10px;font-weight:600;font-family:var(--mono);letter-spacing:.05em;color:var(--fg-40);padding:6px 10px 4px">LINK A TICKET AS A SUB-TICKET</div>
        ${candidates.map((c) => `<button data-act="ticketRelAdd" data-arg="${c.id}" style="display:block;width:100%;text-align:left;padding:7px 10px;border-radius:7px;font-size:12.5px;font-weight:500;color:var(--fg-70);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.title)}</button>`).join("")}
      </div>`
    : "";
  const parentRow = t.parent
    ? `<button data-act="openTicket" data-arg="${t.parent.id}" style="${RAIL_ROW}">
        <span style="${RAIL_BOX}">↰</span>
        <span style="flex:1;min-width:0"><span style="${RAIL_TITLE}">${esc(t.parent.title)}</span><span style="${RAIL_META}">PARENT TICKET</span></span>
        ${RAIL_ARROW}
      </button>`
    : "";
  const childRows = t.children.map((c) =>
    `<button data-act="openTicket" data-arg="${c.id}" style="${RAIL_ROW}">
      <span style="${RAIL_BOX}">↳</span>
      <span style="flex:1;min-width:0"><span style="${RAIL_TITLE}">${esc(c.title)}</span><span style="${RAIL_META}">SUB-TICKET · ${esc(TICKET_STATUS_LABEL[c.status].toUpperCase())}</span></span>
      ${RAIL_ARROW}
    </button>`).join("");
  const empty = !t.parent && t.children.length === 0
    ? `<div style="display:flex;align-items:center;gap:10px;height:34px">
        <div style="width:24px;height:24px;border-radius:6px;border:1px dashed var(--border-strong);flex:none"></div>
        <span style="font-size:12.5px;color:var(--fg-40);font-style:italic">No linked tickets</span>
      </div>`
    : "";
  return `<div>
    <div style="${RAIL_SECTION_HEAD}">
      <div style="${MONO_EYEBROW}">Relations</div>
      <div style="position:relative;display:flex;align-items:center">${addBtn}${menu}</div>
    </div>${parentRow}${childRows}${empty}
  </div>`;
}

export function ticketDetailView(p: TicketDetailProps): string {
  const t = p.ticket;
  return `<div style="max-width:1000px;margin:0 auto;padding:26px 32px 100px">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:20px">
      <div style="flex:1;min-width:0">
        <h2 style="margin:0;font-size:22px;font-weight:600;letter-spacing:-0.02em">${esc(t.title)}</h2>
        <div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:9px;font-size:12px;color:var(--fg-55)">
          <div style="display:flex;align-items:center;gap:6px">${personChip(person(p.persons, t.requester), 20, t.requester)}<span style="font-weight:500;color:var(--fg-70);white-space:nowrap">${esc(nameOf(p.persons, t.requester))}</span></div>
          <span style="color:var(--fg-40);white-space:nowrap">&middot; opened ${esc(relTime(t.created_at))}</span>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;flex:none;padding-top:2px">${transitionButtons(t.status)}</div>
    </div>
    <div class="cnpy-td-grid" style="display:grid;grid-template-columns:minmax(0,1fr) 258px;gap:34px;margin-top:24px">
      <div style="min-width:0">
        <div style="font-size:13.5px;line-height:1.65;color:var(--fg-70);white-space:pre-wrap;max-width:640px">${esc(t.body)}</div>
        ${linkedWorkBlock(p)}
        ${threadBlock(p)}
      </div>
      <div style="border-left:1px solid var(--border);padding-left:26px;display:flex;flex-direction:column;gap:26px">
        <div>
          <div style="${RAIL_SECTION_HEAD}"><div style="${MONO_EYEBROW}">Properties</div></div>
          <div style="${PROP_ROW}"><div style="${PROP_LABEL}">STATUS</div><div>${ticketPill(t.status)}</div></div>
          <div style="${PROP_ROW}"><div style="${PROP_LABEL}">CATEGORY</div><div>${categoryChip(t.category)}</div></div>
          <div style="${PROP_ROW}"><div style="${PROP_LABEL}">PRIORITY</div><div>${priorityChip(t.priority)}</div></div>
        </div>
        ${assigneeRail(p)}
        ${sprintRail(p)}
        ${relationsRail(p)}
      </div>
    </div>
  </div>`;
}
