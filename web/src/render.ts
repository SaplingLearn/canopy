// Faithful static port of Canopy.dc.html — markup + inline styles transcribed
// from the dc-runtime template (lines 53–731), with `sc-for` resolved to
// `.map().join('')`, `sc-if` to ternaries, and `onClick="{{ fn }}"` to
// `data-act` / `data-arg` attributes dispatched in main.ts.

import type { Me } from "./api";
import type { FeedRow, DocRow, DocVersionRow } from "@shared/rows";
import type { SearchResult, MilestoneWithProgress, StagedProposal } from "./api";
import type { AdrRow, NeedsTriageRow } from "@shared/rows";
import { TAGS } from "@shared/vocabulary";
import { renderMarkdown } from "./markdown";

export type DocSpace = "canopy" | "sapling";

export type Screen = "feed" | "docs" | "roadmap" | "triage" | "search" | "settings";

/** Async data slice: a screen's fetched payload plus its load status. */
export interface Loadable<T> {
  status: "idle" | "loading" | "ok" | "error" | "unauth";
  data: T;
  error?: string;
}

export interface AppState {
  view: "auth" | "app";
  authStep: "login" | "verifying" | "nonmember";
  me: Me | null;
  screen: Screen;
  theme: "dark" | "light" | "system";
  systemDark: boolean;
  collapsed: boolean;
  feedAuthor: string;
  feedTag: string;
  feedRange: string;
  feed: Loadable<FeedRow[]>;
  feedAuthors: string[];
  docsList: Loadable<DocRow[]>;
  docDetail: Loadable<{ doc: DocRow; versions: DocVersionRow[] } | null>;
  docSlug: string | null;
  docSpace: DocSpace;
  triageQueue: "proposals" | "decisions" | "triage";
  roadmapTab: "narrative" | "timeline";
  roadmap: Loadable<MilestoneWithProgress[]>;
  selProposal: string | null;
  selDecision: number | null;
  selTriage: number | null;
  showHistory: boolean;
  searchQuery: string;
  searchType: "all" | "doc" | "feed" | "adr";
  searchResults: Loadable<SearchResult[]>;
  displayName: string;
  revealedToken: string | null;
  confirmedMilestones: Record<string, boolean>;
  toast: string | null;
  proposals: Loadable<StagedProposal[]>;
  decisions: Loadable<AdrRow[]>;
  triageItems: Loadable<NeedsTriageRow[]>;
}

export function initialState(): AppState {
  return {
    view: "auth", authStep: "login",
    me: null,
    screen: "feed",
    theme: "dark", systemDark: true,
    collapsed: false,
    feedAuthor: "all", feedTag: "all", feedRange: "all",
    feed: { status: "idle", data: [] },
    feedAuthors: [],
    docsList: { status: "idle", data: [] },
    docDetail: { status: "idle", data: null },
    docSlug: null,
    docSpace: "sapling",
    triageQueue: "proposals",
    roadmapTab: "timeline",
    roadmap: { status: "idle", data: [] },
    selProposal: null, selDecision: null, selTriage: null,
    showHistory: false,
    searchQuery: "token", searchType: "all",
    searchResults: { status: "idle", data: [] },
    displayName: "",
    revealedToken: null,
    confirmedMilestones: {},
    toast: null,
    proposals: { status: "idle", data: [] },
    decisions: { status: "idle", data: [] },
    triageItems: { status: "idle", data: [] },
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────
function resolved(s: AppState): "dark" | "light" {
  return s.theme === "system" ? (s.systemDark ? "dark" : "light") : s.theme;
}
/** Escape text content for safe insertion into innerHTML. */
function esc(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
/** Escape a value for use inside an HTML attribute (delegates to esc for full safety). */
function attr(v: string): string {
  return esc(v);
}
const AVATAR = "border:1px solid var(--border-strong);background:color-mix(in srgb,var(--fg) 7%,transparent);display:grid;place-items:center";

function logo(size: number): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" style="flex:none"><rect x="2" y="4.5" width="20" height="3.4" rx="1.7" fill="var(--accent)"></rect><rect x="5" y="10.3" width="14" height="3.4" rx="1.7" fill="currentColor"></rect><rect x="8" y="16.1" width="8" height="3.4" rx="1.7" fill="currentColor" opacity="0.5"></rect></svg>`;
}

// ── real-data helpers (authors are github logins; no curated display map) ─────
const REPO_URL = "https://github.com/SaplingLearn/canopy";
/** Two-letter avatar initials from a github login, e.g. "jose-a" → "JO". */
function initialsOf(login: string): string {
  const letters = login.replace(/[^a-zA-Z]/g, "");
  return (letters.slice(0, 2) || login.slice(0, 2) || "?").toUpperCase();
}
/** Relative time from an ISO timestamp, e.g. "32m ago" / "2d ago". */
function relTime(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
/** Parse the feed row's artifacts JSON ({prs,commits,issues}) into render-ready chips. */
function feedArtifacts(json: string | null): { kind: string; label: string; href: string }[] {
  if (!json) return [];
  let a: { prs?: string[]; commits?: string[]; issues?: number[] };
  try { a = JSON.parse(json); } catch { return []; }
  const out: { kind: string; label: string; href: string }[] = [];
  for (const pr of a.prs ?? []) out.push({ kind: "PR", label: `#${pr}`, href: `${REPO_URL}/pull/${pr}` });
  for (const c of a.commits ?? []) out.push({ kind: "commit", label: c, href: `${REPO_URL}/commit/${c}` });
  for (const i of a.issues ?? []) out.push({ kind: "issue", label: `#${i}`, href: `${REPO_URL}/issues/${i}` });
  return out;
}
/** Centered muted notice reused for loading / error states (no layout change). */
function notice(text: string): string {
  return `<div style="text-align:center;padding:60px;color:var(--fg-40);font-size:13px">${text}</div>`;
}

// ── auth states ──────────────────────────────────────────────────────────────
function authView(s: AppState): string {
  return `<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px">
    ${s.authStep === "login" ? loginCard() : ""}
    ${s.authStep === "nonmember" ? nonmemberCard() : ""}
    ${s.authStep === "verifying" ? verifyingCard() : ""}
  </div>`;
}

function loginCard(): string {
  return `<div style="width:380px">
    <div style="display:flex;flex-direction:column;align-items:center;gap:0;margin-bottom:40px">
      <div style="display:flex;align-items:center;gap:11px">
        ${logo(30)}
        <span style="font-size:25px;font-weight:600;letter-spacing:-0.02em">Canopy</span>
      </div>
    </div>
    <div style="border:1px solid var(--border);border-radius:14px;padding:30px;display:flex;flex-direction:column;gap:20px;background:var(--bg)">
      <div style="font-size:14px;color:var(--fg-70);text-align:center;line-height:1.55">Sign in to continue to the Sapling team workspace.</div>
      <button data-act="signIn" class="cnpy-accentbtn" style="display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:12px 16px;border-radius:9px;background:var(--accent);color:var(--accent-fg);font-size:14px;font-weight:600">
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .5C5.37.5 0 5.78 0 12.29c0 5.2 3.44 9.6 8.21 11.16.6.11.82-.26.82-.58 0-.29-.01-1.04-.02-2.05-3.34.72-4.04-1.61-4.04-1.61-.55-1.38-1.34-1.75-1.34-1.75-1.09-.74.08-.73.08-.73 1.2.08 1.84 1.23 1.84 1.23 1.07 1.83 2.81 1.3 3.49.99.11-.77.42-1.3.76-1.6-2.67-.3-5.47-1.32-5.47-5.87 0-1.3.47-2.36 1.23-3.19-.12-.3-.53-1.51.12-3.15 0 0 1.01-.32 3.3 1.22a11.5 11.5 0 0 1 6 0c2.29-1.54 3.3-1.22 3.3-1.22.65 1.64.24 2.85.12 3.15.77.83 1.23 1.89 1.23 3.19 0 4.56-2.81 5.57-5.49 5.86.43.37.81 1.1.81 2.22 0 1.6-.01 2.89-.01 3.29 0 .32.22.7.83.58A12.01 12.01 0 0 0 24 12.29C24 5.78 18.63.5 12 .5z"></path></svg>
        Sign in with GitHub
      </button>
    </div>
    <div style="text-align:center;margin-top:22px;font-size:12.5px;color:var(--fg-40);line-height:1.5">The shared source of truth for the Sapling team.</div>
    <div style="text-align:center;margin-top:18px"><button data-act="previewNonMember" class="cnpy-mutelink" style="font-size:11.5px;color:var(--fg-40);text-decoration:underline;text-underline-offset:3px">Preview the non-member screen</button></div>
  </div>`;
}

function nonmemberCard(): string {
  return `<div style="width:400px">
    <div style="border:1px solid var(--border);border-radius:14px;padding:34px;display:flex;flex-direction:column;align-items:center;gap:20px;text-align:center">
      <div style="width:52px;height:52px;border-radius:50%;border:1px solid var(--border-strong);display:grid;place-items:center;color:var(--fg-55)">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V8a4 4 0 0 1 8 0v3"></path></svg>
      </div>
      <div>
        <div style="font-size:18px;font-weight:600;letter-spacing:-0.01em">Canopy is limited to the Sapling team.</div>
        <div style="font-size:13.5px;color:var(--fg-55);margin-top:8px;line-height:1.55">Your GitHub account isn't a member of the <span style="font-family:var(--mono);font-size:12.5px">SaplingLearn</span> organization, so there's nothing here for you yet.</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;padding:9px 14px 9px 9px;border:1px solid var(--border);border-radius:999px">
        <div style="width:26px;height:26px;border-radius:50%;${AVATAR};font-size:10px;font-weight:600;color:var(--fg-70)">OS</div>
        <div style="text-align:left;line-height:1.25;white-space:nowrap"><div style="font-size:12.5px;font-weight:500">Signed in as</div><div style="font-size:11.5px;color:var(--fg-55);font-family:var(--mono)">octo-stranger</div></div>
      </div>
      <button data-act="backToLogin" class="cnpy-outlinebtn" style="width:100%;padding:11px 16px;border-radius:9px;border:1px solid var(--border-strong);font-size:13.5px;font-weight:500">Sign out &amp; switch account</button>
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
function sidebar(s: AppState): string {
  const expanded = !s.collapsed;
  const navItem = (act: string, cls: string, title: string, svg: string, extra = ""): string =>
    `<button data-act="${act}" title="${title}" class="cnpy-nav ${cls}">${svg}${expanded ? `<span style="white-space:nowrap;flex:1;text-align:left">${title}</span>` : ""}${extra}</button>`;

  const counts = s.proposals.data.length + s.decisions.data.length + s.triageItems.data.length;
  const triageExtra = expanded
    ? `<span style="font-size:11px;font-weight:600;font-family:var(--mono);min-width:18px;height:18px;padding:0 5px;border-radius:999px;background:var(--accent);color:var(--accent-fg);display:inline-flex;align-items:center;justify-content:center;flex:none">${counts}</span>`
    : `<span style="position:absolute;top:7px;right:11px;width:7px;height:7px;border-radius:50%;background:var(--accent)"></span>`;

  return `<aside class="cnpy-aside">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 14px 14px 16px;min-height:58px">
      <div style="display:flex;align-items:center;gap:10px;overflow:hidden">
        ${logo(24)}
        ${expanded ? `<span style="font-size:18px;font-weight:600;letter-spacing:-0.02em;white-space:nowrap">Canopy</span>` : ""}
      </div>
      ${expanded ? `<button data-act="toggleCollapse" title="Collapse sidebar" class="cnpy-iconbtn" style="flex:none;width:28px;height:28px;border-radius:7px;display:grid;place-items:center;color:var(--fg-40)">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M9 4v16"></path><path d="M14.5 9.5 12 12l2.5 2.5"></path></svg>
      </button>` : ""}
    </div>

    ${s.collapsed ? `<div style="display:flex;justify-content:center;padding:0 0 8px">
      <button data-act="toggleCollapse" title="Expand sidebar" class="cnpy-iconbtn" style="width:36px;height:30px;border-radius:7px;display:grid;place-items:center;color:var(--fg-40)">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M15 4v16"></path><path d="M9.5 9.5 12 12l-2.5 2.5"></path></svg>
      </button>
    </div>` : ""}

    <nav style="display:flex;flex-direction:column;gap:3px;padding:6px 10px;flex:1">
      ${navItem("goRoadmap", "n-roadmap", "Roadmap", `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="flex:none"><path d="M5 21V4"></path><path d="M5 4.5C7 3 9 3 12 4.5s5 1.5 7 0V13c-2 1.5-4 1.5-7 0s-5-1.5-7 0"></path></svg>`)}
      ${navItem("goFeed", "n-feed", "Feed", `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="flex:none"><path d="M4 5h16"></path><path d="M4 12h16"></path><path d="M4 19h10"></path></svg>`)}
      ${navItem("goDocs", "n-docs", "Docs", `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="flex:none"><path d="M6 3h7l5 5v13H6z"></path><path d="M13 3v5h5"></path><path d="M9 13h6"></path><path d="M9 17h6"></path></svg>`)}
      ${navItem("goTriage", "n-triage", "Triage", `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="flex:none"><path d="M4 13h4l2 3h4l2-3h4"></path><path d="M5 13 7 5h10l2 8"></path><path d="M4 13v5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"></path></svg>`, triageExtra)}
      ${navItem("goSearch", "n-search", "Search", `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="flex:none"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.2-3.2"></path></svg>`)}
    </nav>

    <div style="padding:10px;border-top:1px solid var(--border)">
      <button data-act="goSettings" title="Settings" class="cnpy-chip">
        <div style="width:30px;height:30px;border-radius:50%;${AVATAR};font-size:11px;font-weight:600;color:var(--fg);flex:none">${esc(initialsOf(s.me?.login ?? "?"))}</div>
        ${expanded ? `<div style="overflow:hidden;flex:1;text-align:left"><div style="font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.displayName || (s.me?.login ?? ""))}</div><div style="font-size:11px;color:var(--fg-40);font-family:var(--mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.me?.login ?? "")}</div></div>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" style="flex:none;color:var(--fg-40)"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>` : ""}
      </button>
    </div>
  </aside>`;
}

function header(s: AppState): string {
  const titles: Record<Screen, string> = { feed: "Feed", docs: "Docs", roadmap: "Roadmap", triage: "Triage", search: "Search", settings: "Settings" };
  const dark = resolved(s) === "dark";

  const authorFiltered = s.feedAuthor !== "all";
  const authorFilterLabel = authorFiltered ? `${s.feedAuthor}'s activity` : "";

  const filterChip = s.screen === "feed" && authorFiltered
    ? `<div style="display:flex;align-items:center;gap:7px;padding:4px 6px 4px 10px;border:1px solid var(--accent);color:var(--accent);border-radius:999px;font-size:12px;font-weight:500;background:var(--accent-soft)">${authorFilterLabel}<button data-act="clearAuthor" class="cnpy-xbtn" style="width:16px;height:16px;display:grid;place-items:center;border-radius:50%;color:var(--accent)"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 5l14 14M19 5 5 19"></path></svg></button></div>`
    : "";

  // Author chips are derived from the authors actually present in the feed (captured on
  // the unfiltered load), not a hardcoded people list. Active chip is styled inline
  // because the login set is dynamic (the old `[data-author=…] .a-<login>` CSS can't match).
  const achip = (key: string, label: string): string => {
    const active = s.feedAuthor === key;
    const activeStyle = active ? "border-color:var(--accent);color:var(--accent);background:var(--accent-soft)" : "";
    return `<button data-act="setAuthor" data-arg="${attr(key)}" class="cnpy-achip" style="${activeStyle}">${label}</button>`;
  };
  const authorChips = [achip("all", "All"), ...s.feedAuthors.map((a) => achip(a, a))].join("");

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

  const triageControls = s.screen === "triage" ? `<div style="display:flex;align-items:center;gap:3px;padding:3px;border:1px solid var(--border);border-radius:9px">
      <button data-act="queueProposals" class="cnpy-qtab q-proposals">Proposals<span class="cnpy-qcount">${s.proposals.data.length}</span></button>
      <button data-act="queueDecisions" class="cnpy-qtab q-decisions">Decisions<span class="cnpy-qcount">${s.decisions.data.length}</span></button>
      <button data-act="queueTriage" class="cnpy-qtab q-triage">Triage<span class="cnpy-qcount">${s.triageItems.data.length}</span></button>
    </div>` : "";

  const spaceTab = (k: DocSpace, label: string) =>
    `<button data-act="setDocSpace" data-arg="${k}" style="display:flex;align-items:center;gap:7px;padding:5px 14px;border-radius:7px;font-size:12.5px;font-weight:500;color:${s.docSpace === k ? "var(--fg)" : "var(--fg-55)"};background:${s.docSpace === k ? "var(--hover)" : "transparent"}">${label}</button>`;
  const docsControls = s.screen === "docs" ? `<div style="display:flex;align-items:center;gap:3px;padding:3px;border:1px solid var(--border);border-radius:9px">${spaceTab("sapling", "Sapling")}${spaceTab("canopy", "Canopy")}</div>` : "";

  const rmTabStyle = (k: string) => `display:flex;align-items:center;gap:7px;padding:5px 13px;border-radius:7px;font-size:12.5px;font-weight:500;color:${s.roadmapTab === k ? "var(--fg)" : "var(--fg-55)"};background:${s.roadmapTab === k ? "var(--hover)" : "transparent"}`;
  const overdueCount = s.screen === "roadmap" && s.roadmap.status === "ok"
    ? roadmapEnriched(s.roadmap.data, s.confirmedMilestones).overdueCount
    : 0;
  const roadmapControls = s.screen === "roadmap" ? `<div style="display:flex;align-items:center;gap:3px;padding:3px;border:1px solid var(--border);border-radius:9px">
      <button data-act="roadmapNarrative" style="${rmTabStyle("narrative")}">Narrative</button>
      <button data-act="roadmapTimeline" style="${rmTabStyle("timeline")}">Timeline${overdueCount ? `<span style="width:6px;height:6px;border-radius:50%;background:var(--red);margin-left:1px"></span>` : ""}</button>
    </div>` : "";

  const themeBtn = `<button data-act="cycleTheme" title="Toggle theme" class="cnpy-iconbtn" style="width:32px;height:32px;border-radius:8px;border:1px solid var(--border);display:grid;place-items:center;color:var(--fg-55)">
      ${dark
        ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"></path></svg>`
        : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="4.2"></circle><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"></path></svg>`}
    </button>`;

  return `<header style="display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 24px;min-height:57px;border-bottom:1px solid var(--border);flex:none">
    <div style="display:flex;align-items:center;gap:12px;min-width:0">
      <h1 style="font-size:15px;font-weight:600;letter-spacing:-0.01em;margin:0">${titles[s.screen]}</h1>
      ${filterChip}
    </div>
    <div style="display:flex;align-items:center;gap:8px;flex:none">
      ${feedControls}${triageControls}${docsControls}${roadmapControls}${themeBtn}
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
        <div style="width:30px;height:30px;border-radius:50%;${AVATAR};font-size:10.5px;font-weight:600;color:var(--fg);flex:none;margin-top:1px">${esc(initialsOf(e.author))}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:500;line-height:1.5;letter-spacing:-0.005em">${esc(e.summary)}</div>
          ${e.body ? `<div style="font-size:13px;color:var(--fg-55);line-height:1.6;margin-top:6px">${esc(e.body)}</div>` : ""}
          <div style="display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:12px">
            <div style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--fg-55)"><span style="font-weight:500;color:var(--fg-70)">${esc(e.author)}</span></div>
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
  return wrapFeed(`${cards}${empty}`);
}

// ── docs ─────────────────────────────────────────────────────────────────────
const DOC_SECTION_ORDER = ["reference", "context", "decisions"];

function docsView(s: AppState): string {
  // ── tree (left pane) ────────────────────────────────────────────────────────
  let treeHtml: string;
  if (s.docsList.status === "loading" && s.docsList.data.length === 0) {
    treeHtml = notice("Loading…");
  } else if (s.docsList.status === "error") {
    treeHtml = notice("Couldn't load docs.");
  } else {
    // Filter to the toggled space (Sapling | Canopy), then group by section.
    const spaceDocs = s.docsList.data.filter((d) => d.space === s.docSpace);
    if (spaceDocs.length === 0) {
      treeHtml = notice(`No ${s.docSpace === "sapling" ? "Sapling" : "Canopy"} docs yet.`);
    } else {
      const grouped = new Map<string, DocRow[]>();
      for (const sec of DOC_SECTION_ORDER) grouped.set(sec, []);
      for (const doc of spaceDocs) {
        const sec = doc.section.toLowerCase();
        if (!grouped.has(sec)) grouped.set(sec, []);
        grouped.get(sec)!.push(doc);
      }
      treeHtml = [...grouped.entries()]
        .filter(([, pages]) => pages.length > 0)
        .map(([sec, pages]) => `<div style="margin-bottom:18px">
        <div style="font-size:10.5px;font-weight:600;text-transform:uppercase;letter-spacing:.09em;color:var(--fg-40);padding:0 10px 6px">${esc(sec.toUpperCase())}</div>
        <div style="display:flex;flex-direction:column;gap:1px">
          ${pages.map((doc) => {
            const active = doc.slug === s.docSlug;
            return `<button data-act="openDoc" data-arg="${attr(doc.slug)}" class="cnpy-tree">${active ? `<span class="cnpy-selbar"></span>` : ""}<span style="position:relative;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(doc.title)}</span></button>`;
          }).join("")}
        </div>
      </div>`).join("");
    }
  }

  // ── reader (right pane) ─────────────────────────────────────────────────────
  let readerHtml: string;
  const dd = s.docDetail;

  if (dd.status === "loading" || (dd.status === "idle" && s.docSlug !== null)) {
    readerHtml = notice("Loading…");
  } else if (dd.status === "error") {
    readerHtml = notice("Couldn't load this doc.");
  } else if (dd.data === null) {
    readerHtml = notice(s.docSlug === null ? "Select a doc from the tree." : "Doc not found.");
  } else if (dd.status === "ok" && dd.data !== null) {
    const { doc, versions } = dd.data;
    const hasStaged = versions.some((v) => v.status === "staged" && v.version > doc.current_version);

    const stagedBanner = hasStaged ? `<div style="display:flex;align-items:center;gap:14px;padding:12px 14px;border:1px solid var(--border);border-left:2px solid var(--amber);border-radius:9px;margin-bottom:26px">
      <span style="display:inline-flex;align-items:center;gap:6px;font-size:10.5px;font-weight:600;font-family:var(--mono);letter-spacing:.04em;color:var(--amber);border:1px solid color-mix(in srgb,var(--amber) 45%,transparent);background:color-mix(in srgb,var(--amber) 12%,transparent);border-radius:5px;padding:3px 7px;flex:none">STAGED</span>
      <div style="flex:1;font-size:12.5px;color:var(--fg-70);line-height:1.45">You're viewing the <strong style="font-weight:600;color:var(--fg)">promoted</strong> version. A newer proposal is awaiting review.</div>
      <button data-act="gotoTriage" class="cnpy-link" style="display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:500;color:var(--accent);white-space:nowrap;flex:none">Review in Triage<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M13 6l6 6-6 6"></path></svg></button>
    </div>` : "";

    const history = s.showHistory ? `<div style="border:1px solid var(--border);border-radius:10px;padding:6px;margin-top:18px">
      ${versions.map((v) => `<div style="display:flex;align-items:center;gap:12px;padding:9px 11px;border-radius:7px">
        <span style="font-family:var(--mono);font-size:12px;font-weight:600;color:var(--fg);width:26px">v${v.version}</span>
        <span style="flex:1;font-size:12.5px;color:var(--fg-70)">${esc(v.summary ?? "")}</span>
        <span style="font-size:11.5px;color:var(--fg-40)">${esc(v.created_by)} · ${relTime(v.created_at)}</span>
        ${v.version === doc.current_version ? `<span style="font-size:9.5px;font-weight:600;font-family:var(--mono);color:var(--accent);border:1px solid color-mix(in srgb,var(--accent) 45%,transparent);background:var(--accent-soft);border-radius:4px;padding:2px 6px">PROMOTED</span>` : ""}
      </div>`).join("")}
    </div>` : "";

    readerHtml = `<div style="max-width:740px;margin:0 auto;padding:26px 40px 100px">
    ${stagedBanner}
    <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--fg-40);margin-bottom:8px"><span>${esc(doc.section)}</span></div>
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <h1 style="font-size:28px;font-weight:600;letter-spacing:-0.02em;margin:0;white-space:nowrap">${esc(doc.title)}</h1>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-top:14px;padding-bottom:18px;border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;gap:9px;font-size:12.5px;color:var(--fg-55)">
        <div style="width:24px;height:24px;border-radius:50%;${AVATAR};font-size:9.5px;font-weight:600;color:var(--fg)">${esc(initialsOf(doc.updated_by ?? ""))}</div>
        <span>Updated by <b style="color:var(--fg-70);font-weight:500">${esc(doc.updated_by ?? "")}</b> · ${relTime(doc.updated_at)}</span>
      </div>
      <button data-act="toggleHistory" class="cnpy-ghostbtn" style="display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:500;color:var(--fg-70);border:1px solid var(--border);border-radius:7px;padding:5px 11px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3v6h6"></path><path d="M3.5 9a9 9 0 1 0 2.3-3.3L3 9"></path><path d="M12 8v4l3 2"></path></svg>Version history</button>
    </div>
    ${history}
    <div class="cnpy-md" style="margin-top:26px">${renderMarkdown(doc.body)}</div>
  </div>`;
  } else {
    readerHtml = notice("Select a doc from the tree.");
  }

  return `<div style="display:flex;height:100%">
    <div class="cnpy-scroll" style="width:252px;flex:none;border-right:1px solid var(--border);overflow-y:auto;padding:18px 12px">${treeHtml}</div>
    <div class="cnpy-scroll" style="flex:1;overflow-y:auto;min-width:0">${readerHtml}</div>
  </div>`;
}

// ── triage ───────────────────────────────────────────────────────────────────
function triageView(s: AppState): string {
  const q = s.triageQueue;

  // Determine list pane contents + loading state per queue
  type ListItem = { id: string; selected: boolean; eyebrow: string; title: string; summary: string; author: string; badgeText: string; badgeColor: string };
  let listItems: ListItem[] = [];
  let listStatus: "idle" | "loading" | "ok" | "error" | "unauth" = "idle";

  if (q === "proposals") {
    listStatus = s.proposals.status;
    listItems = s.proposals.data.map((p) => {
      const key = `${p.slug}@${p.version}`;
      const confColor = p.confidence === "high" ? "var(--green)" : p.confidence === "low" ? "var(--red)" : "var(--amber)";
      const confLabel = p.confidence ? p.confidence.toUpperCase() : "?";
      return { id: key, selected: key === s.selProposal, eyebrow: p.section, title: p.title, summary: p.summary ?? "", author: p.author, badgeText: confLabel, badgeColor: confColor };
    });
  } else if (q === "decisions") {
    listStatus = s.decisions.status;
    listItems = s.decisions.data.map((d) => ({
      id: String(d.id), selected: d.id === s.selDecision,
      eyebrow: "ADR", title: d.title, summary: d.context ?? "",
      author: d.created_by, badgeText: "DRAFT", badgeColor: "var(--blue)",
    }));
  } else {
    listStatus = s.triageItems.status;
    listItems = s.triageItems.data.map((t) => {
      const firstLine = t.raw.split("\n")[0].slice(0, 80) + (t.raw.split("\n")[0].length > 80 ? "…" : "");
      return { id: String(t.id), selected: t.id === s.selTriage, eyebrow: "Unplaced", title: firstLine, summary: t.reason, author: t.source_author ?? "unknown", badgeText: "NEEDS-TRIAGE", badgeColor: "var(--red)" };
    });
  }

  let listHtml: string;
  if (listStatus === "loading" && listItems.length === 0) {
    listHtml = notice("Loading&hellip;");
  } else if (listStatus === "error") {
    listHtml = notice("Couldn't load queue.");
  } else if (listItems.length === 0) {
    listHtml = `<div style="display:flex;flex-direction:column;align-items:center;gap:10px;padding:70px 20px;text-align:center">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.7"><path d="M20 6 9 17l-5-5"></path></svg>
      <div style="font-size:13.5px;font-weight:500">Queue clear</div>
      <div style="font-size:12.5px;color:var(--fg-40)">Nothing waiting for review here.</div>
    </div>`;
  } else {
    listHtml = listItems.map((it) => `<button data-act="selectItem" data-arg="${it.id}" class="cnpy-titem">
        ${it.selected ? `<span class="cnpy-selbar"></span>` : ""}
        <div style="position:relative">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:7px">
            <span style="font-size:10.5px;font-weight:600;font-family:var(--mono);text-transform:uppercase;letter-spacing:.06em;color:var(--fg-40)">${esc(it.eyebrow)}</span>
            <span style="font-size:9.5px;font-weight:600;font-family:var(--mono);letter-spacing:.03em;color:${it.badgeColor};border:1px solid color-mix(in srgb,${it.badgeColor} 45%,transparent);background:color-mix(in srgb,${it.badgeColor} 12%,transparent);border-radius:5px;padding:2px 6px;white-space:nowrap">${esc(it.badgeText)}</span>
          </div>
          <div style="font-size:14px;font-weight:600;letter-spacing:-0.01em;line-height:1.35;margin-bottom:5px">${esc(it.title)}</div>
          <div style="font-size:12.5px;color:var(--fg-55);line-height:1.5;margin-bottom:11px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(it.summary)}</div>
          <div style="display:flex;align-items:center;gap:8px"><div style="width:20px;height:20px;border-radius:50%;${AVATAR};font-size:8.5px;font-weight:600;color:var(--fg)">${esc(initialsOf(it.author))}</div><span style="font-size:12px;color:var(--fg-55)">${esc(it.author)}</span></div>
        </div>
      </button>`).join("");
  }

  return `<div style="display:flex;height:100%">
    <div class="cnpy-scroll" style="width:392px;flex:none;border-right:1px solid var(--border);overflow-y:auto;padding:18px 16px">${listHtml}</div>
    <div class="cnpy-scroll" style="flex:1;overflow-y:auto;min-width:0">
      <div style="max-width:720px;margin:0 auto;padding:24px 36px 100px">${triageDetail(s)}</div>
    </div>
  </div>`;
}

type DiffKind = "ctx" | "add" | "del";

function diffLineStyle(t: DiffKind): string {
  const border = t === "add" ? "var(--green)" : t === "del" ? "var(--red)" : "transparent";
  const bg = t === "add" ? "color-mix(in srgb,var(--green) 12%,transparent)" : t === "del" ? "color-mix(in srgb,var(--red) 11%,transparent)" : "transparent";
  const color = t === "ctx" ? "var(--fg-55)" : "var(--fg)";
  return `font-family:var(--mono);font-size:12.5px;line-height:1.85;padding:0 12px;white-space:pre-wrap;word-break:break-word;border-left:2px solid ${border};background:${bg};color:${color}`;
}
function signStyle(t: DiffKind): string {
  const color = t === "add" ? "var(--green)" : t === "del" ? "var(--red)" : "var(--fg-40)";
  return `color:${color};margin-right:10px;user-select:none;font-weight:600`;
}

type DiffRow = { t: DiffKind; text: string };
function lineDiff(oldText: string, newText: string): DiffRow[] {
  const a = oldText.split("\n"), b = newText.split("\n");
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: DiffRow[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ t: "ctx", text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ t: "del", text: a[i] }); i++; }
    else { out.push({ t: "add", text: b[j] }); j++; }
  }
  while (i < n) out.push({ t: "del", text: a[i++] });
  while (j < m) out.push({ t: "add", text: b[j++] });
  return out;
}

function triageDetail(s: AppState): string {
  const q = s.triageQueue;
  if (q === "proposals") {
    const p = s.proposals.data.find((x) => `${x.slug}@${x.version}` === s.selProposal);
    if (!p) return queueEmpty();
    const key = `${p.slug}@${p.version}`;
    const confClr = p.confidence === "high" ? "var(--green)" : p.confidence === "low" ? "var(--red)" : "var(--amber)";
    const confLbl = p.confidence ? `${p.confidence} confidence` : "";
    const diff = lineDiff(p.promotedBody, p.stagedBody);
    const add = diff.filter((l) => l.t === "add").length;
    const del = diff.filter((l) => l.t === "del").length;
    const lines = diff.map((l) => {
      const sign = l.t === "add" ? "+" : l.t === "del" ? "−" : " ";
      return `<div style="${diffLineStyle(l.t)}"><span style="${signStyle(l.t)}">${sign}</span>${esc(l.text) || " "}</div>`;
    }).join("");
    return `<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap">
      <div style="min-width:0">
        <div style="display:flex;align-items:center;gap:9px;margin-bottom:8px"><span style="font-size:11px;font-family:var(--mono);color:var(--fg-40)">Proposal · ${esc(p.section)}</span><span style="font-size:9.5px;font-weight:600;font-family:var(--mono);letter-spacing:.03em;color:var(--amber);border:1px solid color-mix(in srgb,var(--amber) 45%,transparent);background:color-mix(in srgb,var(--amber) 12%,transparent);border-radius:5px;padding:2px 6px">STAGED</span></div>
        <h1 style="font-size:23px;font-weight:600;letter-spacing:-0.015em;margin:0 0 10px">${esc(p.title)}</h1>
        <p style="font-size:14px;color:var(--fg-70);line-height:1.6;margin:0 0 12px;max-width:540px">${esc(p.summary ?? "")}</p>
        <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
          <div style="display:flex;align-items:center;gap:8px"><div style="width:22px;height:22px;border-radius:50%;${AVATAR};font-size:9px;font-weight:600;color:var(--fg)">${esc(initialsOf(p.author))}</div><span style="font-size:12.5px;color:var(--fg-55)">${esc(p.author)}</span></div>
          ${confLbl ? `<div style="display:flex;align-items:center;gap:6px"><span style="width:7px;height:7px;border-radius:50%;background:${confClr}"></span><span style="font-size:12.5px;color:var(--fg-55)">${esc(confLbl)}</span></div>` : ""}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:9px;flex:none">
        <button data-act="dismiss" data-arg="${key}" class="cnpy-outlinebtn" style="padding:9px 15px;border-radius:8px;border:1px solid var(--border-strong);font-size:13px;font-weight:500;color:var(--fg-70)">Dismiss</button>
        <button data-act="promote" data-arg="${key}" class="cnpy-accentbtn" style="display:inline-flex;align-items:center;gap:7px;padding:9px 17px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-size:13px;font-weight:600"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 12l5 5L20 7"></path></svg>Promote</button>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:12px;margin:24px 0 0;padding:11px 14px;border:1px solid var(--border);border-bottom:none;border-radius:11px 11px 0 0;background:var(--bg)">
      <span style="font-size:11.5px;font-weight:600;letter-spacing:.02em">Diff against promoted version</span>
      <div style="flex:1"></div>
      <span style="font-size:11px;font-family:var(--mono);color:var(--green)">+${add}</span>
      <span style="font-size:11px;font-family:var(--mono);color:var(--red)">&minus;${del}</span>
    </div>
    <div style="border:1px solid var(--border);border-radius:0 0 11px 11px;padding:12px 0;overflow-x:auto">${lines}</div>`;
  }

  if (q === "decisions") {
    const d = s.decisions.data.find((x) => x.id === s.selDecision);
    if (!d) return queueEmpty();
    return `<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex-wrap:wrap">
      <div style="min-width:0">
        <div style="display:flex;align-items:center;gap:9px;margin-bottom:8px"><span style="font-size:11px;font-family:var(--mono);color:var(--fg-40)">ADR · Decision</span><span style="font-size:9.5px;font-weight:600;font-family:var(--mono);letter-spacing:.03em;color:var(--blue);border:1px solid color-mix(in srgb,var(--blue) 45%,transparent);background:color-mix(in srgb,var(--blue) 12%,transparent);border-radius:5px;padding:2px 6px">DRAFT</span></div>
        <h1 style="font-size:23px;font-weight:600;letter-spacing:-0.015em;margin:0 0 12px">${esc(d.title)}</h1>
        <div style="display:flex;align-items:center;gap:8px"><div style="width:22px;height:22px;border-radius:50%;${AVATAR};font-size:9px;font-weight:600;color:var(--fg)">${esc(initialsOf(d.created_by))}</div><span style="font-size:12.5px;color:var(--fg-55)">Drafted by ${esc(d.created_by)}</span></div>
      </div>
      <div style="display:flex;align-items:center;gap:9px;flex:none">
        <button data-act="dismiss" data-arg="${d.id}" class="cnpy-outlinebtn" style="padding:9px 15px;border-radius:8px;border:1px solid var(--border-strong);font-size:13px;font-weight:500;color:var(--fg-70)">Dismiss</button>
        <button data-act="ratify" data-arg="${String(d.id)}" class="cnpy-accentbtn" style="display:inline-flex;align-items:center;gap:7px;padding:9px 17px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-size:13px;font-weight:600"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 12l5 5L20 7"></path></svg>Ratify</button>
      </div>
    </div>
    <div style="margin-top:26px;display:flex;flex-direction:column;gap:22px">
      <div><div style="font-size:11px;font-weight:600;font-family:var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--fg-40);margin-bottom:8px">Context</div><p style="font-size:14.5px;line-height:1.7;color:var(--fg-70);margin:0">${esc(d.context ?? "")}</p></div>
      <div style="border-left:2px solid var(--accent);padding-left:18px"><div style="font-size:11px;font-weight:600;font-family:var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--accent);margin-bottom:8px">Decision</div><p style="font-size:14.5px;line-height:1.7;color:var(--fg);margin:0">${esc(d.decision ?? "")}</p></div>
      <div><div style="font-size:11px;font-weight:600;font-family:var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--fg-40);margin-bottom:8px">Rationale</div><p style="font-size:14.5px;line-height:1.7;color:var(--fg-70);margin:0">${esc(d.rationale ?? "")}</p></div>
    </div>`;
  }

  const t = s.triageItems.data.find((x) => x.id === s.selTriage);
  if (!t) return queueEmpty();
  const tFirstLine = t.raw.split("\n")[0].slice(0, 80) + (t.raw.split("\n")[0].length > 80 ? "…" : "");
  return `<div style="display:flex;align-items:center;gap:9px;margin-bottom:8px"><span style="font-size:11px;font-family:var(--mono);color:var(--fg-40)">Unplaced item</span><span style="font-size:9.5px;font-weight:600;font-family:var(--mono);letter-spacing:.03em;color:var(--red);border:1px solid color-mix(in srgb,var(--red) 45%,transparent);background:color-mix(in srgb,var(--red) 12%,transparent);border-radius:5px;padding:2px 6px">NEEDS-TRIAGE</span></div>
    <h1 style="font-size:23px;font-weight:600;letter-spacing:-0.015em;margin:0 0 12px">${esc(tFirstLine)}</h1>
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:22px"><div style="width:22px;height:22px;border-radius:50%;${AVATAR};font-size:9px;font-weight:600;color:var(--fg)">${esc(initialsOf(t.source_author ?? "unknown"))}</div><span style="font-size:12.5px;color:var(--fg-55)">From ${esc(t.source_author ?? "unknown")}'s session</span></div>
    <div style="display:flex;align-items:flex-start;gap:11px;padding:12px 14px;border:1px solid var(--border);border-left:2px solid var(--red);border-radius:9px;margin-bottom:20px"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="1.9" style="flex:none;margin-top:1px"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16h.01"></path></svg><div><div style="font-size:11px;font-weight:600;font-family:var(--mono);text-transform:uppercase;letter-spacing:.06em;color:var(--red);margin-bottom:4px">Why it couldn't be placed</div><div style="font-size:13px;color:var(--fg-70);line-height:1.55">${esc(t.reason)}</div></div></div>
    <div style="font-size:11px;font-weight:600;font-family:var(--mono);text-transform:uppercase;letter-spacing:.08em;color:var(--fg-40);margin-bottom:8px">Raw content</div>
    <div style="border:1px solid var(--border);border-radius:10px;padding:15px 17px;margin-bottom:26px;font-size:13.5px;line-height:1.65;color:var(--fg-70);white-space:pre-wrap">${esc(t.raw)}</div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding-top:18px;border-top:1px solid var(--border)">
      <div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap"><span style="font-size:12.5px;color:var(--fg-55);margin-right:2px">Assign to</span><button data-act="assignItem" data-arg="${t.id}" class="cnpy-assignbtn" style="padding:7px 13px;border-radius:7px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500">Reference</button><button data-act="assignItem" data-arg="${t.id}" class="cnpy-assignbtn" style="padding:7px 13px;border-radius:7px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500">Context</button><button data-act="assignItem" data-arg="${t.id}" class="cnpy-assignbtn" style="padding:7px 13px;border-radius:7px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500">Decisions</button></div>
      <button data-act="discardItem" data-arg="${t.id}" class="cnpy-discard" style="font-size:12.5px;font-weight:500;color:var(--fg-40)">Discard</button>
    </div>`;
}

function queueEmpty(): string {
  return `<div style="display:flex;flex-direction:column;align-items:center;gap:12px;padding:120px 20px;text-align:center">
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.6"><path d="M20 6 9 17l-5-5"></path></svg>
    <div style="font-size:15px;font-weight:600">All caught up</div>
    <div style="font-size:13px;color:var(--fg-40);max-width:280px;line-height:1.5">Every item in this queue has been reviewed. New agent output will appear here.</div>
  </div>`;
}

// ── roadmap ──────────────────────────────────────────────────────────────────
interface EnrichedMilestone {
  id: number; title: string; about: string;
  closed: number | null; total: number | null; done: boolean; ready: boolean; overdue: boolean;
  pct: number; tgt: number; badge: { label: string; color: string; soft?: boolean };
  dateLabel: string; isNext: boolean;
}

function roadmapEnriched(milestones: MilestoneWithProgress[], confirmedMilestones: Record<string, boolean>): { list: EnrichedMilestone[]; doneCount: number; overdueCount: number } {
  const now = Date.now();
  const fmt = (iso: string) => new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const badgeFor = (st: string): { label: string; color: string; soft?: boolean } => {
    if (st === "done") return { label: "Done", color: "var(--green)", soft: true };
    if (st === "in_progress") return { label: "In progress", color: "var(--amber)" };
    return { label: "Upcoming", color: "var(--blue)" };
  };

  const enriched = milestones.map((m) => {
    const confirmed = !!confirmedMilestones[String(m.id)];
    const done = m.status === "done" || confirmed;
    const closed = m.progress ? m.progress.closed : null;
    const total = m.progress ? m.progress.total : null;
    const allClosed = total !== null && total > 0 && closed !== null && closed >= total;
    const ready = !done && m.progress !== null && allClosed;
    const tgt = new Date(m.target_date + "T12:00:00").getTime();
    const overdue = !done && !ready && tgt < now;
    const pct = total !== null && total > 0 && closed !== null ? Math.round((100 * closed) / total) : 0;
    return {
      id: m.id, title: m.title, about: m.description ?? "",
      closed, total, done, ready, overdue, pct, tgt,
      badge: badgeFor(done ? "done" : m.status), dateLabel: fmt(m.target_date),
      isNext: false,
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

function roadmapNarrative(s: AppState): string {
  const { list, doneCount, overdueCount } = roadmapEnriched(s.roadmap.data, s.confirmedMilestones);
  const total = list.length;

  const inProgress = list.filter((m) => !m.done && m.badge.label === "In progress");
  const upcoming = list.filter((m) => !m.done && m.badge.label === "Upcoming");
  const done = list.filter((m) => m.done);

  const sectionHeading = (label: string, color: string): string =>
    `<div style="display:flex;align-items:center;gap:9px;margin:28px 0 12px"><span style="width:7px;height:7px;border-radius:50%;flex:none;background:${color}"></span><span style="font-size:11px;font-weight:600;font-family:var(--mono);text-transform:uppercase;letter-spacing:.1em;color:${color}">${label}</span><div style="flex:1;height:1px;background:var(--border)"></div></div>`;

  const milestoneRow = (m: (typeof list)[0]): string => {
    const dateNote = m.done
      ? `Completed by ${m.dateLabel}`
      : m.overdue
      ? `Was due ${m.dateLabel} — overdue`
      : m.isNext
      ? `Next up · due ${m.dateLabel}`
      : `Due ${m.dateLabel}`;
    const progressNote = m.total !== null && m.closed !== null
      ? `${m.closed}/${m.total} issues closed${m.pct > 0 ? ` (${m.pct}%)` : ""}`
      : "";
    return `<div style="padding:14px 16px;border:1px solid var(--border);border-radius:11px;margin-bottom:8px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">
            <span style="font-size:14.5px;font-weight:600;letter-spacing:-0.01em">${esc(m.title)}</span>
            ${m.isNext ? `<span style="font-size:9.5px;font-weight:700;font-family:var(--mono);letter-spacing:.06em;color:var(--accent);border:1px solid color-mix(in srgb,var(--accent) 45%,transparent);border-radius:5px;padding:1px 6px">NEXT</span>` : ""}
            ${m.overdue ? `<span style="font-size:9.5px;font-weight:700;font-family:var(--mono);letter-spacing:.06em;color:var(--red);border:1px solid color-mix(in srgb,var(--red) 45%,transparent);border-radius:5px;padding:1px 6px">OVERDUE</span>` : ""}
          </div>
          ${m.about ? `<p style="font-size:13px;line-height:1.65;color:var(--fg-70);margin:0 0 8px">${esc(m.about)}</p>` : ""}
          <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
            <span style="font-size:11.5px;color:var(--fg-40);font-family:var(--mono)">${dateNote}</span>
            ${progressNote ? `<span style="font-size:11.5px;color:var(--fg-40)">${progressNote}</span>` : ""}
          </div>
        </div>
      </div>
    </div>`;
  };

  const renderGroup = (items: (typeof list), heading: string, color: string): string =>
    items.length === 0 ? "" : `${sectionHeading(heading, color)}${items.map(milestoneRow).join("")}`;

  const intro = total === 0
    ? notice("No milestones yet.")
    : `<p style="font-size:14px;line-height:1.7;color:var(--fg-70);margin:0 0 4px">
        ${total} milestone${total !== 1 ? "s" : ""} track the coarse goals above issue-level work.
        ${doneCount > 0 ? `<strong style="color:var(--fg);font-weight:600">${doneCount} ${doneCount === 1 ? "is" : "are"} done.</strong>` : ""}
        ${overdueCount > 0 ? `<span style="color:var(--red)">${overdueCount} overdue.</span>` : ""}
        Progress is read live from GitHub at view time.
      </p>`;

  return `<div class="cnpy-scroll" style="max-width:820px;margin:0 auto;padding:32px 40px 100px">
    <div style="margin-bottom:20px">
      <div style="font-size:11px;font-weight:600;font-family:var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--fg-40);margin-bottom:6px">Narrative</div>
      <h1 style="font-size:24px;font-weight:600;letter-spacing:-0.02em;margin:0 0 12px">Roadmap Overview</h1>
      ${intro}
    </div>
    ${renderGroup(inProgress, "In Progress", "var(--amber)")}
    ${renderGroup(upcoming, "Upcoming", "var(--blue)")}
    ${renderGroup(done, "Done", "var(--green)")}
    ${total > 0 ? `<div style="text-align:center;padding:14px 0 0;font-size:11.5px;color:var(--fg-40)">Milestones are coarse goals — the altitude above GitHub issues.</div>` : ""}
  </div>`;
}

function roadmapView(s: AppState): string {
  if (s.roadmap.status === "loading" && s.roadmap.data.length === 0) {
    return `<div class="cnpy-scroll" style="max-width:820px;margin:0 auto;padding:32px 40px 100px">${notice("Loading roadmap&hellip;")}</div>`;
  }
  if (s.roadmap.status === "error") {
    return `<div class="cnpy-scroll" style="max-width:820px;margin:0 auto;padding:32px 40px 100px">${notice("Couldn't load the roadmap.")}</div>`;
  }
  if (s.roadmapTab === "narrative") return roadmapNarrative(s);
  return roadmapTimeline(s);
}

function roadmapTimeline(s: AppState): string {
  const { list, doneCount, overdueCount } = roadmapEnriched(s.roadmap.data, s.confirmedMilestones);
  const total = list.length;

  const rows = list.map((m) => {
    const accent = m.overdue ? "var(--red)" : m.isNext ? "var(--accent)" : "var(--border)";
    const bg = m.overdue ? "color-mix(in srgb,var(--red) 6%,transparent)" : m.isNext ? "var(--accent-soft)" : "transparent";
    const barColor = m.done ? "var(--green)" : m.overdue ? "var(--red)" : "var(--accent)";

    const badge = `display:inline-flex;align-items:center;gap:6px;white-space:nowrap;font-size:10.5px;font-weight:600;font-family:var(--mono);letter-spacing:.04em;text-transform:uppercase;padding:2px 8px;border-radius:6px;color:${m.badge.color};border:1px solid color-mix(in srgb,${m.badge.color} 45%,transparent);background:${m.badge.soft ? `color-mix(in srgb,${m.badge.color} 12%,transparent)` : "transparent"}`;

    // Progress bar: when progress is null, render empty track only
    const progressBar = m.total !== null && m.closed !== null
      ? `<div style="display:flex;align-items:center;gap:12px;margin-top:16px">
          <div style="flex:1;height:5px;border-radius:999px;background:var(--border);overflow:hidden"><div style="height:100%;border-radius:999px;width:${m.pct}%;background:${barColor}"></div></div>
          <span style="font-size:11.5px;color:var(--fg-55);font-family:var(--mono);white-space:nowrap;flex:none">${m.closed} of ${m.total} issues closed</span>
        </div>`
      : `<div style="display:flex;align-items:center;gap:12px;margin-top:16px">
          <div style="flex:1;height:5px;border-radius:999px;background:var(--border);overflow:hidden"></div>
          <span style="font-size:11.5px;color:var(--fg-40);font-family:var(--mono);white-space:nowrap;flex:none">progress unavailable</span>
        </div>`;

    const ready = m.ready ? `<div style="display:flex;align-items:center;gap:12px;margin-top:15px;padding-top:14px;border-top:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--accent);flex:1"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M20 6 9 17l-5-5"></path></svg><span style="color:var(--fg-70)">All linked issues are closed — <strong style="color:var(--fg);font-weight:600">ready to complete</strong>.</span></div>
        <button data-act="confirmMilestone" data-arg="${m.id}" class="cnpy-accentbtn" style="flex:none;display:inline-flex;align-items:center;gap:7px;padding:7px 15px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-size:12.5px;font-weight:600">Confirm done</button>
      </div>` : "";

    return `<div style="display:block;position:relative;border:1px solid ${accent};border-radius:14px;padding:18px 20px;margin-bottom:12px;background:${bg};transition:border-color .12s ease">
      <div style="display:flex;align-items:flex-start;gap:14px">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:5px">
            <span style="font-size:15.5px;font-weight:600;letter-spacing:-0.01em">${esc(m.title)}</span>
            ${m.isNext ? `<span style="font-size:9.5px;font-weight:700;font-family:var(--mono);letter-spacing:.06em;color:var(--accent);border:1px solid color-mix(in srgb,var(--accent) 45%,transparent);border-radius:5px;padding:1px 6px">NEXT</span>` : ""}
            ${m.overdue ? `<span style="font-size:9.5px;font-weight:700;font-family:var(--mono);letter-spacing:.06em;color:var(--red);border:1px solid color-mix(in srgb,var(--red) 45%,transparent);border-radius:5px;padding:1px 6px">OVERDUE</span>` : ""}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:7px;flex:none">
          <span style="${badge}">${m.badge.label}</span>
          <span style="font-size:12px;color:var(--fg-55);font-family:var(--mono)">${m.dateLabel}</span>
        </div>
      </div>
      ${m.about ? `<p style="font-size:13.5px;line-height:1.65;color:var(--fg-70);margin:13px 0 0">${esc(m.about)}</p>` : ""}
      ${progressBar}
      ${ready}
    </div>`;
  }).join("");

  const empty = s.roadmap.status === "ok" && total === 0 ? notice("No milestones yet.") : "";

  return `<div class="cnpy-scroll" style="max-width:820px;margin:0 auto;padding:32px 40px 100px">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;margin:0 0 6px">
      <div>
        <div style="font-size:11px;font-weight:600;font-family:var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--fg-40);margin-bottom:6px">Timeline</div>
        <h1 style="font-size:24px;font-weight:600;letter-spacing:-0.02em;margin:0">Milestones</h1>
      </div>
      <div style="display:flex;align-items:center;gap:16px;font-size:12.5px">
        <span style="color:var(--fg-55)"><strong style="color:var(--fg);font-weight:600">${doneCount}</strong> of ${total} done</span>
        ${overdueCount ? `<span style="display:inline-flex;align-items:center;gap:6px;color:var(--red)"><span style="width:6px;height:6px;border-radius:50%;background:var(--red)"></span>${overdueCount} overdue</span>` : ""}
      </div>
    </div>
    <div style="font-size:12px;color:var(--fg-40);margin-bottom:20px">Progress is read live from GitHub at view time — not stored here.</div>
    ${rows}${empty}
    <div style="text-align:center;padding:14px 0 0;font-size:11.5px;color:var(--fg-40)">Milestones are coarse goals — the altitude above GitHub issues.</div>
  </div>`;
}

// ── search ───────────────────────────────────────────────────────────────────
function searchView(s: AppState): string {
  const typeIcon: Record<string, string> = { feed: "M4 5h16M4 12h16M4 19h10", doc: "M6 3h7l5 5v13H6z", adr: "M9 12l2 2 4-4" };
  const typeLabel: Record<string, string> = { doc: "Doc", feed: "Feed", adr: "Decision" };

  // Client-side filter by type (no refetch — the full set is already fetched).
  let filtered: SearchResult[] = s.searchResults.data;
  if (s.searchType !== "all") filtered = filtered.filter((r) => r.type === s.searchType);

  const sq = (s.searchQuery || "").trim().toLowerCase();

  const typeChips = [["all", "All"], ["doc", "Docs"], ["feed", "Feed"], ["adr", "Decisions"]].map(([k, label]) => {
    const sel = s.searchType === k;
    const style = `padding:6px 13px;border-radius:8px;font-size:13px;font-weight:500;border:1px solid ${sel ? "var(--accent)" : "var(--border)"};color:${sel ? "var(--accent)" : "var(--fg-55)"};background:${sel ? "var(--accent-soft)" : "transparent"};transition:all .12s ease`;
    return `<button data-act="setSearchType" data-arg="${k}" style="${style}">${label}</button>`;
  }).join("");

  let body: string;
  if (s.searchResults.status === "loading") {
    body = notice("Searching&hellip;");
  } else {
    const cards = filtered.map((r) => {
      const idx = sq ? r.snippet.toLowerCase().indexOf(sq) : -1;
      const pre = idx >= 0 ? r.snippet.slice(0, idx) : r.snippet;
      const mid = idx >= 0 ? r.snippet.slice(idx, idx + sq.length) : "";
      const post = idx >= 0 ? r.snippet.slice(idx + sq.length) : "";
      const badgeColor = r.type === "adr" ? "var(--blue)" : r.type === "feed" ? "var(--fg-70)" : "var(--accent)";
      const badgeBorder = r.type === "adr" ? "color-mix(in srgb,var(--blue) 45%,transparent)" : r.type === "feed" ? "var(--border-strong)" : "color-mix(in srgb,var(--accent) 45%,transparent)";
      const label = typeLabel[r.type] ?? r.type;
      const icon = typeIcon[r.type] ?? typeIcon["doc"];
      // G3: adr results are NOT navigable (no adr detail route). doc → openDocFrom, feed → goFeed.
      if (r.type === "adr") {
        return `<div class="cnpy-card" style="display:block;width:100%;text-align:left;border:1px solid var(--border);border-radius:12px;padding:16px 18px;margin-bottom:10px">
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:9px">
            <span style="display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:600;font-family:var(--mono);letter-spacing:.04em;text-transform:uppercase;padding:2px 7px;border-radius:5px;color:${badgeColor};border:1px solid ${badgeBorder}"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="${icon}"></path></svg>${label}</span>
          </div>
          <div style="font-size:14.5px;font-weight:500;letter-spacing:-0.01em;margin-bottom:6px">${esc(r.title)}</div>
          <div style="font-size:13px;line-height:1.6;color:var(--fg-55)">${esc(pre)}${mid ? `<span style="background:var(--accent-soft);color:var(--accent);border-radius:3px;padding:0 3px;font-weight:500">${esc(mid)}</span>` : ""}${esc(post)}</div>
        </div>`;
      }
      const act = r.type === "feed" ? `data-act="goFeed"` : `data-act="openDocFrom" data-arg="${attr(r.id)}"`;
      return `<button ${act} class="cnpy-card" style="display:block;width:100%;text-align:left;border:1px solid var(--border);border-radius:12px;padding:16px 18px;margin-bottom:10px;cursor:pointer">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:9px">
          <span style="display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:600;font-family:var(--mono);letter-spacing:.04em;text-transform:uppercase;padding:2px 7px;border-radius:5px;color:${badgeColor};border:1px solid ${badgeBorder}"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="${icon}"></path></svg>${label}</span>
        </div>
        <div style="font-size:14.5px;font-weight:500;letter-spacing:-0.01em;margin-bottom:6px">${esc(r.title)}</div>
        <div style="font-size:13px;line-height:1.6;color:var(--fg-55)">${esc(pre)}${mid ? `<span style="background:var(--accent-soft);color:var(--accent);border-radius:3px;padding:0 3px;font-weight:500">${esc(mid)}</span>` : ""}${esc(post)}</div>
      </button>`;
    }).join("");

    const empty = s.searchResults.status === "ok" && filtered.length === 0
      ? notice("No results for that query.")
      : "";
    body = `${cards}${empty}`;
  }

  return `<div style="max-width:780px;margin:0 auto;padding:32px 24px 100px">
    <div style="display:flex;align-items:center;gap:11px;border:1px solid var(--border-strong);border-radius:12px;padding:0 16px;height:52px;margin-bottom:18px">
      <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="flex:none;color:var(--fg-40)"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.2-3.2"></path></svg>
      <input data-act="setSearch" data-field="search" value="${attr(s.searchQuery)}" placeholder="Search the store — feed, docs, decisions" style="flex:1;border:none;outline:none;background:transparent;color:var(--fg);font-size:16px" />
      <kbd style="font-family:var(--mono);font-size:11px;color:var(--fg-40);border:1px solid var(--border);border-radius:5px;padding:2px 6px">⌘K</kbd>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:20px">
      <div style="display:flex;align-items:center;gap:7px">${typeChips}</div>
      <span style="font-size:12.5px;color:var(--fg-40);font-family:var(--mono)">${filtered.length} results</span>
    </div>
    ${body}
  </div>`;
}

// ── settings ─────────────────────────────────────────────────────────────────
function settingsView(s: AppState): string {
  const themeCards = [
    ["light", "Light"],
    ["dark", "Dark"],
    ["system", "System"],
  ].map(([k, label]) => {
    const sel = s.theme === k;
    const style = `flex:1;display:flex;flex-direction:column;align-items:center;gap:9px;padding:16px 12px;border-radius:11px;border:1px solid ${sel ? "var(--accent)" : "var(--border)"};background:${sel ? "var(--accent-soft)" : "transparent"};color:${sel ? "var(--accent)" : "var(--fg-70)"}`;
    const icon = k === "light"
      ? `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="4.2"></circle><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"></path></svg>`
      : k === "dark"
      ? `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"></path></svg>`
      : `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="13" rx="2"></rect><path d="M8 21h8M12 17v4"></path></svg>`;
    return `<button data-act="setTheme" data-arg="${k}" class="cnpy-themecard" style="${style}">${icon}<span style="font-size:13px;font-weight:500">${label}</span></button>`;
  }).join("");

  const reveal = s.revealedToken ? `<div style="border:1px solid var(--accent);border-radius:11px;padding:16px;margin-bottom:14px;background:var(--accent-soft)">
      <div style="display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600;color:var(--accent);margin-bottom:10px"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01"></path><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path></svg>Copy this now — it won't be shown again</div>
      <div style="display:flex;align-items:center;gap:10px;background:var(--bg);border:1px solid var(--border-strong);border-radius:8px;padding:11px 13px">
        <code style="flex:1;font-family:var(--mono);font-size:13px;color:var(--fg);word-break:break-all">${esc(s.revealedToken!)}</code>
        <button data-act="dismissReveal" class="cnpy-outlinebtn" style="flex:none;padding:6px 12px;border-radius:7px;border:1px solid var(--border-strong);font-size:12px;font-weight:500">Done</button>
      </div>
    </div>` : "";

  // No GET route for existing tokens — list is empty with a note.
  const tokenListBody = `<div style="padding:14px 18px;font-size:12.5px;color:var(--fg-40)">Existing tokens aren't listed here.</div>`;

  const meLogin = s.me?.login ?? "";
  const meName = s.me?.name ?? meLogin;
  const meOrg = s.me?.org ?? "";

  return `<div style="max-width:680px;margin:0 auto;padding:32px 24px 100px">
    <section style="margin-bottom:14px">
      <div style="font-size:11px;font-weight:600;font-family:var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--fg-40);margin-bottom:14px">Profile</div>
      <div style="border:1px solid var(--border);border-radius:13px;padding:22px">
        <div style="display:flex;align-items:center;gap:16px;margin-bottom:22px">
          <div style="width:56px;height:56px;border-radius:50%;${AVATAR};font-size:18px;font-weight:600;flex:none">${esc(initialsOf(meLogin || "?"))}</div>
          <div>
            <div style="display:flex;align-items:center;gap:8px"><span style="font-size:15px;font-weight:600">${esc(meName)}</span><span style="font-size:10px;font-weight:600;font-family:var(--mono);color:var(--fg-40);border:1px solid var(--border);border-radius:5px;padding:2px 6px">GITHUB</span></div>
            <div style="font-size:12.5px;color:var(--fg-40);font-family:var(--mono);margin-top:3px">${esc(meLogin)}</div>
            <div style="font-size:11.5px;color:var(--fg-40);margin-top:5px">Avatar is imported from GitHub and can't be changed here.</div>
          </div>
        </div>
        <div>
          <label style="display:block;font-size:13px;font-weight:500;margin-bottom:8px">Display name</label>
          <div style="display:flex;gap:10px">
            <input data-act="setDisplayName" data-field="displayName" value="${attr(s.displayName)}" class="cnpy-input" style="flex:1;height:40px;padding:0 13px;border:1px solid var(--border-strong);border-radius:9px;background:transparent;color:var(--fg);font-size:14px;outline:none" />
            <button data-act="saveProfile" class="cnpy-accentbtn" style="padding:0 18px;height:40px;border-radius:9px;background:var(--accent);color:var(--accent-fg);font-size:13.5px;font-weight:600">Save</button>
          </div>
          <div style="font-size:11.5px;color:var(--fg-40);margin-top:8px">This is what shows in the feed and on your identity chip. Defaults to your GitHub login.</div>
        </div>
      </div>
    </section>

    <section style="margin-bottom:14px;margin-top:34px">
      <div style="font-size:11px;font-weight:600;font-family:var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--fg-40);margin-bottom:14px">Appearance</div>
      <div style="display:flex;gap:12px">${themeCards}</div>
      <div style="font-size:11.5px;color:var(--fg-40);margin-top:10px">System follows your operating system's appearance.</div>
    </section>

    <section style="margin-bottom:14px;margin-top:34px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <div style="font-size:11px;font-weight:600;font-family:var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--fg-40)">MCP access tokens</div>
        <button data-act="mintToken" class="cnpy-mintbtn" style="display:inline-flex;align-items:center;gap:7px;padding:7px 13px;border-radius:8px;border:1px solid var(--accent);color:var(--accent);font-size:12.5px;font-weight:600;background:var(--accent-soft)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12h14"></path></svg>Mint new token</button>
      </div>
      ${reveal}
      <div style="border:1px solid var(--border);border-radius:13px;overflow:hidden">${tokenListBody}</div>
      <div style="font-size:11.5px;color:var(--fg-40);margin-top:10px">Tokens authorize agents to write to Canopy over MCP. Revoking takes effect immediately.</div>
    </section>

    <section style="margin-top:34px">
      <div style="font-size:11px;font-weight:600;font-family:var(--mono);text-transform:uppercase;letter-spacing:.1em;color:var(--fg-40);margin-bottom:14px">Account</div>
      <div style="border:1px solid var(--border);border-radius:13px;padding:18px 20px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap">
        <div style="display:flex;align-items:center;gap:13px">
          <div style="width:38px;height:38px;border-radius:50%;${AVATAR};font-size:12px;font-weight:600;flex:none">${esc(initialsOf(meLogin || "?"))}</div>
          <div>
            <div style="font-size:13.5px;font-weight:500">${esc(meLogin)}</div>
            <div style="display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--green);margin-top:3px"><span style="width:6px;height:6px;border-radius:50%;background:var(--green)"></span>Member of <b>${esc(meOrg)}</b></div>
          </div>
        </div>
        <button data-act="signOut" class="cnpy-signout" style="padding:9px 16px;border-radius:9px;border:1px solid var(--border-strong);font-size:13px;font-weight:500">Sign out</button>
      </div>
    </section>
  </div>`;
}

// ── root ─────────────────────────────────────────────────────────────────────
function screenBody(s: AppState): string {
  switch (s.screen) {
    case "feed": return feedView(s);
    case "docs": return docsView(s);
    case "roadmap": return roadmapView(s);
    case "triage": return triageView(s);
    case "search": return searchView(s);
    case "settings": return settingsView(s);
    default: return feedView(s);
  }
}

function appView(s: AppState): string {
  return `<div style="display:flex;height:100vh;overflow:hidden">
    ${sidebar(s)}
    <main style="flex:1;display:flex;flex-direction:column;min-width:0;background:var(--bg)">
      ${header(s)}
      <div class="cnpy-scroll" style="flex:1;overflow-y:auto;min-height:0">${screenBody(s)}</div>
    </main>
  </div>`;
}

function toastBlock(msg: string): string {
  return `<div style="position:fixed;bottom:22px;left:50%;transform:translateX(-50%);z-index:50;display:flex;align-items:center;gap:9px;padding:10px 16px;border:1px solid var(--border-strong);border-radius:10px;background:var(--bg);box-shadow:0 8px 30px rgba(0,0,0,.35);font-size:13px;animation:cnpy-pop .25s ease both">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.4"><path d="M20 6 9 17l-5-5"></path></svg>${msg}
  </div>`;
}

export function render(s: AppState): string {
  const dark = resolved(s) === "dark";
  const themeAttr = dark ? "dark" : "light";
  return `<div data-cnpy-theme="${themeAttr}" data-screen="${s.screen}" data-collapsed="${s.collapsed ? "1" : "0"}" data-author="${s.feedAuthor}" data-tq="${s.triageQueue}" style="background:var(--bg);color:var(--fg);min-height:100vh;font-family:'Geist',system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased">
    ${s.view === "auth" ? authView(s) : appView(s)}
    ${s.toast ? toastBlock(s.toast) : ""}
  </div>`;
}
