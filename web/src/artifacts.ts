// The Artifacts screens (Knowledge › Artifacts) — ported from the Claude Design
// `Canopy Artifacts.dc.html`: the library, one artifact's viewer (with its
// version menu, status and visibility controls, properties and linked work), the
// version diff, the new-artifact form, and the not-found page. Plus the two
// dialogs (ratify, attach to a ticket) and the ticket detail's Artifacts block.
//
// UI ONLY for now. The artifact store — R2 bodies, D1 rows, the MCP upload tool,
// the promote-class status writes — is not built, so every screen reads the
// sample set in artifacts-sample.ts and every "write" (publish, ratify, attach,
// upload) edits that session copy and nothing else. The library says so on screen.
//
// Shape: pure views over props (render.ts calls them), plus ONE reducer,
// `artifactsAct`, that main.ts hands every `art*` act to. The reducer never
// touches the DOM; what it cannot do itself (navigate, toast, download, open a
// tab, copy) it returns as an effect for main.ts to perform.

import { esc, attr } from "./ui";
import { renderMarkdown } from "./markdown";
import { collapsedLineDiff } from "./diff";
import type { PersonColor } from "@shared/rows";

// ── the model (what the store will hold) ─────────────────────────────────────

export type ArtifactKind = "html" | "markdown" | "svg" | "mermaid";
export type ArtifactStatus = "draft" | "published" | "ratified";
export type ArtifactVisibility = "org" | "private";
export interface ArtifactVersion { v: number; by: string; when: string; summary: string; src: string }
export interface ArtifactLinks { tickets: number[]; sprints: string[]; issues: number[]; prs: number[] }
export interface SampleArtifact {
  slug: string;
  title: string;
  kind: ArtifactKind;
  area: string;
  repo: string;
  author: string;
  status: ArtifactStatus;
  visibility: ArtifactVisibility;
  links: ArtifactLinks;
  versions: ArtifactVersion[];
  ratified: { v: number; by: string; when: string } | null;
}

export const ARTIFACT_AREAS = ["auth", "architecture", "infra", "api", "ui", "data"] as const;
export const ARTIFACT_KINDS: readonly ArtifactKind[] = ["html", "markdown", "svg", "mermaid"];
export const ARTIFACT_REPOS = ["SaplingLearn/canopy", "SaplingLearn/sapling"] as const;

/** The sample's own people, tickets and sprints — what its links and bylines point at. */
export interface ArtRef {
  people: Record<string, { name: string; color: PersonColor }>;
  tickets: { id: number; title: string; status: "submitted" | "in_progress" | "done" | "declined" }[];
  sprints: { label: string; dates: string; active: boolean }[];
}
const NO_REF: ArtRef = { people: {}, tickets: [], sprints: [] };

// ── state ────────────────────────────────────────────────────────────────────

export type ArtFilterKey = "area" | "kind" | "author" | "status" | "sprint";
export const ART_FILTER_KEYS: readonly ArtFilterKey[] = ["area", "kind", "author", "status", "sprint"];
export type ArtFilters = Record<ArtFilterKey, string>;
const NO_FILTERS: ArtFilters = { area: "all", kind: "all", author: "all", status: "all", sprint: "all" };

export interface ArtLinkDraft { kind: "ticket" | "sprint" | "PR" | "issue"; label: string; n: number | null }
export interface ArtCreate {
  title: string;
  kind: ArtifactKind;
  area: string;
  repo: string;
  vis: ArtifactVisibility;
  links: ArtLinkDraft[];
  linkDraft: string;
  linkErr: boolean;
  tab: "paste" | "file" | "url";
  paste: string;
  file: { name: string; size: number; text: string } | null;
  url: string;
}
export interface ArtUi {
  /** The session's copy of the sample set; null until its dynamic import lands. */
  items: SampleArtifact[] | null;
  /** The sample's people / tickets / sprints (arrive with `items`). */
  ref: ArtRef | null;
  q: string;
  f: ArtFilters;
  filterOpen: boolean;
  filterCat: ArtFilterKey;
  verMenu: boolean;
  dotMenu: boolean;
  ratifyOpen: boolean;
  attachOpen: boolean;
  attachQ: string;
  attachPick: number | null;
  c: ArtCreate;
}
export function initialArtCreate(): ArtCreate {
  return { title: "", kind: "html", area: "ui", repo: ARTIFACT_REPOS[0], vis: "org", links: [], linkDraft: "", linkErr: false, tab: "paste", paste: "", file: null, url: "" };
}
export function initialArtUi(): ArtUi {
  return {
    items: null, ref: null, q: "", f: { ...NO_FILTERS }, filterOpen: false, filterCat: "area",
    verMenu: false, dotMenu: false, ratifyOpen: false, attachOpen: false, attachQ: "", attachPick: null,
    c: initialArtCreate(),
  };
}

/** The three Artifacts screens. `artifact` is one artifact: its viewer, or its diff when `diff` is set. */
export type ArtScreen = "artifacts" | "artifactnew" | "artifact";
export interface ArtRoute { slug: string | null; v: number | null; diff: { a: number; b: number } | null }
export const ART_ROUTE_NONE: ArtRoute = { slug: null, v: null, diff: null };

export interface ArtPerson { handle: string; name: string | null; color: PersonColor }
export interface ArtProps {
  screen: ArtScreen;
  route: ArtRoute;
  ui: ArtUi;
  /** The signed-in handle — the author check for private artifacts and the visibility toggle. */
  me: string;
  persons: ArtPerson[];
  /** `location.host` in the browser; the address strips print it. */
  host: string;
}

// ── constants (the design's) ─────────────────────────────────────────────────

export const ART_CAP = 500 * 1024;
const CLAUDE_MARKERS = ["window.claude", "window.storage", "api.anthropic.com"];
const REPO_URL = "https://github.com/SaplingLearn/canopy";
const EXT: Record<ArtifactKind, string> = { html: "html", markdown: "md", svg: "svg", mermaid: "mmd" };
const KIND_ICON: Record<ArtifactKind, string> = {
  html: "M8 7 3 12l5 5M16 7l5 5-5 5",
  markdown: "M6 3h7l5 5v13H6zM13 3v5h5M9 13h6M9 17h6",
  svg: "M12 3 21 12 12 21 3 12z",
  mermaid: "M4 4h6v6H4zM14 14h6v6h-6zM10 7h4.5a2.5 2.5 0 0 1 2.5 2.5V14",
};

const CHIP = "font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.04em;border-radius:5px;padding:2px 6px;white-space:nowrap;flex:none;";
const tint = (c: string): string => `${CHIP}color:${c};border:1px solid color-mix(in srgb,${c} 45%,transparent);background:color-mix(in srgb,${c} 12%,transparent)`;
const STATUS: Record<ArtifactStatus, [string, string]> = {
  draft: ["DRAFT", tint("var(--amber)")], published: ["PUBLISHED", tint("var(--blue)")], ratified: ["RATIFIED", tint("var(--accent)")],
};
const TSTATUS: Record<string, [string, string]> = {
  submitted: ["SUBMITTED", tint("var(--blue)")], in_progress: ["IN PROGRESS", tint("var(--accent)")],
  done: ["DONE", CHIP + "color:var(--fg-55);border:1px solid var(--border-strong)"],
  declined: ["DECLINED", CHIP + "color:var(--red);border:1px solid color-mix(in srgb,var(--red) 35%,transparent);opacity:.75"],
};
const NEUTRAL = CHIP + "color:var(--fg-55);border:1px solid var(--border-strong)";
const MONO_VAL = "font-family:var(--mono);font-size:11.5px;color:var(--fg-70)";
const EYEBROW = "font-family:var(--mono);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40)";
const SHELL = "width:100%;max-width:1440px;margin:0 auto;padding:26px clamp(20px,2.6vw,46px) 100px";
const PANEL = "border:1px solid var(--border);border-radius:14px;background:color-mix(in srgb,var(--fg) 2.5%,transparent)";
const MENU = "background:var(--bg);border:1px solid var(--border-strong);border-radius:11px;box-shadow:0 14px 38px rgba(0,0,0,.3)";
const OUTLINE_BTN = "padding:7px 15px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70)";
const ACCENT_BTN = "padding:7px 15px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-size:12.5px;font-weight:600;white-space:nowrap";

const segSt = (on: boolean): string => `padding:4px 14px;border-radius:7px;font-size:12.5px;font-weight:500;white-space:nowrap;transition:all .12s ease;${on ? "color:var(--fg);background:var(--hover)" : "color:var(--fg-55);background:transparent"}`;
const chipSt = (on: boolean): string => `padding:5px 12px;border-radius:7px;font-size:12.5px;font-weight:500;white-space:nowrap;transition:all .12s ease;border:1px solid ${on ? "var(--accent);color:var(--accent);background:var(--accent-soft)" : "var(--border);color:var(--fg-55);background:transparent"}`;
const primarySt = (on: boolean): string => (on
  ? "background:var(--accent);color:var(--accent-fg);border:1px solid transparent;cursor:pointer"
  : "background:transparent;color:var(--fg-40);border:1px solid var(--border);cursor:default")
  + ";border-radius:8px;padding:7px 15px;font-size:12.5px;font-weight:600;transition:all .12s ease;display:inline-flex;align-items:center;gap:7px;white-space:nowrap";

const svg = (w: number, sw: number, paths: string, extra = ""): string =>
  `<svg width="${w}" height="${w}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" aria-hidden="true"${extra}>${paths}</svg>`;
const I = {
  plus: (w = 14, sw = 2.2) => svg(w, sw, `<path d="M12 5v14M5 12h14"></path>`),
  search: () => svg(14, 1.8, `<circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.2-3.2"></path>`, ` style="flex:none"`),
  x: () => svg(10, 2.4, `<path d="M5 5l14 14M19 5 5 19"></path>`),
  caret: () => svg(10, 2.6, `<path d="m6 9 6 6 6-6"></path>`, ` style="opacity:.7"`),
  check: (color = "var(--accent)", st = "") => `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.6" aria-hidden="true" style="${st}"><path d="M20 6 9 17l-5-5"></path></svg>`,
  lock: () => svg(13, 2, `<rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path>`),
  people: (w = 13) => svg(w, 2, `<circle cx="9" cy="8" r="3.2"></circle><path d="M3.5 19c.8-3 3-4.6 5.5-4.6s4.7 1.6 5.5 4.6"></path><path d="M16 5.2a3 3 0 0 1 0 5.6M18 14.6c1.3.7 2.1 2.2 2.5 4.4"></path>`),
  history: () => svg(14, 1.8, `<path d="M3 3v6h6"></path><path d="M3.5 9a9 9 0 1 0 2.3-3.3L3 9"></path><path d="M12 8v4l3 2"></path>`),
  compare: () => svg(13, 2, `<path d="M8 3v12M16 21V9"></path><path d="m5 6 3-3 3 3M13 18l3 3 3-3"></path>`),
  shield: () => svg(11, 2.2, `<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.3 7.5 9.5 4.3-1.2 7.5-4.9 7.5-9.5V6z"></path><path d="m9 12 2.2 2.2L15.5 10"></path>`),
  ext: () => svg(14, 1.8, `<path d="M14 4h6v6"></path><path d="M20 4 11 13"></path><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"></path>`),
  link: () => svg(14, 1.8, `<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"></path><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"></path>`),
  download: () => svg(14, 1.8, `<path d="M12 4v11"></path><path d="m7 10 5 5 5-5"></path><path d="M5 20h14"></path>`),
  arrow: (w = 13) => svg(w, 2, `<path d="M5 12h14M13 6l6 6-6 6"></path>`),
  ticket: () => svg(13, 1.9, `<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"></path>`),
  flag: (w = 13) => svg(w, 1.9, `<path d="M5 21V4"></path><path d="M5 4.5C7 3 9 3 12 4.5s5 1.5 7 0V13c-2 1.5-4 1.5-7 0s-5-1.5-7 0"></path>`),
  file: () => svg(14, 1.8, `<path d="M6 3h7l5 5v13H6z"></path><path d="M13 3v5h5"></path>`),
  upload: () => svg(22, 1.7, `<path d="M12 16V4"></path><path d="m7 9 5-5 5 5"></path><path d="M5 20h14"></path>`, ` style="color:var(--fg-40);margin-bottom:6px"`),
  alert: () => `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="2" aria-hidden="true" style="flex:none;margin-top:2px"><circle cx="12" cy="12" r="9"></circle><path d="M12 7.5v5.5M12 16.5v.01"></path></svg>`,
  kind: (k: ArtifactKind) => `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="${KIND_ICON[k]}"></path></svg>`,
  dots: () => `<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7"></circle><circle cx="12" cy="12" r="1.7"></circle><circle cx="19" cy="12" r="1.7"></circle></svg>`,
  gh: (w = 13) => `<svg width="${w}" height="${w}" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"></path></svg>`,
};

// ── helpers ──────────────────────────────────────────────────────────────────

const latestOf = (a: SampleArtifact): ArtifactVersion => a.versions[a.versions.length - 1];
export const canSee = (a: SampleArtifact, me: string): boolean => a.visibility === "org" || a.author === me;

/** "3h ago" → minutes, for the library's newest-first order (the sample's times are relative strings). */
function ageMins(w: string): number {
  if (!w || w === "just now") return 0;
  const m = /(\d+)\s*([mhd])/.exec(w);
  if (!m) return 0;
  return Number(m[1]) * (m[2] === "m" ? 1 : m[2] === "h" ? 60 : 1440);
}
export const fmtKB = (b: number): string => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(2)} MB` : `${(b / 1024).toFixed(1)} KB`);
export const slugifyTitle = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

interface Who { handle: string; name: string; first: string; color: PersonColor; ini: string }
function who(p: ArtProps, handle: string): Who {
  const live = p.persons.find((x) => x.handle.toLowerCase() === handle.toLowerCase());
  const sample = (p.ui.ref ?? NO_REF).people[handle];
  const name = live?.name || sample?.name || handle;
  const color: PersonColor = live?.color ?? sample?.color ?? "stone";
  const parts = name.trim().split(/\s+/);
  const ini = (parts.length >= 2 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase();
  return { handle, name, first: parts[0], color, ini };
}
/** The design's rounded-square avatar (it scales with --corner-scale like every other radius). */
const av = (w: Who, size: number): string =>
  `<span style="width:${size}px;height:${size}px;border-radius:${size >= 24 ? 12 : size >= 18 ? 11 : 10}px;background:var(--p-${w.color});display:grid;place-items:center;font-size:${Math.max(8, Math.round(size * 0.42))}px;font-weight:600;color:#fff;flex:none">${esc(w.ini)}</span>`;

/** Bytes of the create form's current content (the file's own size for an upload). */
export function createBytes(c: ArtCreate): number {
  if (c.tab === "file") return c.file ? c.file.size : 0;
  return new TextEncoder().encode(createText(c)).length;
}
export function createText(c: ArtCreate): string {
  if (c.tab === "paste") return c.paste;
  if (c.tab === "file") return c.file ? c.file.text : "";
  return "";
}

/** `#10`, `Sprint 14`, a GitHub PR / issue URL, `pr 12` / `issue 12` — else null. */
export function parseArtLink(raw: string): ArtLinkDraft | null {
  const s = raw.trim();
  let m: RegExpExecArray | null;
  if (!s) return null;
  if ((m = /^#?(\d+)$/.exec(s))) return { kind: "ticket", label: "#" + m[1], n: Number(m[1]) };
  if ((m = /\/pull\/(\d+)/.exec(s)) || (m = /^pr\s*#?(\d+)$/i.exec(s))) return { kind: "PR", label: "#" + m[1], n: Number(m[1]) };
  if ((m = /\/issues\/(\d+)/.exec(s)) || (m = /^issue\s*#?(\d+)$/i.exec(s))) return { kind: "issue", label: "#" + m[1], n: Number(m[1]) };
  if ((m = /^sprint\s*(\d+)$/i.exec(s))) return { kind: "sprint", label: "Sprint " + m[1], n: null };
  return null;
}

/** The artifact a route names, when the signed-in person may see it. */
export function routeArtifact(p: Pick<ArtProps, "route" | "ui" | "me">): SampleArtifact | null {
  const a = p.ui.items?.find((x) => x.slug === p.route.slug) ?? null;
  return a && canSee(a, p.me) ? a : null;
}
function routeVersion(a: SampleArtifact, r: ArtRoute): ArtifactVersion {
  return (r.v !== null ? a.versions.find((x) => x.v === r.v) : undefined) ?? latestOf(a);
}

// ── header (title, crumbs, the library's New artifact button) ────────────────

export function artifactsHeader(p: ArtProps): { title: string; crumb: string; controls: string } {
  const titleTop = `<h1 style="font-size:15px;font-weight:600;letter-spacing:-0.01em;margin:0">Artifacts</h1>`;
  const titleBack = `<h1 style="font-size:15px;font-weight:600;letter-spacing:-0.01em;margin:0;white-space:nowrap;flex:none"><button data-act="goArtifacts" style="font-size:15px;font-weight:600;letter-spacing:-0.01em;padding:0;color:var(--fg-55);cursor:pointer">Artifacts</button></h1>`;
  const crumbSt = (last: boolean) => `font-size:13px;font-weight:500;color:${last ? "var(--fg-70)" : "var(--fg-55)"};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;padding:0;cursor:${last ? "default" : "pointer"}`;
  const crumb = (label: string, act: string | null, arg = "") =>
    `<span style="display:inline-flex;align-items:center;gap:10px;min-width:0"><span style="color:var(--fg-40);font-size:13px">›</span>${act
      ? `<button data-act="${act}" data-arg="${attr(arg)}" style="${crumbSt(false)}">${esc(label)}</button>`
      : `<span style="${crumbSt(true)}">${esc(label)}</span>`}</span>`;

  if (p.screen === "artifacts") {
    return {
      title: titleTop, crumb: "",
      controls: `<button data-act="artNew" class="cnpy-accentbtn" style="display:flex;align-items:center;gap:7px;${ACCENT_BTN};padding:7px 14px">${I.plus()}New artifact</button>`,
    };
  }
  if (p.screen === "artifactnew") return { title: titleBack, crumb: crumb("New artifact", null), controls: "" };
  const a = p.ui.items ? routeArtifact(p) : null;
  if (!p.ui.items) return { title: titleBack, crumb: "", controls: "" };
  if (!a) return { title: titleBack, crumb: crumb("Not found", null), controls: "" };
  if (p.route.diff) return { title: titleBack, crumb: crumb(a.title, "artOpen", a.slug) + crumb("Compare", null), controls: "" };
  return { title: titleBack, crumb: crumb(a.title, null), controls: "" };
}

// ── screens ──────────────────────────────────────────────────────────────────

export function artifactsView(p: ArtProps): string {
  if (!p.ui.items) return `<div style="padding:80px 24px;text-align:center;color:var(--fg-40);font-size:13px">Loading artifacts&hellip;</div>`;
  if (p.screen === "artifacts") return libraryView(p);
  if (p.screen === "artifactnew") return createView(p);
  const a = routeArtifact(p);
  if (!a) return notFoundView(p);
  return p.route.diff ? diffView(p, a, p.route.diff) : viewerView(p, a);
}

/** The strip that says what this screen is showing while the store does not exist. */
function previewNote(): string {
  return `<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 14px;border:1px dashed var(--border-strong);border-radius:9px;margin-bottom:18px;font-size:12.5px;color:var(--fg-55);line-height:1.45">
    <span style="${tint("var(--blue)")}">PREVIEW</span>
    <span style="flex:1;min-width:220px">These are sample artifacts. The artifact store isn't built yet, so uploads, versions, ratification and attaching live in this tab only and are gone on reload.</span>
  </div>`;
}

// ── 1 · library ──────────────────────────────────────────────────────────────

interface FilterGroup { key: ArtFilterKey; label: string; options: { v: string; l: string }[] }

function libraryGroups(p: ArtProps, visible: SampleArtifact[]): FilterGroup[] {
  const authors = [...new Set(visible.map((a) => a.author))];
  return [
    { key: "area", label: "Area", options: [{ v: "all", l: "All areas" }, ...ARTIFACT_AREAS.map((x) => ({ v: x, l: x }))] },
    { key: "kind", label: "Kind", options: [{ v: "all", l: "All kinds" }, ...ARTIFACT_KINDS.map((x) => ({ v: x, l: x }))] },
    { key: "author", label: "Author", options: [{ v: "all", l: "Any author" }, ...authors.map((h) => ({ v: h, l: who(p, h).name }))] },
    { key: "status", label: "Status", options: [{ v: "all", l: "Any status" }, ...(["draft", "published", "ratified"] as const).map((x) => ({ v: x, l: x[0].toUpperCase() + x.slice(1) }))] },
    { key: "sprint", label: "Sprint", options: [{ v: "all", l: "Any sprint" }, ...(p.ui.ref ?? NO_REF).sprints.map((x) => ({ v: x.label, l: x.label }))] },
  ];
}

const matchesFilter = (a: SampleArtifact, k: ArtFilterKey, v: string): boolean =>
  v === "all" || (k === "sprint" ? a.links.sprints.includes(v) : k === "area" ? a.area === v : k === "kind" ? a.kind === v : k === "author" ? a.author === v : a.status === v);

export function libraryRows(p: ArtProps): SampleArtifact[] {
  const items = p.ui.items ?? [];
  const q = p.ui.q.trim().toLowerCase();
  return items
    .filter((a) => canSee(a, p.me))
    .filter((a) => ART_FILTER_KEYS.every((k) => matchesFilter(a, k, p.ui.f[k])))
    .filter((a) => {
      if (!q) return true;
      const tix = a.links.tickets.map((id) => `#${id} ticket ${id} ${(p.ui.ref ?? NO_REF).tickets.find((t) => t.id === id)?.title ?? ""}`).join(" ");
      return `${a.title} ${a.slug} ${a.area} ${a.kind} ${tix}`.toLowerCase().includes(q);
    })
    .sort((x, y) => ageMins(latestOf(x).when) - ageMins(latestOf(y).when));
}

function libraryView(p: ArtProps): string {
  const ui = p.ui;
  const visible = (ui.items ?? []).filter((a) => canSee(a, p.me));
  const rows = libraryRows(p);
  const groups = libraryGroups(p, visible);
  const active = ART_FILTER_KEYS.filter((k) => ui.f[k] !== "all").length;
  const anyFilter = ui.q.trim() !== "" || active > 0;
  const rowBase = "display:flex;align-items:center;gap:9px;width:100%;text-align:left;padding:7px 10px;border-radius:7px;font-size:12.5px;font-weight:500;";
  const cat = groups.find((g) => g.key === ui.filterCat) ?? groups[0];

  const popover = ui.filterOpen ? `<div data-act="artFilterClose" style="position:fixed;inset:0;z-index:29"></div>
    <div role="dialog" aria-label="Filter artifacts" style="position:absolute;top:calc(100% + 6px);left:0;right:0;min-width:300px;z-index:30;${MENU};transform-origin:top left;animation:cnpy-drop .18s cubic-bezier(.2,.8,.2,1) both;display:flex;flex-direction:column;overflow:hidden">
      <div style="display:grid;grid-template-columns:136px minmax(0,1fr);height:188px">
        <div style="border-right:1px solid var(--border);padding:6px;display:flex;flex-direction:column;gap:1px">
          ${groups.map((g) => `<button data-act="artFilterCat" data-arg="${g.key}" class="cnpy-menurow" style="${rowBase}${g.key === cat.key ? "color:var(--fg);background:var(--hover)" : "color:var(--fg-55)"}">
            <span style="flex:1;min-width:0">${esc(g.label)}</span>${ui.f[g.key] !== "all" ? `<span style="width:6px;height:6px;border-radius:4px;background:var(--accent);flex:none"></span>` : ""}
          </button>`).join("")}
        </div>
        <div class="cnpy-scroll" style="overflow-y:auto;padding:6px;min-width:0">
          ${cat.options.map((o) => {
            const on = ui.f[cat.key] === o.v;
            const n = o.v === "all" ? visible.length : visible.filter((a) => matchesFilter(a, cat.key, o.v)).length;
            const person = cat.key === "author" && o.v !== "all" ? who(p, o.v) : null;
            return `<button data-act="artFilterPick" data-arg="${attr(`${cat.key}:${o.v}`)}" class="cnpy-menurow art-fopt" style="${rowBase}${on ? "color:var(--fg)" : "color:var(--fg-70)"}">
              <span style="width:14px;flex:none;display:grid;place-items:center">${on ? I.check() : ""}</span>
              ${person ? av(person, 18) : ""}
              <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(o.l)}</span>
              <span style="font-family:var(--mono);font-size:10.5px;font-weight:600;color:var(--fg-40);flex:none">${n}</span>
            </button>`;
          }).join("")}
        </div>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-top:1px solid var(--border)">
        <button data-act="artFilterClear" class="cnpy-mutelink" style="font-size:12px;font-weight:500;padding:2px 0;color:${anyFilter ? "var(--fg-55)" : "var(--fg-40);opacity:.5"}">Clear all</button>
        <button data-act="artFilterClose" class="cnpy-accentbtn" style="${ACCENT_BTN};padding:6px 14px">Show ${rows.length} ${rows.length === 1 ? "artifact" : "artifacts"}</button>
      </div>
    </div>` : "";

  const toolbar = `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 4px">
    <div style="position:relative;display:flex;align-items:stretch;flex:1 1 260px;max-width:480px;min-width:0;height:34px">
      <div class="cnpy-search" style="flex:1;min-width:0;padding:0 11px;border-radius:7px 0 0 7px;border-color:var(--border-strong)">
        ${I.search()}
        <input data-act="artQ" data-field="artQ" class="cnpy-search-in" style="font-size:12.5px" placeholder="Search by title, area, kind or ticket" value="${attr(ui.q)}" autocomplete="off" spellcheck="false">
        ${ui.q ? `<button data-act="artClearQ" aria-label="Clear search" class="cnpy-xbtn" style="width:16px;height:16px;display:grid;place-items:center;color:var(--fg-40);flex:none">${I.x()}</button>` : ""}
      </div>
      <div style="display:flex">
        <button data-act="artFilterToggle" aria-haspopup="dialog" aria-expanded="${ui.filterOpen}" class="cnpy-ghostbtn" style="display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:500;border-radius:0 7px 7px 0;margin-left:-1px;height:100%;padding:0 11px 0 12px;white-space:nowrap;border:1px solid var(--border-strong);${ui.filterOpen ? "color:var(--fg);background:var(--hover)" : "color:var(--fg-70)"}">
          ${svg(14, 1.8, `<path d="M4 6h16"></path><path d="M7 12h10"></path><path d="M10 18h4"></path>`)}
          Filter
          ${active ? `<span style="font-family:var(--mono);font-size:10.5px;font-weight:600;min-width:18px;height:18px;line-height:18px;padding:0 5px;border-radius:6px;text-align:center;color:var(--accent-fg);background:var(--accent)">${active}</span>` : ""}
          ${I.caret()}
        </button>
        ${popover}
      </div>
    </div>
    <span style="font-family:var(--mono);font-size:10.5px;font-weight:600;color:var(--fg-40);white-space:nowrap;margin-left:auto;flex:none">${rows.length} shown · ${visible.length} total</span>
  </div>`;

  const card = (a: SampleArtifact, i: number): string => {
    const L = latestOf(a);
    const au = who(p, a.author);
    let preview = "";
    if (a.kind === "html" || a.kind === "svg") {
      const doc = a.kind === "svg"
        ? `<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#fff;color:#1a1814">${L.src.replace("<svg", '<svg style="max-width:90%;max-height:90vh"')}</body>`
        : L.src;
      // sandbox="" — no scripts, no same-origin: a preview thumbnail can do nothing.
      preview = `<iframe title="${attr(a.title)} preview" srcdoc="${attr(doc)}" sandbox="" tabindex="-1" loading="lazy" style="position:absolute;top:0;left:0;width:400%;height:400%;border:0;transform:scale(.25);transform-origin:0 0;pointer-events:none;background:#fff"></iframe>`;
    } else {
      const text = a.kind === "markdown"
        ? L.src.split("\n").map((l) => l.replace(/^#+\s*|^>\s*|[*_`|]/g, "").trim()).filter((l) => l && !/^-+$/.test(l)).slice(0, 7).join("\n")
        : L.src.split("\n").slice(0, 9).join("\n");
      preview = `<div style="padding:16px 20px;font-size:11.5px;line-height:1.6;color:var(--fg-55);white-space:pre-wrap;${a.kind === "mermaid" ? "font-family:var(--mono)" : ""}">${esc(text)}</div>`;
    }
    return `<button data-act="artOpen" data-arg="${attr(a.slug)}" class="cnpy-card cnpy-rise" style="--i:${i};border:1px solid var(--border);border-radius:14px;padding:0;background:color-mix(in srgb,var(--fg) 2.5%,transparent);display:flex;flex-direction:column;height:100%;width:100%;text-align:left;cursor:pointer;overflow:hidden">
      <div style="position:relative;height:160px;border-bottom:1px solid var(--border);overflow:hidden;background:var(--bg);flex:none">
        ${preview}
        <div style="position:absolute;left:0;right:0;bottom:0;height:36px;background:linear-gradient(to bottom,transparent,var(--bg));pointer-events:none"></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:12px;padding:14px 16px;flex:1">
        <div style="font-size:15px;font-weight:600;letter-spacing:-0.01em;line-height:1.35;color:var(--fg);text-wrap:pretty;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(a.title)}</div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:auto;min-width:0">
          ${av(au, 20)}
          <span style="font-size:12.5px;color:var(--fg-70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:48px;flex:0 1 auto">${esc(au.name)}</span>
          <span style="font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.05em;color:var(--fg-55);border:1px solid var(--border);border-radius:5px;padding:2px 6px;white-space:nowrap;flex:none">${esc(a.area)}</span>
          ${a.visibility === "private" ? `<span style="${tint("var(--amber)")}">PRIVATE</span>` : ""}
          <span style="font-size:11.5px;color:var(--fg-40);margin-left:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:0 1 auto">${esc(L.when)}</span>
        </div>
      </div>
    </button>`;
  };

  const empty = rows.length === 0 ? `<div style="display:flex;justify-content:center;padding:56px 0">
    <div style="border:1px dashed var(--border-strong);border-radius:13px;padding:36px 44px;text-align:center;max-width:380px">
      <div style="font-size:15px;font-weight:600;color:var(--fg-70)">No artifacts match these filters.</div>
      <div style="font-size:12.5px;color:var(--fg-40);margin-top:6px">${ui.q.trim() ? `Nothing matches “${esc(ui.q.trim())}” with the current filters.` : "Try another area or status, or clear the filters."}</div>
      <button data-act="artFilterClear" class="cnpy-outlinebtn" style="margin-top:16px;${OUTLINE_BTN};padding:6px 14px">Clear filters</button>
    </div>
  </div>` : "";

  return `<div data-screen-label="Library" style="${SHELL}">
    ${previewNote()}
    ${toolbar}
    <div class="cnpy-stagger" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(min(300px,100%),1fr));gap:14px;margin-top:18px">${rows.map(card).join("")}</div>
    ${empty}
  </div>`;
}

// ── 2 · viewer ───────────────────────────────────────────────────────────────

/** Measured document heights of framed HTML artifacts (key `slug@v`), so a rerender
 *  — which rebuilds the iframe — sizes the box right before the new frame loads. */
const frameHeights = new Map<string, number>();

function banner(tag: string, tagSt: string, body: string, actions: string): string {
  return `<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;padding:12px 14px;border:1px solid var(--border);border-radius:9px;margin-bottom:22px">
    <span style="font-size:10.5px;font-weight:600;font-family:var(--mono);letter-spacing:.04em;${tagSt};border-radius:5px;padding:3px 7px;flex:none">${tag}</span>
    <div style="flex:1;min-width:220px;font-size:12.5px;color:var(--fg-70);line-height:1.45">${body}</div>
    ${actions}
  </div>`;
}
const tagTint = (c: string): string => `color:${c};border:1px solid color-mix(in srgb,${c} 45%,transparent);background:color-mix(in srgb,${c} 12%,transparent)`;

function ratifyHint(a: SampleArtifact, isLatest: boolean, p: ArtProps): string {
  if (a.status === "draft") return "Publish before ratifying";
  if (a.status === "ratified" && a.ratified) return `Ratified v${a.ratified.v} by ${who(p, a.ratified.by).first} · ${a.ratified.when}`;
  if (!isLatest) return "Only the latest version can be ratified";
  return "";
}

function contentBlock(a: SampleArtifact, ver: ArtifactVersion): string {
  if (a.kind === "html") {
    const key = `${a.slug}@${ver.v}`;
    const h = frameHeights.get(key) ?? 800;
    // allow-same-origin WITHOUT allow-scripts: nothing in the page runs, and the
    // parent can read the document's height to size the box (fitArtifactFrames).
    return `<div class="art-frame" data-art-key="${attr(key)}" style="position:relative;overflow:hidden;background:#fff;height:${Math.round(h * 0.7)}px">
      <iframe title="${attr(a.title)}" srcdoc="${attr(ver.src)}" sandbox="allow-same-origin" style="position:absolute;top:0;left:0;border:0;background:#fff;transform-origin:0 0;width:1280px;height:${h}px"></iframe>
    </div>`;
  }
  if (a.kind === "svg") {
    const doc = `<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#fff;color:#1a1814">${ver.src.replace("<svg", '<svg style="max-width:94%;height:auto"')}</body>`;
    return `<div style="padding:24px;background:var(--bg)"><iframe title="${attr(a.title)}" srcdoc="${attr(doc)}" sandbox="" style="display:block;width:100%;height:340px;border:0;border-radius:7px;background:#fff"></iframe></div>`;
  }
  if (a.kind === "markdown") {
    const html = renderMarkdown(ver.src).replace(/<table>/g, '<div class="cnpy-md-tablewrap"><table>').replace(/<\/table>/g, "</table></div>");
    return `<div style="background:var(--bg);padding:36px clamp(20px,4vw,56px) 44px"><div class="cnpy-md" style="max-width:760px;margin:0 auto">${html}</div></div>`;
  }
  // mermaid: no diagram renderer ships yet, so the source is shown as what it is.
  return `<div style="background:var(--bg);padding:28px clamp(20px,4vw,48px) 32px">
    <div style="${EYEBROW};margin-bottom:10px">Mermaid source · diagram rendering isn't wired yet</div>
    <pre class="cnpy-scroll" style="margin:0;overflow-x:auto;padding:15px 16px;border:1px solid var(--border);border-radius:11px;background:color-mix(in srgb,var(--fg) 4%,var(--bg));font-family:var(--mono);font-size:12.5px;line-height:1.65;color:var(--fg-70)">${esc(ver.src)}</pre>
  </div>`;
}

function viewerView(p: ArtProps, a: SampleArtifact): string {
  const ui = p.ui;
  const L = latestOf(a);
  const ver = routeVersion(a, p.route);
  const isLatest = ver.v === L.v;
  const isPriv = a.visibility === "private";
  const author = who(p, a.author);
  const canRatify = a.status === "published" && isLatest;
  const hint = ratifyHint(a, isLatest, p);
  const many = a.versions.length > 1;
  const cmpBase = isLatest ? a.versions[a.versions.length - 2] : ver;

  const privBanner = isPriv && a.author === p.me ? banner("PRIVATE", tagTint("var(--amber)"),
    `Only you can see this artifact. Teammates who open the link get a not-found page until you <strong style="font-weight:600;color:var(--fg)">publish it to the org</strong>.`,
    `<button data-act="artPublish" class="cnpy-accentbtn" style="display:inline-flex;align-items:center;gap:7px;${ACCENT_BTN};padding:7px 14px;flex:none">${I.people(14)}Publish to org</button>`) : "";
  const oldBanner = !isLatest ? banner(`V${ver.v}`, tagTint("var(--blue)"),
    `You're viewing an <strong style="font-weight:600;color:var(--fg)">older version</strong> from ${esc(ver.when)}. The latest is v${L.v}.`,
    `<button data-act="artDiff" data-arg="${attr(`${a.slug}:${ver.v}..${L.v}`)}" class="cnpy-link" style="display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:500;color:var(--fg-55);white-space:nowrap;flex:none">Compare with v${L.v}</button>
     <button data-act="artOpen" data-arg="${attr(a.slug)}" class="cnpy-link" style="display:inline-flex;align-items:center;gap:5px;font-size:12.5px;font-weight:500;color:var(--accent);white-space:nowrap;flex:none">View latest${I.arrow()}</button>`) : "";

  // The visibility switch: only the author may make an org artifact private.
  const gated = !isPriv && a.author !== p.me;
  const visSwitch = `<button data-act="artVis" role="switch" aria-checked="${isPriv}" title="${gated ? "Only the author can make this private" : isPriv ? "Publish to the org" : "Make private"}" class="${gated ? "" : "cnpy-ghostbtn"}" style="display:inline-flex;align-items:center;gap:8px;height:30px;padding:0 6px 0 11px;border-radius:999px;font-size:12.5px;font-weight:500;white-space:nowrap;border:1px solid ${isPriv ? "color-mix(in srgb,var(--amber) 45%,transparent);color:var(--amber);background:color-mix(in srgb,var(--amber) 10%,transparent)" : "var(--border);color:var(--fg-70)"};${gated ? "opacity:.6;cursor:not-allowed" : ""}">
    ${isPriv ? I.lock() : I.people()}
    <span>${isPriv ? "Private" : "Visible to org"}</span>
    <span style="position:relative;width:30px;height:18px;border-radius:999px;flex:none;transition:background .18s ease;background:${isPriv ? "var(--amber)" : "var(--border-strong)"}"><span style="position:absolute;top:2px;left:${isPriv ? 14 : 2}px;width:14px;height:14px;border-radius:999px;background:var(--bg);box-shadow:0 1px 2px rgba(0,0,0,.25);transition:left .18s cubic-bezier(.4,0,.2,1)"></span></span>
  </button>`;

  const verMenu = ui.verMenu ? `<div data-act="artCloseMenus" style="position:fixed;inset:0;z-index:29"></div>
    <div role="menu" style="position:absolute;top:calc(100% + 6px);left:0;z-index:30;width:320px;max-width:calc(100vw - 40px);${MENU};padding:5px;animation:cnpy-pop .14s ease both">
      <div style="font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.08em;color:var(--fg-40);padding:6px 10px 4px">VERSIONS</div>
      ${[...a.versions].reverse().map((x) => `<button data-act="artOpen" data-arg="${attr(x.v === L.v ? a.slug : `${a.slug}@${x.v}`)}" role="menuitem" class="cnpy-menurow" style="display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:7px 10px;border-radius:7px">
        <span style="font-family:var(--mono);font-size:12px;font-weight:600;color:var(--fg);width:22px;flex:none">v${x.v}</span>
        <span style="flex:1;min-width:0"><span style="display:block;font-size:12.5px;font-weight:500;color:var(--fg-70);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(x.summary)}</span><span style="display:block;font-family:var(--mono);font-size:9.5px;font-weight:600;letter-spacing:.04em;color:var(--fg-40);margin-top:1px">@${esc(x.by)} · ${esc(x.when)}</span></span>
        ${I.check("currentColor", "flex:none;" + (x.v === ver.v ? "color:var(--accent)" : "visibility:hidden"))}
      </button>`).join("")}
      <div style="height:1px;background:var(--border);margin:5px 4px"></div>
      <button ${many ? `data-act="artDiff" data-arg="${attr(`${a.slug}:${cmpBase.v}..${L.v}`)}"` : "disabled"} role="menuitem" class="cnpy-menurow" style="display:flex;align-items:center;gap:9px;width:100%;text-align:left;padding:7px 10px;border-radius:7px;font-size:12.5px;font-weight:500;color:${many ? "var(--fg-70)" : "var(--fg-40)"};cursor:${many ? "pointer" : "default"}">${I.compare()}${many ? `Compare v${cmpBase.v} → v${L.v}` : "Only one version"}</button>
    </div>` : "";

  const statusSeg = (["draft", "published", "ratified"] as const).map((k) => {
    const on = a.status === k;
    const locked = k === "ratified" && !on && !canRatify;
    const st = `display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 9px;border-radius:6px;font-size:12px;font-weight:500;white-space:nowrap;transition:all .12s ease;${on ? (k === "ratified" ? "color:var(--accent);background:var(--accent-soft)" : "color:var(--fg);background:var(--hover)") : locked ? "color:var(--fg-40);opacity:.55;cursor:not-allowed" : "color:var(--fg-55)"}`;
    const title = locked ? hint || "Publish before ratifying" : k === "ratified" && !on ? `Ratify v${ver.v}` : "";
    return `<button data-act="artStatus" data-arg="${k}" title="${attr(title)}" aria-pressed="${on}" class="${on || locked ? "" : "cnpy-segbtn"}" style="${st}">${k === "ratified" ? I.shield() : ""}${k[0].toUpperCase() + k.slice(1)}</button>`;
  }).join("");

  const dotMenu = ui.dotMenu ? `<div data-act="artCloseMenus" style="position:fixed;inset:0;z-index:29"></div>
    <div role="menu" style="position:absolute;top:calc(100% + 6px);right:0;z-index:30;width:210px;${MENU};padding:5px;animation:cnpy-pop .14s ease both">
      ${[["artCopyLink", I.link(), "Copy link"], ["artDownload", I.download(), "Download raw"], ["artOpenTab", I.ext(), "Open in new tab"]].map(([act, icon, label]) =>
        `<button data-act="${act}" role="menuitem" class="cnpy-menurow" style="display:flex;align-items:center;gap:9px;width:100%;text-align:left;padding:7px 10px;border-radius:7px;font-size:12.5px;font-weight:500;color:var(--fg-70)">${icon}${label}</button>`).join("")}
    </div>` : "";

  const toolbar = `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px;padding:6px;border-bottom:1px solid var(--border)">
    <div style="position:relative;flex:none">
      <button data-act="artVerMenu" aria-haspopup="menu" aria-expanded="${ui.verMenu}" class="cnpy-ghostbtn" style="display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:500;color:var(--fg-70);border:1px solid var(--border);border-radius:7px;padding:3px 8px 3px 9px;white-space:nowrap">
        ${I.history()}
        <span style="font-family:var(--mono);font-weight:600;color:var(--fg)">v${ver.v}</span>
        ${isLatest ? `<span style="font-family:var(--mono);font-size:9.5px;font-weight:600;color:var(--fg-40)">LATEST</span>` : ""}
        ${I.caret()}
      </button>
      ${verMenu}
    </div>
    <span style="flex:1 1 120px;min-width:0;padding-left:4px;font-family:var(--mono);font-size:11px;color:var(--fg-55);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(p.host)}/#artifacts/${esc(a.slug)}/v${ver.v}</span>
    <div role="group" aria-label="Status" style="display:inline-flex;align-items:center;gap:1px;border:1px solid var(--border);border-radius:8px;padding:2px;background:var(--bg);flex:none">${statusSeg}</div>
    <span style="width:1px;height:18px;background:var(--border);flex:none"></span>
    <button data-act="artOpenTab" title="Open in new tab" aria-label="Open in new tab" class="cnpy-iconbtn" style="width:28px;height:28px;border-radius:7px;display:grid;place-items:center;color:var(--fg-55);flex:none">${I.ext()}</button>
    <div style="position:relative;flex:none">
      <button data-act="artDotMenu" title="More" aria-label="More actions" aria-haspopup="menu" aria-expanded="${ui.dotMenu}" class="cnpy-iconbtn" style="width:28px;height:28px;border-radius:7px;display:grid;place-items:center;color:var(--fg-55)">${I.dots()}</button>
      ${dotMenu}
    </div>
  </div>`;

  const propRow = (k: string, v: string) => `<div style="display:grid;grid-template-columns:72px minmax(0,1fr);gap:10px;align-items:center;min-height:36px;border-top:1px solid var(--border)">
    <div style="font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.06em;color:var(--fg-40)">${k}</div>
    <div style="min-width:0;display:flex;align-items:center;gap:8px">${v}</div>
  </div>`;
  const props = [
    propRow("KIND", `<span style="${NEUTRAL}">${a.kind.toUpperCase()}</span>`),
    propRow("AREA", `<span style="${CHIP}color:var(--fg-40);border:1px solid var(--border)">${esc(a.area)}</span>`),
    propRow("REPO", `<a href="https://github.com/${attr(a.repo)}" target="_blank" rel="noopener" style="${MONO_VAL};min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.repo)}</a>`),
    propRow("AUTHOR", `${av(author, 20)}<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;color:var(--fg-70)">${esc(author.name)} <span style="font-family:var(--mono);font-size:11px;color:var(--p-${author.color})">@${esc(author.handle)}</span></span>`),
    propRow("UPDATED", `<span style="font-size:12.5px;color:var(--fg-70)">v${L.v} · ${esc(L.when)} by @${esc(L.by)}</span>`),
    ...(a.ratified ? [propRow("RATIFIED", `<span style="font-size:12.5px;color:var(--fg-70)">v${a.ratified.v} · ${esc(a.ratified.when)} by @${esc(a.ratified.by)}</span>`)] : []),
  ].join("");

  const linkCard = (icon: string, title: string, meta: string, open: string, mono = false) =>
    `${open} class="cnpy-card" style="display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:9px 11px;border:1px solid var(--border);border-radius:9px;background:var(--bg);min-width:0;text-decoration:none">
      <span style="width:26px;height:26px;border-radius:6px;background:var(--hover);display:grid;place-items:center;color:var(--fg-55);flex:none">${icon}</span>
      <span style="min-width:0;flex:1"><span style="display:block;font-size:13px;font-weight:500;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${mono ? "font-family:var(--mono)" : ""}">${esc(title)}</span><span style="display:block;font-family:var(--mono);font-size:9.5px;font-weight:600;letter-spacing:.04em;color:var(--fg-40);white-space:nowrap;margin-top:2px">${esc(meta)}</span></span>`;
  const tix = a.links.tickets.map((id) => {
    const t = (p.ui.ref ?? NO_REF).tickets.find((x) => x.id === id);
    return `<button data-act="openTicket" data-arg="${id}"${linkCard(I.ticket(), t?.title ?? `Ticket #${id}`, `TICKET #${id} · ${TSTATUS[t?.status ?? "submitted"][0]}`, "")}</button>`;
  });
  const spr = a.links.sprints.map((l) => {
    const sp = (p.ui.ref ?? NO_REF).sprints.find((x) => x.label === l);
    return `<div${linkCard(I.flag(), l, sp ? sp.dates + (sp.active ? " · ACTIVE" : "") : "", "")}</div>`;
  });
  const gh = [
    ...a.links.prs.map((n) => ({ label: `#${n}`, meta: "PULL REQUEST · CANOPY", href: `${REPO_URL}/pull/${n}` })),
    ...a.links.issues.map((n) => ({ label: `#${n}`, meta: "ISSUE · CANOPY", href: `${REPO_URL}/issues/${n}` })),
  ].map((g) => `<a href="${attr(g.href)}" target="_blank" rel="noopener"${linkCard(I.gh(), g.label, g.meta, "", true)}</a>`);
  const links = [...tix, ...spr, ...gh];

  return `<div data-screen-label="Artifact viewer" style="${SHELL}">
    ${privBanner}${oldBanner}
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px 24px;flex-wrap:wrap">
      <div style="min-width:0;flex:1 1 380px"><h1 style="font-size:29px;font-weight:650;letter-spacing:-0.022em;line-height:1.16;margin:0;text-wrap:pretty">${esc(a.title)}</h1></div>
      <div style="padding-top:3px">${visSwitch}</div>
    </div>

    <div style="margin-top:22px;border:1px solid var(--border-strong);border-radius:11px;background:color-mix(in srgb,var(--fg) 2.5%,transparent)">
      ${toolbar}
      <div style="border-radius:0 0 11px 11px;overflow:hidden">${contentBlock(a, ver)}</div>
    </div>

    <div data-screen-label="Artifact details" class="art-bento" style="display:grid;gap:14px;margin-top:18px">
      <div class="art-b-props" style="${PANEL};padding:16px 18px;min-width:0">
        <div style="display:flex;align-items:center;height:24px;margin-bottom:8px"><div style="${EYEBROW}">Properties</div></div>
        ${props}
      </div>
      <div class="art-b-links" style="${PANEL};padding:16px 18px;min-width:0">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;height:24px;margin-bottom:8px">
          <div style="${EYEBROW}">Linked work</div>
          <button data-act="artAttachOpen" title="Attach to ticket" class="cnpy-iconbtn" style="display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border-radius:6px;font-size:11.5px;font-weight:500;color:var(--fg-55)">${I.plus(12)}Attach ticket</button>
        </div>
        ${links.length ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px">${links.join("")}</div>` : `<div style="font-size:12.5px;color:var(--fg-40);padding:10px 0 4px">Nothing linked yet.</div>`}
      </div>
    </div>
  </div>`;
}

/**
 * Size each framed HTML artifact: the page lays out at a desktop width (at least
 * 1280px) and is scaled down to the box, whose height follows the document's.
 * Called by main.ts after every paint and on resize; a frame's `load` re-runs it.
 */
export function fitArtifactFrames(root: ParentNode): void {
  for (const box of Array.from(root.querySelectorAll<HTMLElement>(".art-frame"))) {
    const frame = box.querySelector("iframe");
    const key = box.dataset.artKey ?? "";
    if (!frame) continue;
    const fit = () => {
      const w = box.getBoundingClientRect().width;
      if (!w) return;
      const vw = Math.max(1280, w);
      const sc = w / vw;
      const h = frameHeights.get(key) ?? 800;
      frame.style.width = `${vw}px`;
      frame.style.height = `${h}px`;
      frame.style.transform = `scale(${sc.toFixed(4)})`;
      box.style.height = `${Math.round(h * sc)}px`;
    };
    if (!frame.dataset.artBound) {
      frame.dataset.artBound = "1";
      frame.addEventListener("load", () => {
        try {
          const d = frame.contentDocument;
          const h = d ? Math.max(d.documentElement.scrollHeight, d.body?.scrollHeight ?? 0) : 0;
          if (h) frameHeights.set(key, Math.max(480, h));
        } catch { /* cross-origin: keep the default */ }
        fit();
      });
    }
    fit();
  }
}

// ── 3 · diff ─────────────────────────────────────────────────────────────────

function diffView(p: ArtProps, a: SampleArtifact, d: { a: number; b: number }): string {
  const L = latestOf(a);
  const va = a.versions.find((x) => x.v === d.a) ?? a.versions[0];
  const vb = a.versions.find((x) => x.v === d.b) ?? L;
  const rows = va.v === vb.v ? [] : collapsedLineDiff(va.src, vb.src);
  const adds = rows.filter((x) => x.t === "add").length;
  const dels = rows.filter((x) => x.t === "del").length;
  const opts = (sel: number) => a.versions.map((x) => `<option value="${x.v}"${x.v === sel ? " selected" : ""}>v${x.v} · ${esc(x.when)}</option>`).join("");
  const side = (x: ArtifactVersion, tag: string, color: string) => {
    const w = who(p, x.by);
    return `<div style="border:1px solid var(--border);border-radius:11px;padding:12px 14px;background:color-mix(in srgb,var(--fg) 2.5%,transparent)">
      <div style="display:flex;align-items:center;gap:8px"><span style="${CHIP}color:${color};border:1px solid color-mix(in srgb,${color} 38%,transparent)">${tag}</span><span style="font-family:var(--mono);font-size:12px;font-weight:600">v${x.v}</span></div>
      <div style="font-size:13px;color:var(--fg-70);margin-top:7px">${esc(x.summary)}</div>
      <div style="display:flex;align-items:center;gap:6px;margin-top:7px;font-size:11.5px;color:var(--fg-40)">${av(w, 16)}<span style="font-family:var(--mono);font-size:11px;font-weight:500;color:var(--p-${w.color})">@${esc(w.handle)}</span> · ${esc(x.when)}</div>
    </div>`;
  };
  const base = "font-family:var(--mono);font-size:12.5px;line-height:1.75;padding:2px 16px 2px 12px;white-space:pre-wrap;word-break:break-word;color:var(--fg-55)";
  const lineSt = (t: string) => t === "del" ? base + ";background:color-mix(in srgb,var(--red) 7%,transparent)"
    : t === "add" ? base + ";background:color-mix(in srgb,var(--green) 7%,transparent);color:var(--fg-70)"
      : t === "ellipsis" ? base + ";color:var(--fg-40);background:var(--hover);font-size:11.5px" : base;
  const lines = rows.map((x) => {
    const pre = x.t === "del" ? "−" : x.t === "add" ? "+" : "";
    const preColor = x.t === "del" ? "var(--red)" : x.t === "add" ? "var(--green)" : "var(--fg-40)";
    return `<div style="display:flex;${lineSt(x.t)}"><span style="display:inline-block;width:18px;flex:none;color:${preColor}">${pre}</span><span style="min-width:0">${esc(x.t === "ellipsis" ? "⋯ " + x.text : x.text || " ")}</span></div>`;
  }).join("");

  return `<div data-screen-label="Version diff" style="width:100%;max-width:1120px;margin:0 auto;padding:26px clamp(20px,2.6vw,46px) 100px">
    <div style="font-family:var(--mono);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.11em;color:var(--fg-40);margin-bottom:11px">Compare versions <span style="color:var(--border-strong);margin:0 2px">/</span> ${a.kind.toUpperCase()}</div>
    <h2 style="margin:0;font-size:22px;font-weight:600;letter-spacing:-0.02em">${esc(a.title)}</h2>
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:16px">
      <select data-act="artDiffA" data-arg="${attr(a.slug)}" class="cnpy-select" aria-label="Base version">${opts(va.v)}</select>
      <span style="color:var(--fg-40);display:inline-flex">${I.arrow(14)}</span>
      <select data-act="artDiffB" data-arg="${attr(a.slug)}" class="cnpy-select" aria-label="Compared version">${opts(vb.v)}</select>
      <span style="font-family:var(--mono);font-size:11.5px;font-weight:600;color:var(--green);margin-left:6px">+${adds}</span>
      <span style="font-family:var(--mono);font-size:11.5px;font-weight:600;color:var(--red)">−${dels}</span>
      <span style="flex:1"></span>
      <button data-act="artOpen" data-arg="${attr(vb.v === L.v ? a.slug : `${a.slug}@${vb.v}`)}" class="cnpy-ghostbtn" style="display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:500;color:var(--fg-70);border:1px solid var(--border);border-radius:7px;padding:5px 11px;white-space:nowrap">Open v${vb.v}</button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;margin-top:18px">${side(va, "BASE", "var(--red)")}${side(vb, "COMPARED", "var(--green)")}</div>
    ${va.v === vb.v
      ? `<div style="text-align:center;padding:60px;color:var(--fg-40);font-size:13px">Pick two different versions to compare.</div>`
      : `<div style="border:1px solid var(--border);border-radius:10px;overflow:hidden;padding:8px 0;margin-top:18px">${lines}</div>`}
  </div>`;
}

// ── 4 · create ───────────────────────────────────────────────────────────────

function createView(p: ArtProps): string {
  const c = p.ui.c;
  const bytes = createBytes(c);
  const text = createText(c);
  const over = bytes > ART_CAP;
  const hits = CLAUDE_MARKERS.filter((m) => text.includes(m));
  const canSubmit = !!c.title.trim() && bytes > 0 && !over;
  const label = (t: string) => `<label style="display:block;font-size:13px;font-weight:500;margin-bottom:8px">${t}</label>`;
  const inputSt = "width:100%;height:40px;padding:0 13px;border:1px solid var(--border-strong);border-radius:9px;background:transparent;color:var(--fg);font-size:14px;outline:none";
  const seg = (items: string) => `<div style="display:inline-flex;align-items:center;gap:2px;border:1px solid var(--border);border-radius:9px;padding:2px;flex-wrap:wrap">${items}</div>`;
  const preview = text.length > 6000 ? text.slice(0, 6000) + "\n…" : text;
  const prePreview = `<pre class="cnpy-scroll" style="margin:10px 0 0;flex:1;min-height:280px;max-height:420px;overflow:auto;padding:12px 13px;border:1px solid var(--border);border-radius:9px;font-family:var(--mono);font-size:12px;line-height:1.6;color:var(--fg-55);white-space:pre">${esc(preview)}</pre>`;

  let source = "";
  if (c.tab === "paste") {
    source = `<textarea data-act="artCPaste" data-field="artCPaste" class="cnpy-input cnpy-scroll" spellcheck="false" placeholder="Paste the page's full source: HTML, markdown, SVG or a mermaid diagram." style="width:100%;min-height:360px;flex:1;resize:vertical;padding:12px 13px;border:1px solid var(--border-strong);border-radius:9px;background:transparent;color:var(--fg);font-family:var(--mono);font-size:12px;line-height:1.6;outline:none;white-space:pre">${esc(c.paste)}</textarea>`;
  } else if (c.tab === "file") {
    source = !c.file
      ? `<div data-art-drop style="border:1px dashed var(--border-strong);border-radius:11px;padding:56px 24px;text-align:center;min-height:360px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px">
          ${I.upload()}
          <div style="font-size:14px;font-weight:600;color:var(--fg-70)">Drop one file here</div>
          <div style="font-size:12.5px;color:var(--fg-40)">.html, .md, .svg or .mmd · a single file · 500 KB max</div>
          <label class="cnpy-outlinebtn" style="margin-top:12px;${OUTLINE_BTN};padding:6px 14px;cursor:pointer">Choose file<input type="file" data-art-file accept=".html,.htm,.md,.markdown,.svg,.mmd,.mermaid" style="display:none"></label>
        </div>`
      : `<div style="display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--border);border-radius:11px;background:color-mix(in srgb,var(--fg) 2.5%,transparent)">
          <span style="width:30px;height:30px;border-radius:6px;border:1px solid var(--border-strong);display:grid;place-items:center;color:var(--fg-55);flex:none">${I.file()}</span>
          <span style="flex:1;min-width:0"><span style="display:block;font-family:var(--mono);font-size:12.5px;font-weight:500;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.file.name)}</span><span style="display:block;font-size:11.5px;color:var(--fg-40);margin-top:1px">${fmtKB(c.file.size)}${c.file.size > ART_CAP ? " · over the cap" : ""}</span></span>
          <button data-act="artCRemoveFile" class="cnpy-mutelink" style="font-size:12px;font-weight:500;color:var(--fg-40)">Remove</button>
        </div>${prePreview}`;
  } else {
    source = `<div style="display:flex;gap:8px">
        <input data-act="artCUrl" data-field="artCUrl" class="cnpy-input" value="${attr(c.url)}" placeholder="https://…/page.html" style="flex:1;min-width:0;height:40px;padding:0 12px;border:1px solid var(--border-strong);border-radius:9px;background:transparent;color:var(--fg);font-size:12.5px;font-family:var(--mono);outline:none">
        <button data-act="artCFetch" class="cnpy-outlinebtn" style="padding:0 16px;border-radius:9px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70)">Fetch</button>
      </div>
      <div style="font-size:12px;color:var(--fg-40);margin-top:7px">Canopy fetches the page once and stores a copy. Later changes at the URL don't update the artifact.</div>`;
  }

  return `<div data-screen-label="New artifact" style="${SHELL}">
    <h2 style="margin:0;font-size:22px;font-weight:600;letter-spacing:-0.02em">New artifact</h2>
    <div style="font-size:13px;color:var(--fg-55);margin-top:6px">One self-contained page, stored and versioned in Canopy. Agents upload over MCP; this form is for people.</div>
    <div class="cnpy-nt-grid" style="display:grid;grid-template-columns:minmax(0,0.9fr) minmax(0,1.2fr);gap:34px;margin-top:24px">
      <div style="display:flex;flex-direction:column;gap:22px;min-width:0">
        <div>
          ${label("Title")}
          <input data-act="artCTitle" data-field="artCTitle" class="cnpy-input" value="${attr(c.title)}" placeholder="e.g. Google sign-in design page" style="${inputSt}">
          <div style="font-family:var(--mono);font-size:11px;color:var(--fg-40);margin-top:7px">${esc(p.host)}/#artifacts/${esc(slugifyTitle(c.title) || "…")}</div>
        </div>
        <div>${label("Kind")}${seg(ARTIFACT_KINDS.map((k) => `<button data-act="artCKind" data-arg="${k}" class="cnpy-segbtn${c.kind === k ? " is-on" : ""}" style="${segSt(c.kind === k)}">${k}</button>`).join(""))}</div>
        <div>${label("Area")}<div style="display:flex;gap:6px;flex-wrap:wrap">${ARTIFACT_AREAS.map((k) => `<button data-act="artCArea" data-arg="${k}" class="cnpy-pickchip${c.area === k ? " is-on" : ""}" style="${chipSt(c.area === k)}">${k}</button>`).join("")}</div></div>
        <div>
          ${label("Repo")}
          <select data-act="artCRepo" class="cnpy-select" style="width:100%;height:40px;font-size:13.5px;border-color:var(--border-strong);color:var(--fg)">${ARTIFACT_REPOS.map((r) => `<option value="${r}"${c.repo === r ? " selected" : ""}>${r}</option>`).join("")}</select>
        </div>
        <div>
          ${label("Visibility")}${seg((["org", "private"] as const).map((k) => `<button data-act="artCVis" data-arg="${k}" class="cnpy-segbtn${c.vis === k ? " is-on" : ""}" style="${segSt(c.vis === k)}">${k === "org" ? "Org" : "Private"}</button>`).join(""))}
          <div style="font-size:12px;color:var(--fg-40);margin-top:7px;line-height:1.5">${c.vis === "org" ? "Everyone in SaplingLearn can open it once it's uploaded." : "Only you can open it. Teammates who follow the link see a not-found page until you publish."}</div>
        </div>
        <div>
          ${label("Links")}
          <div style="display:flex;gap:8px">
            <input data-act="artCLinkDraft" data-field="artCLinkDraft" data-enter="artCLinkAdd" class="cnpy-input" value="${attr(c.linkDraft)}" placeholder="#10, Sprint 14, or a GitHub PR / issue URL" style="flex:1;min-width:0;height:36px;padding:0 12px;border:1px solid var(--border-strong);border-radius:8px;background:transparent;color:var(--fg);font-size:12.5px;font-family:var(--mono);outline:none">
            <button data-act="artCLinkAdd" class="cnpy-outlinebtn" style="padding:0 14px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70)">Link</button>
          </div>
          ${c.links.length ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">${c.links.map((l, i) => `<span style="display:inline-flex;align-items:center;gap:6px;font-size:11.5px;border:1px solid var(--border);border-radius:6px;padding:3px 4px 3px 8px;color:var(--fg-70)"><span style="color:var(--fg-40)">${esc(l.kind)}</span><span style="font-family:var(--mono);font-weight:500">${esc(l.label)}</span><button data-act="artCLinkRemove" data-arg="${i}" aria-label="Remove link" class="cnpy-xbtn" style="width:16px;height:16px;display:grid;place-items:center;color:var(--fg-40)">${I.x()}</button></span>`).join("")}</div>` : ""}
          ${c.linkErr ? `<div style="font-size:12px;color:var(--red);margin-top:7px">Not a ticket, sprint, PR or issue reference.</div>` : ""}
        </div>
      </div>

      <div style="border-left:1px solid var(--border);padding-left:34px;min-width:0;display:flex;flex-direction:column">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:10px">
          <label style="font-size:13px;font-weight:500">Content</label>
          <div style="display:flex;align-items:center;gap:3px;padding:3px;border:1px solid var(--border);border-radius:9px">
            ${([["paste", "Paste"], ["file", "Upload file"], ["url", "From URL"]] as const).map(([k, l]) => `<button data-act="artCTab" data-arg="${k}" style="display:flex;align-items:center;gap:7px;padding:5px 14px;border-radius:7px;font-size:12.5px;font-weight:500;color:${c.tab === k ? "var(--fg)" : "var(--fg-55)"};background:${c.tab === k ? "var(--hover)" : "transparent"}">${l}</button>`).join("")}
          </div>
        </div>
        ${source}
        <div style="display:flex;align-items:center;gap:12px;margin-top:12px">
          <div style="flex:1;height:4px;border-radius:4px;background:var(--hover);overflow:hidden"><div style="height:100%;width:${Math.min(100, (bytes / ART_CAP) * 100).toFixed(1)}%;background:${over ? "var(--red)" : "var(--accent)"};transition:width .3s ease"></div></div>
          <span style="font-family:var(--mono);font-size:11px;font-weight:600;white-space:nowrap;color:${over ? "var(--red)" : "var(--fg-40)"}">${fmtKB(bytes)} / 500 KB</span>
        </div>
        ${over ? `<div style="display:flex;align-items:flex-start;gap:10px;margin-top:12px;padding:11px 14px;border:1px solid color-mix(in srgb,var(--red) 40%,transparent);background:color-mix(in srgb,var(--red) 8%,transparent);border-radius:9px;font-size:12.5px;color:var(--fg-70);line-height:1.5">
          ${I.alert()}<div><strong style="font-weight:600;color:var(--red)">Over the 500 KB cap.</strong> This content is ${fmtKB(bytes)}. Split it into smaller pages or strip inlined assets, then try again.</div>
        </div>` : ""}
        ${hits.length ? `<div style="display:flex;align-items:flex-start;gap:14px;margin-top:12px;padding:12px 14px;border:1px solid var(--border);border-radius:9px">
          <span style="font-size:10.5px;font-weight:600;font-family:var(--mono);letter-spacing:.04em;${tagTint("var(--amber)")};border-radius:5px;padding:3px 7px;flex:none">CLAUDE.AI ONLY</span>
          <div style="flex:1;font-size:12.5px;color:var(--fg-70);line-height:1.55">
            This page calls features that only exist inside claude.ai. Canopy renders artifacts in a sandbox with no network, so these calls will fail and parts of the page may render empty. You can still upload it.
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">${hits.map((h) => `<code style="font-family:var(--mono);font-size:11px;color:var(--fg);background:color-mix(in srgb,var(--fg) 6%,transparent);border:1px solid var(--border);border-radius:5px;padding:1.5px 6px">${esc(h)}</code>`).join("")}</div>
          </div>
        </div>` : ""}
        <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:22px;flex-wrap:wrap">
          <span style="flex:1;min-width:180px;font-size:12px;color:var(--fg-40)">Uploads as v1, ${c.vis === "private" ? "private draft." : "draft, visible to the org."}</span>
          <button data-act="goArtifacts" class="cnpy-outlinebtn" style="${OUTLINE_BTN}">Cancel</button>
          <button data-act="artCSubmit" class="${canSubmit ? "cnpy-accentbtn" : ""}" style="${primarySt(canSubmit)}"${canSubmit ? "" : ' aria-disabled="true"'}>Upload artifact</button>
        </div>
      </div>
    </div>
  </div>`;
}

// ── 6 · not found ────────────────────────────────────────────────────────────

function notFoundView(p: ArtProps): string {
  return `<div data-screen-label="Artifact not found" style="display:flex;justify-content:center;padding:80px 24px">
    <div style="width:420px;max-width:100%;border:1px solid var(--border);border-radius:14px;padding:34px;display:flex;flex-direction:column;align-items:center;gap:20px;text-align:center">
      <div style="width:52px;height:52px;border-radius:14px;background:var(--hover);display:grid;place-items:center;color:var(--fg-55)">${svg(22, 1.7, `<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M3 9h18"></path><path d="m9.5 12.5 5 5M14.5 12.5l-5 5"></path>`)}</div>
      <div>
        <div style="font-size:18px;font-weight:600;letter-spacing:-0.01em">This artifact isn't available.</div>
        <div style="font-size:13.5px;color:var(--fg-55);margin-top:8px;line-height:1.55;text-wrap:pretty">It doesn't exist, or it's private to its author. If someone sent you this link, ask them to publish it to the org.</div>
      </div>
      <div style="font-family:var(--mono);font-size:12px;color:var(--fg-55);padding:7px 12px;border:1px solid var(--border);border-radius:9px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.host)}/#artifacts/${esc(p.route.slug ?? "")}</div>
      <button data-act="goArtifacts" class="cnpy-outlinebtn" style="width:100%;padding:11px 16px;border-radius:9px;border:1px solid var(--border-strong);font-size:13.5px;font-weight:500">Back to Artifacts</button>
    </div>
  </div>`;
}

// ── dialogs (ratify, attach) ─────────────────────────────────────────────────

export function artifactsDialogs(p: ArtProps): string {
  if (p.screen !== "artifact" || p.route.diff || !(p.ui.ratifyOpen || p.ui.attachOpen)) return "";
  const a = routeArtifact(p);
  if (!a) return "";
  const ver = routeVersion(a, p.route);
  const shell = (w: number, inner: string, label: string) => `<div data-act="artCloseDialogs" style="position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.5);animation:cnpy-fade .14s ease"></div>
    <div style="position:fixed;inset:0;z-index:61;display:grid;place-items:center;padding:16px;pointer-events:none">
      <div role="dialog" aria-modal="true" aria-label="${label}" style="pointer-events:auto;width:min(${w}px,100%);max-height:calc(100vh - 32px);display:flex;flex-direction:column;border:1px solid var(--border-strong);border-radius:14px;background:var(--bg);box-shadow:0 20px 60px rgba(0,0,0,.45);animation:cnpy-pop .2s ease both">${inner}</div>
    </div>`;

  if (p.ui.ratifyOpen) {
    const me = who(p, p.me);
    return shell(460, `<div style="padding:24px 26px">
      <div style="${EYEBROW};margin-bottom:10px">Ratify · v${ver.v}</div>
      <div style="font-size:17px;font-weight:600;letter-spacing:-0.01em">Ratify “${esc(a.title)}”?</div>
      <div style="font-size:13.5px;color:var(--fg-70);margin-top:8px;line-height:1.55">Ratifying marks v${ver.v} as the version the team agreed on. Agents reading this artifact are told it's ratified. A newer upload starts as published again and needs its own ratification.</div>
      <div style="display:flex;align-items:center;gap:9px;margin-top:16px;padding:10px 12px;border:1px solid var(--border);border-radius:9px;font-size:12.5px;color:var(--fg-55)">
        ${av(me, 20)}<span>Recorded as <span style="font-family:var(--mono);font-size:12px;font-weight:500;color:var(--p-${me.color})">@${esc(me.handle)}</span>, just now</span>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:20px">
        <button data-act="artCloseDialogs" class="cnpy-outlinebtn" style="${OUTLINE_BTN}">Cancel</button>
        <button data-act="artRatifyConfirm" class="cnpy-accentbtn" style="${ACCENT_BTN}">Ratify v${ver.v}</button>
      </div>
    </div>`, "Ratify");
  }

  const q = p.ui.attachQ.trim().toLowerCase().replace(/^#/, "");
  const rows = (p.ui.ref ?? NO_REF).tickets.filter((t) => !q || String(t.id) === q || t.title.toLowerCase().includes(q));
  const pick = p.ui.attachPick;
  return shell(540, `<div style="padding:22px 24px 14px">
      <div style="font-size:17px;font-weight:600;letter-spacing:-0.01em">Attach to a ticket</div>
      <div style="font-size:12.5px;color:var(--fg-55);margin-top:4px">${esc(a.title)} · v${ver.v}</div>
      <div class="cnpy-search" style="margin-top:14px;padding:8px 11px;border-color:var(--border-strong)">
        ${I.search()}
        <input data-act="artAttachQ" data-field="artAttachQ" class="cnpy-search-in" value="${attr(p.ui.attachQ)}" placeholder="Search tickets by title or #number" autocomplete="off">
      </div>
    </div>
    <div class="cnpy-scroll" style="flex:1;min-height:0;overflow-y:auto;padding:0 24px;display:flex;flex-direction:column;gap:6px;max-height:320px">
      ${rows.map((t) => {
        const attached = a.links.tickets.includes(t.id);
        const on = pick === t.id;
        const [pl, ps] = TSTATUS[t.status];
        return `<button data-act="artAttachPick" data-arg="${t.id}" style="display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:7px;font-size:13px;font-weight:500;text-align:left;width:100%;transition:all .12s ease;border:1px solid ${on ? "var(--accent)" : "var(--border)"};color:${on ? "var(--accent)" : attached ? "var(--fg-40)" : "var(--fg-70)"};background:${on ? "var(--accent-soft)" : "transparent"};cursor:${attached ? "default" : "pointer"};flex:none">
          <span style="font-family:var(--mono);font-size:11.5px;font-weight:600;color:var(--fg-55);width:28px;flex:none">#${t.id}</span>
          <span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(t.title)}</span>
          ${attached ? `<span style="font-family:var(--mono);font-size:9.5px;font-weight:600;letter-spacing:.05em;color:var(--fg-40);flex:none">ATTACHED</span>` : ""}
          <span style="${ps}">${pl}</span>
        </button>`;
      }).join("")}
      ${rows.length ? "" : `<div style="text-align:center;padding:30px;color:var(--fg-40);font-size:13px">No tickets match “${esc(p.ui.attachQ)}”.</div>`}
    </div>
    <div style="display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:16px 24px 20px;border-top:1px solid var(--border);margin-top:14px">
      <button data-act="artCloseDialogs" class="cnpy-outlinebtn" style="${OUTLINE_BTN}">Cancel</button>
      <button data-act="artAttachConfirm" class="${pick ? "cnpy-accentbtn" : ""}" style="${primarySt(pick !== null)}">${pick ? `Attach to #${pick}` : "Attach"}</button>
    </div>`, "Attach to a ticket");
}

// ── the ticket detail's Artifacts block ──────────────────────────────────────

/** The ticket detail's Artifacts section. Nothing is attached to a real ticket
 *  until the store exists, so it says exactly that. */
export function ticketArtifactsBlock(): string {
  return `<div data-screen-label="Attached artifacts" style="display:flex;align-items:baseline;gap:10px;margin-top:26px">
      <div style="${EYEBROW};flex:none">Artifacts</div>
      <span style="font-family:var(--mono);font-size:10.5px;font-weight:600;color:var(--fg-40)">0</span>
    </div>
    <div style="font-size:12px;color:var(--fg-40);margin-top:10px">No artifacts attached. Attach one from its page in <button data-act="goArtifacts" class="cnpy-link" style="font-size:12px;color:var(--accent);padding:0">Artifacts</button>.</div>`;
}

// ── the reducer ──────────────────────────────────────────────────────────────

export type ArtEffect =
  | { nav: { screen: ArtScreen; route: ArtRoute } }
  | { flash: string }
  | { download: { name: string; text: string } }
  | { openTab: { body: string; type: string } }
  | { copy: { text: string; flash: string } }
  | null;

/**
 * Apply one `art*` act to the UI state. Returns what main.ts must do beyond a
 * rerender (navigate, toast, download…). Mutates `ui` in place, like every other
 * dispatch case.
 */
export function artifactsAct(ui: ArtUi, ctx: { screen: ArtScreen | null; route: ArtRoute; me: string; host: string }, act: string, arg: string | null, value: string | null): ArtEffect {
  const items = ui.items ?? [];
  const a = ctx.screen === "artifact" ? items.find((x) => x.slug === ctx.route.slug && canSee(x, ctx.me)) ?? null : null;
  const ver = a ? routeVersion(a, ctx.route) : null;
  const closeMenus = () => { ui.verMenu = false; ui.dotMenu = false; };

  switch (act) {
    // navigation
    case "artNew": return { nav: { screen: "artifactnew", route: ART_ROUTE_NONE } };
    case "artOpen": {
      if (!arg) return null;
      const [slug, v] = arg.split("@");
      closeMenus();
      return { nav: { screen: "artifact", route: { slug, v: v ? Number(v) : null, diff: null } } };
    }
    case "artDiff": {
      const m = /^(.+):(\d+)\.\.(\d+)$/.exec(arg ?? "");
      if (!m) return null;
      closeMenus();
      return { nav: { screen: "artifact", route: { slug: m[1], v: null, diff: { a: Number(m[2]), b: Number(m[3]) } } } };
    }
    case "artDiffA":
    case "artDiffB": {
      const d = ctx.route.diff;
      if (!arg || !d || !value) return null;
      const n = Number(value);
      return { nav: { screen: "artifact", route: { slug: arg, v: null, diff: act === "artDiffA" ? { a: n, b: d.b } : { a: d.a, b: n } } } };
    }

    // library
    case "artQ": ui.q = value ?? ""; return null;
    case "artClearQ": ui.q = ""; return null;
    case "artFilterToggle": ui.filterOpen = !ui.filterOpen; return null;
    case "artFilterClose": ui.filterOpen = false; return null;
    case "artFilterCat": if ((ART_FILTER_KEYS as readonly string[]).includes(arg ?? "")) ui.filterCat = arg as ArtFilterKey; return null;
    case "artFilterPick": {
      const i = (arg ?? "").indexOf(":");
      const k = (arg ?? "").slice(0, i) as ArtFilterKey;
      if (i < 0 || !ART_FILTER_KEYS.includes(k)) return null;
      ui.f = { ...ui.f, [k]: (arg ?? "").slice(i + 1) };
      return null;
    }
    case "artFilterClear": ui.q = ""; ui.f = { ...NO_FILTERS }; return null;

    // viewer
    case "artVerMenu": ui.verMenu = !ui.verMenu; ui.dotMenu = false; return null;
    case "artDotMenu": ui.dotMenu = !ui.dotMenu; ui.verMenu = false; return null;
    case "artCloseMenus": closeMenus(); return null;
    case "artCloseDialogs": ui.ratifyOpen = false; ui.attachOpen = false; return null;
    case "artPublish":
      if (!a) return null;
      a.visibility = "org";
      if (a.status === "draft") a.status = "published";
      return { flash: "Published to the org" };
    case "artVis": {
      if (!a) return null;
      if (a.visibility === "org" && a.author !== ctx.me) return null;
      a.visibility = a.visibility === "org" ? "private" : "org";
      return { flash: a.visibility === "org" ? "Published to the org" : "Now private to you" };
    }
    case "artStatus": {
      if (!a || !ver) return null;
      const k = arg as ArtifactStatus;
      if (k === a.status || !["draft", "published", "ratified"].includes(k)) return null;
      if (k === "ratified") {
        if (a.status === "published" && ver.v === latestOf(a).v) ui.ratifyOpen = true;
        return null;
      }
      a.status = k;
      a.ratified = null;
      return { flash: k === "draft" ? "Moved back to draft" : "Published" };
    }
    case "artRatifyConfirm":
      if (!a || !ver) return null;
      a.status = "ratified";
      a.ratified = { v: ver.v, by: ctx.me, when: "just now" };
      ui.ratifyOpen = false;
      return { flash: `Ratified v${ver.v}` };
    case "artAttachOpen": ui.attachOpen = true; ui.attachQ = ""; ui.attachPick = null; return null;
    case "artAttachQ": ui.attachQ = value ?? ""; return null;
    case "artAttachPick": {
      const id = Number(arg);
      if (!a || !Number.isInteger(id) || a.links.tickets.includes(id)) return null;
      ui.attachPick = id;
      return null;
    }
    case "artAttachConfirm": {
      if (!a || ui.attachPick === null) return null;
      const id = ui.attachPick;
      a.links.tickets = [...a.links.tickets, id];
      ui.attachOpen = false;
      ui.attachPick = null;
      return { flash: `Attached to ticket #${id}` };
    }
    case "artCopyLink":
      if (!a) return null;
      closeMenus();
      return { copy: { text: `${ctx.host.includes("://") ? ctx.host : `https://${ctx.host}`}/#artifacts/${a.slug}`, flash: a.visibility === "private" ? "Link copied. Teammates can't open it until you publish." : "Link copied" } };
    case "artDownload":
      if (!a || !ver) return null;
      closeMenus();
      return { download: { name: `${a.slug}-v${ver.v}.${EXT[a.kind]}`, text: ver.src } };
    case "artOpenTab": {
      if (!a || !ver) return null;
      closeMenus();
      if (a.kind === "html") return { openTab: { body: ver.src, type: "text/html" } };
      if (a.kind === "svg") return { openTab: { body: ver.src, type: "image/svg+xml" } };
      const inner = a.kind === "markdown" ? renderMarkdown(ver.src) : `<pre>${esc(ver.src)}</pre>`;
      return { openTab: { body: `<!doctype html><meta charset="utf-8"><title>${esc(a.title)}</title><body style="margin:0 auto;max-width:760px;padding:48px 24px;font:15px/1.7 system-ui,sans-serif;color:#1a1814;background:#faf8f3">${inner}</body>`, type: "text/html" } };
    }

    // create
    case "artCTitle": ui.c.title = value ?? ""; return null;
    case "artCKind": if ((ARTIFACT_KINDS as readonly string[]).includes(arg ?? "")) ui.c.kind = arg as ArtifactKind; return null;
    case "artCArea": if ((ARTIFACT_AREAS as readonly string[]).includes(arg ?? "")) ui.c.area = arg as string; return null;
    case "artCRepo": if (value) ui.c.repo = value; return null;
    case "artCVis": if (arg === "org" || arg === "private") ui.c.vis = arg; return null;
    case "artCTab": if (arg === "paste" || arg === "file" || arg === "url") ui.c.tab = arg; return null;
    case "artCPaste": ui.c.paste = value ?? ""; return null;
    case "artCUrl": ui.c.url = value ?? ""; return null;
    case "artCFetch": return ui.c.url.trim() ? { flash: "Fetching from a URL isn't wired yet" } : null;
    case "artCRemoveFile": ui.c.file = null; return null;
    case "artCLinkDraft": ui.c.linkDraft = value ?? ""; ui.c.linkErr = false; return null;
    case "artCLinkAdd": {
      const l = parseArtLink(ui.c.linkDraft);
      if (!l) { if (ui.c.linkDraft.trim()) ui.c.linkErr = true; return null; }
      ui.c.links = [...ui.c.links, l];
      ui.c.linkDraft = "";
      return null;
    }
    case "artCLinkRemove": {
      const i = Number(arg);
      ui.c.links = ui.c.links.filter((_, j) => j !== i);
      return null;
    }
    case "artCSubmit": {
      const c = ui.c;
      const text = createText(c);
      const bytes = createBytes(c);
      if (!c.title.trim() || bytes === 0 || bytes > ART_CAP || !ui.items) return null;
      let slug = slugifyTitle(c.title) || "artifact";
      if (slug === "new" || items.some((x) => x.slug === slug)) slug += `-${items.length + 1}`;
      const pick = (k: ArtLinkDraft["kind"]) => c.links.filter((l) => l.kind === k);
      ui.items = [{
        slug, title: c.title.trim(), kind: c.kind, area: c.area, repo: c.repo, author: ctx.me, status: "draft", visibility: c.vis,
        links: { tickets: pick("ticket").map((l) => l.n as number), sprints: pick("sprint").map((l) => l.label), prs: pick("PR").map((l) => l.n as number), issues: pick("issue").map((l) => l.n as number) },
        ratified: null,
        versions: [{ v: 1, by: ctx.me, when: "just now", summary: "Uploaded from Canopy", src: text }],
      }, ...ui.items];
      ui.c = { ...initialArtCreate(), repo: c.repo, area: c.area, vis: c.vis };
      return { nav: { screen: "artifact", route: { slug, v: null, diff: null } } };
    }
    default:
      return null;
  }
}

/** A picked/dropped file → the create form (kind and title follow the file, as in the design). */
export function artAcceptFile(ui: ArtUi, file: { name: string; size: number; text: string }): void {
  ui.c.file = file;
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  const kind = ({ html: "html", htm: "html", md: "markdown", markdown: "markdown", svg: "svg", mmd: "mermaid", mermaid: "mermaid" } as Record<string, ArtifactKind>)[ext];
  if (kind) ui.c.kind = kind;
  if (!ui.c.title) ui.c.title = file.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
}
