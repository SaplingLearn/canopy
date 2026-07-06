// App entry: holds the single in-memory state, mounts the UI, dispatches DOM
// events to state changes, and loads real data per screen from the cookie-gated
// routes via ./api. Wiring proceeds screen by screen (Phase 2); unwired screens
// still render their Phase-1 mock until their task lands.

import "./canopy.css";
import { render, initialState, type AppState } from "./render";
import {
  getFeed, listDocs, getDoc, search, getRoadmap, getMyDashboard,
  completeMilestone,
  listStagedProposals, listAdrs, promoteDoc, rejectDoc, ratifyAdr, rejectAdr,
  listNeedsTriage, listIdentityTasks, assignTriage, discardTriage, mapIdentity, type AssignTarget,
  getMe, logout, mintMcpToken, adminBackfill,
  Unauthorized, NotFound, ApiError,
} from "./api";
import { decodeReviewId } from "./triage-map";
// TEMPORARY design-preview mocks — delete this import (and web/src/mock.ts)
// when the structured-summary backend lands.
import { MYWORK_MOCKS_ENABLED, applyMyWorkMocks } from "./mock";

const root = document.getElementById("app");
if (!root) throw new Error("Canopy: #app mount point missing");
const mount = root;

const state: AppState = initialState();

// ── persisted client prefs (theme + sidebar only; not backend state) ─────────
try {
  const t = localStorage.getItem("canopy.theme");
  if (t === "dark" || t === "light" || t === "midnight" || t === "system") state.theme = t;
  const c = localStorage.getItem("canopy.collapsed");
  if (c) state.collapsed = c === "1";
} catch { /* localStorage unavailable */ }

if (window.matchMedia) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  state.systemDark = mq.matches;
  const onChange = (ev: MediaQueryListEvent) => { state.systemDark = ev.matches; rerender(); };
  if (mq.addEventListener) mq.addEventListener("change", onChange);
  else mq.addListener(onChange);
}

// ── render with focus/caret preservation for the two live text inputs ────────
function rerender(): void {
  const active = document.activeElement as HTMLElement | null;
  const field = active?.getAttribute?.("data-field") ?? null;
  let selStart = 0;
  let selEnd = 0;
  if (field && active instanceof HTMLInputElement) {
    selStart = active.selectionStart ?? 0;
    selEnd = active.selectionEnd ?? 0;
  }
  mount.innerHTML = render(state);
  if (field) {
    const el = mount.querySelector<HTMLInputElement>(`[data-field="${field}"]`);
    if (el) {
      el.focus();
      try { el.setSelectionRange(selStart, selEnd); } catch { /* non-text input */ }
    }
  }
}

function resolvedTheme(): "dark" | "light" | "midnight" {
  return state.theme === "system" ? (state.systemDark ? "dark" : "light") : state.theme;
}
function persist(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

// ── per-screen data loaders ──────────────────────────────────────────────────
function loadFeed(): void {
  state.feed = { status: "loading", data: state.feed.data };
  rerender();
  const author = state.feedAuthor !== "all" ? state.feedAuthor : undefined;
  const tags = state.feedTag !== "all" ? [state.feedTag] : undefined;
  getFeed({ author, tags })
    .then((rows) => {
      state.feed = { status: "ok", data: rows };
      // Capture the author chip set only from the unfiltered view, so filtering doesn't shrink it.
      if (!author && !tags) state.feedAuthors = [...new Set(rows.map((r) => r.author))];
      rerender();
    })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      state.feed = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}
function loadFeedIfNeeded(): void {
  if (state.feed.status === "idle") loadFeed();
  else rerender();
}

function loadMyWork(): void {
  state.mywork = { status: "loading", data: state.mywork.data };
  rerender();
  getMyDashboard()
    .then((data) => {
      // TEMPORARY: decorate with design-preview mocks (web/src/mock.ts) — the
      // ONE call site to delete when the structured-summary backend lands.
      state.mywork = { status: "ok", data: MYWORK_MOCKS_ENABLED ? applyMyWorkMocks(data) : data };
      rerender();
    })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      state.mywork = { status: "error", data: null, error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}
function loadMyWorkIfNeeded(): void {
  if (state.mywork.status === "idle") loadMyWork();
  else rerender();
}

function loadDoc(slug: string): void {
  state.docDetail = { status: "loading", data: null };
  rerender();
  getDoc(slug)
    .then((result) => {
      state.docDetail = { status: "ok", data: result };
      state.docSpace = result.doc.space === "sapling" ? "sapling" : "canopy";
      rerender();
    })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      if (e instanceof NotFound) { state.docDetail = { status: "ok", data: null }; rerender(); return; }
      state.docDetail = { status: "error", data: null, error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}

function loadDocs(): void {
  state.docsList = { status: "loading", data: state.docsList.data };
  rerender();
  listDocs()
    .then((docs) => {
      state.docsList = { status: "ok", data: docs };
      const first = docs.find((d) => d.space === state.docSpace) ?? docs[0];
      if (state.docSlug === null && first) {
        state.docSlug = first.slug;
        loadDoc(first.slug);
      } else {
        rerender();
      }
    })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      state.docsList = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}

function loadDocsIfNeeded(): void {
  if (state.docsList.status === "idle") loadDocs();
  else rerender();
}

let searchDebounce: ReturnType<typeof setTimeout> | null = null;

const EMPTY_QUERY_RESULT = { primary: [], pointers: [], meta: { engine: "fts5" as const, total: 0 } };

function loadSearch(): void {
  state.searchResults = { status: "loading", data: state.searchResults.data };
  rerender();
  search(state.searchQuery)
    .then((result) => {
      state.searchResults = { status: "ok", data: result };
      rerender();
    })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      state.searchResults = { status: "error", data: EMPTY_QUERY_RESULT, error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}

function loadSearchIfNeeded(): void {
  if (state.searchResults.status === "idle") loadSearch();
  else rerender();
}

function loadRoadmap(): void {
  state.roadmap = { status: "loading", data: state.roadmap.data };
  rerender();
  getRoadmap()
    .then((planView) => {
      state.roadmap = { status: "ok", data: planView };
      rerender();
    })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      state.roadmap = {
        status: "error",
        data: { narrative: "", version: 0, updated_at: null, updated_by: null, milestones: [] },
        error: e instanceof Error ? e.message : String(e),
      };
      rerender();
    });
}

function loadRoadmapIfNeeded(): void {
  if (state.roadmap.status === "idle") loadRoadmap();
  else rerender();
}

// Write-completion handlers refetch the triage slices directly (not via
// IfNeeded), so two loads of the same slice can overlap; the seq guard lets
// only the newest in-flight request commit, so a slow earlier response can't
// overwrite fresher data.
let proposalsSeq = 0;
function loadProposals(): void {
  const seq = ++proposalsSeq;
  state.proposals = { status: "loading", data: state.proposals.data };
  rerender();
  listStagedProposals()
    .then((rows) => { if (seq !== proposalsSeq) return; state.proposals = { status: "ok", data: rows }; rerender(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      if (seq !== proposalsSeq) return;
      state.proposals = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}
function loadProposalsIfNeeded(): void {
  if (state.proposals.status === "idle" || state.proposals.status === "error") loadProposals();
  else rerender();
}

let draftAdrsSeq = 0;
function loadDraftAdrs(): void {
  const seq = ++draftAdrsSeq;
  state.draftAdrs = { status: "loading", data: state.draftAdrs.data };
  rerender();
  listAdrs("draft")
    .then((rows) => { if (seq !== draftAdrsSeq) return; state.draftAdrs = { status: "ok", data: rows }; rerender(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      if (seq !== draftAdrsSeq) return;
      state.draftAdrs = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}
function loadDraftAdrsIfNeeded(): void {
  if (state.draftAdrs.status === "idle" || state.draftAdrs.status === "error") loadDraftAdrs();
  else rerender();
}

let needsTriageSeq = 0;
function loadNeedsTriage(): void {
  const seq = ++needsTriageSeq;
  state.needsTriage = { status: "loading", data: state.needsTriage.data };
  rerender();
  listNeedsTriage()
    .then((rows) => { if (seq !== needsTriageSeq) return; state.needsTriage = { status: "ok", data: rows }; rerender(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      if (seq !== needsTriageSeq) return;
      state.needsTriage = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}
function loadNeedsTriageIfNeeded(): void {
  if (state.needsTriage.status === "idle" || state.needsTriage.status === "error") loadNeedsTriage();
  else rerender();
}

let identityTasksSeq = 0;
function loadIdentityTasks(): void {
  const seq = ++identityTasksSeq;
  state.identityTasks = { status: "loading", data: state.identityTasks.data };
  rerender();
  listIdentityTasks()
    .then((rows) => { if (seq !== identityTasksSeq) return; state.identityTasks = { status: "ok", data: rows }; rerender(); })
    .catch((e) => {
      if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
      if (seq !== identityTasksSeq) return;
      state.identityTasks = { status: "error", data: [], error: e instanceof Error ? e.message : String(e) };
      rerender();
    });
}
function loadIdentityTasksIfNeeded(): void {
  if (state.identityTasks.status === "idle" || state.identityTasks.status === "error") loadIdentityTasks();
  else rerender();
}

function flash(msg: string): void {
  state.toast = msg;
  rerender();
  setTimeout(() => { state.toast = null; rerender(); }, 2200);
}

// Drives a (possibly multi-batch) Sync GitHub run: the backend caps AI calls
// per invocation (src/tools/backfill.ts's summaryBudgetExhausted), so this
// keeps calling adminBackfill() while a budget was exhausted, updating
// state.backfillSync after every batch — both PR and issue counts are
// absolute snapshots from the response, not accumulated here, so the modal's
// progress bars always reflect real server-side state. MAX_BACKFILL_BATCHES
// is a client-side backstop against spinning forever if summaries never
// converge (e.g. every AI call keeps falling back to excerpt).
const MAX_BACKFILL_BATCHES = 10;

async function runAdminBackfillLoop(): Promise<void> {
  let summarizedSoFar = 0;
  let batchesSoFar = 0;
  let last: Awaited<ReturnType<typeof adminBackfill>> | null = null;
  try {
    do {
      last = await adminBackfill();
      batchesSoFar++;
      summarizedSoFar += last.summarized;
      state.backfillSync = {
        phase: "progress",
        prSummarizedCount: last.prSummarizedCount,
        prsTotal: last.prs,
        issueSummarizedCount: last.issueSummarizedCount,
        issuesTotal: last.issuesToSummarize,
      };
      rerender();
    } while (last.summaryBudgetExhausted && batchesSoFar < MAX_BACKFILL_BATCHES);

    state.backfillSync = null;
    const more = last.summaryBudgetExhausted ? " — more remain, click Sync again" : "";
    flash(`Synced: ${last.captured} captured, ${last.unchanged} unchanged, ${summarizedSoFar} summaries updated${more}`);
    loadMyWork();
  } catch (e) {
    state.backfillSync = null;
    if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
    flash(e instanceof ApiError ? e.message : "Sync failed");
    rerender();
  }
}

// Copy text to the clipboard. Prefers the async Clipboard API (available on
// localhost + https); falls back to a hidden-textarea execCommand for older or
// non-secure contexts. Resolves to whether the copy succeeded.
function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => fallbackCopy(text));
  }
  return Promise.resolve(fallbackCopy(text));
}

function fallbackCopy(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// ── action dispatch ──────────────────────────────────────────────────────────
function dispatch(act: string, arg: string | null, value: string | null): void {
  switch (act) {
    // auth state navigation (how the screens become reachable)
    case "signIn":
      window.location.href = "/auth/login";
      return;
    case "previewNonMember": state.authStep = "nonmember"; break;
    case "backToLogin":
      state.authStep = "login";
      history.replaceState({}, "", "/");
      break;
    case "signOut":
      logout()
        .then(() => { state.me = null; state.view = "auth"; state.authStep = "login"; rerender(); })
        .catch(() => { state.view = "auth"; state.authStep = "login"; rerender(); });
      return;

    // primary navigation
    case "goMyWork": state.screen = "mywork"; loadMyWorkIfNeeded(); return;
    case "goFeed": state.screen = "feed"; loadFeedIfNeeded(); return;
    case "goDocs": state.screen = "docs"; loadDocsIfNeeded(); return;
    case "goRoadmap": state.screen = "roadmap"; loadRoadmapIfNeeded(); loadFeedIfNeeded(); return;

    // roadmap tab toggle
    case "roadmapNarrative": state.roadmapTab = "narrative"; break;
    case "roadmapTimeline": state.roadmapTab = "timeline"; break;
    case "goReview": state.screen = "review"; loadProposalsIfNeeded(); loadDraftAdrsIfNeeded(); return;
    case "goMaintenance": state.screen = "maintenance"; loadNeedsTriageIfNeeded(); loadIdentityTasksIfNeeded(); loadFeedIfNeeded(); return;
    case "goSearch": state.screen = "search"; loadSearchIfNeeded(); return;
    case "goSettings": state.screen = "settings"; break;
    case "goGuide": state.screen = "guide"; break;

    // chrome: theme + sidebar
    case "toggleCollapse":
      state.collapsed = !state.collapsed;
      persist("canopy.collapsed", state.collapsed ? "1" : "0");
      break;
    case "cycleTheme": {
      // header button steps through the three concrete themes; settings can also pick "system".
      const order = ["light", "dark", "midnight"] as const;
      const next = order[(order.indexOf(resolvedTheme()) + 1) % order.length];
      state.theme = next;
      persist("canopy.theme", next);
      break;
    }
    case "setTheme":
      if (arg === "dark" || arg === "light" || arg === "midnight" || arg === "system") {
        state.theme = arg;
        persist("canopy.theme", arg);
      }
      break;

    // feed filters
    case "setAuthor": state.feedAuthor = arg ?? "all"; loadFeed(); return;
    case "clearAuthor": state.feedAuthor = "all"; loadFeed(); return;
    case "setTag": state.feedTag = value ?? "all"; loadFeed(); return;
    case "setRange": state.feedRange = value ?? "all"; break;

    // ── Review (wired: real proposals + draft ADR reads, real verdict writes) ──
    case "reviewSelect": if (arg) state.reviewSel = arg; break;
    case "reviewFilter":
      if (arg === "all" || arg === "proposal" || arg === "decision") state.reviewFilter = arg;
      break;
    case "reviewDiffView":
      if (arg === "unified" || arg === "split" || arg === "rendered") state.reviewDiffView = arg;
      break;
    case "reviewAccept":
    case "reviewReject": {
      if (!arg) return;
      const ref = decodeReviewId(arg);
      if (!ref) return;
      const accept = act === "reviewAccept";
      const op = ref.kind === "doc"
        ? (accept ? promoteDoc(ref.slug, ref.version) : rejectDoc(ref.slug, ref.version))
        : (accept ? ratifyAdr(ref.id) : rejectAdr(ref.id));
      op.then(() => {
          state.reviewSel = null; // fall back to the first visible item
          flash(accept
            ? (ref.kind === "adr" ? "Ratified — the decision is now accepted" : "Promoted — the proposal is live; previous version kept")
            : "Rejected — parked, nothing changed");
          // Refetch the affected list — never locally decrement (badge drift is worse).
          if (ref.kind === "doc") loadProposals();
          else loadDraftAdrs();
        })
        .catch((e) => {
          if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
          flash(e instanceof ApiError ? e.message : "Action failed");
        });
      return;
    }

    // docs navigation
    case "openDoc":
      if (arg) { state.docSlug = arg; state.showHistory = false; loadDoc(arg); }
      return;
    case "openDocFrom":
      if (arg) { state.screen = "docs"; state.docSlug = arg; state.showHistory = false; loadDocsIfNeeded(); loadDoc(arg); }
      return;
    case "setDocSpace": {
      const sp = arg === "sapling" ? "sapling" : "canopy";
      state.docSpace = sp;
      state.showHistory = false;
      const first = state.docsList.data.find((d) => d.space === sp);
      if (first) { state.docSlug = first.slug; loadDoc(first.slug); }
      else { state.docSlug = null; state.docDetail = { status: "ok", data: null }; rerender(); }
      return;
    }
    case "toggleHistory": state.showHistory = !state.showHistory; break;

    // search
    case "setSearch":
      state.searchQuery = value ?? "";
      if (searchDebounce !== null) clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => { searchDebounce = null; loadSearch(); }, 250);
      rerender();
      return;
    case "setSearchType":
      if (arg === "all" || arg === "doc" || arg === "feed" || arg === "decision") state.searchType = arg;
      break;

    // settings — display name echoes live; everything else is Phase 2
    case "setDisplayName": state.displayName = value ?? ""; break;

    case "confirmMilestone": {
      if (!arg) return;
      completeMilestone(Number(arg))
        .then(() => { flash("Milestone marked done"); loadRoadmap(); })
        .catch((e) => {
          if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
          flash(e instanceof ApiError ? e.message : "Could not complete milestone");
        });
      return;
    }
    // ADMIN action (My Work): trigger the server-side GitHub backfill, then
    // refresh My Work so newly-captured PRs/issues surface in the two lists.
    case "adminBackfill": {
      if (state.backfillSync) return; // already syncing — button is disabled, but guard duplicate dispatch too
      state.backfillSync = { phase: "starting" }; // no real counts until the first batch resolves — the modal shows an inventory-taking line, never "0 of 0"
      rerender();
      runAdminBackfillLoop();
      return;
    }
    // ── Maintenance (mock-driven until the backend reads land — no writes) ───
    case "maintAssignToggle": {
      if (!arg) return;
      state.assignOpen = state.assignOpen === arg ? null : arg;
      state.assignKind = null;
      state.assignSection = null;
      state.assignSpace = null;
      state.assignTags = [];
      break;
    }
    case "maintAssignKind":
      if (arg === "doc" || arg === "adr" || arg === "milestone" || arg === "feed") {
        state.assignKind = arg;
        state.assignSection = null;
        state.assignSpace = null;
        state.assignTags = [];
      }
      break;
    case "maintAssignSection": if (arg) state.assignSection = arg; break;
    case "maintAssignSpace": if (arg) state.assignSpace = state.assignSpace === arg ? null : arg; break;
    case "maintAssignTag":
      if (arg) state.assignTags = state.assignTags.includes(arg) ? state.assignTags.filter((t) => t !== arg) : [...state.assignTags, arg];
      break;
    case "maintFile": {
      if (!arg || state.assignOpen !== arg || !state.assignKind) return;
      if (state.assignKind === "doc" && !state.assignSection) return;
      const id = Number(arg);
      if (!Number.isInteger(id)) return;
      const kind = state.assignKind;
      const target: AssignTarget = { type: kind };
      if (kind === "doc") {
        target.section = state.assignSection ?? undefined;
        target.space = state.assignSpace === "sapling" || state.assignSpace === "canopy" ? state.assignSpace : undefined;
      }
      if (kind === "feed") target.tags = state.assignTags;
      assignTriage(id, target)
        .then(() => {
          state.assignOpen = null; state.assignKind = null; state.assignSection = null; state.assignSpace = null; state.assignTags = [];
          flash("Filed — placed through the gate and resolved");
          loadNeedsTriage();
          if (kind === "doc") loadProposals();   // an assigned doc lands as a staged proposal
          if (kind === "adr") loadDraftAdrs();   // an assigned decision lands as a draft
          if (kind === "feed") loadFeed();   // a filed feed entry lands live on the Feed screen
        })
        .catch((e) => {
          if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
          // e.g. "cannot assign a free-form triage item; discard it instead" — verbatim from the gate
          flash(e instanceof ApiError ? e.message : "Could not file this item");
        });
      return;
    }
    case "maintDiscard": {
      if (!arg) return;
      const id = Number(arg);
      if (!Number.isInteger(id)) return;
      if (state.assignOpen === arg) { state.assignOpen = null; state.assignKind = null; state.assignSection = null; state.assignSpace = null; state.assignTags = []; }
      discardTriage(id)
        .then(() => { flash("Discarded — parked, nothing changed"); loadNeedsTriage(); })
        .catch((e) => {
          if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
          flash(e instanceof ApiError ? e.message : "Could not discard");
        });
      return;
    }
    case "identityPick": {
      if (!arg) return;
      const sep = arg.indexOf(":");
      if (sep < 0) return;
      const login = arg.slice(0, sep);
      state.mapPicks = { ...state.mapPicks, [login]: arg.slice(sep + 1) };
      if (state.mapConfirm === login) state.mapConfirm = null; // changing the pick re-arms the confirm
      break;
    }
    case "identityMap": {
      if (!arg) return;
      const person = state.mapPicks[arg];
      if (!person) return;                                              // no auto-select: a person must be picked
      if (state.mapConfirm !== arg) { state.mapConfirm = arg; break; }  // step 1: show the concrete effect
      state.mapConfirm = null;
      mapIdentity(arg, person)
        .then(() => {
          flash(`Mapped — ${arg} → ${person}; their captured activity is now attributed`);
          loadIdentityTasks();
        })
        .catch((e) => {
          if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
          flash(e instanceof ApiError ? e.message : "Could not map login");
        });
      return;
    }
    // ── Settings ─────────────────────────────────────────────────────────────
    case "mintToken":
      mintMcpToken()
        .then(({ token }) => { state.revealedToken = token; state.tokenCopied = false; rerender(); })
        .catch((e) => {
          if (e instanceof Unauthorized) { state.view = "auth"; state.authStep = "login"; rerender(); return; }
          flash(e instanceof ApiError ? e.message : "Could not mint token");
        });
      return;
    case "copyToken": {
      const tk = state.revealedToken;
      if (!tk) return;
      copyToClipboard(tk).then((ok) => {
        if (!ok) { flash("Couldn't copy — select the token and copy it manually"); return; }
        state.tokenCopied = true;
        rerender();
        flash("Token copied to clipboard");
        setTimeout(() => { state.tokenCopied = false; rerender(); }, 1800);
      });
      return;
    }
    case "dismissReveal": state.revealedToken = null; state.tokenCopied = false; break;
    // INERT — no backend route for saving display name or revoking tokens
    case "saveProfile": return;
    case "revokeToken": return;

    default:
      return;
  }
  rerender();
}

// Clicks drive buttons; selects/inputs are handled by change/input so their
// native interaction (dropdown open, typing) is preserved. Anchors keep their
// default behavior (open the GitHub link in a new tab).
mount.addEventListener("click", (e) => {
  const target = e.target as Element;
  if (target.closest("input, select, a[href]")) return;
  const el = target.closest<HTMLElement>("[data-act]");
  if (!el) return;
  dispatch(el.dataset.act ?? "", el.dataset.arg ?? null, null);
});

mount.addEventListener("change", (e) => {
  const el = e.target as HTMLElement;
  if (el instanceof HTMLSelectElement && el.dataset.act) {
    dispatch(el.dataset.act, el.dataset.arg ?? null, el.value);
  }
});

mount.addEventListener("input", (e) => {
  const el = e.target as HTMLElement;
  if (el instanceof HTMLInputElement && el.dataset.act) {
    dispatch(el.dataset.act, el.dataset.arg ?? null, el.value);
  }
});

// ── boot: detect session via /auth/me ────────────────────────────────────────
if (new URLSearchParams(location.search).get("denied") === "1") {
  // Non-member: /auth/callback redirected here after org check failed
  state.view = "auth";
  state.authStep = "nonmember";
  rerender();
} else {
  // Show "verifying" while we check if a session cookie exists
  state.view = "auth";
  state.authStep = "verifying";
  rerender();
  getMe()
    .then((me) => {
      state.me = me;
      state.displayName = me.name ?? me.login;
      state.view = "app";
      loadMyWork();
      // Boot-time loads for the sidebar triage badges — the counts must be
      // right on every screen, not just after visiting Review/Maintenance.
      loadProposals();
      loadDraftAdrs();
      loadNeedsTriage();
      loadIdentityTasks();
    })
    .catch(() => {
      // Unauthorized or any error → show login
      state.view = "auth";
      state.authStep = "login";
      rerender();
    });
}
