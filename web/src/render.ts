// Faithful static port of Canopy.dc.html — markup + inline styles transcribed
// from the dc-runtime template (lines 53–731), with `sc-for` resolved to
// `.map().join('')`, `sc-if` to ternaries, and `onClick="{{ fn }}"` to
// `data-act` / `data-arg` attributes dispatched in main.ts.

import type { Me, StagedProposal, IdentityTask, PersonSummary, InviteRow } from "./api";
import type { FeedRow, DocRow, DocVersionRow, AdrRow, NeedsTriageRow, PersonColor } from "@shared/rows";
import type { QueryResult, QueryPrimary, QueryPointer, Authority, SprintView, SprintDetail, PlanView } from "./api";
import type { TicketListItem, TicketDetail, TicketSeg, TicketAssigneeFilter, TicketCategory } from "./api";
import type { TicketPriority } from "@shared/tickets";
import { queueView, newTicketView, ticketDetailView, ticketPill, priorityChip, type StatusMenuAnchor } from "./tickets";
import { sprintCard, newSprintPanel, newSprintToggle, sprintScreen } from "./sprints";
import type { SprintUrgency, SprintDomain } from "@shared/sprints";
import { initialOnboard, onboardView, personChip, handleTag, swatches, type OnboardState } from "./people";
import type { DashboardData, MyWorkPr, MyWorkTodo, MyWorkTicket } from "@shared/dashboard";
import { TAGS } from "@shared/vocabulary";
import { renderMarkdown, renderMarkdownInline } from "./markdown";
import { extractOutline } from "./outline";
import { REPO_URL } from "./github";
import { esc, attr, initialsOf, relTime } from "./ui";
import { landingView } from "./landing";
import { reviewView, type ReviewFilter, type ReviewProps, type DiffViewMode } from "./review";
import { maintenanceView, peopleSection, type MaintenanceProps, type AssignKind } from "./maintenance";
import { emailNotificationsSection, notificationsMaintenanceSections, unsubscribeView } from "./notifications";
import type { PrefsView, PolicyKindView, NotificationOutboxRow, NotificationSettingsRow, McpTokenSummary } from "./api";
import { sidebarView, NAV_CLOSED, type NavOpen } from "./sidebar";
import { repoView, repoControls, repoCrumb, type RepoProps, type RepoPollState } from "./repo";
import type { RepoDashboard, RepoTab, RepoRange } from "@shared/repo";
import { reviewItemsFromReads, ASSIGN_OPTIONS, unplacedFromRow, identityFromTask, peopleFromPersons } from "./triage-map";

// A docs "space" is a free-form top-level grouping shown as a toggle (e.g.
// Technical | Product). Values come from the data, not a fixed union.
export type DocSpace = string;

export type Screen =
  | "mywork" | "feed" | "docs" | "roadmap" | "review" | "maintenance" | "search" | "settings" | "guide" | "unsubscribe"
  // The landing page reopened from inside the app (sidebar logo). Full-screen, no chrome.
  | "site"
  // Tickets (Phase 5): the queue, one ticket, the new-ticket form, and a sprint.
  // `sprint` is a Roadmap child — the sidebar highlights Roadmap while it is open.
  | "tickets" | "ticketdetail" | "newticket" | "sprint"
  // The Repo dashboard (Monitor › Repo): five tabs under one screen, `#repo/<tab>`.
  | "repo";

/** Async data slice: a screen's fetched payload plus its load status. */
export interface Loadable<T> {
  status: "idle" | "loading" | "ok" | "error" | "unauth";
  data: T;
  error?: string;
}

export interface AppState {
  view: "auth" | "app";
  authStep: "login" | "verifying" | "nonmember" | "notinvited" | "onboard";
  /** The landing page's sign-in dialog (authStep "login" only). */
  signInOpen: boolean;
  /** Landing reveal keys that already played (landing-motion.ts records them). */
  landingSeen: Set<string>;
  /** Where "Back to the app" on the #site landing returns to (the route the logo was clicked from). */
  siteReturn: import("./hash").Route | null;
  deniedEmail: string | null;
  onboard: OnboardState;
  persons: Loadable<PersonSummary[]>;
  invites: Loadable<InviteRow[]>;
  inviteDraft: string;
  me: Me | null;
  mywork: Loadable<DashboardData | null>;
  screen: Screen;
  theme: "dark" | "light" | "midnight" | "system";
  systemDark: boolean;
  collapsed: boolean;
  /** The viewport is too narrow for the full rail — it renders collapsed regardless of `collapsed`. */
  narrow: boolean;
  /** Which sidebar entries have their sub-page list open (persisted; a group opens itself on entry). */
  navOpen: NavOpen;
  // ── Repo dashboard ─────────────────────────────────────────────────────────
  repo: Loadable<RepoDashboard | null>;
  repoTab: RepoTab;
  repoRange: RepoRange;
  /** Usage › Product: the environment picked this session (null = the default one). */
  repoProductEnv: string | null;
  repoDriftOpen: boolean;
  /** When `repo` last loaded (ms) — the header's "updated Xm ago". */
  repoFetchedAt: number | null;
  /** Showing the built-in sample set instead of the Worker's projection. Session-only. */
  repoSample: boolean;
  /** The admin's last "Poll now" on the Usage tab. Session-only, never persisted; cleared on leaving the Repo screen. */
  repoPoll: RepoPollState | null;
  feedAuthor: string;
  feedTag: string;
  feedRange: string;
  feed: Loadable<FeedRow[]>;
  feedAuthors: string[];
  docsList: Loadable<DocRow[]>;
  docDetail: Loadable<{ doc: DocRow; versions: DocVersionRow[] } | null>;
  docSlug: string | null;
  docSpace: DocSpace;
  /** Docs-tree pages whose outline (in-page headings) is expanded, keyed by slug. */
  docOutlineOpen: Record<string, boolean>;
  /** Heading id to scroll the reader to after the next render, then cleared. */
  pendingScrollId: string | null;
  roadmapTab: "narrative" | "timeline";
  roadmap: Loadable<PlanView>;
  // Triage surfaces (Review + Maintenance) — four Loadable slices, one per
  // list read; each surface's counts/props derive straight from these.
  proposals: Loadable<StagedProposal[]>;
  draftAdrs: Loadable<AdrRow[]>;
  needsTriage: Loadable<NeedsTriageRow[]>;
  identityTasks: Loadable<IdentityTask[]>;
  reviewFilter: ReviewFilter;
  reviewSel: string | null;
  reviewDiffView: DiffViewMode;
  assignOpen: string | null;
  assignKind: AssignKind | null;
  assignSection: string | null;
  assignSpace: string | null;
  assignTags: string[];
  mapConfirm: string | null;
  mapPicks: Record<string, string>;
  showHistory: boolean;
  searchQuery: string;
  searchType: "all" | "doc" | "feed" | "decision";
  searchResults: Loadable<QueryResult>;
  displayName: string;
  /** Settings › "Get connection command": the modal, open while non-null. `token` is
   *  null while the mint is in flight; `error` is set when it failed. The token lives
   *  ONLY here — closing the modal drops it, and the server keeps just a hash. */
  connect: { token: string | null; error: string | null } | null;
  /** Which client's setup the modal shows, and its Copy button's state. */
  connectClient: ConnectClient;
  connectCopied: boolean;
  /** Settings › MCP access tokens: the caller's live tokens (hint only, never the value). */
  tokens: Loadable<McpTokenSummary[]>;
  /** The token whose Revoke was clicked once — the second click is the one that revokes. */
  tokenRevokeArm: number | null;
  // Settings › Profile: the handle rename editor.
  handleEdit: boolean;
  handleDraft: string;
  handleCheck: "idle" | "checking" | "available" | "invalid" | "reserved" | "taken" | "same";
  // Email notifications (Settings) — the user's resolved prefs + the address edit form.
  notifPrefs: Loadable<PrefsView | null>;
  emailEditing: boolean;
  emailDraft: string;
  // Email notifications (Maintenance, admin) — policy / schedule / recent outbox.
  notifPolicy: Loadable<PolicyKindView[]>;
  notifSettings: Loadable<NotificationSettingsRow | null>;
  notifOutbox: Loadable<NotificationOutboxRow[]>;
  outboxExpanded: string | null;
  fromDraft: string | null;
  /** The #unsubscribe screen: the flip in flight, its error, or a Settings preview (no flip). */
  unsub: { pending: boolean; error: string | null; preview: boolean };
  confirmedSprints: Record<string, boolean>;
  // ── Tickets (Phase 5) ──────────────────────────────────────────────────────
  /** The queue list for the CURRENT filters (the server applies seg/assignee/category). */
  tickets: Loadable<TicketListItem[]>;
  ticketDetail: Loadable<TicketDetail | null>;
  /** The ticket the detail screen is showing (from `#tickets/<id>`). */
  ticketId: number | null;
  /** Unassigned + open, org-wide — the sidebar badge AND the queue's footer count. */
  ticketBadge: number;
  qSeg: TicketSeg;
  qAssignee: TicketAssigneeFilter;
  qCategory: TicketCategory | "all";
  qView: "table" | "board";
  // New-ticket form fields (the design's f* state).
  fTitle: string;
  /** null = nothing picked, which files as `other`. */
  fCat: TicketCategory | null;
  fPrio: TicketPriority;
  fDesc: string;
  fAsgs: string[];
  fLink: string;
  /** null = Backlog. */
  fSpr: number | null;
  // Ticket-detail-only UI state (drafts + which popover is open).
  commentDraft: string;
  /**
   * The open @mention picker over the comment box: the token being typed
   * (`start` is the index of its `@` in `commentDraft`), the active row, and
   * the caret's 0-based line, which is what the picker hangs under.
   * null = closed. Reset whenever the detail changes or a comment posts.
   */
  mention: { query: string; start: number; index: number; line: number } | null;
  /** The comment box's height after a grip drag (null = the resting height).
   *  It lives in state because `rerender()` replaces the textarea element on
   *  every keystroke, which would throw a DOM-only height away. */
  commentHeight: number | null;
  linkDraft: string;
  lkOpen: boolean;
  asgMenu: boolean;
  sprMenu: boolean;
  relMenu: boolean;
  /** Which of the ticket's two status controls has its menu open (null = neither). */
  stMenu: StatusMenuAnchor | null;
  /** Sprints back the queue's group headers and the ticket form's/rail's menus. */
  sprints: Loadable<SprintView[]>;
  /** The sprint screen's payload. */
  sprintDetail: Loadable<SprintDetail | null>;
  sprintId: number | null;
  // The Roadmap Timeline's New sprint panel (the design's ns* state). `label` is
  // the only required field, so `nsName` is what arms "Create sprint".
  nsOpen: boolean;
  nsName: string;
  nsDates: string;
  nsDesc: string;
  nsUrg: SprintUrgency;
  nsDue: string;
  nsLead: string | null;
  nsDom: SprintDomain | null;
  toast: string | null;
  /** ADMIN Sync GitHub progress — null when idle; present while a (possibly
   *  multi-batch) sync is running, tracking cumulative counts across batches. */
  backfillSync: BackfillSyncState | null;
}

/** Sync GitHub modal state: "starting" from the click until the first batch
 *  resolves (the server is paginating GitHub + ingesting — there are no real
 *  counts yet, and rendering "0 of 0" reads as a broken sync), then "progress"
 *  with absolute counts snapshotted from the most recent batch response. */
export type BackfillSyncState =
  | { phase: "starting" }
  | { phase: "progress"; prSummarizedCount: number; prsTotal: number; issueSummarizedCount: number; issuesTotal: number };

export function initialState(): AppState {
  return {
    view: "auth", authStep: "login", signInOpen: false, landingSeen: new Set(), siteReturn: null,
    deniedEmail: null,
    onboard: initialOnboard(),
    persons: { status: "idle", data: [] },
    invites: { status: "idle", data: [] },
    inviteDraft: "",
    me: null,
    screen: "mywork",
    theme: "dark", systemDark: true,
    collapsed: false,
    narrow: false,
    navOpen: { ...NAV_CLOSED },
    repo: { status: "idle", data: null },
    repoTab: "overview", repoRange: "7d", repoProductEnv: null, repoDriftOpen: false, repoFetchedAt: null, repoSample: false, repoPoll: null,
    feedAuthor: "all", feedTag: "all", feedRange: "all",
    feed: { status: "idle", data: [] },
    mywork: { status: "idle", data: null },
    feedAuthors: [],
    docsList: { status: "idle", data: [] },
    docDetail: { status: "idle", data: null },
    docSlug: null,
    docSpace: "technical",
    docOutlineOpen: {},
    pendingScrollId: null,
    roadmapTab: "timeline",
    roadmap: { status: "idle", data: { narrative: "", version: 0, updated_at: null, updated_by: null, sprints: [] } },
    proposals: { status: "idle", data: [] },
    draftAdrs: { status: "idle", data: [] },
    needsTriage: { status: "idle", data: [] },
    identityTasks: { status: "idle", data: [] },
    reviewFilter: "all", reviewSel: null, reviewDiffView: "unified",
    assignOpen: null, assignKind: null, assignSection: null, assignSpace: null, assignTags: [],
    mapConfirm: null,
    mapPicks: {},
    showHistory: false,
    searchQuery: "token", searchType: "all",
    searchResults: { status: "idle", data: { primary: [], pointers: [], meta: { engine: "fts5", total: 0 } } },
    displayName: "",
    connect: null,
    connectClient: "claude",
    connectCopied: false,
    tokens: { status: "idle", data: [] },
    tokenRevokeArm: null,
    handleEdit: false,
    handleDraft: "",
    handleCheck: "idle",
    notifPrefs: { status: "idle", data: null },
    emailEditing: false,
    emailDraft: "",
    notifPolicy: { status: "idle", data: [] },
    notifSettings: { status: "idle", data: null },
    notifOutbox: { status: "idle", data: [] },
    outboxExpanded: null,
    fromDraft: null,
    unsub: { pending: false, error: null, preview: false },
    confirmedSprints: {},
    // Tickets — defaults transcribed from the design's `state` block: the queue
    // opens on Open / Any assignee / All categories in the Table view, and the
    // new-ticket form opens empty (no category → `other`, Normal, Backlog,
    // Unassigned).
    tickets: { status: "idle", data: [] },
    ticketDetail: { status: "idle", data: null },
    ticketId: null,
    ticketBadge: 0,
    qSeg: "open", qAssignee: "anyone", qCategory: "all", qView: "table",
    fTitle: "", fCat: null, fPrio: "normal", fDesc: "", fAsgs: [], fLink: "", fSpr: null,
    commentDraft: "", mention: null, commentHeight: null, linkDraft: "",
    lkOpen: false, asgMenu: false, sprMenu: false, relMenu: false, stMenu: null,
    sprints: { status: "idle", data: [] },
    sprintDetail: { status: "idle", data: null },
    sprintId: null,
    nsOpen: false, nsName: "", nsDates: "", nsDesc: "", nsUrg: "normal", nsDue: "", nsLead: null, nsDom: null,
    toast: null,
    backfillSync: null,
  };
}

// ── triage surface data (real reads — the mapping layer lives in triage-map.ts) ──
export function reviewProps(s: AppState): ReviewProps {
  return {
    items: reviewItemsFromReads(s.proposals.data, s.draftAdrs.data).map((it) => {
      const p = personFor(s, it.agent);
      return p ? { ...it, agentColor: p.color, agentAvatar: p.avatar_url } : it;
    }),
    filter: s.reviewFilter,
    selectedId: s.reviewSel,
    diffView: s.reviewDiffView,
  };
}

export function maintenanceProps(s: AppState): MaintenanceProps {
  return {
    unplaced: s.needsTriage.data.map(unplacedFromRow),
    assign: ASSIGN_OPTIONS,
    assignOpen: s.assignOpen,
    assignKind: s.assignKind,
    assignSection: s.assignSection,
    assignSpace: s.assignSpace,
    assignTags: s.assignTags,
    identity: s.identityTasks.data.map(identityFromTask),
    people: peopleFromPersons(s.persons.data),
    mapPicks: s.mapPicks,
    mapConfirm: s.mapConfirm,
  };
}

/** Sidebar counts for the two triage entries — the lengths of the four list reads. */
export function triageCounts(s: AppState): { review: number; maintenance: number } {
  return {
    review: s.proposals.data.length + s.draftAdrs.data.length,
    maintenance: s.needsTriage.data.length + s.identityTasks.data.length,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────
function resolved(s: AppState): "dark" | "light" | "midnight" {
  return s.theme === "system" ? (s.systemDark ? "dark" : "light") : s.theme;
}
// esc / attr live in ./ui (shared with the componentized surfaces).
// Defense-in-depth: external URLs from captured payloads must be http(s) — never javascript:/data:/etc.
const safeUrl = (u: string): string => (/^https?:\/\//i.test(u) ? u : "#");
const AVATAR = "border:1px solid var(--border-strong);background:color-mix(in srgb,var(--fg) 7%,transparent);display:grid;place-items:center";
/** Look up a captured login (feed author, doc updated_by) in the persons directory
 *  for its color/avatar — case-insensitive, since GitHub logins are case-preserving
 *  but case-insensitive for matching. null when unmapped (personChip falls back to initials). */
function personFor(s: AppState, handle: string): PersonSummary | null {
  return s.persons.data.find((p) => p.handle.toLowerCase() === handle.toLowerCase()) ?? null;
}

function logo(size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" style="flex:none"><rect x="2" y="4.5" width="20" height="3.4" rx="1.7" fill="var(--accent)"></rect><rect x="5" y="10.3" width="14" height="3.4" rx="1.7" fill="currentColor"></rect><rect x="8" y="16.1" width="8" height="3.4" rx="1.7" fill="currentColor" opacity="0.5"></rect></svg>`;
}

// ── real-data helpers (authors are github logins; no curated display map) ─────
/** A PR artifact may arrive bare ("14"), as "#14", or as a full pull URL (".../pull/14"). */
function prNumber(ref: string): string {
  const s = String(ref);
  const m = s.match(/\/pull\/(\d+)/) ?? s.match(/^#?(\d+)$/);
  return m ? m[1] : s;
}
/** A commit artifact may arrive as a bare SHA or a full commit URL; extract the SHA (href keeps it whole). */
function commitSha(ref: string): string {
  const s = String(ref);
  const m = s.match(/\/commit\/([0-9a-f]+)/i) ?? s.match(/\b([0-9a-f]{7,40})\b/i);
  return m ? m[1] : s;
}
/** Parse the feed row's artifacts JSON ({prs,commits,issues}) into render-ready chips. */
function feedArtifacts(json: string | null): { kind: string; label: string; href: string }[] {
  if (!json) return [];
  let a: { prs?: string[]; commits?: string[]; issues?: number[] };
  try { a = JSON.parse(json); } catch { return []; }
  const isUrl = (v: string) => /^https?:\/\//i.test(v);
  const out: { kind: string; label: string; href: string }[] = [];
  for (const pr of a.prs ?? []) {
    const num = prNumber(pr);
    out.push({ kind: "PR", label: `#${num}`, href: isUrl(String(pr)) ? String(pr) : `${REPO_URL}/pull/${num}` });
  }
  for (const c of a.commits ?? []) {
    const sha = commitSha(c);
    out.push({ kind: "commit", label: sha.slice(0, 7), href: isUrl(String(c)) ? String(c) : `${REPO_URL}/commit/${sha}` });
  }
  for (const i of a.issues ?? []) out.push({ kind: "issue", label: `#${i}`, href: `${REPO_URL}/issues/${i}` });
  return out;
}
/** A linked GitHub chip (issue / PR / commit / issue group). */
function ghChip(c: { kind: string; label: string; href: string }): string {
  return `<a href="${c.href}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;gap:6px;font-size:11.5px;border:1px solid var(--border);border-radius:6px;padding:3px 8px;text-decoration:none;color:var(--fg-70)"><span style="color:var(--fg-40)">${esc(c.kind)}</span><span style="font-family:var(--mono);font-weight:500">${esc(c.label)}</span></a>`;
}
/** GitHub links for a sprint's github_ref. The bare number IS the number of an
 *  issue GROUP on GitHub, hence the "group" chip kind and the URL below. */
function sprintRefChips(github_ref: string | null): { kind: string; label: string; href: string }[] {
  if (!github_ref) return [];
  try {
    const p = JSON.parse(github_ref);
    // The path segment is GitHub's own — not Canopy vocabulary.
    if (typeof p === "number") return [{ kind: "group", label: `#${p}`, href: `${REPO_URL}/milestone/${p}` }];
    if (Array.isArray(p)) return p.map((n) => ({ kind: "issue", label: `#${n}`, href: `${REPO_URL}/issues/${n}` }));
  } catch { /* malformed ref → no chips */ }
  return [];
}
/** Escape text, then turn bare GitHub issue refs (#123) into links. esc runs first, so it's safe. */
function linkifyRefs(text: string): string {
  return esc(text).replace(/#(\d+)\b/g, (_m, n) => `<a href="${REPO_URL}/issues/${n}" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none">#${n}</a>`);
}
/** Centered muted notice reused for loading / error states (no layout change). */
function notice(text: string): string {
  return `<div style="text-align:center;padding:60px;color:var(--fg-40);font-size:13px">${text}</div>`;
}

// ── auth states ──────────────────────────────────────────────────────────────
function authView(s: AppState): string {
  // Signed out → the landing page; its Sign in opens the provider dialog.
  if (s.authStep === "login") return landingView({ dark: resolved(s) !== "light", signInOpen: s.signInOpen, seen: s.landingSeen });
  return `<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px">
    ${s.authStep === "nonmember" ? nonmemberCard() : ""}
    ${s.authStep === "notinvited" ? notInvitedCard(s.deniedEmail) : ""}
    ${s.authStep === "verifying" ? verifyingCard() : ""}
    ${s.authStep === "onboard" ? onboardView(s.onboard) : ""}
  </div>`;
}

function nonmemberCard(): string {
  return `<div style="width:400px">
    <div style="border:1px solid var(--border);border-radius:14px;padding:34px;display:flex;flex-direction:column;align-items:center;gap:20px;text-align:center">
      <div class="cnpy-seal" style="width:52px;height:52px;border-radius:50%;border:1px solid var(--border-strong);display:grid;place-items:center;color:var(--fg-55)">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V8a4 4 0 0 1 8 0v3"></path></svg>
      </div>
      <div>
        <div style="font-size:18px;font-weight:600;letter-spacing:-0.01em">Canopy is limited to the Sapling team.</div>
        <div style="font-size:13.5px;color:var(--fg-55);margin-top:8px;line-height:1.55">Your GitHub account isn't a member of the <span style="font-family:var(--mono);font-size:12.5px">SaplingLearn</span> organization, so there's nothing here for you yet.</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;padding:9px 14px 9px 9px;border:1px solid var(--border);border-radius:999px">
        <div class="cnpy-av cnpy-av-anon" style="width:26px;height:26px;border-radius:50%;${AVATAR};font-size:10px;font-weight:600;color:var(--fg-70)">OS</div>
        <div style="text-align:left;line-height:1.25;white-space:nowrap"><div style="font-size:12.5px;font-weight:500">Signed in as</div><div style="font-size:11.5px;color:var(--fg-55);font-family:var(--mono)">octo-stranger</div></div>
      </div>
      <button data-act="backToLogin" class="cnpy-outlinebtn" style="width:100%;padding:11px 16px;border-radius:9px;border:1px solid var(--border-strong);font-size:13.5px;font-weight:500">Sign out &amp; switch account</button>
    </div>
  </div>`;
}

function notInvitedCard(email: string | null): string {
  return `<div style="width:400px">
    <div style="border:1px solid var(--border);border-radius:14px;padding:34px;display:flex;flex-direction:column;align-items:center;gap:20px;text-align:center">
      <div class="cnpy-seal" style="width:52px;height:52px;border-radius:50%;border:1px solid var(--border-strong);display:grid;place-items:center;color:var(--fg-55)">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V8a4 4 0 0 1 8 0v3"></path></svg>
      </div>
      <div>
        <div style="font-size:18px;font-weight:600;letter-spacing:-0.01em">This Google account hasn't been invited yet.</div>
        <div style="font-size:13.5px;color:var(--fg-55);margin-top:8px;line-height:1.55">Canopy is limited to the Sapling team. Ask an admin to invite <span style="font-family:var(--mono);font-size:12.5px">${esc(email ?? "your address")}</span>, then sign in again.</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;padding:9px 14px 9px 9px;border:1px solid var(--border);border-radius:999px">
        <div class="cnpy-av cnpy-av-anon" style="width:26px;height:26px;border-radius:50%;${AVATAR};font-size:10px;font-weight:600;color:var(--fg-70)">${esc(initialsOf(email ?? "?"))}</div>
        <div style="text-align:left;line-height:1.25;white-space:nowrap"><div style="font-size:12.5px;font-weight:500">Signed in with Google as</div><div style="font-size:11.5px;color:var(--fg-55);font-family:var(--mono)">${esc(email ?? "unknown")}</div></div>
      </div>
      <button data-act="signInGoogleSwitch" class="cnpy-outlinebtn" style="width:100%;padding:11px 16px;border-radius:9px;border:1px solid var(--border-strong);font-size:13.5px;font-weight:500">Try a different account</button>
    </div>
  </div>`;
}

function verifyingCard(): string {
  return `<div style="display:flex;flex-direction:column;align-items:center;gap:22px">
    <div style="display:flex;align-items:center;gap:11px;opacity:.95">
      ${logo(28)}
      <span style="font-size:23px;font-weight:600;letter-spacing:-0.02em">Canopy</span>
    </div>
    <div style="display:flex;align-items:center;gap:11px;color:var(--fg-55);font-size:13px">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.4" style="animation:cnpy-spin .8s linear infinite"><path d="M12 3a9 9 0 1 0 9 9" stroke-linecap="round"></path></svg>
      Verifying Sapling membership&hellip;
    </div>
  </div>`;
}

// ── app shell ────────────────────────────────────────────────────────────────
/** The rail is collapsed when the person collapsed it OR the viewport forces it. */
export const railCollapsed = (s: AppState): boolean => s.collapsed || s.narrow;

function sidebar(s: AppState): string {
  const counts = triageCounts(s);
  return sidebarView({
    screen: s.screen,
    collapsed: railCollapsed(s),
    navOpen: s.navOpen,
    qView: s.qView,
    roadmapTab: s.roadmapTab,
    repoTab: s.repoTab,
    docSpace: s.docSpace,
    docSpaces: DOC_SPACES.map((k) => ({ key: k, label: spaceLabel(k) })),
    // Tickets: unassigned ACTIVE tickets — a "nobody has this" signal (design call #2).
    counts: { review: counts.review, maintenance: counts.maintenance, tickets: s.ticketBadge },
    me: s.me ? { handle: s.me.handle, name: s.me.name, color: s.me.color, avatar_url: s.me.avatar_url } : null,
    displayName: s.displayName,
    logo: logo(24),
  });
}

/** The "›" crumb text for the three child screens (empty on a top-level screen). */
function headerCrumb(s: AppState): string {
  if (s.screen === "newticket") return "New ticket";
  if (s.screen === "ticketdetail") return s.ticketDetail.data?.title ?? "";
  if (s.screen === "sprint") {
    return s.sprintDetail.data?.label ?? s.sprints.data.find((sp) => sp.id === s.sprintId)?.label ?? "";
  }
  return "";
}

function header(s: AppState): string {
  const titles: Record<Screen, string> = {
    mywork: "My Work", feed: "Feed", docs: "Docs", roadmap: "Roadmap", review: "Review",
    maintenance: "Maintenance", search: "Search", settings: "Settings", guide: "Get Started",
    unsubscribe: "Unsubscribe", site: "Canopy",
    // The three ticket screens all sit under Tickets; a sprint sits under Roadmap.
    tickets: "Tickets", ticketdetail: "Tickets", newticket: "Tickets", sprint: "Roadmap",
    repo: "Repo",
  };
  // dark = "show the moon icon" — true for any non-light theme (dark + midnight).
  const dark = resolved(s) !== "light";

  const authorFiltered = s.feedAuthor !== "all";
  const authorFilterLabel = authorFiltered ? `${s.feedAuthor}'s activity` : "";

  const filterChip = s.screen === "feed" && authorFiltered
    ? `<div style="display:flex;align-items:center;gap:7px;padding:4px 6px 4px 10px;border:1px solid var(--accent);color:var(--accent);border-radius:999px;font-size:12px;font-weight:500;background:var(--accent-soft)">${authorFilterLabel}<button data-act="clearAuthor" class="cnpy-xbtn" style="width:16px;height:16px;display:grid;place-items:center;border-radius:50%;color:var(--accent)"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 5l14 14M19 5 5 19"></path></svg></button></div>`
    : "";

  // Author chips are derived from the authors actually present in the feed (captured on
  // the unfiltered load), not a hardcoded people list. Active chip is styled inline
  // because the login set is dynamic (the old `[data-author=…] .a-<login>` CSS can't match).
  const achip = (key: string, labelHtml: string): string => {
    const active = s.feedAuthor === key;
    const activeStyle = active ? "border-color:var(--accent);color:var(--accent);background:var(--accent-soft)" : "";
    return `<button data-act="setAuthor" data-arg="${attr(key)}" class="cnpy-achip" style="${activeStyle}">${labelHtml}</button>`;
  };
  const authorChips = [achip("all", "All"), ...s.feedAuthors.map((a) => achip(a, handleTag(personFor(s, a), a, 12)))].join("");

  const feedControls = s.screen === "feed" ? `<div style="display:flex;align-items:center;gap:6px">
      <span style="font-size:11px;color:var(--fg-40);text-transform:uppercase;letter-spacing:.08em;margin-right:2px">Author</span>
      ${authorChips}
      <div style="width:1px;height:20px;background:var(--border);margin:0 4px"></div>
      <select data-act="setTag" class="cnpy-select">
        <option value="all"${s.feedTag === "all" ? " selected" : ""}>All tags</option>
        ${TAGS.map((t) => `<option value="${t}"${s.feedTag === t ? " selected" : ""}>${t}</option>`).join("")}
      </select>
      <select data-act="setRange" class="cnpy-select">
        ${["all:All time", "24h:Last 24h", "7d:Last 7 days"].map((o) => { const [v, l] = o.split(":"); return `<option value="${v}"${s.feedRange === v ? " selected" : ""}>${l}</option>`; }).join("")}
      </select>
    </div>` : "";

  const spaceTab = (k: DocSpace) =>
    `<button data-act="setDocSpace" data-arg="${attr(k)}" style="display:flex;align-items:center;gap:7px;padding:5px 14px;border-radius:7px;font-size:12.5px;font-weight:500;color:${s.docSpace === k ? "var(--fg)" : "var(--fg-55)"};background:${s.docSpace === k ? "var(--hover)" : "transparent"}">${esc(spaceLabel(k))}</button>`;
  const docsControls = s.screen === "docs"
    ? `<div style="display:flex;align-items:center;gap:3px;padding:3px;border:1px solid var(--border);border-radius:9px">${DOC_SPACES.map(spaceTab).join("")}</div>`
    : "";

  const rmTabStyle = (k: string) => `display:flex;align-items:center;gap:7px;padding:5px 13px;border-radius:7px;font-size:12.5px;font-weight:500;color:${s.roadmapTab === k ? "var(--fg)" : "var(--fg-55)"};background:${s.roadmapTab === k ? "var(--hover)" : "transparent"}`;
  const overdueCount = s.screen === "roadmap" && s.roadmap.status === "ok"
    ? roadmapEnriched(s.roadmap.data.sprints, s.confirmedSprints).overdueCount
    : 0;
  const roadmapControls = s.screen === "roadmap" ? `<div style="display:flex;align-items:center;gap:3px;padding:3px;border:1px solid var(--border);border-radius:9px">
      <button data-act="roadmapNarrative" style="${rmTabStyle("narrative")}">Narrative</button>
      <button data-act="roadmapTimeline" style="${rmTabStyle("timeline")}">Timeline${overdueCount ? `<span style="width:6px;height:6px;border-radius:50%;background:var(--red);margin-left:1px"></span>` : ""}</button>
    </div>` : "";

  // ADMIN-only, My Work screen: trigger the server-side GitHub backfill. Rendered
  // only when /auth/me returned admin:true (outline button, promote-class action).
  // While s.backfillSync is set, the button is disabled (progress itself shows
  // in the modal below — see backfillSyncModal) — a sync can span multiple
  // batched requests (src/tools/backfill.ts caps AI calls per invocation),
  // driven by main.ts.
  const syncing = s.backfillSync !== null;
  const myworkControls = s.screen === "mywork" && s.me?.admin
    ? `<button data-act="adminBackfill" title="${syncing ? "Sync in progress" : "Fetch all GitHub PRs + issues"}" class="cnpy-outlinebtn" ${syncing ? "disabled" : ""} style="display:flex;align-items:center;gap:7px;padding:6px 12px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70);${syncing ? "opacity:.65;cursor:default" : ""}">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ${syncing ? 'style="animation:cnpy-spin .8s linear infinite"' : ""}><path d="M21 12a9 9 0 1 1-3-6.7L21 8"></path><path d="M21 3v5h-5"></path></svg>
      ${syncing ? "Syncing&hellip;" : "Sync GitHub"}
    </button>` : "";

  // Queue chrome (the `tickets` screen only): the Table / Board toggle in the
  // Roadmap tab idiom, plus the header's submit button.
  const qTabStyle = (k: "table" | "board") => `display:flex;align-items:center;gap:6px;padding:5px 13px;border-radius:7px;font-size:12.5px;font-weight:500;white-space:nowrap;color:${s.qView === k ? "var(--fg)" : "var(--fg-55)"};background:${s.qView === k ? "var(--hover)" : "transparent"}`;
  const queueControls = s.screen === "tickets" ? `<div style="display:flex;align-items:center;gap:3px;padding:3px;border:1px solid var(--border);border-radius:9px">
      <button data-act="queueTable" style="${qTabStyle("table")}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 6h16M4 12h16M4 18h16"></path></svg>Table</button>
      <button data-act="queueBoard" style="${qTabStyle("board")}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="6" height="16" rx="1.5"></rect><rect x="14" y="4" width="6" height="10" rx="1.5"></rect></svg>Board</button>
    </div>
    <button data-act="newTicket" class="cnpy-accentbtn" style="display:flex;align-items:center;gap:7px;padding:7px 14px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-size:12.5px;font-weight:600;white-space:nowrap;transition:filter .12s ease"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"></path></svg>Submit a ticket</button>` : "";

  const themeBtn = `<button data-act="cycleTheme" title="Toggle theme" class="cnpy-iconbtn" style="width:32px;height:32px;border-radius:8px;border:1px solid var(--border);display:grid;place-items:center;color:var(--fg-55)">
      ${dark
        ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"></path></svg>`
        : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4.2"></circle><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"></path></svg>`}
    </button>`;

  // Breadcrumb (the design's titleBtnSt / crumbSt): on a CHILD screen the title
  // becomes a back button to its parent and a "›" crumb names the child.
  // `ticketsBack` resolves to Tickets, or Roadmap from a sprint (one act, like
  // the design's single `back` handler).
  const child = s.screen === "ticketdetail" || s.screen === "newticket" || s.screen === "sprint";
  const crumb = s.screen === "repo" ? repoCrumb(repoProps(s)) : child
    ? `<span style="display:inline-flex;align-items:center;gap:10px;min-width:0"><span style="color:var(--fg-40);font-size:13px">›</span><span style="font-size:13px;font-weight:500;color:var(--fg-70);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0">${esc(headerCrumb(s))}</span></span>`
    : "";
  const title = child
    ? `<h1 style="font-size:15px;font-weight:600;letter-spacing:-0.01em;margin:0;white-space:nowrap;flex:none"><button data-act="ticketsBack" style="font-size:15px;font-weight:600;letter-spacing:-0.01em;padding:0;color:var(--fg-55);cursor:pointer">${titles[s.screen]}</button></h1>`
    : `<h1 style="font-size:15px;font-weight:600;letter-spacing:-0.01em;margin:0">${titles[s.screen]}</h1>`;

  return `<header style="display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 24px;min-height:57px;border-bottom:1px solid var(--border);flex:none">
    <div style="display:flex;align-items:center;gap:12px;min-width:0">
      ${title}
      ${crumb}
      ${filterChip}
    </div>
    <div style="display:flex;align-items:center;gap:8px;flex:none">
      ${feedControls}${docsControls}${roadmapControls}${queueControls}${myworkControls}${s.screen === "repo" ? repoControls(repoProps(s)) : ""}${themeBtn}
    </div>
  </header>`;
}

// ── feed ─────────────────────────────────────────────────────────────────────
function wrapFeed(inner: string): string {
  return `<div style="max-width:760px;margin:0 auto;padding:24px 24px 80px">
    ${inner}
    <div style="text-align:center;padding:18px 0;font-size:11.5px;color:var(--fg-40);font-family:var(--mono)">&mdash; start of recorded history &mdash;</div>
  </div>`;
}

/** A feed entry's body is agent-written markdown (lists, code, links, bold), so it goes through
 *  `renderMarkdown` — marked + DOMPurify, the same pipeline as a doc or a ticket body — and is
 *  NEVER additionally esc()'d. `.cnpy-feed-body` scales the doc typography down to a card's and
 *  keeps a typed single line break inside a paragraph. The summary is one line: inline-only. */
function feedBody(body: string | null): string {
  if (!body || !body.trim()) return "";
  return `<div class="cnpy-md cnpy-feed-body" style="font-size:13px;color:var(--fg-55);line-height:1.6;margin-top:6px">${renderMarkdown(body)}</div>`;
}

function feedView(s: AppState): string {
  if (s.feed.status === "loading" && s.feed.data.length === 0) return wrapFeed(notice("Loading feed&hellip;"));
  if (s.feed.status === "error") return wrapFeed(notice("Couldn't load the feed."));

  const cards = s.feed.data.map((e) => {
    const artifacts = feedArtifacts(e.artifacts);
    const artifactRow = artifacts.length
      ? `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:7px;margin-top:11px;padding-top:11px;border-top:1px solid var(--border)">
          ${artifacts.map((ar) => `<a href="${ar.href}" target="_blank" class="cnpy-issuechip" style="display:inline-flex;align-items:center;gap:6px;font-size:11.5px;border:1px solid var(--border);border-radius:6px;padding:3px 8px;text-decoration:none;color:var(--fg-70)"><span style="color:var(--fg-40)">${esc(ar.kind)}</span><span style="font-family:var(--mono);font-weight:500">${esc(ar.label)}</span></a>`).join("")}
        </div>`
      : "";
    return `<div class="cnpy-card" style="border:1px solid var(--border);border-radius:12px;padding:16px 18px;margin-bottom:12px">
      <div style="display:flex;align-items:flex-start;gap:12px">
        <div style="margin-top:1px">${personChip(personFor(s, e.author), 30, e.author)}</div>
        <div style="flex:1;min-width:0">
          <div class="cnpy-md-inline" style="font-size:14px;font-weight:500;line-height:1.5;letter-spacing:-0.005em">${renderMarkdownInline(e.summary)}</div>
          ${feedBody(e.body)}
          <div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:12px">
            <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--fg-55)">${handleTag(personFor(s, e.author), e.author)}</div>
            <span style="display:inline-flex;align-items:center;gap:4px;font-size:10.5px;color:var(--fg-40);border:1px solid var(--border);border-radius:5px;padding:1px 5px"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="8" width="16" height="11" rx="2"></rect><path d="M12 8V4M8 13h.01M16 13h.01"></path></svg>agent</span>
            <span style="font-size:12px;color:var(--fg-40)">&middot;</span>
            <span style="font-size:12px;color:var(--fg-40)">${relTime(e.created_at)}</span>
            <div style="flex:1"></div>
          </div>
          ${artifactRow}
        </div>
      </div>
    </div>`;
  }).join("");

  const empty = s.feed.status === "ok" && s.feed.data.length === 0 ? notice("No entries match this filter.") : "";
  return wrapFeed(`<div class="cnpy-stagger">${cards}</div>${empty}`);
}

// ── docs ─────────────────────────────────────────────────────────────────────
// Preferred display order for section groups within a space; anything not listed
// falls to the end (alphabetical). Case-insensitive match against doc.section.
const DOC_SECTION_ORDER = [
  "Overview", "Architecture", "AI & Learning Engine", "Engineering Guide", "Decisions",
  "Roadmap", "Brand & Marketing", "reference", "context", "decisions",
];
const sectionRank = (sec: string): number => {
  const i = DOC_SECTION_ORDER.findIndex((x) => x.toLowerCase() === sec.toLowerCase());
  return i < 0 ? DOC_SECTION_ORDER.length : i;
};

// The Docs space toggle is a FIXED two-tab set, in this order — the tabs are NOT
// derived from the data, so a stray/foreign `space` value can never add or change
// a tab. New docs are constrained to these values at the write boundary too.
export const DOC_SPACES = ["technical", "product"] as const;
const spaceLabel = (k: string): string => (k ? k.charAt(0).toUpperCase() + k.slice(1) : k);

/** First doc of a space in tree display order (section rank, then title) — the
 *  page opened by default when the docs list loads or the space toggles. */
export function firstDocForSpace(docs: DocRow[], space: string): DocRow | undefined {
  return docs
    .filter((d) => d.space === space)
    .sort((a, b) => sectionRank(a.section) - sectionRank(b.section) || a.title.localeCompare(b.title))[0];
}

// One tree row: the page button (opens the doc) with a chevron that toggles its
// in-page outline, plus the outline itself (scroll-to-heading links) when open.
function docTreeRow(s: AppState, doc: DocRow): string {
  const active = doc.slug === s.docSlug;
  const outline = extractOutline(doc.body);
  const open = !!s.docOutlineOpen[doc.slug];
  const chevron = outline.length
    ? `<span class="cnpy-treechev${open ? " is-open" : ""}" data-act="toggleOutline" data-arg="${attr(doc.slug)}" role="button" aria-expanded="${open ? "true" : "false"}" aria-label="Toggle outline"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"></path></svg></span>`
    : `<span class="cnpy-treechev is-empty"></span>`;
  const page = `<button data-act="openDoc" data-arg="${attr(doc.slug)}" class="cnpy-tree${active ? " is-active" : ""}">${chevron}<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(doc.title)}</span></button>`;
  const outlineHtml = outline.length
    ? `<div class="cnpy-outline${open ? " is-open" : ""}" data-outline="${attr(doc.slug)}"><div class="cnpy-outline-inner">${outline.map((h) =>
        `<button data-act="scrollToHeading" data-arg="${attr(doc.slug + "::" + h.id)}" class="cnpy-outline-item${h.level >= 3 ? " lvl3" : ""}"><span>${esc(h.text)}</span></button>`).join("")}</div></div>`
    : "";
  return page + outlineHtml;
}

function docsView(s: AppState): string {
  // ── tree (left pane) ────────────────────────────────────────────────────────
  let treeHtml: string;
  if (s.docsList.status === "loading" && s.docsList.data.length === 0) {
    treeHtml = notice("Loading…");
  } else if (s.docsList.status === "error") {
    treeHtml = notice("Couldn't load docs.");
  } else {
    // Filter to the toggled space (Technical | Product), then group by section.
    // Sections are static labels; each page expands to its own headings.
    const spaceDocs = s.docsList.data.filter((d) => d.space === s.docSpace);
    if (spaceDocs.length === 0) {
      treeHtml = notice(`No ${spaceLabel(s.docSpace)} docs yet.`);
    } else {
      const grouped = new Map<string, DocRow[]>();
      for (const doc of spaceDocs) {
        if (!grouped.has(doc.section)) grouped.set(doc.section, []);
        grouped.get(doc.section)!.push(doc);
      }
      const sections = [...grouped.keys()].sort((a, b) => sectionRank(a) - sectionRank(b) || a.localeCompare(b));
      treeHtml = sections.map((sec) => {
        const rows = grouped.get(sec)!.map((doc) => docTreeRow(s, doc)).join("");
        return `<div style="margin-bottom:16px">
        <div class="cnpy-treesec">${esc(sec)}</div>
        <div style="display:flex;flex-direction:column;gap:1px">${rows}</div>
      </div>`;
      }).join("");
    }
  }

  // ── reader (right pane) ─────────────────────────────────────────────────────
  const readerHtml = docReaderHtml(s);

  return `<div style="display:flex;height:100%">
    <div class="cnpy-scroll" style="width:252px;flex:none;border-right:1px solid var(--border);overflow-y:auto;padding:18px 12px">${treeHtml}</div>
    <div id="cnpy-reader" class="cnpy-scroll" style="flex:1;overflow-y:auto;min-width:0">${readerHtml}</div>
  </div>`;
}

/** The reader pane's inner HTML. Extracted so main.ts can load a doc into the
 *  pane in place (updating only #cnpy-reader) without rerendering the tree —
 *  a tree rerender swaps in fresh outline elements and kills their transition. */
export function docReaderHtml(s: AppState): string {
  const dd = s.docDetail;

  if (dd.status === "loading" || (dd.status === "idle" && s.docSlug !== null)) {
    return notice("Loading…");
  } else if (dd.status === "error") {
    return notice("Couldn't load this doc.");
  } else if (dd.data === null) {
    return notice(s.docSlug === null ? "Select a doc from the tree." : "Doc not found.");
  } else if (dd.status === "ok" && dd.data !== null) {
    const { doc, versions } = dd.data;
    const hasStaged = versions.some((v) => v.status === "staged" && v.version > doc.current_version);

    const stagedBanner = hasStaged ? `<div style="display:flex;align-items:center;gap:14px;padding:12px 14px;border:1px solid var(--border);border-left:2px solid var(--amber);border-radius:9px;margin-bottom:26px">
      <span style="display:inline-flex;align-items:center;gap:6px;font-size:10.5px;font-weight:600;font-family:var(--mono);letter-spacing:.04em;color:var(--amber);border:1px solid color-mix(in srgb,var(--amber) 45%,transparent);background:color-mix(in srgb,var(--amber) 12%,transparent);border-radius:5px;padding:3px 7px;flex:none">STAGED</span>
      <div style="flex:1;font-size:12.5px;color:var(--fg-70);line-height:1.45">You're viewing the <strong style="font-weight:600;color:var(--fg)">promoted</strong> version. A newer proposal is awaiting review.</div>
      <button data-act="goReview" class="cnpy-link" style="display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:500;color:var(--accent);white-space:nowrap;flex:none">Review proposal<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"></path></svg></button>
    </div>` : "";

    const history = s.showHistory ? `<div style="border:1px solid var(--border);border-radius:10px;padding:6px;margin-top:18px">
      ${versions.map((v) => `<div style="display:flex;align-items:center;gap:12px;padding:9px 11px;border-radius:7px">
        <span style="font-family:var(--mono);font-size:12px;font-weight:600;color:var(--fg);width:26px">v${v.version}</span>
        <span style="flex:1;font-size:12.5px;color:var(--fg-70)">${esc(v.summary ?? "")}</span>
        <span style="display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--fg-40)">${personChip(personFor(s, v.created_by), 16, v.created_by)}${handleTag(personFor(s, v.created_by), v.created_by, 11)} · ${relTime(v.created_at)}</span>
        ${v.version === doc.current_version ? `<span style="font-size:9.5px;font-weight:600;font-family:var(--mono);color:var(--accent);border:1px solid color-mix(in srgb,var(--accent) 45%,transparent);background:var(--accent-soft);border-radius:4px;padding:2px 6px">PROMOTED</span>` : ""}
      </div>`).join("")}
    </div>` : "";

    return `<div style="max-width:1080px;margin:0 auto;padding:34px 52px 120px">
    ${stagedBanner}
    <div style="font-family:var(--mono);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.11em;color:var(--fg-40);margin-bottom:11px">${esc(spaceLabel(doc.space))} <span style="color:var(--border-strong);margin:0 2px">/</span> ${esc(doc.section)}</div>
    <h1 style="font-size:29px;font-weight:650;letter-spacing:-0.022em;line-height:1.16;margin:0">${esc(doc.title)}</h1>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-top:15px;padding-bottom:17px;border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;gap:9px;font-size:12.5px;color:var(--fg-55)">
        ${personChip(doc.updated_by ? personFor(s, doc.updated_by) : null, 24, doc.updated_by ?? "?")}
        <span>Updated by ${doc.updated_by ? handleTag(personFor(s, doc.updated_by), doc.updated_by) : ""} · ${relTime(doc.updated_at)}</span>
      </div>
      <button data-act="toggleHistory" class="cnpy-ghostbtn" style="display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:500;color:var(--fg-70);border:1px solid var(--border);border-radius:7px;padding:5px 11px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3v6h6"></path><path d="M3.5 9a9 9 0 1 0 2.3-3.3L3 9"></path><path d="M12 8v4l3 2"></path></svg>Version history</button>
    </div>
    ${history}
    <div class="cnpy-md" style="margin-top:28px">${renderMarkdown(doc.body)}</div>
  </div>`;
  }
  return notice("Select a doc from the tree.");
}

// ── roadmap ──────────────────────────────────────────────────────────────────
interface EnrichedSprint {
  id: number; title: string; about: string; github_ref: string | null; phase: string | null;
  closed: number | null; total: number | null; done: boolean; ready: boolean; overdue: boolean;
  pct: number; tgt: number; badge: { label: string; color: string; soft?: boolean };
  dateLabel: string; isNext: boolean;
  /** The GitHub half, straight off `SprintView.issues` — the Narrative spotlight
   *  is the ONLY place it renders, and null means the sprint has no cache row. */
  issues: { closed: number; total: number } | null;
}

function roadmapEnriched(sprints: SprintView[], confirmedSprints: Record<string, boolean>): { list: EnrichedSprint[]; doneCount: number; overdueCount: number } {
  const now = Date.now();
  const fmt = (iso: string) => new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const badgeFor = (st: string): { label: string; color: string; soft?: boolean } => {
    if (st === "done") return { label: "Done", color: "var(--green)", soft: true };
    if (st === "in_progress") return { label: "In progress", color: "var(--amber)" };
    return { label: "Upcoming", color: "var(--blue)" };
  };

  const enriched = sprints.map((sp) => {
    const confirmed = !!confirmedSprints[String(sp.id)];
    const done = sp.status === "done" || confirmed;
    // SprintView.progress is TICKETS ONLY and always present, reading 0/0 when a
    // sprint holds no tickets — so `total === 0` means no bar, and never "ready
    // to complete". The GitHub issue counts never enter this: a sprint is ready
    // when its own tickets are resolved.
    const counted = sp.progress.total > 0;
    const closed = counted ? sp.progress.closed : null;
    const total = counted ? sp.progress.total : null;
    const ready = !done && counted && sp.progress.closed >= sp.progress.total;
    // An unscheduled sprint (due: null) is never overdue and never "next up".
    const tgt = sp.due ? new Date(sp.due + "T12:00:00").getTime() : Infinity;
    const overdue = !done && !ready && tgt < now;
    return {
      id: sp.id, title: sp.label, about: sp.description ?? "", github_ref: sp.github_ref, phase: sp.phase,
      closed, total, done, ready, overdue, pct: counted ? sp.progress.pct : 0, tgt,
      badge: badgeFor(done ? "done" : sp.status), dateLabel: sp.due ? fmt(sp.due) : "No target date",
      isNext: false, issues: sp.issues,
    };
  });

  let nextId: number | null = null;
  let nextTime = Infinity;
  enriched.forEach((m) => {
    if (!m.done && !m.overdue && m.tgt >= now && m.tgt < nextTime) { nextTime = m.tgt; nextId = m.id; }
  });
  enriched.forEach((m) => { m.isNext = m.id === nextId; });

  return {
    list: enriched,
    doneCount: enriched.filter((m) => m.done).length,
    overdueCount: enriched.filter((m) => m.overdue).length,
  };
}

/**
 * The Roadmap's Timeline tab: the plan as a sequence of sprint cards, grouped
 * In Progress (active) / Upcoming / Done (§C.6). Every card is `sprintCard` from
 * ./sprints — the ONE place a sprint is painted, shared with nothing else on this
 * screen so the card and the Sprint screen can never drift.
 *
 * The header also carries the "New sprint" toggle; the panel it opens renders
 * above the first group (`POST /sprints` creates the sprint unscheduled and
 * inactive, so it lands in Upcoming).
 */
function roadmapNarrative(s: AppState): string {
  const sprints = s.roadmap.data.sprints;
  const total = sprints.length;
  const isDone = (sp: SprintView) => sp.status === "done" || !!s.confirmedSprints[String(sp.id)];

  const inProgress = sprints.filter((sp) => !isDone(sp) && sp.active);
  const upcoming = sprints.filter((sp) => !isDone(sp) && !sp.active);
  const done = sprints.filter(isDone);

  const sectionHeading = (label: string, color: string): string =>
    `<div style="display:flex;align-items:center;gap:9px;margin:28px 0 12px"><span style="width:7px;height:7px;border-radius:50%;flex:none;background:${color}"></span><span style="font-size:11px;font-weight:600;font-family:var(--mono);text-transform:uppercase;letter-spacing:.1em;color:${color}">${label}</span><div style="flex:1;height:1px;background:var(--border)"></div></div>`;

  const renderGroup = (items: SprintView[], heading: string, color: string): string =>
    items.length === 0
      ? ""
      : `${sectionHeading(heading, color)}<div class="cnpy-stagger">${items.map((sp) => sprintCard(sp, s.persons.data, { done: isDone(sp) })).join("")}</div>`;

  const intro = total === 0
    ? notice("No sprints yet.")
    : `<p style="font-size:14px;line-height:1.7;color:var(--fg-70);margin:0 0 4px">
        The plan is a sequence of time-boxed sprints, each a container of tickets with its own screen.
        <strong style="color:var(--fg);font-weight:600">Progress is live</strong> — computed from each sprint's done tickets.
      </p>`;

  return `<div class="cnpy-scroll" style="max-width:820px;margin:0 auto;padding:32px 40px 100px">
    <div style="margin-bottom:20px">
      <div style="font-size:11px;font-weight:600;font-family:var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--fg-40);margin-bottom:6px">Narrative</div>
      <h1 style="font-size:24px;font-weight:600;letter-spacing:-0.02em;margin:0 0 12px">Roadmap Overview</h1>
      <div style="display:flex;align-items:flex-start;gap:12px">
        <div style="flex:1;min-width:0">${intro}</div>
        ${newSprintToggle(s.nsOpen)}
      </div>
    </div>
    ${newSprintPanel({
      open: s.nsOpen, name: s.nsName, dates: s.nsDates, desc: s.nsDesc,
      urgency: s.nsUrg, due: s.nsDue, lead: s.nsLead, domain: s.nsDom,
    }, s.persons.data)}
    ${renderGroup(inProgress, "In Progress", "var(--amber)")}
    ${renderGroup(upcoming, "Upcoming", "var(--blue)")}
    ${renderGroup(done, "Done", "var(--green)")}
    ${total > 0 ? `<div style="text-align:center;padding:14px 0 0;font-size:11.5px;color:var(--fg-40)">Sprints are the plan — each one is a time-boxed container of tickets with its own screen.</div>` : ""}
  </div>`;
}

function roadmapView(s: AppState): string {
  if (s.roadmap.status === "loading" && s.roadmap.data.sprints.length === 0) {
    return `<div class="cnpy-scroll" style="max-width:820px;margin:0 auto;padding:32px 40px 100px">${notice("Loading roadmap&hellip;")}</div>`;
  }
  if (s.roadmap.status === "error") {
    return `<div class="cnpy-scroll" style="max-width:820px;margin:0 auto;padding:32px 40px 100px">${notice("Couldn't load the roadmap.")}</div>`;
  }
  if (s.roadmapTab === "narrative") return roadmapDigest(s);
  return roadmapNarrative(s);
}

/**
 * The ADMIN-AUTHORED plan narrative (written via the update-plan skill), rendered as markdown
 * inside the digest card idiom (mono "Narrative" label + h1, matching the rest of the app's
 * section chrome). The narrative is the ONLY thing here that goes through markdownFn — it is
 * DB-sourced prose, so it must be sanitized the same way doc bodies are (real callers pass
 * renderMarkdown, i.e. DOMPurify); it is never additionally esc()'d (that would double-encode
 * markdownFn's own escaping/output). Empty narrative → the existing dashed-card empty-state hint.
 */
export function planNarrativeBlock(narrative: string, markdownFn: (body: string) => string): string {
  const body = narrative.trim()
    ? `<div class="cnpy-md">${markdownFn(narrative)}</div>`
    : `<div style="border:1px dashed var(--border-strong);border-radius:13px;padding:18px 20px;color:var(--fg-55);font-size:13.5px;line-height:1.6">No plan narrative yet — write one with the update-plan skill</div>`;
  return `<div style="margin-bottom:18px">
    <div style="font-size:11px;font-weight:600;font-family:var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--fg-40);margin-bottom:6px">Narrative</div>
    <h1 style="font-size:24px;font-weight:600;letter-spacing:-0.02em;margin:0 0 14px">What's happening</h1>
    ${body}
  </div>`;
}

function roadmapDigest(s: AppState): string {
  const { list } = roadmapEnriched(s.roadmap.data.sprints, s.confirmedSprints);
  const inProgress = list.filter((m) => !m.done && m.badge.label === "In progress");
  // What's "getting the attention" = something actively in progress first; only fall back
  // to the next upcoming goal when nothing is underway.
  const focus = inProgress[0] ?? list.find((m) => m.isNext) ?? list.find((m) => !m.done);

  // ── Current-focus spotlight (with progress bar + GitHub links) ──
  const spotlight = focus ? (() => {
    const barColor = focus.done ? "var(--green)" : focus.overdue ? "var(--red)" : "var(--accent)";
    const bar = focus.total !== null && focus.closed !== null
      ? `<div style="display:flex;align-items:center;gap:12px;margin-top:15px">
          <div style="flex:1;height:6px;border-radius:999px;background:var(--border);overflow:hidden"><div style="height:100%;border-radius:999px;width:${focus.pct}%;background:${barColor}"></div></div>
          <span style="font-size:12px;color:var(--fg-55);font-family:var(--mono);white-space:nowrap;flex:none">${focus.closed}/${focus.total} closed</span>
        </div>`
      : "";
    const chips = sprintRefChips(focus.github_ref);
    // The GitHub half of a sprint lives HERE and nowhere else: the cached issue
    // counts, beside the chips that link the issues themselves. Nothing renders
    // when the sprint has no cache row.
    const issueCount = focus.issues
      ? `<span style="font-size:11.5px;color:var(--fg-55);font-family:var(--mono);white-space:nowrap;flex:none">${focus.issues.closed}/${focus.issues.total} issues closed</span>`
      : "";
    return `<div style="border:1px solid var(--accent);border-radius:14px;padding:20px;margin:22px 0;background:var(--accent-soft)">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:10px;min-width:0">
          <span style="font-size:10px;font-weight:700;font-family:var(--mono);letter-spacing:.12em;color:var(--accent);flex:none">NOW</span>
          <span style="font-size:16px;font-weight:600;letter-spacing:-0.01em">${esc(focus.title)}</span>
        </div>
        <span style="font-size:12px;color:var(--fg-55);font-family:var(--mono);flex:none">${focus.dateLabel}</span>
      </div>
      ${focus.about ? `<p style="font-size:13px;line-height:1.6;color:var(--fg-70);margin:10px 0 0">${linkifyRefs(focus.about)}</p>` : ""}
      ${bar}
      ${chips.length || issueCount ? `<div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-top:14px">${chips.map(ghChip).join("")}${issueCount}</div>` : ""}
    </div>`;
  })() : "";

  // ── Recent happenings (compact table from the live feed, with GitHub chips) ──
  const entries = s.feed.data.slice(0, 6);
  const happenRows = entries.map((e) => {
    const chips = feedArtifacts(e.artifacts);
    return `<tr style="border-top:1px solid var(--border)">
      <td style="padding:11px 14px 11px 0;vertical-align:top;white-space:nowrap;font-size:11.5px;color:var(--fg-40);font-family:var(--mono)">${relTime(e.created_at)}</td>
      <td style="padding:11px 14px 11px 0;vertical-align:top;white-space:nowrap;font-size:12.5px;color:var(--fg-55)"><span style="display:inline-flex;align-items:center;gap:6px">${personChip(personFor(s, e.author), 18, e.author)}${handleTag(personFor(s, e.author), e.author, 11.5)}</span></td>
      <td style="padding:11px 0;vertical-align:top;font-size:13px;color:var(--fg);line-height:1.5"><span class="cnpy-md-inline">${renderMarkdownInline(e.summary)}</span>${chips.length ? ` <span style="display:inline-flex;gap:6px;flex-wrap:wrap;margin-left:4px;vertical-align:middle">${chips.map(ghChip).join("")}</span>` : ""}</td>
    </tr>`;
  }).join("");
  const happenings = s.feed.status === "loading" && entries.length === 0
    ? notice("Loading recent activity&hellip;")
    : entries.length === 0
    ? notice("No recent activity yet.")
    : `<table style="width:100%;border-collapse:collapse">${happenRows}</table>`;

  return `<div class="cnpy-scroll" style="max-width:820px;margin:0 auto;padding:32px 40px 100px">
    ${planNarrativeBlock(s.roadmap.data.narrative, renderMarkdown)}
    ${spotlight}
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:28px 0 2px">
      <h2 style="font-size:12px;font-weight:600;font-family:var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--fg-55);margin:0">Recent happenings</h2>
      <button data-act="goFeed" class="cnpy-link" style="font-size:12.5px;font-weight:500;color:var(--accent);background:none">View all in Feed →</button>
    </div>
    ${happenings}
  </div>`;
}

// ── search ───────────────────────────────────────────────────────────────────
// The ticket icon is the sidebar family's ticket glyph (a stub with a notch),
// drawn at the same 24-viewBox scale as the rest of this map.
const SEARCH_TYPE_ICON: Record<string, string> = { feed: "M4 5h16M4 12h16M4 19h10", doc: "M6 3h7l5 5v13H6z", decision: "M9 12l2 2 4-4", sprint: "M5 3v18M5 4h11l-2 3 2 3H5" };
// The "sprint" type covers the plan narrative + the sprints, so its badge keeps
// reading "Roadmap" — the screen it navigates to.
const SEARCH_TYPE_LABEL: Record<string, string> = { doc: "Doc", feed: "Feed", decision: "Decision", sprint: "Roadmap" };

// Authority → badge. /search is live-only, so humans normally see LIVE / PENDING;
// the others are mapped for completeness. Reuses the status badge styling.
function authorityBadge(a: Authority): string {
  const map: Record<Authority, { label: string; color: string }> = {
    live: { label: "LIVE", color: "var(--green)" },
    staged_pending: { label: "PENDING", color: "var(--amber)" },
    unpromoted: { label: "UNPROMOTED", color: "var(--amber)" },
    draft: { label: "DRAFT", color: "var(--blue)" },
  };
  const { label, color } = map[a];
  return `<span style="font-size:9.5px;font-weight:600;font-family:var(--mono);letter-spacing:.03em;color:${color};border:1px solid color-mix(in srgb,${color} 45%,transparent);background:color-mix(in srgb,${color} 12%,transparent);border-radius:5px;padding:2px 6px;white-space:nowrap">${label}</span>`;
}

function searchTypeBadge(type: string): string {
  const color = type === "decision" ? "var(--blue)" : type === "feed" ? "var(--fg-70)" : "var(--accent)";
  const border = type === "decision" ? "color-mix(in srgb,var(--blue) 45%,transparent)" : type === "feed" ? "var(--border-strong)" : "color-mix(in srgb,var(--accent) 45%,transparent)";
  const label = SEARCH_TYPE_LABEL[type] ?? type;
  const icon = SEARCH_TYPE_ICON[type] ?? SEARCH_TYPE_ICON["doc"];
  return `<span style="display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:600;font-family:var(--mono);letter-spacing:.04em;text-transform:uppercase;padding:2px 7px;border-radius:5px;color:${color};border:1px solid ${border}"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="${icon}"></path></svg>${label}</span>`;
}

// Highlight the active query term inside a body of text.
function highlight(text: string, sq: string): string {
  if (!sq) return esc(text);
  const idx = text.toLowerCase().indexOf(sq);
  if (idx < 0) return esc(text);
  const pre = text.slice(0, idx), mid = text.slice(idx, idx + sq.length), post = text.slice(idx + sq.length);
  return `${esc(pre)}<span style="background:var(--accent-soft);color:var(--accent);border-radius:3px;padding:0 3px;font-weight:500">${esc(mid)}</span>${esc(post)}`;
}

// G3: decisions are NOT navigable (no detail route). doc → openDocFrom, feed → goFeed,
// sprint → goRoadmap (the Roadmap screen — sprints have no standalone detail route
// yet, so this navigates to the screen that lists them, same idiom as goFeed).
// There is no ticket case: tickets are NOT in the /search fan-out at all.
function searchOpenAttr(type: string, id: string): string | null {
  if (type === "decision") return null;
  if (type === "feed") return `data-act="goFeed"`;
  if (type === "sprint") return `data-act="goRoadmap"`;
  return `data-act="openDocFrom" data-arg="${attr(id)}"`;
}

function primaryCard(r: QueryPrimary, sq: string): string {
  const preview = r.body.replace(/\s+/g, " ").trim().slice(0, 280);
  const inner = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:9px;flex-wrap:wrap">${searchTypeBadge(r.type)}${authorityBadge(r.authority)}</div>
    <div style="font-size:14.5px;font-weight:500;letter-spacing:-0.01em;margin-bottom:6px">${esc(r.title)}</div>
    <div style="font-size:13px;line-height:1.6;color:var(--fg-55)">${highlight(preview, sq)}${r.body.length > 280 ? "…" : ""}</div>`;
  const act = searchOpenAttr(r.type, r.id);
  return act
    ? `<button ${act} class="cnpy-card" style="display:block;width:100%;text-align:left;border:1px solid var(--border);border-radius:12px;padding:16px 18px;margin-bottom:10px;cursor:pointer">${inner}</button>`
    : `<div class="cnpy-card" style="display:block;width:100%;text-align:left;border:1px solid var(--border);border-radius:12px;padding:16px 18px;margin-bottom:10px">${inner}</div>`;
}

function pointerRow(r: QueryPointer, sq: string): string {
  const inner = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">${searchTypeBadge(r.type)}${authorityBadge(r.authority)}<span style="font-size:13px;font-weight:500;letter-spacing:-0.01em">${esc(r.title)}</span></div>
    <div style="font-size:12.5px;line-height:1.55;color:var(--fg-55)">${highlight(r.snippet, sq)}</div>`;
  const act = searchOpenAttr(r.type, r.id);
  return act
    ? `<button ${act} style="display:block;width:100%;text-align:left;border:1px solid var(--border);border-radius:10px;padding:11px 14px;margin-bottom:8px;background:transparent;cursor:pointer">${inner}</button>`
    : `<div style="display:block;width:100%;text-align:left;border:1px solid var(--border);border-radius:10px;padding:11px 14px;margin-bottom:8px">${inner}</div>`;
}

function searchView(s: AppState): string {
  const result = s.searchResults.data;
  // Client-side filter by type (no refetch — the full set is already fetched).
  const keep = (t: string) => s.searchType === "all" || s.searchType === t;
  const primary = result.primary.filter((r) => keep(r.type));
  const pointers = result.pointers.filter((r) => keep(r.type));

  const sq = (s.searchQuery || "").trim().toLowerCase();

  // No "Tickets" chip: tickets never appear in search results, so a filter for
  // them would only ever show an empty list.
  const typeChips = [["all", "All"], ["doc", "Docs"], ["feed", "Feed"], ["decision", "Decisions"]].map(([k, label]) => {
    const sel = s.searchType === k;
    const style = `padding:6px 13px;border-radius:8px;font-size:13px;font-weight:500;border:1px solid ${sel ? "var(--accent)" : "var(--border)"};color:${sel ? "var(--accent)" : "var(--fg-55)"};background:${sel ? "var(--accent-soft)" : "transparent"};transition:all .12s ease`;
    return `<button data-act="setSearchType" data-arg="${k}" style="${style}">${label}</button>`;
  }).join("");

  let body: string;
  if (s.searchResults.status === "loading") {
    body = notice("Searching&hellip;");
  } else if (s.searchResults.status === "ok" && primary.length === 0 && pointers.length === 0) {
    body = notice("No results for that query.");
  } else {
    const primaryBlock = primary.length
      ? `<div class="cnpy-stagger">${primary.map((r) => primaryCard(r, sq)).join("")}</div>`
      : "";
    const pointerBlock = pointers.length
      ? `<div style="margin-top:22px">
           <div style="font-size:11px;font-weight:600;font-family:var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--fg-40);margin-bottom:10px">More pointers</div>
           ${pointers.map((r) => pointerRow(r, sq)).join("")}
         </div>`
      : "";
    body = `${primaryBlock}${pointerBlock}`;
  }

  const count = primary.length + pointers.length;
  return `<div style="max-width:780px;margin:0 auto;padding:32px 24px 100px">
    <div style="display:flex;align-items:center;gap:11px;border:1px solid var(--border-strong);border-radius:12px;padding:0 16px;height:52px;margin-bottom:18px">
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="flex:none;color:var(--fg-40)"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.2-3.2"></path></svg>
      <input data-act="setSearch" data-field="search" value="${attr(s.searchQuery)}" placeholder="Search the store — feed, docs, decisions" style="flex:1;border:none;outline:none;background:transparent;color:var(--fg);font-size:16px" />
      <kbd style="font-family:var(--mono);font-size:11px;color:var(--fg-40);border:1px solid var(--border);border-radius:5px;padding:2px 6px">⌘K</kbd>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:20px">
      <div style="display:flex;align-items:center;gap:7px">${typeChips}</div>
      <span style="font-size:12.5px;color:var(--fg-40);font-family:var(--mono)">${count} results</span>
    </div>
    ${body}
  </div>`;
}

// ── get started / guide ──────────────────────────────────────────────────────
function guideView(s: AppState): string {
  // Screenshots are captured per theme (dark/light/midnight); pick the variant that matches
  // the viewer's active theme so the figures never clash with the surrounding page.
  const th = resolved(s);
  const gP = "font-size:14.5px;line-height:1.8;color:var(--fg-70);margin:0 0 4px";
  const gH2 = "font-size:22px;font-weight:600;letter-spacing:-0.02em;margin:8px 0 10px";
  const gH3 = "font-size:17px;font-weight:600;letter-spacing:-0.01em;margin:34px 0 10px";
  const gEyebrow = "font-family:var(--mono);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.11em;color:var(--fg-40);margin:52px 0 2px";
  const gStrong = (t: string) => `<strong style="color:var(--fg);font-weight:600">${t}</strong>`;
  const gEm = (t: string) => `<strong style="color:var(--fg-55)">${t}</strong>`;
  const gFig = (name: string, cap: string) => `<figure style="margin:18px 0 4px">
      <img src="/guide/${name}-${th}.png" alt="" style="display:block;width:100%;border:1px solid var(--border);border-radius:12px" />
      <figcaption style="font-size:12px;color:var(--fg-40);margin-top:8px">${cap}</figcaption>
    </figure>`;
  const gPre = (body: string) => `<pre style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:14px 16px;overflow-x:auto;margin:12px 0 0"><code style="font-family:var(--mono);font-size:12.5px;line-height:1.6;color:var(--fg-70)">${body}</code></pre>`;
  return `<div class="cnpy-scroll" style="max-width:860px;margin:0 auto;padding:52px 40px 120px">
    <h1 style="font-size:30px;font-weight:650;letter-spacing:-0.025em;margin:0 0 14px">Get Started</h1>
    <p style="font-size:16px;line-height:1.8;color:var(--fg-70);margin:0 0 14px">Welcome to Canopy, your team's shared memory. It holds the team's docs, decisions, roadmap, and a running feed of everything people and their coding agents have done, and it keeps that memory trustworthy with one golden rule: ${gStrong("agents only ever stage changes; a human confirms the ones that matter")}. Nothing an agent writes goes live until someone approves it, so the store stays reliable no matter how many agents are writing to it.</p>
    <p style="${gP}">This is a tour of the app, following the sidebar top to bottom (${gStrong("Workspace")}, ${gStrong("Knowledge")}, and ${gStrong("Triage")}), then how to connect your own coding agent.</p>

    <div style="${gEyebrow}">Workspace</div>
    <h2 style="${gH2}">Your day-to-day</h2>

    <h3 style="${gH3}">My Work</h3>
    <p style="${gP}">Canopy opens on ${gStrong("My Work")}, your personal dashboard. It's a read-only projection over captured GitHub events and the ticket queue (no live API calls), so it loads instantly. Three lists: ${gStrong("To-Do")}, your open assigned issues (each with a one-line summary, its sprint, and a suggested next step); ${gStrong("Previous activity")}, your recently merged and closed PRs, each summarized once at capture time; and ${gStrong("Tickets assigned to me")}, the open tickets from the queue that are yours. ${gStrong("Sync GitHub")} pulls the latest events.</p>
    ${gFig("mywork", `${gEm("My Work")}: your open issues with a summary, sprint, and next step, your recent PRs, and the tickets assigned to you.`)}

    <h3 style="${gH3}">Roadmap</h3>
    <p style="${gP}">${gStrong("Roadmap")} is the admin-authored plan: a narrative of what's happening plus sprints in target-date order. Each sprint's progress comes from its ${gStrong("tickets")} — done plus declined, over the total in that sprint — with overdue flags; the ${gStrong("Narrative")} tab still links the GitHub issues behind a sprint. Toggle between the ${gStrong("Narrative")} digest and the ${gStrong("Timeline")} of sprints.</p>
    ${gFig("roadmap", `${gEm("Roadmap")}: sprints in target-date order with their ticket progress bars, overdue flags, and the GitHub issues behind each one in the Narrative tab.`)}

    <h3 style="${gH3}">Feed</h3>
    <p style="${gP}">${gStrong("Feed")} is the running timeline of everything that's shipped, from people and their agents alike, newest first. Each entry links to its PR, commit, or issue, and you can filter by author, tag, or time window.</p>
    ${gFig("feed", `${gEm("Feed")}: one timeline of every change, with PR / commit / issue chips and author, tag, and time filters.`)}

    <div style="${gEyebrow}">Knowledge</div>
    <h2 style="${gH2}">The living reference</h2>

    <h3 style="${gH3}">Docs</h3>
    <p style="${gP}">The ${gStrong("Docs")} library is the team's living reference, split into two spaces (${gStrong("Technical")} and ${gStrong("Product")}), each grouped into sections like ${gStrong("Architecture")}, ${gStrong("Engineering Guide")}, and ${gStrong("Decisions")}. Open a doc and its ${gStrong("heading outline")} expands in the tree so you can jump to any section, and it tracks your scroll position as you read. Every doc is versioned: an agent's proposed update lands as a ${gStrong("staged")} new version while the current one stays live and untouched, with a banner up top pointing you to the proposal. Promote it in Review and the new version goes live; prior versions are never overwritten, just superseded.</p>
    ${gFig("docs", `${gEm("Docs")}: the Technical / Product library. Opening a doc expands its heading outline in the tree; the STAGED banner flags a proposal awaiting review.`)}

    <h3 style="${gH3}">Search</h3>
    <p style="${gP}">${gStrong("Search")} runs full-text across everything (docs, decisions, the feed, and the roadmap), ranked by relevance. It returns whole entries plus pointers to related ones, and every result is tagged ${gStrong("live")} or ${gStrong("staged")} so you can tell settled context from a proposal that hasn't been promoted yet.</p>
    ${gFig("search", `${gEm("Search")}: ranked full-text results across every type, each flagged LIVE or STAGED, with your query highlighted.`)}

    <div style="${gEyebrow}">Triage</div>
    <h2 style="${gH2}">Where humans confirm</h2>
    <p style="${gP}">The ${gStrong("Triage")} section is the human's desk, where agent-produced changes get a verdict. It's split into two surfaces.</p>

    <h3 style="${gH3}">Review</h3>
    <p style="${gP}">${gStrong("Review")} is one queue for everything awaiting a decision: staged doc ${gStrong("proposals")}, shown as a diff against the live version (unified, side-by-side, or rendered), and drafted ${gStrong("decisions")} (ADRs), shown as the proposed record. On each item you ${gStrong("Promote")} the doc (or ${gStrong("Ratify")} the decision) or ${gStrong("Reject")} it; edits made against a stale version are flagged.</p>
    ${gFig("review", `${gEm("Review")}: the queue on the left, the selected proposal's diff on the right, ready to Promote or Reject.`)}

    <h3 style="${gH3}">Maintenance</h3>
    <p style="${gP}">${gStrong("Maintenance")} is occasional housekeeping; empty is the normal state. ${gStrong("Unplaced")} holds anything an agent couldn't confidently place: read it, then route it where it belongs or ${gStrong("Discard")} it. ${gStrong("Identity")} matches unrecognized activity logins to people. Nothing here is ever hard-deleted.</p>
    ${gFig("maintenance", `${gEm("Maintenance")}: the Unplaced queue, where anything an agent couldn't place waits to be routed or discarded.`)}

    <div style="${gEyebrow}">Connect your agent</div>
    <h2 style="${gH2}">Plug in your coding agent</h2>
    <p style="${gP}">Everything above is also open to your coding agent over the ${gStrong("Model Context Protocol")}. First, get a token:</p>
    <ol style="font-size:14.5px;line-height:1.8;color:var(--fg-70);margin:10px 0 0;padding-left:22px">
      <li>You're already signed in, so that's step one done.</li>
      <li>Open ${gStrong("Settings")} and, under ${gStrong("MCP access tokens")}, click ${gStrong("Get connection command")}. It creates a token and hands you the exact setup for Claude Code, Codex or a plain <code style="font-family:var(--mono);font-size:13px">.mcp.json</code> with it filled in. Copy it before closing, since it's shown only once.</li>
    </ol>
    ${gFig("settings", `${gEm("Settings")}: mint an MCP access token, pick a theme, and see your org membership.`)}
    <p style="${gP};margin-top:14px">${gStrong("Easiest: install the Canopy plugin.")} It bundles the three skills below ${gStrong("and")} the MCP connection, so there's nothing to wire by hand. In Claude Code:</p>
    ${gPre(`/plugin marketplace add SaplingLearn/canopy
/plugin install canopy@canopy`)}
    <p style="${gP};margin-top:12px">The plugin reads your token from an environment variable, so export it in the shell that launches your agent (add it to your shell profile to make it stick), then restart:</p>
    ${gPre(`export CANOPY_MCP_TOKEN=canopy_mcp_…`)}
    <p style="${gP};margin-top:14px">${gStrong("Prefer to wire it by hand")}, or running your own Canopy? Skip the plugin and drop a <code style="font-family:var(--mono);font-size:13px">.mcp.json</code> in your project with the token as a bearer header, then restart your agent:</p>
    ${gPre(`{
  "mcpServers": {
    "canopy": {
      "type": "streamable-http",
      "url": "https://&lt;your-canopy-host&gt;/mcp",
      "headers": { "Authorization": "Bearer canopy_mcp_…" }
    }
  }
}`)}
    <p style="${gP};margin-top:14px">Once connected, your agent can read everything with ${gStrong("query")} (ranked, authority-flagged search) and ${gStrong("get_doc")}, and add new context with ${gStrong("append_feed")} and ${gStrong("propose_doc_update")}. Exactly like the UI, those writes are ${gStrong("staged")}: they land in Review for you to confirm, never straight into the live store. The gate de-duplicates no-op writes and tags each doc change as new, edit, or rewrite, so re-running a session never piles up noise.</p>

    <div style="${gEyebrow}">The living loop</div>
    <h2 style="${gH2}">How Canopy stays current</h2>
    <p style="${gP}">The thing that keeps Canopy alive isn't any one screen; it's a loop your agent runs every session: ${gStrong("orient → work → record")}. Three Claude Code skills (under <code style="font-family:var(--mono);font-size:13px">.claude/skills/</code>) drive it, and they're the real heart of the system.</p>
    <ol style="font-size:14.5px;line-height:1.8;color:var(--fg-70);margin:10px 0 0;padding-left:22px">
      <li>${gStrong("Orient: load-context.")} Fires on its own before your agent works an area it has touched before, and always before it proposes a doc change. It calls the read-only ${gStrong("query")} tool, reads the assembled authoritative bodies, and respects each result's authority flag, so the agent builds on what the team already knows instead of re-deriving it. It never writes.</li>
      <li>${gStrong("Work.")} The agent does the task, now grounded in real context rather than guesses.</li>
      <li>${gStrong("Record: record-session.")} You ask for it explicitly at the end ("record this session"; it never fires on its own). It observes what actually shipped from <code style="font-family:var(--mono);font-size:13px">git</code>/<code style="font-family:var(--mono);font-size:13px">gh</code>, reads the docs it touched back from Canopy so it writes a true delta from a known base, and stages one reconciled batch through the ${gStrong("record_session")} MCP tool, over the same bearer connection you set up above, with no extra auth. The gate drops no-ops, tags each doc change new/edit/rewrite, and routes anything low-confidence or out-of-vocab to Maintenance.</li>
    </ol>
    <p style="${gP};margin-top:12px">Then you ${gStrong("confirm")} in Review. That's the whole point: agents feed the store continuously, a human curates what matters, and because nothing goes live unreviewed, and every session writes back what it learned, the context stays trustworthy and current instead of going stale. This loop is the difference between a wiki that rots and a memory that grows.</p>
    <p style="${gP}">${gStrong("canopy")} is the umbrella skill that maps all of this and carries the full ${gStrong("query")} reference; ${gStrong("load-context")} and ${gStrong("record-session")} are the two halves it composes, kept separate because one must fire on its own and the other must never. The Canopy plugin (above) ships all three, so installing it is all it takes to get them in any project, with no copying by hand.</p>
  </div>`;
}

// ── settings ─────────────────────────────────────────────────────────────────
const SECTION_LABEL = "font-size:11px;font-weight:600;font-family:var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--fg-40);margin-bottom:14px";

/** Handle-check status wording, shared with onboarding's STATUS map (people.ts) —
 *  "same" (draft equals the current handle) and "idle" both render blank. */
function handleStatusText(check: AppState["handleCheck"]): { text: string; color: string } {
  switch (check) {
    case "checking": return { text: "checking…", color: "var(--fg-40)" };
    case "available": return { text: "available", color: "var(--green)" };
    case "invalid": return { text: "invalid", color: "var(--red)" };
    case "reserved": return { text: "reserved", color: "var(--red)" };
    case "taken": return { text: "taken", color: "var(--red)" };
    default: return { text: "", color: "var(--fg-40)" }; // idle, same
  }
}

/** Settings › Profile: display name, handle, and color.
 *  Pure over AppState — exported for the pure render test. */
export function profileSection(s: AppState): string {
  const me = s.me;
  const handle = me?.handle ?? "";
  const handleRow = s.handleEdit ? (() => {
    const st = handleStatusText(s.handleCheck);
    const canSave = s.handleCheck === "available" && s.handleDraft.trim().toLowerCase() !== handle.toLowerCase();
    return `<div style="margin-top:8px">
      <div style="display:flex;align-items:center;border:1px solid var(--border-strong);border-radius:9px;background:var(--bg);overflow:hidden;max-width:280px">
        <span style="font-family:var(--mono);font-size:13px;color:var(--fg-40);padding-left:10px">@</span>
        <input data-act="handleDraft" data-field="handleDraft" value="${attr(s.handleDraft)}" autocomplete="off" spellcheck="false" maxlength="24" class="cnpy-input" style="flex:1;min-width:0;border:none;outline:none;background:transparent;color:var(--fg);font-size:13px;padding:9px 4px;font-family:var(--mono)" />
        <span style="font-family:var(--mono);font-size:11px;padding:0 10px;white-space:nowrap;color:${st.color}">${esc(st.text)}</span>
      </div>
      <div style="font-size:11.5px;color:var(--fg-40);margin-top:8px;line-height:1.5">Every entry you've written is re-attributed to the new handle. Links to the old one stop working.</div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button data-act="handleSave" class="cnpy-accentbtn" ${canSave ? "" : "disabled "}style="padding:0 14px;height:32px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-size:12.5px;font-weight:600;${canSave ? "" : "opacity:.45;cursor:default"}">Save</button>
        <button data-act="handleCancel" class="cnpy-ghostbtn" style="padding:0 14px;height:32px;border-radius:8px;border:1px solid var(--border);font-size:12.5px;color:var(--fg-55)">Cancel</button>
      </div>
    </div>`;
  })() : `<div style="font-size:12px;color:var(--fg-40);margin-top:8px">Handle ${me ? handleTag({ handle, color: me.color }, handle, 12) : handleTag(null, handle, 12)} <button data-act="handleEdit" class="cnpy-mutelink" style="font-size:11.5px;color:var(--fg-55);text-decoration:underline;text-underline-offset:2px;margin-left:6px">Change</button></div>`;
  const FIELD_LABEL = "display:block;font-size:13px;font-weight:500;margin-bottom:8px";
  return `<section class="cnpy-tile">
    <div style="${SECTION_LABEL}">Profile</div>
    <div style="display:flex;align-items:flex-start;gap:14px">
      ${personChip(me ? { handle, name: s.displayName || me.name, color: me.color, avatar_url: me.avatar_url } : null, 48, handle || "?")}
      <div style="flex:1;min-width:0">
        <label style="${FIELD_LABEL}">Display name</label>
        <div style="display:flex;gap:10px">
          <input data-act="setDisplayName" data-field="displayName" value="${attr(s.displayName)}" class="cnpy-input" style="flex:1;min-width:0;height:40px;padding:0 13px;border:1px solid var(--border-strong);border-radius:9px;background:transparent;color:var(--fg);font-size:14px;outline:none" />
          <button data-act="saveProfile" class="cnpy-accentbtn" style="padding:0 16px;height:40px;border-radius:9px;background:var(--accent);color:var(--accent-fg);font-size:13.5px;font-weight:600">Save</button>
        </div>
        ${handleRow}
      </div>
    </div>
    <div style="margin-top:20px"><label style="${FIELD_LABEL}">Your color</label>${swatches("setMyColor", me?.color ?? "stone", true)}</div>
  </section>`;
}

/** Settings › Account: who you are signed in as (no avatar — Profile, beside it, already
 *  shows it), Sign out, and the sign-in methods
 *  (link/unlink per provider — the last identity can't be unlinked).
 *  Pure over AppState — exported for the pure render test. */
export function accountSection(s: AppState): string {
  const me = s.me;
  const last = (me?.identities.length ?? 0) <= 1;
  const viaGithub = me?.identities.some((i) => i.provider === "github") ?? false;
  const provRow = (p: "github" | "google", label: string) => {
    const id = me?.identities.find((i) => i.provider === p);
    const btn = id
      ? `<button data-act="unlinkProvider" data-arg="${p}" class="cnpy-ghostbtn" ${last ? "disabled " : ""}style="font-size:12px;color:var(--fg-40);padding:4px 10px;border-radius:6px;border:1px solid var(--border);${last ? "opacity:.45;cursor:default" : ""}">Unlink</button>`
      : `<button data-act="linkProvider" data-arg="${p}" class="cnpy-ghostbtn" style="font-size:12px;color:var(--fg-70);padding:4px 10px;border-radius:6px;border:1px solid var(--border-strong)">Link ${label}</button>`;
    return `<div style="display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;padding:10px 0;border-top:1px solid var(--border)"><div style="line-height:1.25"><b style="font-size:13.5px;font-weight:600;display:block">${label}</b><span style="font-family:var(--mono);font-size:11.5px;color:${id ? "var(--fg-55)" : "var(--fg-40)"}">${id ? esc(id.label) : "not linked"}</span></div>${btn}</div>`;
  };
  return `<section class="cnpy-tile" style="display:flex;flex-direction:column">
    <div style="${SECTION_LABEL}">Account</div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
      <div style="min-width:0">
        <div style="font-size:13.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Signed in as ${me ? handleTag({ handle: me.handle, color: me.color }, me.handle, 13) : ""}</div>
        <div style="display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--green);margin-top:4px"><span style="width:6px;height:6px;border-radius:50%;background:var(--green)"></span>${viaGithub ? `Member of <b>${esc(me?.org ?? "")}</b>` : "Signed in with Google"}</div>
      </div>
      <button data-act="signOut" class="cnpy-signout" style="flex:none;padding:7px 13px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500">Sign out</button>
    </div>
    <div style="margin-top:auto;padding-top:20px">
      <div style="font-size:13px;font-weight:500;margin-bottom:8px">Sign-in methods <span style="font-weight:400;color:var(--fg-40)">· at least one stays linked</span></div>
      ${provRow("github", "GitHub")}${provRow("google", "Google")}
    </div>
  </section>`;
}

/** Settings › MCP access tokens: one hairline row per live token. Only the hint is ever
 *  known here — the server keeps a hash — so a row is `canopy_mcp_ab12…`, when it was
 *  minted and last used, and a two-click Revoke (an agent stops working the moment it lands). */
export function tokenListBody(s: Pick<AppState, "tokens" | "tokenRevokeArm">): string {
  const note = (text: string) => `<div style="padding:12px 0;border-top:1px solid var(--border);font-size:12.5px;color:var(--fg-40)">${text}</div>`;
  const t = s.tokens;
  if (t.status === "error") return note(`Couldn't load your tokens${t.error ? ` &mdash; ${esc(t.error)}` : ""}.`);
  if (t.status !== "ok" && !t.data.length) return note("Loading tokens&hellip;");
  if (!t.data.length) return note("No tokens yet. Get a connection command to connect an agent.");
  const rows = t.data.map((tk) => {
    const armed = s.tokenRevokeArm === tk.id;
    const btn = "flex:none;padding:4px 10px;border-radius:6px;font-size:12px";
    const actions = armed
      ? `<button data-act="revokeToken" data-arg="${tk.id}" class="cnpy-revoke" style="${btn};font-weight:600;color:var(--red);border:1px solid var(--red)">Revoke</button>
         <button data-act="revokeTokenCancel" class="cnpy-ghostbtn" style="${btn};color:var(--fg-55);border:1px solid var(--border)">Keep</button>`
      : `<button data-act="revokeTokenArm" data-arg="${tk.id}" class="cnpy-revoke" style="${btn};color:var(--fg-55);border:1px solid var(--border)">Revoke</button>`;
    return `<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--border)">
      <div style="flex:1;min-width:0;line-height:1.35">
        <code style="display:block;font-family:var(--mono);font-size:12.5px;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">canopy_mcp_${esc(tk.hint ?? "")}<span style="color:var(--fg-40)">&bull;&bull;&bull;&bull;</span></code>
        <span style="font-size:11.5px;color:var(--fg-40)">${armed ? "Any agent using it stops working." : `Minted ${esc(relTime(tk.created_at))} &middot; ${tk.last_used_at ? `last used ${esc(relTime(tk.last_used_at))}` : "never used"}`}</span>
      </div>
      ${actions}
    </div>`;
  }).join("");
  return `<div class="cnpy-scroll cnpy-set-tokens">${rows}</div>`;
}

// ── Settings › Connect an agent ──────────────────────────────────────────────

export type ConnectClient = "claude" | "codex" | "json" | "token";
export const CONNECT_CLIENTS: readonly { id: ConnectClient; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "json", label: ".mcp.json" },
  { id: "token", label: "Token only" },
];

/** This Canopy's own MCP endpoint — the origin the SPA is served from, so a local
 *  `wrangler dev` hands out a local URL and prod hands out prod's. */
const mcpEndpoint = (): string =>
  `${typeof location !== "undefined" && location.origin ? location.origin : "https://canopy.saplinglearn.com"}/mcp`;

/**
 * The setup text for one client, with `token` filled in. Pure, so a test pins each
 * shape. Claude Code takes the header on the command line; Codex reads a bearer
 * token from an environment variable (its `--bearer-token-env-var`), which is the
 * SAME `CANOPY_MCP_TOKEN` the Canopy plugin reads.
 */
export function connectSnippet(client: ConnectClient, token: string, url: string = mcpEndpoint()): string {
  switch (client) {
    case "claude":
      return `claude mcp add --transport http --scope user canopy ${url} \\\n  --header "Authorization: Bearer ${token}"`;
    case "codex":
      return `export CANOPY_MCP_TOKEN=${token}\ncodex mcp add canopy --url ${url} --bearer-token-env-var CANOPY_MCP_TOKEN`;
    case "json":
      return `{\n  "mcpServers": {\n    "canopy": {\n      "type": "http",\n      "url": "${url}",\n      "headers": { "Authorization": "Bearer ${token}" }\n    }\n  }\n}`;
    case "token":
      return token;
  }
}

const CONNECT_NOTE: Record<ConnectClient, string> = {
  claude: `Paste it into a terminal, then restart Claude Code. <code style="font-family:var(--mono);font-size:11px">--scope user</code> makes Canopy available in every project.`,
  codex: `Paste both lines into a terminal, then restart Codex. Codex reads the token from <code style="font-family:var(--mono);font-size:11px">CANOPY_MCP_TOKEN</code> each time it starts, so add the <code style="font-family:var(--mono);font-size:11px">export</code> line to your shell profile too.`,
  json: `For Cursor and other MCP clients: put this in the client's MCP config (for Claude Code, a project's <code style="font-family:var(--mono);font-size:11px">.mcp.json</code>), then restart it.`,
  token: `For anything else, send it as a bearer header: <code style="font-family:var(--mono);font-size:11px">Authorization: Bearer &lt;token&gt;</code> to <code style="font-family:var(--mono);font-size:11px">${esc(mcpEndpoint())}</code>. Using the Canopy plugin? Export it as <code style="font-family:var(--mono);font-size:11px">CANOPY_MCP_TOKEN</code>.`,
};

/** The Settings row a minted token shows up as: `canopy_mcp_` + the first 4 characters. */
export const tokenLabel = (token: string): string =>
  `canopy_mcp_${token.startsWith("canopy_mcp_") ? token.slice(11, 15) : ""}`;

/**
 * "Get connection command": ONE modal that is the whole flow. The click mints a
 * token; the modal shows the exact setup for the chosen client with that token
 * already in it, says where the token now lives in Settings, and on Done/close the
 * token is gone from the page for good — there is no second place it is shown.
 * Built on the sign-in dialog's pattern: a sibling backdrop that closes it, and a
 * pointer-events:none wrapper so clicks inside the panel never reach the backdrop.
 */
export function connectModal(s: Pick<AppState, "connect" | "connectClient" | "connectCopied">): string {
  const m = s.connect;
  if (!m) return "";
  const close = `<button data-act="connectClose" title="Close" aria-label="Close" class="cnpy-iconbtn" style="position:absolute;top:12px;right:12px;width:30px;height:30px;border-radius:8px;display:grid;place-items:center;color:var(--fg-40)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18"></path></svg></button>`;

  let body: string;
  if (m.error) {
    body = `<div style="font-size:13px;color:var(--red);line-height:1.6;margin-bottom:18px">Couldn't create a token — ${esc(m.error)}</div>
      <div style="display:flex;justify-content:flex-end"><button data-act="connectClose" class="cnpy-outlinebtn" style="padding:7px 14px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70)">Close</button></div>`;
  } else if (!m.token) {
    body = `<div style="display:flex;align-items:center;gap:10px;font-size:13px;color:var(--fg-55);padding:18px 0 8px"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" style="animation:cnpy-spin .8s linear infinite"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"></path><path d="M21 3v5h-5"></path></svg>Creating a token for this connection&hellip;</div>`;
  } else {
    const tabs = CONNECT_CLIENTS.map(({ id, label }) => {
      const on = s.connectClient === id;
      return `<button ${on ? "" : `data-act="connectClient" data-arg="${id}"`} aria-pressed="${on}" style="padding:5px 11px;border-radius:7px;font-size:12.5px;font-weight:${on ? 600 : 500};color:${on ? "var(--fg)" : "var(--fg-55)"};background:${on ? "var(--hover)" : "transparent"};border:1px solid ${on ? "var(--border-strong)" : "transparent"}">${label}</button>`;
    }).join("");
    const btnBase = "flex:none;align-self:flex-start;display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:7px;font-size:12.5px;font-weight:600";
    const copy = s.connectCopied
      ? `<button data-act="connectCopy" class="cnpy-copybtn is-copied" style="${btnBase};background:var(--accent-soft);color:var(--accent);border:1px solid var(--accent)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M20 6 9 17l-5-5"></path></svg>Copied</button>`
      : `<button data-act="connectCopy" class="cnpy-copybtn" style="${btnBase};background:var(--accent);color:var(--accent-fg);border:1px solid var(--accent)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a2 2 0 0 1 2-2h10"></path></svg>Copy</button>`;
    body = `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:12px">${tabs}</div>
      <div style="display:flex;align-items:stretch;gap:8px;background:var(--hover);border:1px solid var(--border-strong);border-radius:9px;padding:10px 10px 10px 14px">
        <pre style="flex:1;min-width:0;margin:0;font-family:var(--mono);font-size:12.5px;line-height:1.6;color:var(--fg);white-space:pre-wrap;word-break:break-all">${esc(connectSnippet(s.connectClient, m.token))}</pre>
        ${copy}
      </div>
      <div style="font-size:11.5px;color:var(--fg-55);margin-top:10px;line-height:1.55">${CONNECT_NOTE[s.connectClient]}</div>
      <div style="display:flex;gap:10px;align-items:flex-start;margin-top:18px;padding:12px 14px;border-radius:9px;border:1px solid var(--border);font-size:12px;line-height:1.55;color:var(--fg-70)">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--amber)" stroke-width="2" style="flex:none;margin-top:1px"><path d="M12 9v4M12 17h.01"></path><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path></svg>
        <div>This is the only time the token is shown, so copy it before closing. It's saved as <code style="font-family:var(--mono);font-size:11.5px;color:var(--fg)">${esc(tokenLabel(m.token))}&bull;&bull;&bull;&bull;</code> under <strong style="color:var(--fg);font-weight:600">MCP access tokens</strong> in Settings. Revoke it there to disconnect the agent.</div>
      </div>
      <div style="display:flex;justify-content:flex-end;margin-top:18px"><button data-act="connectClose" class="cnpy-outlinebtn" style="padding:7px 16px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:600;color:var(--fg)">Done</button></div>`;
  }

  return `<div data-act="connectClose" style="position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.5);animation:cnpy-fade .14s ease"></div>
  <div style="position:fixed;inset:0;z-index:61;display:grid;place-items:center;padding:16px;pointer-events:none">
    <div role="dialog" aria-modal="true" aria-labelledby="connect-title" style="pointer-events:auto;position:relative;width:min(580px, 100%);max-height:calc(100vh - 32px);overflow-y:auto;border:1px solid var(--border-strong);border-radius:14px;padding:26px 26px 22px;background:var(--bg);box-shadow:var(--shadow);animation:cnpy-pop .16s ease">
      ${close}
      <div id="connect-title" style="font-size:16px;font-weight:600;letter-spacing:-0.01em;margin-bottom:4px">Connect an agent</div>
      <div style="font-size:12.5px;color:var(--fg-55);margin-bottom:18px">Pick your agent, copy the setup, paste it. Your agent acts as you.</div>
      ${body}
    </div>
  </div>`;
}

function settingsView(s: AppState): string {
  const themeCards = [
    ["light", "Light"],
    ["dark", "Dark"],
    ["midnight", "Midnight"],
    ["system", "System"],
  ].map(([k, label]) => {
    const sel = s.theme === k;
    const style = `display:flex;align-items:center;justify-content:center;gap:9px;padding:13px 8px;border-radius:11px;border:1px solid ${sel ? "var(--accent)" : "var(--border)"};background:${sel ? "var(--accent-soft)" : "transparent"};color:${sel ? "var(--accent)" : "var(--fg-70)"}`;
    const icon = k === "light"
      ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="4.2"></circle><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"></path></svg>`
      : k === "dark"
      ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"></path></svg>`
      : k === "midnight"
      ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"></path><path d="M17 3.2l.55 1.55L19.1 5.3l-1.55.55L17 7.4l-.55-1.55L14.9 5.3l1.55-.55z"></path></svg>`
      : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="13" rx="2"></rect><path d="M8 21h8M12 17v4"></path></svg>`;
    return `<button data-act="setTheme" data-arg="${k}" class="cnpy-themecard" style="${style}">${icon}<span style="font-size:13px;font-weight:500">${label}</span></button>`;
  }).join("");

  const tokenList = tokenListBody(s);

  // Bento on three columns: Profile / Account / tokens across the top — the three tiles
  // whose natural heights match, so none is stretched hollow — then Email and the
  // Appearance strip at full width. Nothing sits BESIDE the tall tile: whatever does
  // gets stretched to its height (canopy.css has the folds).
  return `<div class="cnpy-set-wrap"><div class="cnpy-set">
    ${profileSection(s)}

    ${accountSection(s)}

    <section class="cnpy-tile" style="display:flex;flex-direction:column">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px">
        <div style="${SECTION_LABEL};margin-bottom:0">MCP access tokens</div>
        <button data-act="connectOpen" class="cnpy-mintbtn" style="flex:none;display:inline-flex;align-items:center;gap:7px;padding:7px 13px;border-radius:8px;border:1px solid var(--accent);color:var(--accent);font-size:12.5px;font-weight:600;background:var(--accent-soft)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"></path></svg>Get connection command</button>
      </div>
      ${tokenList}
      <div style="font-size:11.5px;color:var(--fg-40);margin-top:auto;padding-top:12px;line-height:1.5">Each connection command creates its own token. Revoking one disconnects that agent immediately.</div>
    </section>

    ${emailNotificationsSection({
      prefs: s.notifPrefs.data,
      loading: s.notifPrefs.status === "idle" || s.notifPrefs.status === "loading",
      error: s.notifPrefs.error ?? null,
      emailEditing: s.emailEditing,
      emailDraft: s.emailDraft,
    })}

    <section class="cnpy-tile cnpy-set-appear">
      <div style="${SECTION_LABEL}">Appearance</div>
      <div class="cnpy-set-themes">${themeCards}</div>
      <div style="font-size:11.5px;color:var(--fg-40);margin-top:10px">System follows your operating system's appearance.</div>
    </section>
  </div></div>`;
}

// ── my work (personal dashboard) ──────────────────────────────────────────────
const MW_LABEL = "font-size:13px;font-weight:700;font-family:var(--mono);text-transform:uppercase;letter-spacing:.14em;color:var(--fg)";

// Option-2a card anatomy (design_handoff_mywork_cards): roomy card, title +
// number pill row, then hairline-separated 96px-label section rows, footer meta.
const MW_CARD = "border:1px solid var(--border);border-radius:16px;padding:20px 22px 14px;background:color-mix(in srgb,var(--fg) 2.5%,transparent);display:flex;flex-direction:column;height:100%";
const MW_ROW = "display:grid;grid-template-columns:96px 1fr;gap:12px;padding:11px 0;border-top:1px solid var(--border)";
const MW_ROW_LABEL = "font-family:var(--mono);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;color:var(--fg-40);padding-top:2px";
const MW_ROW_BODY = "font-size:13.5px;line-height:1.6;color:var(--fg-70)";
const MW_CODE = "font-family:var(--mono);font-size:12.5px;background:var(--hover);border:1px solid var(--border);border-radius:4px;padding:0 4px";
const MW_ARROW_SVG = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M7 17 17 7"></path><path d="M9 7h8v8"></path></svg>`;
const MW_FLAG_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" style="flex:none"><path d="M12 2v20"></path><path d="M12 4h7l-2 3 2 3h-7"></path></svg>`;

function wrapMyWork(inner: string): string {
  return `<div class="cnpy-scroll" style="max-width:1120px;margin:0 auto;padding:32px 32px 100px">${inner}</div>`;
}
function greetingFor(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}
function mwSection(label: string, body: string): string {
  return `<section style="margin-top:44px">
    <div style="padding-bottom:13px;margin-bottom:18px;border-bottom:1px solid var(--border-strong)">
      <span style="${MW_LABEL}">${label}</span>
    </div>${body}</section>`;
}
/** Dashed-card empty-state hint (existing idiom, e.g. old "no focus set yet"). */
function mwEmptyHint(text: string): string {
  return `<div style="border:1px dashed var(--border-strong);border-radius:13px;padding:18px 20px;color:var(--fg-55);font-size:13.5px;line-height:1.6">${text}</div>`;
}
/** Muted single-line hint for a degraded (D1 projection unavailable) section (existing idiom). */
function mwDegradedHint(text: string): string {
  return `<div style="font-size:13px;color:var(--fg-40);padding:2px 0">${text}</div>`;
}

/** Card title row: title left, number pill (the card's ONLY link) far right. */
function mwTitleRow(title: string, number: number, url: string): string {
  return `<div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:16px">
      <span style="font-size:16.5px;font-weight:600;letter-spacing:-0.01em;line-height:1.35;color:var(--fg);flex:1;min-width:0">${esc(title)}</span>
      <a href="${attr(safeUrl(url))}" target="_blank" rel="noopener" class="cnpy-numpill" style="font-family:var(--mono);font-size:11.5px;font-weight:600;color:var(--accent);background:var(--accent-soft);border-radius:6px;padding:3px 8px;display:flex;align-items:center;gap:5px;margin-top:2px;text-decoration:none;flex:none">#${number}${MW_ARROW_SVG}</a>
    </div>`;
}
/** One hairline-separated section row: 96px mono label + a pre-built body cell.
 *  Callers skip the call entirely for null data — no empty labels. */
function mwRow(label: string, bodyCell: string, labelExtra = ""): string {
  return `<div style="${MW_ROW}"><div style="${MW_ROW_LABEL}${labelExtra}">${label}</div>${bodyCell}</div>`;
}
/** Escaped prose body cell; backtick spans become styled <code> AFTER escaping,
 *  so bodies never inject unescaped HTML. */
function mwProseBody(text: string): string {
  const prose = esc(text).replace(/`([^`]+)`/g, `<code style="${MW_CODE}">$1</code>`);
  return `<div style="${MW_ROW_BODY}">${prose}</div>`;
}
/** Markdown-rendered body cell (PR summaries/impact only; todo bodies stay prose). */
function mwMdBody(body: string, markdownFn: (body: string) => string): string {
  return `<div class="cnpy-md" style="${MW_ROW_BODY}">${markdownFn(body)}</div>`;
}
/** Footer meta row closing a card (chips left, timestamp right via margin-left:auto). */
function mwFooter(inner: string, gap: number): string {
  return `<div style="margin-top:auto;padding:12px 0 2px;border-top:1px solid var(--border);display:flex;align-items:center;gap:${gap}px">${inner}</div>`;
}
/** Human-short date for a sprint due date, e.g. "Jul 20" (the same short
 *  format relTime falls back to; date-only ISO pinned to noon to dodge TZ shift). */
function mwDueDate(iso: string): string {
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00` : iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** A merged/closed PR card (option 2a): title + number pill, then the structured
 *  rows — "What changed"/"Why" from the DTO fields (pr.what/pr.why), "Impact" when
 *  present — and a footer with the MERGED/CLOSED chip + time ("· into <base>" when
 *  known). A PR with no structured summary shows a "No summary recorded"
 *  placeholder; the raw excerpt is NEVER rendered here — a prose "Summary" is the
 *  issue/todo surface (see todoCard), not the PR surface. */
export function prActivityCard(pr: MyWorkPr, markdownFn: (body: string) => string): string {
  const rows: string[] = [];
  if (pr.what !== null) {
    rows.push(mwRow("What changed", mwMdBody(pr.what, markdownFn)));
    if (pr.why) rows.push(mwRow("Why", mwMdBody(pr.why, markdownFn)));
  } else {
    rows.push(mwRow("What changed", `<div style="font-size:13.5px;color:var(--fg-55);line-height:1.6">${linkifyRefs("No summary recorded for this PR.")}</div>`));
  }
  if (pr.impact) rows.push(mwRow("Impact", mwMdBody(pr.impact, markdownFn)));
  const chip = pr.merged
    ? `<span style="font-size:9.5px;font-weight:600;font-family:var(--mono);letter-spacing:.03em;color:var(--green);border:1px solid color-mix(in srgb,var(--green) 45%,transparent);background:color-mix(in srgb,var(--green) 12%,transparent);border-radius:5px;padding:2px 6px;white-space:nowrap">MERGED</span>`
    : `<span style="font-size:9.5px;font-weight:600;font-family:var(--mono);letter-spacing:.03em;color:var(--fg-40);border:1px solid var(--border);border-radius:5px;padding:2px 6px;white-space:nowrap">CLOSED</span>`;
  const into = pr.baseRef ? ` · into <span style="font-family:var(--mono)">${esc(pr.baseRef)}</span>` : "";
  const footer = mwFooter(`${chip}<span style="font-size:11.5px;color:var(--fg-40)">${relTime(pr.occurredAt)}${into}</span>`, 9);
  return `<div class="cnpy-card" style="${MW_CARD}">
    ${mwTitleRow(pr.displayTitle ?? pr.title, pr.number, pr.url)}
    <div style="display:flex;flex-direction:column;flex:1">${rows.join("")}${footer}</div>
  </div>`;
}

/** An assigned-issue card (option 2a): title + number pill, then labeled rows —
 *  Summary (escaped prose, backtick code spans styled), Sprint (flag + title
 *  + "· due <date>"), Next step (the one accent label) — null rows collapse —
 *  and a footer with the priority chip, labels (capped at 3, existing
 *  convention) and "updated <relTime>". Only the number pill links out. */
export function todoCard(t: MyWorkTodo): string {
  const rows: string[] = [];
  if (t.summary) rows.push(mwRow("Summary", mwProseBody(t.summary)));
  if (t.sprint) {
    const due = t.sprint.dueOn ? `<span style="font-size:11.5px;color:var(--fg-40)">· due ${esc(mwDueDate(t.sprint.dueOn))}</span>` : "";
    rows.push(mwRow("Sprint", `<div style="${MW_ROW_BODY};display:flex;align-items:center;gap:8px">${MW_FLAG_SVG}<span>${esc(t.sprint.title)}</span>${due}</div>`));
  }
  if (t.nextStep) rows.push(mwRow("Next step", mwProseBody(t.nextStep), ";color:var(--accent)"));
  const prio = t.priority ? `<span style="font-family:var(--mono);font-size:10.5px;font-weight:700;color:var(--amber);border:1px solid color-mix(in srgb,var(--amber) 45%,transparent);background:color-mix(in srgb,var(--amber) 12%,transparent);border-radius:5px;padding:1px 6px">${esc(t.priority)}</span>` : "";
  const labels = t.labels.slice(0, 3).map((l) => `<span style="font-size:10.5px;color:var(--fg-40);border:1px solid var(--border);border-radius:5px;padding:1px 6px">${esc(l)}</span>`).join("");
  const footer = mwFooter(`${prio}${labels}<span style="font-size:11px;color:var(--fg-40);margin-left:auto">updated ${relTime(t.updatedAt)}</span>`, 6);
  return `<div class="cnpy-card" style="${MW_CARD}">
    ${mwTitleRow(t.displayTitle ?? t.title, t.number, t.url)}
    <div style="display:flex;flex-direction:column;flex:1">${rows.join("")}${footer}</div>
  </div>`;
}

/**
 * A ticket assigned to me, in the To-do card treatment (design call #9 / design
 * 611–637): the title, then the labeled rows — Summary (the ticket body as
 * escaped prose; the row collapses when the body is empty), Requester, Sprint
 * ("Backlog" when it has none) — and a footer with the status pill, the
 * monochrome priority chip and "updated <relTime>".
 *
 * NO NUMERIC ID is shown: a ticket's id is an internal D1 key, not something
 * people refer to a ticket by. The TITLE is the open control
 * (data-act="openTicket") — it NAVIGATES rather than linking out, because a
 * ticket is a D1 row on this origin, never a GitHub issue (ADR-007), so there is
 * no external URL to point at. That is exactly what separates this block from
 * the To-do cards above it, which keep their GitHub issue number pill.
 */
export function ticketCard(t: MyWorkTicket, personOf: (handle: string) => PersonSummary | null): string {
  const rows: string[] = [];
  if (t.body.trim()) rows.push(mwRow("Summary", mwProseBody(t.body)));
  rows.push(mwRow("Requester", `<div style="${MW_ROW_BODY};display:flex;align-items:center;gap:8px">${personChip(personOf(t.requester), 20, t.requester)}${handleTag(personOf(t.requester), t.requester, 13)}</div>`));
  rows.push(mwRow("Sprint", `<div style="${MW_ROW_BODY}">${esc(t.sprint?.label ?? "Backlog")}</div>`));
  const footer = mwFooter(
    `${ticketPill(t.status)}${priorityChip(t.priority)}<span style="font-size:11px;color:var(--fg-40);margin-left:auto;white-space:nowrap">updated ${relTime(t.updatedAt)}</span>`,
    6
  );
  return `<div class="cnpy-card" style="${MW_CARD}">
    <div style="display:flex;align-items:flex-start;gap:10px;margin-bottom:16px">
      <button data-act="openTicket" data-arg="${t.id}" style="font-size:16.5px;font-weight:600;letter-spacing:-0.01em;line-height:1.35;color:var(--fg);flex:1;min-width:0;text-align:left;background:none;padding:0;display:flex;align-items:flex-start;gap:6px"><span style="min-width:0">${esc(t.title)}</span><span style="flex:none;color:var(--accent);margin-top:3px">${MW_ARROW_SVG}</span></button>
    </div>
    <div style="display:flex;flex-direction:column;flex:1">${rows.join("")}${footer}</div>
  </div>`;
}

function myWorkView(s: AppState): string {
  const slice = s.mywork;
  if (slice.status === "loading" && !slice.data) return wrapMyWork(notice("Loading your work&hellip;"));
  if (slice.status === "error") return wrapMyWork(notice("Couldn't load your dashboard."));
  const d = slice.data;
  if (!d) return wrapMyWork(notice("Nothing to show yet."));

  const name = esc(s.displayName || s.me?.name || s.me?.handle || "there");
  const hero = `<div style="margin-bottom:24px">
    <h2 style="font-size:24px;font-weight:600;letter-spacing:-0.02em;margin:0">${greetingFor()}, ${name}</h2>
  </div>`;

  const activityBody = d.degraded
    ? mwDegradedHint("Couldn't load your recent activity right now.")
    : d.previousActivity.length === 0
      ? mwEmptyHint("No merged or closed PRs yet.")
      : `<div class="cnpy-mw-grid cnpy-stagger">${d.previousActivity.map((pr) => prActivityCard(pr, renderMarkdown)).join("")}</div>`;

  const todoBody = d.degraded
    ? mwDegradedHint("Couldn't load your to-do list right now.")
    : d.todo.length === 0
      ? mwEmptyHint("No open issues assigned to you.")
      : `<div class="cnpy-mw-grid cnpy-stagger">${d.todo.map((t) => todoCard(t)).join("")}</div>`;

  // The third block (design call #9): the org's ticket queue, filtered to what is
  // assigned to me and still open. Tickets are NEVER folded into `todo` — that
  // list is the GitHub issue surface.
  const ticketsBody = d.degraded
    ? mwDegradedHint("Couldn't load your assigned tickets right now.")
    : d.tickets.length === 0
      ? mwEmptyHint("No tickets assigned to you. The queue has what's waiting.")
      : `<div class="cnpy-mw-grid cnpy-stagger">${d.tickets.map((t) => ticketCard(t, (h) => personFor(s, h))).join("")}</div>`;

  const activity = mwSection("Previous activity", activityBody);
  const todo = mwSection("To-do", todoBody);
  const tickets = mwSection("Tickets assigned to me", ticketsBody);

  return wrapMyWork(`${hero}${todo}${activity}${tickets}`);
}

/** A list slice that hasn't produced data yet (idle/loading with nothing cached). */
function slicePending(l: Loadable<unknown[]>): boolean {
  return (l.status === "idle" || l.status === "loading") && l.data.length === 0;
}

/** Review screen with slice-level loading/error states around the pure view. */
function reviewScreen(s: AppState): string {
  if (slicePending(s.proposals) && slicePending(s.draftAdrs)) return notice("Loading review queue&hellip;");
  if (s.proposals.status === "error" && s.draftAdrs.status === "error") return notice("Couldn't load the review queue.");
  const hint = s.proposals.status === "error" ? mwDegradedHint("Couldn't load doc/decision proposals.")
    : s.draftAdrs.status === "error" ? mwDegradedHint("Couldn't load draft ADRs.")
    : "";
  return `${hint}${reviewView(reviewProps(s))}`;
}

/** Maintenance screen with slice-level loading/error states around the pure view. */
function maintenanceScreen(s: AppState): string {
  if (slicePending(s.needsTriage) && slicePending(s.identityTasks)) return notice("Loading maintenance&hellip;");
  if (s.needsTriage.status === "error" && s.identityTasks.status === "error") return notice("Couldn't load maintenance.");
  const hint = s.needsTriage.status === "error" ? mwDegradedHint("Couldn't load the triage queue.")
    : s.identityTasks.status === "error" ? mwDegradedHint("Couldn't load identity tasks.")
    : "";
  const people = s.me?.admin
    ? peopleSection({
        persons: s.persons.data,
        invites: s.invites.data,
        inviteDraft: s.inviteDraft,
        loading: s.persons.status === "loading" || s.invites.status === "loading",
        error: s.invites.error ?? null,
      })
    : "";
  const notif = s.me?.admin
    ? notificationsMaintenanceSections({
        policy: s.notifPolicy.data,
        settings: s.notifSettings.data,
        outbox: s.notifOutbox.data,
        outboxExpanded: s.outboxExpanded,
        fromDraft: s.fromDraft,
      })
    : "";
  // The maintenance view closes its own container; People + the notification
  // sections share that column, so they are spliced in before its closing tag.
  const base = maintenanceView(maintenanceProps(s));
  const cut = base.lastIndexOf("</div>");
  return `${hint}${base.slice(0, cut)}${people}${notif}${base.slice(cut)}`;
}

// ── tickets ──────────────────────────────────────────────────────────────────
/** The queue screen with slice-level loading/error states around the pure view. */
function ticketsScreen(s: AppState): string {
  if (slicePending(s.tickets)) return notice("Loading the queue&hellip;");
  if (s.tickets.status === "error") return notice("Couldn't load the ticket queue.");
  // The sprints slice is a SEPARATE fetch: when it fails the queue still renders
  // (every ticket falls into BACKLOG — `queueGroups` never drops one), but say so
  // rather than letting the grouping look like a filter bug.
  const hint = s.sprints.status === "error" ? mwDegradedHint("Couldn't load sprints — grouping by sprint is unavailable.") : "";
  return hint + queueView({
    tickets: s.tickets.data,
    sprints: s.sprints.data,
    persons: s.persons.data,
    seg: s.qSeg,
    assignee: s.qAssignee,
    category: s.qCategory,
    view: s.qView,
    unassignedCount: s.ticketBadge,
  });
}

function newTicketScreen(s: AppState): string {
  return newTicketView({
    title: s.fTitle,
    category: s.fCat,
    priority: s.fPrio,
    description: s.fDesc,
    assignees: s.fAsgs,
    link: s.fLink,
    sprintId: s.fSpr,
    sprints: s.sprints.data,
    persons: s.persons.data,
    sprMenu: s.sprMenu,
  });
}

function ticketDetailScreen(s: AppState): string {
  const slice = s.ticketDetail;
  if (slice.status === "loading" && !slice.data) return notice("Loading the ticket&hellip;");
  if (slice.status === "error") return notice("Couldn't load this ticket.");
  if (!slice.data) return notice("That ticket doesn't exist.");
  return ticketDetailView({
    ticket: slice.data,
    allTickets: s.tickets.data,
    sprints: s.sprints.data,
    persons: s.persons.data,
    commentDraft: s.commentDraft,
    mention: s.mention,
    commentHeight: s.commentHeight,
    linkDraft: s.linkDraft,
    linkOpen: s.lkOpen,
    asgMenu: s.asgMenu,
    sprMenu: s.sprMenu,
    relMenu: s.relMenu,
    stMenu: s.stMenu,
  });
}

/** The sprint screen with slice-level loading/error states around the pure view. */
function sprintScreenBody(s: AppState): string {
  const slice = s.sprintDetail;
  if ((slice.status === "loading" || slice.status === "idle") && !slice.data) return notice("Loading the sprint&hellip;");
  if (slice.status === "error") return notice("Couldn't load this sprint.");
  if (!slice.data) return notice("That sprint doesn't exist.");
  return sprintScreen({ detail: slice.data, persons: s.persons.data, resourceDraft: s.linkDraft });
}

// ── root ─────────────────────────────────────────────────────────────────────
function screenBody(s: AppState): string {
  switch (s.screen) {
    case "mywork": return myWorkView(s);
    case "feed": return feedView(s);
    case "docs": return docsView(s);
    case "roadmap": return roadmapView(s);
    case "review": return reviewScreen(s);
    case "maintenance": return maintenanceScreen(s);
    case "search": return searchView(s);
    case "settings": return settingsView(s);
    case "guide": return guideView(s);
    case "tickets": return ticketsScreen(s);
    case "newticket": return newTicketScreen(s);
    case "ticketdetail": return ticketDetailScreen(s);
    case "sprint": return sprintScreenBody(s);
    case "repo": return repoView(repoProps(s));
    default: return feedView(s);
  }
}

/** Project the app state onto the Repo dashboard's props (its components never see AppState). */
function repoProps(s: AppState): RepoProps {
  return {
    tab: s.repoTab, range: s.repoRange, driftOpen: s.repoDriftOpen, repo: s.repo, fetchedAt: s.repoFetchedAt, sample: s.repoSample,
    admin: s.me?.admin === true, poll: s.repoPoll, productEnv: s.repoProductEnv,
  };
}

// `.cnpy-shell` is the seam web/src/morph.ts looks for: inside it the <aside> is
// patched in place (so its transitions run) and <main> is swapped.
function appView(s: AppState): string {
  return `<div class="cnpy-shell" style="display:flex;height:100vh;overflow:hidden">
    ${sidebar(s)}
    <main style="flex:1;display:flex;flex-direction:column;min-width:0;background:var(--bg)">
      ${header(s)}
      <div id="cnpy-main" class="cnpy-scroll" style="flex:1;overflow-y:auto;min-height:0">${screenBody(s)}</div>
    </main>
  </div>`;
}

function toastBlock(msg: string): string {
  return `<div style="position:fixed;bottom:22px;left:50%;transform:translateX(-50%);z-index:50;display:flex;align-items:center;gap:9px;padding:10px 16px;border:1px solid var(--border-strong);border-radius:10px;background:var(--bg);box-shadow:0 8px 30px rgba(0,0,0,.35);font-size:13px;animation:cnpy-pop .25s ease both">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.4"><path d="M20 6 9 17l-5-5"></path></svg>${esc(msg)}
  </div>`;
}

// Centered modal shown for the duration of an admin Sync GitHub run (possibly
// several batched requests — src/tools/backfill.ts caps AI calls per
// invocation, shared across PRs and issues). Both counts are absolute
// snapshots from the most recent batch, not accumulated client-side, so the
// bars always reflect real server-side state.
function backfillSyncModal(sync: BackfillSyncState): string {
  const bar = (label: string, count: number, total: number) => {
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    return `
      <div style="font-size:12.5px;color:var(--fg-55);margin:0 0 6px">${count} of ${total} ${label}</div>
      <div style="height:8px;border-radius:999px;background:var(--hover);overflow:hidden;margin-bottom:14px">
        <div style="height:100%;width:${pct}%;background:var(--accent);border-radius:999px;transition:width .3s ease"></div>
      </div>`;
  };
  const body = sync.phase === "starting"
    ? `<div style="font-size:12.5px;color:var(--fg-55);line-height:1.6">Contacting GitHub — taking inventory of PRs and issues&hellip;</div>`
    : `${bar("PRs summarized", sync.prSummarizedCount, sync.prsTotal)}
      ${bar("issues summarized", sync.issueSummarizedCount, sync.issuesTotal)}`;
  return `<div style="position:fixed;inset:0;z-index:70;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55)">
    <div style="width:360px;border:1px solid var(--border-strong);border-radius:14px;padding:28px 30px;background:var(--bg);box-shadow:0 20px 60px rgba(0,0,0,.45);text-align:center">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" style="animation:cnpy-spin .8s linear infinite;margin-bottom:14px"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"></path><path d="M21 3v5h-5"></path></svg>
      <div style="font-size:15px;font-weight:600;margin-bottom:14px">Syncing GitHub</div>
      ${body}
    </div>
  </div>`;
}

export function render(s: AppState): string {
  const themeAttr = resolved(s);
  return `<div data-cnpy-theme="${themeAttr}" data-screen="${s.screen}" data-collapsed="${railCollapsed(s) ? "1" : "0"}" data-narrow="${s.narrow ? "1" : "0"}" data-author="${s.feedAuthor}" style="background:var(--bg);color:var(--fg);min-height:100vh;font-family:'Geist',system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased">
    ${s.view === "auth" ? authView(s) : s.screen === "site" ? landingView({ dark: resolved(s) !== "light", signInOpen: false, signedIn: true, seen: s.landingSeen }) : s.screen === "unsubscribe" ? unsubscribeView({ email: s.notifPrefs.data?.email ?? s.me?.handle ?? null, pending: s.unsub.pending, error: s.unsub.error }) : appView(s)}
    ${s.toast ? toastBlock(s.toast) : ""}
    ${s.backfillSync ? backfillSyncModal(s.backfillSync) : ""}
    ${s.view === "app" ? connectModal(s) : ""}
  </div>`;
}
