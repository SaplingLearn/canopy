/**
 * Phase 5a render tests — the SPA's ticket screens.
 *
 * Pure functions + `render()` over a hand-built AppState (no D1, no DOM), the
 * same idiom as test/render.review.test.ts and test/render.mywork.test.ts:
 *  • the sidebar entry + badge (design call #2)
 *  • queueView — grouping/order, hidden empty groups, the ACTIVE label, the
 *    needs-attention rule (call #6), the exact footer count, board columns per
 *    segment, the tinted pills (call #5) and the relation text
 *  • newTicketView — the inert Submit button and the design's defaults
 *  • ticketDetailView — legal moves only (call #7), link field ↔ "Linked to
 *    engineering work" (call #8), the sub-ticket candidate filter, the merged
 *    thread with "opened this ticket", the sprint menu's tick, assignee controls
 */
import { describe, it, expect } from "vitest";
import { render, initialState, type AppState } from "../web/src/render";
import {
  queueView, newTicketView, ticketDetailView, relCandidates, queueGroups,
  ticketPill, priorityChip, age, avatarStack, SEG_STATUSES,
  type QueueProps, type NewTicketProps, type TicketDetailProps,
} from "../web/src/tickets";
import type { TicketListItem, TicketDetail, TicketLinkRow, TicketCommentRow, TicketEventRow } from "@shared/tickets";
import type { SprintView } from "@shared/sprints";
import type { PersonSummary } from "../web/src/api";

// ── fixtures ─────────────────────────────────────────────────────────────────

const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const H = 3600_000;
const D = 86_400_000;

const PERSONS: PersonSummary[] = [
  { handle: "meilin", name: "Meilin Zhao", color: "rose", avatar_url: null },
  { handle: "sanaok", name: "Sana Okafor", color: "ochre", avatar_url: null },
  { handle: "jose-a", name: "Jose Alvarez", color: "moss", avatar_url: null },
];

function sprint(o: Partial<SprintView> & { id: number; label: string }): SprintView {
  return {
    summary: null, description: null, phase: "Phase 2", dates: "SEP 8 – 19", due: "2026-09-26",
    status: "upcoming", active: false, urgency: "normal", lead: null, domain: null,
    github_ref: null, created_at: ago(30 * D), created_by: "jose-a", updated_at: null,
    progress: { closed: 0, total: 0, pct: 0 },
    issues: null, members: [],
    ...o,
  };
}

function ticket(o: Partial<TicketListItem> & { id: number; title: string }): TicketListItem {
  return {
    body: "", category: "bug", priority: "normal", status: "submitted", requester: "meilin",
    parent_id: null, sprint_id: null, created_at: ago(2 * H), updated_at: ago(1 * H),
    assignees: [], link_count: 0, sub_count: 0, sprint_label: null,
    ...o,
  };
}

function detail(o: Partial<TicketDetail> & { id: number; title: string }): TicketDetail {
  return {
    body: "Something is broken.", category: "bug", priority: "normal", status: "submitted",
    requester: "meilin", parent_id: null, sprint_id: null,
    created_at: ago(2 * H), updated_at: ago(1 * H),
    assignees: [], links: [], comments: [], events: [], parent: null, children: [], sprint: null,
    ...o,
  };
}

const link = (o: Partial<TicketLinkRow> = {}): TicketLinkRow => ({
  id: 1, ticket_id: 1, url: "https://github.com/SaplingLearn/sapling/issues/214",
  kind: "github", label: "sapling #214", meta: "GITHUB · ISSUE",
  created_by: "jose-a", created_at: ago(1 * H), ...o,
});
const comment = (o: Partial<TicketCommentRow> = {}): TicketCommentRow => ({
  id: 1, ticket_id: 1, author: "jose-a", body: "On it.", created_at: ago(1 * H), ...o,
});
const event = (o: Partial<TicketEventRow> = {}): TicketEventRow => ({
  id: 1, ticket_id: 1, actor: "meilin", from_status: null, to_status: "submitted",
  created_at: ago(3 * H), ...o,
});

function queueProps(o: Partial<QueueProps> = {}): QueueProps {
  return {
    tickets: [], sprints: [], persons: PERSONS,
    seg: "open", assignee: "anyone", category: "all", view: "table", unassignedCount: 0,
    ...o,
  };
}
function formProps(o: Partial<NewTicketProps> = {}): NewTicketProps {
  return {
    title: "", category: null, priority: "normal", description: "", assignees: [],
    link: "", sprintId: null, sprints: [], persons: PERSONS,
    ...o,
  };
}
function detailProps(t: TicketDetail, o: Partial<TicketDetailProps> = {}): TicketDetailProps {
  return {
    ticket: t, allTickets: [], sprints: [], persons: PERSONS,
    commentDraft: "", mention: null, linkDraft: "", linkOpen: false,
    asgMenu: false, sprMenu: false, relMenu: false,
    ...o,
  };
}

/** An app-view AppState positioned on a ticket screen. */
function appState(o: Partial<AppState> = {}): AppState {
  const s = initialState();
  s.view = "app";
  s.me = { handle: "jose-a", name: "Jose Alvarez", avatar_url: null, color: "moss", identities: [], org: "SaplingLearn", admin: false };
  s.persons = { status: "ok", data: PERSONS };
  return Object.assign(s, o);
}

// ── atoms ────────────────────────────────────────────────────────────────────

describe("ticketPill / priorityChip / age (design call #5)", () => {
  it("tints Submitted blue, In progress accent, Done muted, Declined red at reduced opacity", () => {
    expect(ticketPill("submitted")).toContain("var(--blue)");
    expect(ticketPill("submitted")).toContain("SUBMITTED");
    expect(ticketPill("in_progress")).toContain("var(--accent)");
    expect(ticketPill("in_progress")).toContain("IN PROGRESS");
    expect(ticketPill("done")).toContain("color:var(--fg-55);border:1px solid var(--border-strong)");
    expect(ticketPill("done")).not.toContain("var(--blue)");
    expect(ticketPill("declined")).toContain("var(--red)");
    expect(ticketPill("declined")).toContain("opacity:.75");
  });

  it("keeps priority chips MONOCHROME — no accent/blue/red/amber anywhere", () => {
    for (const p of ["low", "normal", "high"] as const) {
      const html = priorityChip(p);
      expect(html).toContain(p.toUpperCase());
      expect(html).not.toMatch(/var\(--accent\)|var\(--blue\)|var\(--red\)|var\(--amber\)|var\(--green\)/);
    }
    // ...and they are distinguishable from one another by weight alone.
    expect(priorityChip("high")).toContain("color:var(--fg);");
    expect(priorityChip("normal")).toContain("color:var(--fg-55);");
    expect(priorityChip("low")).toContain("color:var(--fg-40);");
  });

  it("renders the design's short age form", () => {
    expect(age(ago(42 * 60_000))).toBe("42m");
    expect(age(ago(6 * H))).toBe("6h");
    expect(age(ago(3 * D))).toBe("3d");
    expect(age("not-a-date")).toBe("");
  });

  it("overlaps stacked avatars by -7px from the second one on", () => {
    const html = avatarStack(["meilin", "sanaok"], PERSONS);
    expect(html.match(/margin-left:-7px/g)?.length).toBe(1);
    expect(avatarStack(["meilin"], PERSONS)).not.toContain("margin-left:-7px");
  });
});

// ── sidebar ──────────────────────────────────────────────────────────────────

describe("sidebar — the Tickets entry (design call #2)", () => {
  it("sits after Feed and before Docs, inside Workspace", () => {
    const html = render(appState({ screen: "tickets" }));
    const feed = html.indexOf('data-act="goFeed"');
    const tickets = html.indexOf('data-act="goTickets"');
    const docs = html.indexOf('data-act="goDocs"');
    expect(feed).toBeGreaterThan(-1);
    expect(tickets).toBeGreaterThan(feed);
    expect(docs).toBeGreaterThan(tickets);
  });

  it("hides the badge at 0 and shows the count in an accent pill above it", () => {
    const zero = render(appState({ screen: "feed", ticketBadge: 0 }));
    expect(zero).toContain('class="cnpy-nav n-tickets"');
    expect(zero).not.toContain("border-radius:999px;flex:none;color:var(--accent)");

    const some = render(appState({ screen: "feed", ticketBadge: 4 }));
    expect(some).toContain("border-radius:999px;flex:none;color:var(--accent);border:1px solid var(--accent);background:var(--accent-soft)\">4</span>");
  });

  it("collapses the badge to a single accent dot", () => {
    const html = render(appState({ screen: "feed", ticketBadge: 4, collapsed: true }));
    const dots = html.match(/width:7px;height:7px;border-radius:50%;background:var\(--accent\)/g) ?? [];
    expect(dots.length).toBe(1);                       // review/maintenance counts are 0 here
    expect(html).not.toContain(">4</span>");
  });

  it("marks the nav active on all three ticket screens via data-screen", () => {
    for (const screen of ["tickets", "ticketdetail", "newticket"] as const) {
      expect(render(appState({ screen }))).toContain(`data-screen="${screen}"`);
    }
  });
});

// ── header ───────────────────────────────────────────────────────────────────

describe("header — titles, breadcrumb, queue chrome", () => {
  it("titles the three ticket screens Tickets and a sprint Roadmap", () => {
    expect(render(appState({ screen: "tickets" }))).toContain(">Tickets</h1>");
    expect(render(appState({ screen: "newticket" }))).toContain(">Tickets</button>");
    expect(render(appState({ screen: "sprint", sprintId: 3 }))).toContain(">Roadmap</button>");
  });

  it("turns the title into a back button plus a › crumb on a child screen", () => {
    const html = render(appState({ screen: "newticket" }));
    expect(html).toContain('data-act="ticketsBack"');
    expect(html).toContain("›");
    expect(html).toContain("New ticket");
  });

  it("names the open ticket in the crumb", () => {
    const html = render(appState({
      screen: "ticketdetail", ticketId: 5,
      ticketDetail: { status: "ok", data: detail({ id: 5, title: "CSV export fails" }) },
    }));
    expect(html).toContain("CSV export fails");
  });

  it("says so when the sprints fetch failed, and still renders every ticket", () => {
    // `GET /sprints` is a separate fetch from `GET /tickets`. When it fails the
    // queue must still render (everything folds into BACKLOG) AND admit that the
    // sprint grouping is missing, rather than looking like a filter swallowed rows.
    const html = render(appState({
      screen: "tickets",
      tickets: { status: "ok", data: [ticket({ id: 1, title: "Orphaned row", sprint_id: 12, sprint_label: "Sprint 12" })] },
      sprints: { status: "error", data: [], error: "boom" },
    }));
    expect(html).toContain("Couldn't load sprints");
    expect(html).toContain("Orphaned row");
    expect(html).toContain("BACKLOG");
    // …and a healthy sprints slice says nothing.
    const ok = render(appState({
      screen: "tickets",
      tickets: { status: "ok", data: [ticket({ id: 1, title: "Orphaned row" })] },
    }));
    expect(ok).not.toContain("Couldn't load sprints");
  });

  it("has no back button and no crumb on the queue itself", () => {
    const html = render(appState({ screen: "tickets" }));
    expect(html).not.toContain('data-act="ticketsBack"');
  });

  it("shows the Table/Board toggle and the submit button ONLY on the queue", () => {
    const queue = render(appState({ screen: "tickets" }));
    expect(queue).toContain('data-act="queueTable"');
    expect(queue).toContain('data-act="queueBoard"');
    expect(queue).toContain('data-act="newTicket"');
    for (const screen of ["newticket", "ticketdetail", "feed"] as const) {
      const other = render(appState({ screen }));
      expect(other).not.toContain('data-act="queueTable"');
      expect(other).not.toContain('data-act="newTicket"');
    }
  });
});

// ── queue ────────────────────────────────────────────────────────────────────

describe("queueView — table grouping", () => {
  const s12 = sprint({ id: 12, label: "Sprint 12 — Notifications GA", dates: "SEP 8 – 19", active: true, status: "in_progress" });
  const s13 = sprint({ id: 13, label: "Sprint 13 — Tickets", dates: "SEP 22 – OCT 3" });
  const s14 = sprint({ id: 14, label: "Sprint 14 — Empty", dates: "OCT 6 – 17" });

  const rows = [
    ticket({ id: 1, title: "In sprint 12", sprint_id: 12, sprint_label: s12.label }),
    ticket({ id: 2, title: "In sprint 13", sprint_id: 13, sprint_label: s13.label, assignees: ["jose-a"] }),
    ticket({ id: 3, title: "In the backlog", assignees: ["meilin"] }),
  ];

  it("groups in sprint order with BACKLOG last and drops empty groups", () => {
    const groups = queueGroups(rows, [s12, s13, s14]);
    expect(groups.map((g) => g.label)).toEqual([
      "SPRINT 12 — NOTIFICATIONS GA",
      "SPRINT 13 — TICKETS",
      "BACKLOG",
    ]);
    // Sprint 14 has no rows — hidden, not rendered as an empty group.
    const html = queueView(queueProps({ tickets: rows, sprints: [s12, s13, s14] }));
    expect(html).not.toContain("SPRINT 14 — EMPTY");
    expect(html.indexOf("SPRINT 12")).toBeLessThan(html.indexOf("SPRINT 13"));
    expect(html.indexOf("SPRINT 13")).toBeLessThan(html.indexOf("BACKLOG"));
  });

  it("labels the active sprint ACTIVE in accent and gives every sprint an Open sprint link", () => {
    const html = queueView(queueProps({ tickets: rows, sprints: [s12, s13] }));
    expect(html).toContain('<span style="color:var(--accent)"> · ACTIVE</span>');
    expect(html.match(/ · ACTIVE/g)?.length).toBe(1);        // only the active one
    expect(html).toContain('data-act="openSprint" data-arg="12"');
    expect(html).toContain('data-act="openSprint" data-arg="13"');
    // BACKLOG has no sprint to open, and reads "NO SPRINT".
    expect(html).toContain("NO SPRINT");
    expect(html).not.toContain('data-act="openSprint" data-arg=""');
  });

  it("counts each group's rows with the right singular/plural", () => {
    const html = queueView(queueProps({ tickets: rows, sprints: [s12, s13] }));
    expect(html).toContain("1 ticket<");
    const two = queueView(queueProps({
      tickets: [rows[0], ticket({ id: 9, title: "Also 12", sprint_id: 12 })],
      sprints: [s12],
    }));
    expect(two).toContain("2 tickets<");
  });

  it("opens the detail from a row", () => {
    const html = queueView(queueProps({ tickets: rows, sprints: [s12] }));
    expect(html).toContain('data-act="openTicket" data-arg="1"');
  });

  // GET /sprints is a SEPARATE fetch from GET /tickets: it can fail, or simply
  // land later. If a ticket whose sprint is missing fell out of every group it
  // would vanish from the table while the footer kept counting it — silent, and
  // it looks like a filter bug because Board view (grouped by status) is fine.
  it("folds a ticket whose sprint is not loaded into BACKLOG rather than dropping it", () => {
    const orphan = ticket({ id: 7, title: "Sprint went missing", sprint_id: 999, sprint_label: "Gone" });
    const groups = queueGroups([...rows, orphan], []);
    expect(groups.map((g) => g.label)).toEqual(["BACKLOG"]);
    expect(groups[0].rows.map((t) => t.id)).toEqual([1, 2, 3, 7]);   // every row, nothing dropped

    const html = queueView(queueProps({ tickets: [...rows, orphan], sprints: [] }));
    expect(html).toContain("Sprint went missing");
    expect(html).toContain("4 shown · 0 unassigned");                // the footer and the table agree
  });

  it("still folds an unknown sprint_id into BACKLOG when OTHER sprints did load", () => {
    const orphan = ticket({ id: 7, title: "Stale sprint ref", sprint_id: 999 });
    const groups = queueGroups([...rows, orphan], [s12, s13]);
    expect(groups.map((g) => g.label)).toEqual([
      "SPRINT 12 — NOTIFICATIONS GA", "SPRINT 13 — TICKETS", "BACKLOG",
    ]);
    expect(groups[2].rows.map((t) => t.id)).toEqual([3, 7]);
  });
});

describe("queueView — the needs-attention rule (design call #6)", () => {
  const cases: [string, TicketListItem, boolean][] = [
    ["unassigned + submitted", ticket({ id: 1, title: "A" }), true],
    ["assigned + submitted", ticket({ id: 2, title: "B", assignees: ["jose-a"] }), false],
    ["unassigned + in progress", ticket({ id: 3, title: "C", status: "in_progress" }), false],
    ["unassigned + done", ticket({ id: 4, title: "D", status: "done" }), false],
    ["unassigned + declined", ticket({ id: 5, title: "E", status: "declined" }), false],
  ];
  for (const [name, t, want] of cases) {
    it(`${want ? "marks" : "leaves plain"}: ${name}`, () => {
      const html = queueView(queueProps({ tickets: [t], seg: "all" }));
      // The marker is the faint `.cnpy-attn` fill and NOTHING else.
      expect(html.includes("cnpy-attn")).toBe(want);
    });
  }

  it("marks exactly the unassigned submitted rows in a mixed queue", () => {
    const html = queueView(queueProps({ tickets: cases.map(([, t]) => t), seg: "all" }));
    expect(html.match(/cnpy-attn/g)?.length).toBe(1);
  });

  it("marks the board CARD the same way, fill only", () => {
    const board = queueView(queueProps({ tickets: cases.map(([, t]) => t), seg: "all", view: "board" }));
    expect(board.match(/cnpy-attn/g)?.length).toBe(1);
    expect(board).toContain("cnpy-card cnpy-attn");
  });

  it("carries NO inset left rule — owner request: the fill alone marks it", () => {
    // Table rows and board cards both: the 2px accent edge must not come back,
    // in any form, while the faint fill stays.
    for (const view of ["table", "board"] as const) {
      const html = queueView(queueProps({ tickets: cases.map(([, t]) => t), seg: "all", view }));
      expect(html).toContain("cnpy-attn");                     // the fill survives
      expect(html).not.toContain("box-shadow:inset 2px 0 0 var(--accent)");
      expect(html).not.toMatch(/box-shadow:inset/);
      expect(html).not.toMatch(/border-left:\s*2px/);
    }
  });
});

describe("queueView — the footer count", () => {
  it("is 'N shown · M unassigned' where M is the org-wide badge, not the page", () => {
    const html = queueView(queueProps({
      tickets: [ticket({ id: 1, title: "A" }), ticket({ id: 2, title: "B" }), ticket({ id: 3, title: "C" })],
      unassignedCount: 7,
    }));
    expect(html).toContain("3 shown · 7 unassigned");
  });

  it("reads 0 shown on an empty queue", () => {
    expect(queueView(queueProps({ unassignedCount: 0 }))).toContain("0 shown · 0 unassigned");
  });
});

describe("queueView — the filter row", () => {
  it("renders the segment, the assignee select and the category select with the design's labels", () => {
    const html = queueView(queueProps({ seg: "closed", assignee: "me", category: "bug" }));
    expect(html).toContain('data-act="queueSeg" data-arg="open"');
    expect(html).toContain('data-act="queueSeg" data-arg="closed"');
    expect(html).toContain('data-act="queueSeg" data-arg="all"');
    expect(html).toContain('<select data-act="queueAssignee"');
    expect(html).toContain(">Any assignee</option>");
    expect(html).toContain(">Assigned to me</option>");
    expect(html).toContain(">Unassigned</option>");
    expect(html).toContain('<select data-act="queueCategory"');
    expect(html).toContain(">All categories</option>");
    for (const c of ["bug", "request", "question", "access", "other"]) {
      expect(html).toContain(`<option value="${c}"`);
    }
    // The current values are the selected ones.
    expect(html).toContain('<option value="me" selected>');
    expect(html).toContain('<option value="bug" selected>');
  });
});

describe("queueView — board columns follow the segment", () => {
  const rows = [
    ticket({ id: 1, title: "S", status: "submitted" }),
    ticket({ id: 2, title: "P", status: "in_progress" }),
    ticket({ id: 3, title: "D", status: "done" }),
    ticket({ id: 4, title: "X", status: "declined" }),
  ];
  const columnLabels = (html: string) =>
    (html.match(/letter-spacing:\.08em;white-space:nowrap;color:var\(--(?:accent|blue|fg-40)\)">([A-Z ]+)</g) ?? [])
      .map((m) => m.replace(/.*">/, "").replace(/<$/, ""));

  it("open → SUBMITTED + IN PROGRESS", () => {
    const html = queueView(queueProps({ tickets: rows, view: "board", seg: "open" }));
    expect(columnLabels(html)).toEqual(["SUBMITTED", "IN PROGRESS"]);
    expect(SEG_STATUSES.open).toEqual(["submitted", "in_progress"]);
  });

  it("closed → DONE + DECLINED", () => {
    const html = queueView(queueProps({ tickets: rows, view: "board", seg: "closed" }));
    expect(columnLabels(html)).toEqual(["DONE", "DECLINED"]);
  });

  it("all → four columns in status order", () => {
    const html = queueView(queueProps({ tickets: rows, view: "board", seg: "all" }));
    expect(columnLabels(html)).toEqual(["SUBMITTED", "IN PROGRESS", "DONE", "DECLINED"]);
    expect(html).toContain("grid-template-columns:repeat(4,minmax(0,1fr))");
  });

  it("colors the headers per the design and shows a dashed placeholder for an empty column", () => {
    const html = queueView(queueProps({ tickets: [rows[0]], view: "board", seg: "open" }));
    expect(html).toContain("color:var(--blue)\">SUBMITTED");
    expect(html).toContain("color:var(--accent)\">IN PROGRESS");
    expect(html).toContain("border:1px dashed var(--border)");
    expect(html).toContain("Nothing here");
    expect(html.match(/Nothing here/g)?.length).toBe(1);   // only IN PROGRESS is empty
  });

  it("renders no table header in board mode (and vice versa)", () => {
    const board = queueView(queueProps({ tickets: rows, view: "board", seg: "all" }));
    expect(board).not.toContain("<div>OPENED BY</div>");
    const table = queueView(queueProps({ tickets: rows, view: "table", seg: "all" }));
    expect(table).toContain("<div>OPENED BY</div>");
  });
});

describe("queueView — the row", () => {
  it("shows N sub on a parent and ↳ sub-ticket on a child, nothing otherwise", () => {
    const html = queueView(queueProps({
      tickets: [
        ticket({ id: 1, title: "Parent", sub_count: 2 }),
        ticket({ id: 2, title: "Child", parent_id: 1 }),
        ticket({ id: 3, title: "Lonely" }),
      ],
      seg: "all",
    }));
    expect(html).toContain("2 sub");
    expect(html).toContain("↳ sub-ticket");
    // Three rows, two relation chips.
    expect(html.match(/data-act="openTicket"/g)?.length).toBe(3);
    expect(html.match(/font-size:9\.5px/g)?.length).toBe(2);
  });

  it("writes the assignee cell as italic Unassigned, a full name, or First +N", () => {
    const html = queueView(queueProps({
      tickets: [
        ticket({ id: 1, title: "None" }),
        ticket({ id: 2, title: "One", assignees: ["meilin"] }),
        ticket({ id: 3, title: "Two", assignees: ["meilin", "sanaok"] }),
      ],
      seg: "all",
    }));
    expect(html).toContain("font-style:italic\">Unassigned<");
    expect(html).toContain(">Meilin Zhao<");
    expect(html).toContain(">Meilin +1<");
  });

  it("escapes hostile ticket titles", () => {
    const html = queueView(queueProps({ tickets: [ticket({ id: 1, title: `<img src=x onerror="alert(1)">` })] }));
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });
});

// ── new ticket ───────────────────────────────────────────────────────────────

describe("newTicketView", () => {
  it("keeps Submit inert until the title is non-empty", () => {
    const empty = newTicketView(formProps({ title: "   " }));
    expect(empty).toContain('data-act="ntSubmit"');
    expect(empty).toContain("color:var(--fg-40);border:1px solid var(--border);cursor:default");
    expect(empty).not.toContain("background:var(--accent);color:var(--accent-fg)");

    const typed = newTicketView(formProps({ title: "Export is broken" }));
    expect(typed).toContain("background:var(--accent);color:var(--accent-fg)");
  });

  it("opens with the design's defaults: no category, Normal, Backlog, Unassigned", () => {
    const html = newTicketView(formProps({ sprints: [sprint({ id: 12, label: "Sprint 12" })] }));
    const on = "border:1px solid var(--accent);color:var(--accent);background:var(--accent-soft)";
    // No category chip is selected (none selected = `other` on submit).
    for (const c of ["bug", "request", "question", "access", "other"]) {
      expect(html).toContain(`data-act="ntCategory" data-arg="${c}"`);
      const chip = html.slice(html.indexOf(`data-arg="${c}"`), html.indexOf(`>${c}<`));
      expect(chip).not.toContain(on);
    }
    // Normal is the selected priority segment.
    const normal = html.slice(html.indexOf('data-act="ntPriority" data-arg="normal"'), html.indexOf(">Normal<"));
    expect(normal).toContain("color:var(--fg);background:var(--hover)");
    const low = html.slice(html.indexOf('data-act="ntPriority" data-arg="low"'), html.indexOf(">Low<"));
    expect(low).toContain("color:var(--fg-55);background:transparent");
    // Backlog is the selected sprint chip; Unassigned the selected assignee chip.
    const backlog = html.slice(html.indexOf('data-act="ntSprint" data-arg=""'), html.indexOf(">Backlog<"));
    expect(backlog).toContain(on);
    const unassigned = html.slice(html.indexOf('data-act="ntAssignee" data-arg=""'), html.indexOf("Unassigned</button>"));
    expect(unassigned).toContain(on);
  });

  it("carries the design's placeholders verbatim", () => {
    const html = newTicketView(formProps());
    expect(html).toContain('placeholder="One line: what do you need?"');
    expect(html).toContain(`placeholder="What's happening, and what would good look like?"`);
    expect(html).toContain('placeholder="GitHub or Figma URL, or #issue-number"');
  });

  it("offers Backlog plus every sprint, and Unassigned plus every person", () => {
    const html = newTicketView(formProps({
      sprints: [sprint({ id: 12, label: "Sprint 12" }), sprint({ id: 13, label: "Sprint 13" })],
      sprintId: 13,
      assignees: ["meilin", "sanaok"],
    }));
    expect(html.match(/data-act="ntSprint"/g)?.length).toBe(3);
    expect(html.match(/data-act="ntAssignee"/g)?.length).toBe(4);
    const on = "border:1px solid var(--accent);color:var(--accent);background:var(--accent-soft)";
    const s13 = html.slice(html.indexOf('data-act="ntSprint" data-arg="13"'), html.indexOf(">Sprint 13<"));
    expect(s13).toContain(on);
  });

  it("echoes the typed values back into the fields", () => {
    const html = newTicketView(formProps({ title: "A & B", description: "line one", link: "#214" }));
    expect(html).toContain('value="A &amp; B"');
    expect(html).toContain(">line one</textarea>");
    expect(html).toContain('value="#214"');
  });

  it("cancels back to the queue with the same act the breadcrumb uses", () => {
    expect(newTicketView(formProps())).toContain('data-act="ticketsBack"');
  });
});

// ── ticket detail ────────────────────────────────────────────────────────────

describe("ticketDetailView — transitions (design call #7)", () => {
  it("submitted offers Start + Decline only", () => {
    const html = ticketDetailView(detailProps(detail({ id: 1, title: "T", status: "submitted" })));
    expect(html).toContain('data-act="ticketStatus" data-arg="in_progress"');
    expect(html).toContain(">Start<");
    expect(html).toContain('data-act="ticketStatus" data-arg="declined"');
    expect(html).toContain(">Decline<");
    expect(html).not.toContain('data-arg="done"');
    expect(html.match(/data-act="ticketStatus"/g)?.length).toBe(2);
  });

  it("in_progress offers Done + Back only", () => {
    const html = ticketDetailView(detailProps(detail({ id: 1, title: "T", status: "in_progress" })));
    expect(html).toContain('data-act="ticketStatus" data-arg="done"');
    expect(html).toContain(">Done<");
    expect(html).toContain('data-act="ticketStatus" data-arg="submitted"');
    expect(html).toContain(">Back to submitted<");
    expect(html).not.toContain('data-arg="declined"');
    expect(html.match(/data-act="ticketStatus"/g)?.length).toBe(2);
  });

  it("offers nothing from a terminal status", () => {
    for (const status of ["done", "declined"] as const) {
      const html = ticketDetailView(detailProps(detail({ id: 1, title: "T", status })));
      expect(html).not.toContain('data-act="ticketStatus"');
    }
  });
});

describe("ticketDetailView — linked work (design call #8)", () => {
  it("shows the link field, and no 'Linked to engineering work' line, while there are no links", () => {
    const html = ticketDetailView(detailProps(detail({ id: 1, title: "T" })));
    expect(html).toContain('data-field="ticketLinkDraft"');
    expect(html).toContain('data-act="ticketLinkAdd"');
    expect(html).not.toContain("Linked to engineering work");
    expect(html).not.toContain('data-act="ticketLinkToggle"');
  });

  it("replaces it with the plain line once a link exists", () => {
    const html = ticketDetailView(detailProps(detail({ id: 1, title: "T", links: [link()] })));
    expect(html).toContain("Linked to engineering work");
    expect(html).not.toContain('data-field="ticketLinkDraft"');
    expect(html).toContain('data-act="ticketLinkToggle"');     // the escape hatch for a second link
    expect(html).toContain("sapling #214");
    expect(html).toContain("GITHUB · ISSUE");
    expect(html).toContain('href="https://github.com/SaplingLearn/sapling/issues/214"');
  });

  it("re-opens the field through the toggle", () => {
    const html = ticketDetailView(detailProps(detail({ id: 1, title: "T", links: [link()] }), { linkOpen: true }));
    expect(html).toContain('data-field="ticketLinkDraft"');
  });

  it("never dereferences a non-http(s) stored url", () => {
    const html = ticketDetailView(detailProps(detail({
      id: 1, title: "T", links: [link({ url: "javascript:alert(1)", kind: "plain", label: "bad" })],
    })));
    expect(html).not.toContain("javascript:alert(1)");
    expect(html).toContain('href="#"');
  });
});

describe("relCandidates — the sub-ticket add menu's filter", () => {
  const self = detail({ id: 1, title: "Self", parent_id: 4 });
  const all: TicketListItem[] = [
    ticket({ id: 1, title: "Self" }),                                  // excluded: self
    ticket({ id: 4, title: "My parent", sub_count: 1 }),               // excluded: is the parent
    ticket({ id: 5, title: "Has a parent", parent_id: 9 }),            // excluded: already nested
    ticket({ id: 6, title: "Has children", sub_count: 3 }),            // excluded: is a parent
    ticket({ id: 7, title: "Closed done", status: "done" }),           // excluded: closed
    ticket({ id: 8, title: "Closed declined", status: "declined" }),   // excluded: closed
    ticket({ id: 10, title: "Eligible submitted" }),
    ticket({ id: 11, title: "Eligible in progress", status: "in_progress" }),
  ];

  it("keeps only free, open tickets", () => {
    expect(relCandidates(all, self).map((t) => t.id)).toEqual([10, 11]);
  });

  it("drops each exclusion independently", () => {
    for (const id of [1, 4, 5, 6, 7, 8]) {
      expect(relCandidates(all, self).some((t) => t.id === id)).toBe(false);
    }
  });

  it("offers the menu on a root ticket and hides it on one that already has a parent", () => {
    const root = detail({ id: 1, title: "Root" });
    const open = ticketDetailView(detailProps(root, { allTickets: all, relMenu: true }));
    expect(open).toContain('data-act="ticketRelMenu"');
    expect(open).toContain("LINK A TICKET AS A SUB-TICKET");
    expect(open).toContain('data-act="ticketRelAdd" data-arg="10"');

    // A ticket that already has a parent can never become one (one level).
    const nested = ticketDetailView(detailProps(self, { allTickets: all, relMenu: true }));
    expect(nested).not.toContain('data-act="ticketRelMenu"');
    expect(nested).not.toContain('data-act="ticketRelAdd"');
  });

  it("shows the parent line, the children, and an empty state when there is neither", () => {
    const withRel = ticketDetailView(detailProps(detail({
      id: 1, title: "T",
      parent: { id: 4, title: "Parent ticket", status: "in_progress" },
      children: [{ id: 5, title: "Child ticket", status: "submitted" }],
    })));
    expect(withRel).toContain("PARENT TICKET");
    expect(withRel).toContain("Parent ticket");
    expect(withRel).toContain("SUB-TICKET · SUBMITTED");
    expect(withRel).toContain('data-act="openTicket" data-arg="4"');
    expect(withRel).toContain('data-act="openTicket" data-arg="5"');
    expect(withRel).not.toContain("No linked tickets");

    expect(ticketDetailView(detailProps(detail({ id: 1, title: "T" })))).toContain("No linked tickets");
  });
});

describe("ticketDetailView — the thread", () => {
  it("renders the opening event as 'opened this ticket' and later ones as from → to", () => {
    const html = ticketDetailView(detailProps(detail({
      id: 1, title: "T", status: "in_progress",
      events: [
        event({ id: 1, actor: "meilin", from_status: null, to_status: "submitted", created_at: ago(3 * H) }),
        event({ id: 2, actor: "jose-a", from_status: "submitted", to_status: "in_progress", created_at: ago(1 * H) }),
      ],
    })));
    expect(html).toContain("opened this ticket");
    expect(html).not.toContain("opened · SUBMITTED");
    expect(html).toContain("Submitted → In progress");
    expect(html.indexOf("opened this ticket")).toBeLessThan(html.indexOf("Submitted → In progress"));
  });

  it("merges comments and history ascending by time", () => {
    const html = ticketDetailView(detailProps(detail({
      id: 1, title: "T",
      comments: [comment({ id: 1, author: "meilin", body: "SECOND", created_at: ago(2 * H) })],
      events: [
        event({ id: 1, from_status: null, to_status: "submitted", created_at: ago(3 * H) }),
        event({ id: 2, from_status: "submitted", to_status: "in_progress", created_at: ago(1 * H) }),
      ],
    })));
    expect(html.indexOf("opened this ticket")).toBeLessThan(html.indexOf("SECOND"));
    expect(html.indexOf("SECOND")).toBeLessThan(html.indexOf("Submitted → In progress"));
    expect(html).toContain("1 comment<");
  });

  it("keeps Post inert until the draft is non-empty", () => {
    const empty = ticketDetailView(detailProps(detail({ id: 1, title: "T" }), { commentDraft: "  " }));
    expect(empty).toContain('data-act="ticketCommentPost"');
    expect(empty).toContain("color:var(--fg-40);border:1px solid var(--border);cursor:default");
    const typed = ticketDetailView(detailProps(detail({ id: 1, title: "T" }), { commentDraft: "hi" }));
    expect(typed).toContain("background:var(--accent);color:var(--accent-fg)");
    expect(typed).toContain(">hi</textarea>");
  });

  it("escapes comment bodies and paints known @mentions (handle AND first-name form)", () => {
    const html = ticketDetailView(detailProps(detail({
      id: 1, title: "T",
      // @meilin = the handle form, @Sana = the first-name form, @nobody = not an
      // org member, so it must survive as plain text (design's `mention()`).
      comments: [comment({ body: "<b>hi</b> @meilin and @Sana and @nobody" })],
    })));
    expect(html).not.toContain("<b>hi</b>");
    expect(html).toContain("&lt;b&gt;hi&lt;/b&gt;");
    // Both resolving forms become the accent chip carrying the person's FIRST name.
    const chip = (first: string) =>
      `<span style="color:var(--accent);font-weight:600;background:var(--accent-soft);border-radius:4px;padding:0 4px">@${first}</span>`;
    expect(html).toContain(chip("Meilin"));   // @meilin → handle match
    expect(html).toContain(chip("Sana"));     // @Sana   → first-name match
    // A non-member stays plain: the literal text is there and it is NOT chipped.
    expect(html).toContain("@nobody");
    expect(html).not.toContain(chip("nobody"));
    expect(html).not.toContain(">@nobody</span>");
  });
});

describe("ticketDetailView — the @mention picker", () => {
  const d = detail({ id: 1, title: "T" });
  const open = (query: string, index = 0, start = 0) =>
    ticketDetailView(detailProps(d, { commentDraft: `@${query}`, mention: { query, start, index } }));

  it("is hidden when nothing is being mentioned", () => {
    const html = ticketDetailView(detailProps(d, { commentDraft: "hello", mention: null }));
    expect(html).not.toContain('data-act="mentionPick"');
    expect(html).not.toContain('role="listbox"');
  });

  it("renders a listbox of candidate rows under the comment box", () => {
    const html = open("sa");
    expect(html).toContain('role="listbox"');
    expect(html).toContain('data-act="mentionPick" data-arg="sanaok"');
    expect(html).toContain('role="option"');
    // Each row carries the name and the @handle, and the picker is anchored.
    expect(html).toContain("Sana Okafor");
    expect(html).toContain("@sanaok</span>");
    expect(html).toContain("position:absolute;top:calc(100% + 6px)");
    // It sits INSIDE the comment box, right after the textarea.
    expect(html).toMatch(/<\/textarea>\s*<div role="listbox"/);
  });

  it("lists every person on an empty query (the @ was just typed)", () => {
    const html = open("");
    for (const p of PERSONS) expect(html).toContain(`data-arg="${p.handle}"`);
  });

  it("matches a first name, not just a handle", () => {
    const html = open("Meil");
    expect(html).toContain('data-arg="meilin"');
    expect(html).not.toContain('data-arg="sanaok"');
  });

  it("is hidden when the query matches nobody", () => {
    const html = open("zzzz");
    expect(html).not.toContain('data-act="mentionPick"');
    expect(html).not.toContain('role="listbox"');
  });

  it("paints only the active row, and moves it with the index", () => {
    const first = open("", 0);
    const second = open("", 1);
    const hits = (h: string) => h.split("background:var(--hover)").length - 1;
    expect(hits(first)).toBe(1);
    expect(hits(second)).toBe(1);
    // index 0 → jose-a (names ascending); index 1 → meilin.
    expect(first).toContain('data-arg="jose-a" role="option" aria-selected="true"');
    expect(first).toContain('data-arg="meilin" role="option" aria-selected="false"');
    expect(second).toContain('data-arg="meilin" role="option" aria-selected="true"');
    expect(second).toContain('data-arg="jose-a" role="option" aria-selected="false"');
  });

  it("wraps a stale index rather than painting no row at all", () => {
    // The query narrowed to one candidate while the index was still on row 2.
    const html = open("sana", 2);
    expect(html.split("background:var(--hover)").length - 1).toBe(1);
    expect(html).toContain('data-arg="sanaok" role="option" aria-selected="true"');
  });

  it("carries the keyboard hint", () => {
    expect(open("sa")).toContain("↑↓ to move · Enter to mention · Esc to close");
  });
});

describe("ticketDetailView — the rails", () => {
  const s12 = sprint({ id: 12, label: "Sprint 12", dates: "SEP 8 – 19", active: true, status: "in_progress" });
  const s13 = sprint({ id: 13, label: "Sprint 13", dates: "SEP 22 – OCT 3" });

  it("ticks the current sprint in the menu and leaves the others unticked", () => {
    const html = ticketDetailView(detailProps(
      detail({ id: 1, title: "T", sprint_id: 13, sprint: { id: 13, label: "Sprint 13" } }),
      { sprints: [s12, s13], sprMenu: true }
    ));
    expect(html).toContain('data-act="ticketSprintSet" data-arg=""');       // Backlog
    expect(html).toContain('data-act="ticketSprintSet" data-arg="12"');
    expect(html).toContain('data-act="ticketSprintSet" data-arg="13"');
    // Exactly one accent tick, and it belongs to Sprint 13.
    expect(html.match(/style="flex:none;color:var\(--accent\)"/g)?.length).toBe(1);
    expect(html.match(/style="flex:none;visibility:hidden"/g)?.length).toBe(2);
    const row13 = html.slice(html.indexOf('data-arg="13"'), html.indexOf('data-arg="13"') + 600);
    expect(row13).toContain("flex:none;color:var(--accent)");
  });

  it("links the rail to the sprint screen when set, and reads Backlog / NO SPRINT when not", () => {
    const set = ticketDetailView(detailProps(
      detail({ id: 1, title: "T", sprint_id: 12, sprint: { id: 12, label: "Sprint 12" } }),
      { sprints: [s12] }
    ));
    expect(set).toContain('data-act="openSprint" data-arg="12"');
    expect(set).toContain("SEP 8 – 19");

    const unset = ticketDetailView(detailProps(detail({ id: 1, title: "T" }), { sprints: [s12] }));
    expect(unset).toContain(">Backlog<");
    expect(unset).toContain(">NO SPRINT<");
    expect(unset).not.toContain('data-act="openSprint"');
  });

  it("offers remove on each assignee and add for everyone else", () => {
    const html = ticketDetailView(detailProps(
      detail({ id: 1, title: "T", assignees: ["meilin"] }),
      { asgMenu: true }
    ));
    expect(html).toContain('data-act="ticketAsgRemove" data-arg="meilin"');
    expect(html).toContain('data-act="ticketAsgMenu"');
    expect(html).toContain('data-act="ticketAsgAdd" data-arg="sanaok"');
    expect(html).toContain('data-act="ticketAsgAdd" data-arg="jose-a"');
    expect(html).not.toContain('data-act="ticketAsgAdd" data-arg="meilin"');
    expect(html).toContain('data-act="closeTicketMenus"');
  });

  it("shows the italic Unassigned placeholder with no assignees", () => {
    const html = ticketDetailView(detailProps(detail({ id: 1, title: "T" })));
    expect(html).toContain("font-style:italic\">Unassigned<");
    expect(html).not.toContain('data-act="ticketAsgRemove"');
  });

  it("repeats status / category / priority in the Properties rail", () => {
    const html = ticketDetailView(detailProps(detail({ id: 1, title: "T", status: "in_progress", category: "access", priority: "high" })));
    expect(html).toContain(">STATUS</div>");
    expect(html).toContain(">CATEGORY</div>");
    expect(html).toContain(">PRIORITY</div>");
    expect(html).toContain(">access</span>");
    expect(html).toContain(">HIGH</span>");
  });
});

// ── screen routing through render() ──────────────────────────────────────────

describe("render — the ticket screens", () => {
  it("paints the queue from the tickets slice", () => {
    const html = render(appState({
      screen: "tickets",
      tickets: { status: "ok", data: [ticket({ id: 1, title: "Queue row" })] },
      ticketBadge: 1,
    }));
    expect(html).toContain("Queue row");
    expect(html).toContain("1 shown · 1 unassigned");
  });

  it("shows a loading notice before the queue arrives", () => {
    expect(render(appState({ screen: "tickets" }))).toContain("Loading the queue");
  });

  it("paints the detail from the ticketDetail slice, and says so when it is missing", () => {
    const ok = render(appState({
      screen: "ticketdetail", ticketId: 3,
      ticketDetail: { status: "ok", data: detail({ id: 3, title: "Detail row" }) },
    }));
    expect(ok).toContain("Detail row");

    const gone = render(appState({ screen: "ticketdetail", ticketId: 3, ticketDetail: { status: "ok", data: null } }));
    expect(gone).toContain("That ticket doesn't exist.");
  });

  it("paints the new-ticket form", () => {
    expect(render(appState({ screen: "newticket" }))).toContain('data-act="ntSubmit"');
  });
});
