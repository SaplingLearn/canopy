// App entry: holds the single in-memory state, mounts the UI, dispatches DOM
// events to state changes, and loads real data per screen from the cookie-gated
// routes via ./api. Wiring proceeds screen by screen (Phase 2); unwired screens
// still render their Phase-1 mock until their task lands.

import "./canopy.css";
import { render, initialState, type AppState } from "./render";
import {
  getFeed, listDocs, getDoc, search, getRoadmap, getMyDashboard,
  completeMilestone,
  getMe, logout, mintMcpToken, adminBackfill,
  Unauthorized, NotFound, ApiError,
} from "./api";
// The Review + Maintenance surfaces are mock-driven until the backend reads
// land: their actions below mutate UI state over the mock module — no fetches.
import { MOCK_REVIEW_ITEMS, MOCK_UNPLACED, MOCK_IDENTITY, MOCK_PEOPLE } from "./triage-mock";

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
      state.mywork = { status: "ok", data };
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
    case "goReview": state.screen = "review"; break;
    case "goMaintenance": state.screen = "maintenance"; break;
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

    // ── Review (mock-driven until the backend reads land — no writes) ────────
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
      const item = MOCK_REVIEW_ITEMS.find((it) => it.id === arg);
      if (!item || state.reviewDone.includes(arg)) return;
      state.reviewDone.push(arg);
      state.reviewSel = null; // fall back to the first visible item
      if (act === "reviewAccept") {
        flash(item.kind === "decision"
          ? `Ratified — ${item.eyebrow.split(" · ")[1] ?? item.title} is now accepted`
          : `Promoted — “${item.title}” is live; previous version kept`);
      } else {
        flash("Rejected — parked, nothing changed");
      }
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
      state.backfillSync = { prSummarizedCount: 0, prsTotal: 0, issueSummarizedCount: 0, issuesTotal: 0 }; // real counts land after the first batch resolves
      rerender();
      runAdminBackfillLoop();
      return;
    }
    // ── Maintenance (mock-driven until the backend reads land — no writes) ───
    case "maintAssignToggle": {
      if (!arg) return;
      state.assignOpen = state.assignOpen === arg ? null : arg;
      state.assignKind = null;
      state.assignTarget = null;
      break;
    }
    case "maintAssignKind": if (arg) { state.assignKind = arg; state.assignTarget = null; } break;
    case "maintAssignTarget": if (arg) state.assignTarget = arg; break;
    case "maintFile": {
      if (!arg || state.assignOpen !== arg || !state.assignKind || !state.assignTarget) return;
      const item = MOCK_UNPLACED.find((u) => u.id === arg);
      if (!item || state.unplacedDone.includes(arg)) return;
      state.unplacedDone.push(arg);
      const { assignKind, assignTarget } = state;
      state.assignOpen = null; state.assignKind = null; state.assignTarget = null;
      flash(`Filed — “${item.title}” → ${assignKind} · ${assignTarget}`);
      return;
    }
    case "maintDiscard": {
      if (!arg) return;
      const item = MOCK_UNPLACED.find((u) => u.id === arg);
      if (!item || state.unplacedDone.includes(arg)) return;
      state.unplacedDone.push(arg);
      if (state.assignOpen === arg) { state.assignOpen = null; state.assignKind = null; state.assignTarget = null; }
      flash(`Discarded — “${item.title}”`);
      return;
    }
    case "identityPick": {
      if (!arg) return;
      const sep = arg.indexOf(":");
      if (sep < 0) return;
      state.mapPicks = { ...state.mapPicks, [arg.slice(0, sep)]: arg.slice(sep + 1) };
      break;
    }
    case "identityMap": {
      if (!arg) return;
      const group = MOCK_IDENTITY.find((g) => g.id === arg);
      const pick = state.mapPicks[arg];
      const person = MOCK_PEOPLE.find((p) => p.id === pick);
      if (!group || !person || state.identityDone.includes(arg)) return;
      state.identityDone.push(arg);
      flash(`Mapped — ${group.login} → ${person.name}; ${group.countNum} captured events now flow into their view`);
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
    })
    .catch(() => {
      // Unauthorized or any error → show login
      state.view = "auth";
      state.authStep = "login";
      rerender();
    });
}
