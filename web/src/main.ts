// Phase 1 entry: holds the single in-memory state, mounts the static UI, and
// dispatches DOM events to state changes. Mirrors the dc-runtime component's
// state model. NO fetches, NO routes, NO @shared — navigation + visual state
// only; consequential write actions (promote/ratify/mint/…) are intentionally
// inert (Phase 2 wires them to the real backend).

import "./canopy.css";
import { render, initialState, type AppState } from "./render";

const root = document.getElementById("app");
if (!root) throw new Error("Canopy: #app mount point missing");
const mount = root;

const state: AppState = initialState();

// ── persisted client prefs (theme + sidebar only; not backend state) ─────────
try {
  const t = localStorage.getItem("canopy.theme");
  if (t === "dark" || t === "light" || t === "system") state.theme = t;
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

function resolvedTheme(): "dark" | "light" {
  return state.theme === "system" ? (state.systemDark ? "dark" : "light") : state.theme;
}
function persist(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* ignore */ }
}

// ── action dispatch ──────────────────────────────────────────────────────────
function dispatch(act: string, arg: string | null, value: string | null): void {
  switch (act) {
    // auth state navigation (how the screens become reachable)
    case "signIn":
      state.authStep = "verifying";
      rerender();
      window.setTimeout(() => { state.view = "app"; state.authStep = "login"; rerender(); }, 1000);
      return;
    case "previewNonMember": state.authStep = "nonmember"; break;
    case "backToLogin": state.authStep = "login"; break;
    case "signOut": state.view = "auth"; state.authStep = "login"; break;

    // primary navigation
    case "goFeed": state.screen = "feed"; break;
    case "goDocs": state.screen = "docs"; break;
    case "goRoadmap": state.screen = "roadmap"; break;
    case "goTriage": state.screen = "triage"; break;
    case "goSearch": state.screen = "search"; break;
    case "goSettings": state.screen = "settings"; break;

    // chrome: theme + sidebar
    case "toggleCollapse":
      state.collapsed = !state.collapsed;
      persist("canopy.collapsed", state.collapsed ? "1" : "0");
      break;
    case "cycleTheme": {
      const next = resolvedTheme() === "dark" ? "light" : "dark";
      state.theme = next;
      persist("canopy.theme", next);
      break;
    }
    case "setTheme":
      if (arg === "dark" || arg === "light" || arg === "system") {
        state.theme = arg;
        persist("canopy.theme", arg);
      }
      break;

    // feed filters
    case "setAuthor": state.feedAuthor = arg ?? "all"; break;
    case "clearAuthor": state.feedAuthor = "all"; break;
    case "setTag": state.feedTag = value ?? "all"; break;
    case "setRange": state.feedRange = value ?? "all"; break;

    // triage navigation (browse the queues — no writes)
    case "queueProposals": state.triageQueue = "proposals"; break;
    case "queueDecisions": state.triageQueue = "decisions"; break;
    case "queueTriage": state.triageQueue = "triage"; break;
    case "selectItem":
      if (arg) {
        if (state.triageQueue === "proposals") state.selProposal = arg;
        else if (state.triageQueue === "decisions") state.selDecision = arg;
        else state.selTriage = arg;
      }
      break;

    // docs navigation
    case "openDoc": if (arg) { state.docId = arg; state.showHistory = false; } break;
    case "openDocFrom": if (arg) { state.screen = "docs"; state.docId = arg; state.showHistory = false; } break;
    case "toggleHistory": state.showHistory = !state.showHistory; break;
    case "gotoTriage": state.screen = "triage"; state.triageQueue = "proposals"; break;

    // search
    case "setSearch": state.searchQuery = value ?? ""; break;
    case "setSearchType":
      if (arg === "all" || arg === "doc" || arg === "feed" || arg === "decision") state.searchType = arg;
      break;

    // settings — display name echoes live; everything else is Phase 2
    case "setDisplayName": state.displayName = value ?? ""; break;

    // roadmap tabs
    case "roadmapNarrative": state.screen = "roadmap"; state.roadmapTab = "narrative"; break;
    case "roadmapTimeline": state.screen = "roadmap"; state.roadmapTab = "timeline"; break;

    // ── Phase 2 (intentionally inert in Phase 1 — static affordances only) ──
    case "promote":
    case "dismissProposal":
    case "dismissDecision":
    case "ratify":
    case "assignItem":
    case "discardItem":
    case "confirmMilestone":
    case "mintToken":
    case "dismissReveal":
    case "revokeToken":
    case "saveProfile":
      return; // render nothing new

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

rerender();
