// The Repo dashboard (Monitor › Repo) — ported from the Claude Design
// `Canopy Repo Dashboard.dc.html`. Purely presentational: props in, markup out,
// interactions via data-act / data-arg dispatched in main.ts.
//
// Five tabs, each ONE bordered panel divided by hairlines (the design's rule:
// lines, not cards). Every block is a `RepoSection`, so each one renders four
// ways — live, `empty`, `not_connected` (nothing captured for it yet) and, while the
// fetch is out or failed, loading / error. The Worker decides which sections are
// live (`src/tools/repo.ts`); nothing here invents a number.
//
// Motion hooks (`cnpy-rise` + `--i`, `repo-bar`, `repo-spark`, `repo-fill`,
// `data-count`) are inert until main.ts flags a screen ENTER — so a rerender for
// an unrelated reason never replays them.

import {
  REPO_RANGES, REPO_TABS,
  type RepoActivity, type RepoActivityKind, type RepoDashboard, type RepoPerson, type RepoPr, type RepoPrState,
  type RepoProductEnv, type RepoRange, type RepoSection, type RepoTab, type RepoTone, type RepoTrend, type RepoUsageEnv, type RepoUsageMetric,
  type PollOutcome, type UsagePollResult, type UsagePollSource,
} from "@shared/repo";
import type { Loadable } from "./render";
import { esc, attr, statusBadge } from "./ui";
import { personChip } from "./people";

export interface RepoProps {
  tab: RepoTab;
  range: RepoRange;
  driftOpen: boolean;
  repo: Loadable<RepoDashboard | null>;
  fetchedAt: number | null;
  sample: boolean;
  /** The viewer is an admin — the only one offered "Poll now" on the Usage tab. */
  admin: boolean;
  /** The last on-demand usage poll. Session-only; null = none / dismissed. */
  poll: RepoPollState | null;
}

/** "Poll now" (POST /admin/poll-usage): in flight, its per-source outcomes, or a failed request. */
export type RepoPollState = { status: "polling" } | { status: "done"; result: UsagePollResult } | { status: "error" };

// ── design tokens (verbatim from the .dc.html) ───────────────────────────────
const LABEL = "font-family:var(--mono);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40);white-space:nowrap";
const LABEL_SM = LABEL.replace("10.5px", "10px");
const FRAME = "max-width:1180px;margin:0 auto;padding:22px 32px 36px";
const PANEL = "border:1px solid var(--border);border-radius:16px;background:color-mix(in srgb,var(--fg) 2.5%,transparent);display:flex;flex-direction:column;overflow:hidden";
const CODE = "font-family:var(--mono);font-size:12.5px;color:var(--fg);background:var(--hover);border:1px solid var(--border);border-radius:4px;padding:0 5px";
const TOP = "border-top:1px solid var(--border)";
const LEFT = "border-left:1px solid var(--border)";

const TONE: Record<RepoTone, string> = { neutral: "var(--fg-55)", good: "var(--green)", warn: "var(--amber)", bad: "var(--red)" };

/** Stagger index for the enter animation. */
const rise = (i: number, style = "", cls = ""): string => `class="cnpy-rise${cls ? ` ${cls}` : ""}" style="--i:${i};${style}"`;

// Defense-in-depth: a captured URL must be http(s) — never javascript:/data:.
const safeUrl = (u: string | null): string => (u && /^https?:\/\//i.test(u) ? u : "#");

/** Short age: "just now" is "0m" in a dense column, so floor at 1m. */
export function ago(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.max(1, Math.round((now - then) / 60000));
  if (mins < 60) return `${mins}m`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** Polyline points for a sparkline in a 100×26 box (the design's `pts()`). */
export function sparkPoints(arr: number[], w = 100, h = 26, pad = 3): string {
  if (arr.length < 2) return "";
  const mn = Math.min(...arr), mx = Math.max(...arr), rg = (mx - mn) || 1;
  return arr.map((v, i) => `${((i / (arr.length - 1)) * w).toFixed(1)},${(h - pad - ((v - mn) / rg) * (h - 2 * pad)).toFixed(1)}`).join(" ");
}

// M11: `sparkPoints` returns "" for fewer than 2 points — a line needs two
// ends. Rendering the box anyway drew an empty sparkline; render nothing at
// all instead, same as the CI-failures block already does for `rate: null`.
const spark = (trend: number[], stroke: string, height: number, mt = 10): string =>
  trend.length < 2 ? "" :
  `<div class="repo-spark" style="margin-top:${mt}px"><svg viewBox="0 0 100 26" preserveAspectRatio="none" style="width:100%;height:${height}px;display:block"><polyline points="${sparkPoints(trend)}" fill="none" stroke="${stroke}" stroke-width="1.6" vector-effect="non-scaling-stroke"></polyline></svg></div>`;

/** "▲ 2" / "▼ 3" / "—" — the design's week-over-week delta. */
const delta = (n: number): string => (n > 0 ? `▲ ${n}` : n < 0 ? `▼ ${Math.abs(n)}` : "—");

const avatar = (p: RepoPerson, size: number): string =>
  personChip(p.handle && p.color ? { handle: p.handle, name: p.name, color: p.color } : null, size, p.login);
const who = (p: RepoPerson): string => p.handle ?? p.login;

// ── section states ───────────────────────────────────────────────────────────
type Phase = "loading" | "error" | "ready";
const phaseOf = (p: RepoProps): Phase =>
  p.repo.data ? "ready" : p.repo.status === "error" ? "error" : "loading";

const skeleton = (lines = 3): string => {
  const widths = [68, 92, 54, 80, 61];
  return `<div style="display:flex;flex-direction:column;gap:10px;justify-content:center;padding:12px 0">${Array.from({ length: lines }, (_, i) =>
    `<div class="repo-shimmer" style="height:12px;border-radius:6px;background:var(--hover);width:${widths[i % widths.length]}%;animation-delay:${(i * 0.2).toFixed(1)}s"></div>`).join("")}</div>`;
};

const emptyBlock = (sub: string): string =>
  `<div style="display:flex;align-items:center;justify-content:center;padding:14px 0"><div style="border:1px dashed var(--border-strong);border-radius:11px;padding:18px 24px;text-align:center;width:100%">
    <div style="font-size:13.5px;font-weight:500;color:var(--fg-70)">Nothing here yet</div>
    <div style="font-size:12.5px;color:var(--fg-40);margin-top:4px">${esc(sub)}</div>
  </div></div>`;

const errorBlock = (): string =>
  `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;padding:14px 0">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="1.8"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16h.01"></path></svg>
    <div><div style="font-size:13.5px;font-weight:500;color:var(--fg-70)">Couldn't load this section</div><div style="font-size:12.5px;color:var(--fg-40);margin-top:3px">The dashboard request failed.</div></div>
    <button data-act="repoRefresh" class="cnpy-outlinebtn" style="padding:6px 14px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70)">Retry now</button>
  </div>`;

/** The design's "Source not connected" block. No button: there is no connect flow
 *  to start. Every section HAS a capture path now, so the copy names what that
 *  path is still waiting on, in the owner's terms — a setting or secret by NAME
 *  (never a value), a webhook event, the repo's CI, or Sync GitHub. */
const notConnected = (what: string): string =>
  `<div style="display:flex;align-items:center;justify-content:center;padding:14px 0;flex:1"><div style="border:1px dashed color-mix(in srgb,var(--accent) 45%,transparent);border-radius:11px;padding:18px 24px;text-align:center;width:100%;background:color-mix(in srgb,var(--accent) 4%,transparent)">
    <div style="font-size:13.5px;font-weight:600">Source not connected</div>
    <div style="font-size:12.5px;color:var(--fg-55);margin-top:4px;line-height:1.55">${esc(what)}</div>
  </div></div>`;

/** `nc` is given only by a section the Worker can actually send as
 *  `not_connected`; one it only ever sends as ok / empty (`bars`) has no such
 *  sentence to keep true, and falls back to the generic line below. */
interface SectionCopy { nc?: string; empty: string; lines?: number }
const NC_GENERIC = "Nothing has been captured for this section yet.";

/** Render one section in whichever of its states applies. */
function sec<T>(p: RepoProps, pick: (d: RepoDashboard) => RepoSection<T>, copy: SectionCopy, live: (data: T) => string): string {
  const phase = phaseOf(p);
  if (phase === "loading") return skeleton(copy.lines);
  if (phase === "error" || !p.repo.data) return errorBlock();
  const s = pick(p.repo.data);
  if (s.status === "not_connected") return notConnected(copy.nc ?? NC_GENERIC);
  if (s.status === "empty") return emptyBlock(copy.empty);
  return live(s.data);
}

/** True when a section has live data — for chrome that only makes sense beside it. */
function okData<T>(p: RepoProps, pick: (d: RepoDashboard) => RepoSection<T>): T | null {
  const s = p.repo.data ? pick(p.repo.data) : null;
  return s && s.status === "ok" ? s.data : null;
}

// ── header chrome ────────────────────────────────────────────────────────────
export function repoCrumb(p: RepoProps): string {
  const label = REPO_TABS.find(([k]) => k === p.tab)?.[1] ?? "";
  const slug = p.repo.data?.repo ?? "";
  return `<span style="display:inline-flex;align-items:center;gap:14px;min-width:0">
    <span style="color:var(--fg-40);font-size:13px">›</span>
    <span style="font-size:13px;font-weight:500;color:var(--fg-70);white-space:nowrap">${esc(label)}</span>
    ${slug ? `<span style="font-family:var(--mono);font-size:11px;color:var(--fg-40);white-space:nowrap">${esc(slug)}</span>` : ""}
  </span>`;
}

/** "updated just now" / "updated 4m ago" — main.ts re-ticks this node in place. */
export function repoUpdatedLabel(p: Pick<RepoProps, "repo" | "fetchedAt">, now: number = Date.now()): string {
  if (p.repo.status === "loading") return p.repo.data ? "refreshing…" : "loading…";
  if (p.fetchedAt === null) return "";
  const mins = Math.max(0, Math.round((now - p.fetchedAt) / 60000));
  return mins < 1 ? "updated just now" : `updated ${mins}m ago`;
}

export function repoControls(p: RepoProps): string {
  const envs = okData(p, (d) => d.environments) ?? [];
  const pills = envs.map((e) => {
    const c = TONE[e.tone];
    return `<span title="${attr(`${e.name} — ${e.pill.toLowerCase()}`)}" style="display:inline-flex;align-items:center;gap:7px;font-family:var(--mono);font-size:11px;white-space:nowrap;color:var(--fg-70)"><span class="${e.tone === "good" || e.tone === "neutral" ? "" : "repo-pulse"}" style="--c:${c};width:7px;height:7px;border-radius:50%;background:${c};box-shadow:0 0 0 3px color-mix(in srgb,${c} 16%,transparent)"></span>${esc(e.name)}</span>`;
  }).join("");
  const busy = p.repo.status === "loading";
  return `${pills}${pills ? `<div style="width:1px;height:20px;background:var(--border);margin:0 2px"></div>` : ""}
    <span data-repo-updated style="font-size:11.5px;color:var(--fg-40);white-space:nowrap">${esc(repoUpdatedLabel(p))}</span>
    <button data-act="repoRefresh" title="Refresh" class="cnpy-iconbtn" style="width:32px;height:32px;border-radius:8px;border:1px solid var(--border);display:grid;place-items:center;color:var(--fg-55)">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"${busy ? ' style="animation:cnpy-spin .8s linear infinite"' : ""}><path d="M21 12a9 9 0 1 1-3-6.7L21 8"></path><path d="M21 3v5h-5"></path></svg>
    </button>`;
}

// ── Overview ─────────────────────────────────────────────────────────────────
const kv = (k: string, v: string): string =>
  `<div style="display:grid;grid-template-columns:96px 1fr;gap:12px;padding:11px 0;${TOP}"><div style="${LABEL_SM};padding-top:2px">${k}</div>${v}</div>`;

function overviewTab(p: RepoProps): string {
  const now = Date.now();
  const envs = sec(p, (d) => d.environments, { nc: "Nothing captured for a configured environment yet. Cards appear once REPO_ENVIRONMENTS lists an environment and a health ping, a deploy or a head check lands for it — from the 10-minute cron, the GitHub webhook, or an admin's Sync GitHub.", empty: "No environments recorded." }, (rows) =>
    `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr))">${rows.map((e, i) => {
      const c = TONE[e.tone];
      return `<div style="padding:20px 22px 10px;min-width:0;${i ? LEFT : ""}">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
          <span style="font-size:16.5px;font-weight:600;letter-spacing:-0.01em;flex:1">${esc(e.name)}${e.note ? ` <span style="font-size:11.5px;font-weight:500;color:var(--fg-40)">${esc(e.note)}</span>` : ""}</span>
          ${statusBadge(e.pill, c)}
        </div>
        ${e.parts.map((pt) => kv(pt.part === "backend" ? "Backend" : "Frontend",
          pt.sha
            ? `<div style="font-size:13.5px;line-height:1.6;color:var(--fg-70);display:flex;align-items:center;gap:9px;flex-wrap:wrap"><span style="${CODE}">${esc(pt.sha)}</span><span style="font-size:12px;color:var(--fg-40);white-space:nowrap">${esc(ago(pt.deployedAt ?? "", now))} ago · by ${esc(pt.deployedBy ?? "unknown")} · ${esc(pt.host)}</span>${pt.result === "fail" ? `<span style="font-family:var(--mono);font-size:10px;font-weight:600;color:var(--red)">FAILED</span>` : ""}</div>`
            : `<div style="font-size:12.5px;color:var(--fg-40)">No ${esc(pt.host)} deploy captured yet</div>`)).join("")}
        ${kv("CI on head", `<div style="font-size:13.5px;line-height:1.6;display:flex;align-items:center;gap:7px;color:${TONE[e.ciTone]}"><span style="font-family:var(--mono);font-size:13px">${e.ciTone === "good" ? "✓" : e.ciTone === "bad" ? "✕" : "●"}</span>${esc(e.ci)}</div>`)}
        ${kv("URL", `<div style="font-size:13.5px;line-height:1.6"><a href="${attr(safeUrl(e.url))}" target="_blank" rel="noopener" class="repo-link" style="font-family:var(--mono);font-size:12.5px">${esc(e.url.replace(/^https?:\/\//, ""))} ↗</a></div>`)}
      </div>`;
    }).join("")}</div>`);

  // The drift strip only means something beside the two environments it compares.
  const drift = okData(p, (d) => d.drift);
  const driftStrip = drift ? `<button data-act="repoToggleDrift" aria-expanded="${p.driftOpen}" class="repo-strip" style="width:100%;display:flex;align-items:center;justify-content:center;gap:10px;padding:12px 22px;${TOP};font-size:13px;color:var(--fg-70)">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--fg-40)" stroke-width="1.8" style="flex:none"><path d="M6 3v12"></path><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg>
      <span>${esc(drift.head)} is <span style="font-family:var(--mono);font-weight:600;color:var(--fg)">${drift.ahead}</span> commits ahead, <span style="font-family:var(--mono);font-weight:600;color:var(--fg)">${drift.behind}</span> behind ${esc(drift.base)}</span>
      <svg class="repo-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--fg-40)" stroke-width="2.4" style="flex:none;transform:rotate(${p.driftOpen ? 90 : 0}deg)"><path d="M9 6l6 6-6 6"></path></svg>
    </button>
    <div class="repo-drift" data-open="${p.driftOpen ? "1" : "0"}"><div style="overflow:hidden;min-height:0">${drift.groups.map((g) => {
      const c = g.kind === "pr" ? "var(--accent)" : g.kind === "behind" ? "var(--red)" : "var(--fg-55)";
      return `<div>
        <div style="display:flex;align-items:center;gap:9px;padding:10px 22px;${TOP};background:color-mix(in srgb,var(--fg) 2%,transparent)">
          <span style="font-family:var(--mono);font-size:11px;font-weight:600;color:${c};background:color-mix(in srgb,${c} 12%,transparent);border-radius:5px;padding:1px 7px;flex:none">${esc(g.tag)}</span>
          <span style="font-size:13px;font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(g.title)}</span>
          <span style="font-size:11.5px;color:var(--fg-40);flex:none;margin-left:auto;white-space:nowrap">${esc(g.meta)}</span>
        </div>
        ${g.commits.map((cm) => `<div style="display:grid;grid-template-columns:84px minmax(0,1fr) 64px;gap:10px;align-items:center;padding:7px 22px 7px 30px;${TOP}">
          <span style="font-family:var(--mono);font-size:11.5px;color:var(--fg-55)">${esc(cm.sha)}</span>
          <span style="font-size:12.5px;color:var(--fg-70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(cm.msg)}</span>
          <span style="font-size:11px;color:var(--fg-40);text-align:right">${esc(ago(cm.at, now))}</span>
        </div>`).join("")}
      </div>`;
    }).join("")}</div></div>` : "";

  const stats = sec(p, (d) => d.stats, { nc: "Repo stats aren't connected.", empty: "No data recorded for this window.", lines: 2 }, (rows) =>
    `<div class="repo-tiles" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr))">${rows.map((s, i) => `<div style="padding:16px 22px;${i ? LEFT : ""}">
      <div style="${LABEL}">${esc(s.label)}</div>
      <div style="display:flex;align-items:baseline;gap:10px;margin-top:8px;flex-wrap:wrap">
        <span data-count="${s.value}" style="font-family:var(--mono);font-size:27px;font-weight:600;letter-spacing:-0.02em">${s.value}</span>
        <span style="font-family:var(--mono);font-size:11.5px;font-weight:600;color:${TONE[s.tone]}">${delta(s.delta)}</span>
        <span style="font-size:11px;color:var(--fg-40)">vs last week</span>
      </div>
    </div>`).join("")}</div>`);

  // Three states, decided server-side (src/tools/repo.ts): `not_connected` =
  // nothing has ever pinged these URLs; `empty` = the pings exist but every
  // reading has aged out (the 10-minute cron has stopped) — which must NOT read
  // as "never set up".
  const health = sec(p, (d) => d.health, { nc: "No health ping has landed yet. The repo cron pings each environment in REPO_ENVIRONMENTS every 10 minutes, so this fills in after its first tick.", empty: "No fresh health reading — the last ping is over 30 minutes old.", lines: 2 }, (rows) =>
    rows.map((h) => {
      const c = h.up ? "var(--green)" : "var(--red)";
      return `<div style="display:grid;grid-template-columns:84px minmax(0,1fr) 110px 90px;gap:14px;align-items:center;padding:12px 0;border-bottom:1px solid var(--border)">
        <span style="font-family:var(--mono);font-size:11.5px;font-weight:600;color:var(--fg-70)">${esc(h.env)}</span>
        <a href="${attr(safeUrl(h.url))}" target="_blank" rel="noopener" class="repo-link" style="font-family:var(--mono);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg-55)">${esc(h.url.replace(/^https?:\/\//, ""))}</a>
        <span style="display:inline-flex;align-items:center;gap:7px;font-family:var(--mono);font-size:11px;font-weight:600;color:${c}"><span style="width:7px;height:7px;border-radius:50%;background:${c}"></span>${h.up ? "UP" : "DOWN"}</span>
        <span style="font-family:var(--mono);font-size:12px;color:var(--fg-55);text-align:right">${h.ms} ms</span>
      </div>`;
    }).join(""));

  const envsLive = okData(p, (d) => d.environments) !== null;
  return `<div ${rise(0)}>${envsLive ? envs : `<div style="padding:6px 22px">${envs}</div>`}</div>
    ${driftStrip ? `<div ${rise(1)}>${driftStrip}</div>` : ""}
    <div ${rise(2, `${TOP}`)}>${okData(p, (d) => d.stats) ? stats : `<div style="padding:6px 22px">${stats}</div>`}</div>
    <div ${rise(3, `${TOP};padding:16px 22px 14px;flex:1`)}>
      <div style="${LABEL};margin-bottom:4px">Health checks</div>
      ${health}
    </div>`;
}

// ── Code ─────────────────────────────────────────────────────────────────────
const M_CHIP = "font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.04em;border-radius:5px;padding:2px 7px;white-space:nowrap;color:var(--fg-40);border:1px solid var(--border);background:transparent";
const PR_STATE: Record<RepoPrState, [string, string | null]> = {
  draft: ["DRAFT", null], review: ["IN REVIEW", "var(--blue)"], approved: ["APPROVED", "var(--green)"],
  merged: ["MERGED", "var(--accent)"], closed: ["CLOSED", null],
};
const CHECKS = { pass: ["✓", "var(--green)", "all checks passing"], fail: ["✕", "var(--red)", "checks failing"], run: ["●", "var(--amber)", "checks running"] } as const;

function prRow(pr: RepoPr, now: number): string {
  const [text, color] = PR_STATE[pr.state];
  const chip = color ? statusBadge(text, color) : `<span style="${M_CHIP}">${text}</span>`;
  const ck = pr.checks ? CHECKS[pr.checks] : null;
  return `<a href="${attr(safeUrl(pr.url))}" target="_blank" rel="noopener" class="repo-row" style="display:flex;align-items:center;gap:12px;padding:8px 20px;border-bottom:1px solid var(--border);color:inherit;text-decoration:none">
    <span title="${attr(who(pr.author))}" style="flex:none">${avatar(pr.author, 22)}</span>
    <span style="min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500">${esc(pr.title)} <span style="font-family:var(--mono);font-size:11px;font-weight:400;color:var(--fg-40)">#${pr.number}${pr.branch ? ` · ${esc(pr.branch)}` : ""}</span></span>
    <span style="flex:none">${chip}</span>
    <span title="${ck ? ck[2] : ""}" style="width:16px;text-align:center;flex:none;font-family:var(--mono);font-size:12px;font-weight:600;color:${ck ? ck[1] : "transparent"}">${ck ? ck[0] : ""}</span>
    <span style="width:38px;text-align:right;flex:none;font-size:11.5px;color:var(--fg-40)">${esc(ago(pr.at, now))}</span>
  </a>`;
}

function codeTab(p: RepoProps): string {
  const now = Date.now();
  const tiles = sec(p, (d) => d.codeStats, { nc: "Repo stats aren't connected.", empty: "No data recorded for this window.", lines: 2 }, (rows) =>
    `<div class="repo-tiles" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr))">${rows.map((s, i) => `<div style="padding:14px 20px 12px;${i ? LEFT : ""}">
      <div style="${LABEL}">${esc(s.label)}</div>
      <div style="display:flex;align-items:baseline;gap:9px;margin-top:6px;flex-wrap:wrap">
        <span data-count="${s.value}" style="font-family:var(--mono);font-size:24px;font-weight:600;letter-spacing:-0.02em">${s.value}</span>
        <span style="font-size:11px;color:${s.tone === "neutral" ? "var(--fg-40)" : TONE[s.tone]};white-space:nowrap">${esc(s.sub)}</span>
      </div>
    </div>`).join("")}</div>`);

  const barsData = okData(p, (d) => d.bars);
  const bars = sec(p, (d) => d.bars, { empty: "No commits or merges in the last 14 days.", lines: 2 }, (b) => {
    const max = Math.max(1, ...b.days.map((d) => d.count));
    const w = 100 / b.days.length;
    const fmt = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    const mid = b.days[Math.floor((b.days.length - 1) / 2)];
    return `<svg viewBox="0 0 100 28" preserveAspectRatio="none" style="width:100%;height:74px;margin-top:10px;display:block">${b.days.map((d, i) => {
      const h = (d.count / max) * 25;
      return `<rect class="repo-bar" style="--i:${i}" x="${(i * w + 0.8).toFixed(2)}" y="${(27 - h).toFixed(2)}" width="${(w - 1.6).toFixed(2)}" height="${h.toFixed(2)}" fill="var(--accent)" opacity="0.85"><title>${esc(fmt(d.date))} — ${d.count}</title></rect>`;
    }).join("")}</svg>
    <div style="display:flex;justify-content:space-between;margin-top:6px;font-family:var(--mono);font-size:10px;color:var(--fg-40)"><span>${esc(fmt(b.days[0].date))}</span><span>${esc(fmt(mid.date))}</span><span>${esc(fmt(b.days[b.days.length - 1].date))}</span></div>`;
  });

  const prRows = okData(p, (d) => d.prs);
  const prsLive = prRows !== null;
  // The header names what's actually shown, not the sample flag — a captured list can include OPEN PRs.
  const prsOpen = prRows ? prRows.some((r) => r.state !== "merged" && r.state !== "closed") : false;
  const prs = sec(p, (d) => d.prs, { nc: "Pull requests aren't connected.", empty: "No pull requests captured yet.", lines: 4 }, (rows) => rows.map((r) => prRow(r, now)).join(""));

  const br = okData(p, (d) => d.branches);
  const branches = sec(p, (d) => d.branches, { nc: "No branch snapshot yet. One is taken when an admin runs Sync GitHub and by the 6-hourly GitHub reconcile — both need GITHUB_SERVICE_TOKEN.", empty: "No branches recorded." }, (b) =>
    b.rows.map((r) => `<div style="display:grid;grid-template-columns:minmax(0,1.4fr) 90px 130px 54px;gap:12px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
      <span style="font-family:var(--mono);font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.name)}</span>
      <span style="font-size:11.5px;color:var(--fg-40);white-space:nowrap">${esc(ago(r.at, now))} ago</span>
      <span style="font-family:var(--mono);font-size:11.5px;color:var(--fg-55);white-space:nowrap">+${r.ahead} / −${r.behind}${b.head ? ` vs ${esc(b.head)}` : ""}</span>
      <span style="text-align:right">${r.stale ? `<span style="font-family:var(--mono);font-size:9.5px;font-weight:600;letter-spacing:.04em;color:var(--amber);border:1px solid color-mix(in srgb,var(--amber) 45%,transparent);background:color-mix(in srgb,var(--amber) 12%,transparent);border-radius:5px;padding:1px 5px;flex:none">STALE</span>` : ""}</span>
    </div>`).join(""));

  return `<div ${rise(0)}>${okData(p, (d) => d.codeStats) ? tiles : `<div style="padding:6px 20px">${tiles}</div>`}</div>
    <div ${rise(1, `${TOP};padding:14px 20px 12px`)}>
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px"><span style="${LABEL}">${esc(barsData?.title ?? "Activity — last 14 days")}</span><span style="font-size:11px;color:var(--fg-40);white-space:nowrap">${esc(barsData?.note ?? "")}</span></div>
      ${bars}
    </div>
    <div ${rise(2, `display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:13px 20px;${TOP};border-bottom:1px solid var(--border)`)}>
      <span style="${LABEL}">Pull requests — ${prsOpen ? "open &amp; recent" : "recently closed"}</span>
      <span style="font-size:11px;color:var(--fg-40);white-space:nowrap">sorted by last updated</span>
    </div>
    <div ${rise(3)}>${prsLive ? prs : `<div style="padding:6px 20px;border-bottom:1px solid var(--border)">${prs}</div>`}</div>
    <div ${rise(4, `padding:14px 20px 10px;flex:1;display:flex;flex-direction:column`)}>
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:4px"><span style="${LABEL}">Branches</span><span style="font-size:11px;color:var(--fg-40)">${br ? `${br.active} active · ${br.stale} stale` : ""}</span></div>
      ${branches}
    </div>`;
}

// ── CI & Deploys ─────────────────────────────────────────────────────────────
const ACTIVITY_ICON: Record<RepoActivityKind, [string, string]> = {
  push: ["M12 19V5M5 12l7-7 7 7", "var(--fg-55)"], merge: ["M20 6 9 17l-5-5", "var(--green)"],
  deploy: ["M13 2 3 14h9l-1 8 10-12h-9l1-8", "var(--accent)"], issue: ["M12 8v5M12 16h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18", "var(--amber)"],
  close: ["M20 6 9 17l-5-5", "var(--fg-55)"], release: ["M12 3l8 9-8 9-8-9z", "var(--blue)"],
  review: ["M4 12c2.7-4.7 13.3-4.7 16 0-2.7 4.7-13.3 4.7-16 0z", "var(--fg-55)"],
};

function activityRow(a: RepoActivity, now: number): string {
  const [d, c] = ACTIVITY_ICON[a.kind];
  const text = `${a.actor ? `${esc(who(a.actor))} ` : ""}${esc(a.text)}`;
  const body = a.url && safeUrl(a.url) !== "#"
    ? `<a href="${attr(safeUrl(a.url))}" target="_blank" rel="noopener" class="repo-quiet" style="font-size:12.5px;color:var(--fg-70);min-width:0;flex:1;line-height:1.5;text-decoration:none">${text}</a>`
    : `<span style="font-size:12.5px;color:var(--fg-70);min-width:0;flex:1;line-height:1.5">${text}</span>`;
  return `<div style="display:flex;align-items:flex-start;gap:10px;padding:8px 4px;${TOP}">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" style="flex:none;margin-top:3px"><path d="${d}"></path></svg>
    ${body}
    <span style="font-size:11px;color:var(--fg-40);flex:none">${esc(ago(a.at, now))}</span>
  </div>`;
}

// `t.delta` is "" once the window can't support a trend claim (see
// `windowDelta` in src/tools/repo.ts) — render the note alone then, with no
// delta span and no stray leading space.
const trendBlock = (title: string, t: RepoTrend, stroke: string): string =>
  `<div style="display:flex;align-items:baseline;justify-content:space-between"><span style="${LABEL}">${title}</span><span style="font-family:var(--mono);font-size:16px;font-weight:600;white-space:nowrap">${esc(t.value)}</span></div>
  ${spark(t.trend, stroke, 44)}
  <div style="font-size:11.5px;color:var(--fg-40);margin-top:6px">${t.delta ? `<span style="font-family:var(--mono);color:${TONE[t.tone]}">${esc(t.delta)}</span> ` : ""}${esc(t.note)}</div>`;
const titled = (title: string, body: string): string => `<div style="${LABEL}">${title}</div>${body}`;

function ciTab(p: RepoProps): string {
  const now = Date.now();
  const RESULT = { ok: ["var(--green)", "DEPLOYED"], fail: ["var(--red)", "FAILED"], cancel: ["var(--amber)", "CANCELLED"] } as const;
  const deploys = sec(p, (d) => d.deploys, { nc: "No deploy captured for a configured environment yet. Deploys arrive when the GitHub webhook delivers deployment_status and check_run events, or when an admin runs Sync GitHub; environments come from REPO_ENVIRONMENTS.", empty: "No deploys recorded.", lines: 2 }, (rows) =>
    rows.map((row) => {
      const okCount = row.deploys.filter((d) => d.result === "ok").length;
      const last = row.deploys[row.deploys.length - 1];
      return `<div style="display:flex;align-items:center;gap:16px;padding:14px 0;${TOP};flex-wrap:wrap">
        <span style="width:118px;font-family:var(--mono);font-size:11.5px;font-weight:600;color:var(--fg-70);flex:none">${esc(row.label)}</span>
        <div style="display:flex;align-items:center;gap:9px">${row.deploys.map((d, i) => {
          const [color, word] = RESULT[d.result];
          // Pure CSS tooltip (hover + keyboard focus): no state, so no rerender on every dot.
          return `<span class="repo-dotwrap" style="position:relative;display:inline-block">
            <button class="repo-dot" style="--i:${i};width:15px;height:15px;border-radius:50%;background:${color};display:block;padding:0" aria-label="${attr(`${d.sha} ${word.toLowerCase()} ${ago(d.at, now)} ago by ${d.by}`)}"></button>
            <span class="repo-tip" role="tooltip">
              <span style="display:block;font-family:var(--mono);font-size:11.5px;font-weight:600">${esc(d.sha)}</span>
              <span style="display:block;font-size:11.5px;color:var(--fg-55);margin-top:2px">${esc(ago(d.at, now))} ago · by ${esc(d.by)}</span>
              <span style="display:block;font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.04em;margin-top:4px;color:${color}">${word}</span>
            </span>
          </span>`;
        }).join("")}</div>
        <span style="margin-left:auto;font-size:11.5px;color:var(--fg-40)">${last ? `last ${esc(ago(last.at, now))} ago · ` : ""}${okCount} of ${row.deploys.length} succeeded</span>
      </div>`;
    }).join(""));

  const fails = okData(p, (d) => d.ciFailures);
  // `rate === null` = run capture has not been recording for a whole week yet
  // (src/tools/repo.ts). The percentage and the sparkline both describe seven
  // days, so neither is drawn — a quiet line says why instead. The failure rows
  // themselves are facts and are always listed.
  const failures = sec(p, (d) => d.ciFailures, { nc: "No workflow run captured yet. Runs arrive when the GitHub webhook delivers workflow_run events, or when an admin runs Sync GitHub.", empty: "No CI failures this week." }, (f) =>
    `${f.rate === null
        ? `<div style="margin-top:8px;font-size:12.5px;color:var(--fg-40)">A 7-day rate appears after a week of captured runs.</div>`
        : spark(f.trend, "var(--amber)", 40)}
    <div style="margin-top:10px">${f.rows.map((r) => `<div style="display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr) minmax(0,1fr) 82px;gap:10px;align-items:center;padding:10px 4px;${TOP}">
      <span style="display:inline-flex;align-items:center;gap:7px;min-width:0"><span style="font-family:var(--mono);font-size:12px;font-weight:600;color:var(--red);flex:none">✕</span><span style="font-family:var(--mono);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.workflow)}</span></span>
      <span style="font-family:var(--mono);font-size:11.5px;color:var(--fg-55);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.branch)}</span>
      <span style="font-size:12px;color:var(--fg-70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.job)}</span>
      <span style="text-align:right;white-space:nowrap"><span style="font-size:11px;color:var(--fg-40)">${esc(ago(r.at, now))} · </span><a href="${attr(safeUrl(r.url))}" target="_blank" rel="noopener" class="repo-link" style="font-size:11.5px">Logs ↗</a></span>
    </div>`).join("")}</div>`);

  // I2: `empty` now means "a reading has landed before, just not in the
  // window" (src/tools/repo.ts checks `latestMetric` on the empty path) — the
  // copy says so, rather than implying nothing has ever been reported.
  const cov = okData(p, (d) => d.coverage);
  const coverage = sec(p, (d) => d.coverage, { nc: "No coverage reported yet. It appears once the repo's CI posts a canopy/coverage commit status on a push to the default environment branch and the GitHub webhook delivers status events.", empty: "No coverage reported in the last 30 days.", lines: 2 }, (t) => trendBlock("Test coverage", t, "var(--green)"));
  const bun = okData(p, (d) => d.bundle);
  const bundle = sec(p, (d) => d.bundle, { nc: "No bundle size reported yet. It appears once the repo's CI posts a canopy/bundle-kb commit status on a push to the default environment branch and the GitHub webhook delivers status events.", empty: "No bundle size reported in the last 30 days.", lines: 2 }, (t) => trendBlock("Bundle size — web", t, "var(--fg-55)"));

  const activity = sec(p, (d) => d.activity, { nc: "The activity feed isn't connected.", empty: "No repo events captured yet.", lines: 4 }, (rows) =>
    `<div class="cnpy-scroll" style="max-height:236px;overflow-y:auto">${rows.map((a) => activityRow(a, now)).join("")}</div>`);
  const count = okData(p, (d) => d.activity)?.length ?? 0;

  return `<div ${rise(0, `padding:18px 20px 4px`)}>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <span style="${LABEL}">Deploy history — last 10</span>
        <span style="display:${okData(p, (d) => d.deploys) ? "inline-flex" : "none"};gap:14px;font-size:10.5px;font-family:var(--mono);color:var(--fg-40)">${(["ok", "fail", "cancel"] as const).map((k) => `<span style="display:inline-flex;align-items:center;gap:5px"><span style="width:8px;height:8px;border-radius:50%;background:${RESULT[k][0]}"></span>${RESULT[k][1].toLowerCase()}</span>`).join("")}</span>
      </div>
      ${deploys}
    </div>
    <div ${rise(1, `display:grid;grid-template-columns:minmax(0,1.35fr) minmax(280px,1fr);${TOP};flex:1`, "repo-split")}>
      <div style="padding:18px 20px;min-width:0;display:flex;flex-direction:column">
        <div style="display:flex;align-items:baseline;justify-content:space-between"><span style="${LABEL}">CI failures — 7-day rate</span>${fails && fails.rate !== null ? `<span style="font-family:var(--mono);font-size:16px;font-weight:600;white-space:nowrap;color:var(--amber)">${fails.rate.toFixed(1)}%</span>` : ""}</div>
        ${failures}
      </div>
      <div style="${LEFT};min-width:0;display:flex;flex-direction:column" class="repo-split-r">
        <div style="padding:18px 20px">${cov ? coverage : titled("Test coverage", coverage)}</div>
        <div style="padding:18px 20px;${TOP};flex:1">${bun ? bundle : titled("Bundle size — web", bundle)}</div>
      </div>
    </div>
    <div ${rise(2, `${TOP};padding:14px 20px 10px`)}>
      <div style="${LABEL};margin-bottom:6px">Activity — last ${count || 20} events</div>
      ${activity}
    </div>`;
}

// ── Usage ────────────────────────────────────────────────────────────────────
// A `null` metric keeps its label row (so the block never collapses or shifts
// its neighbours) and shows a quiet line where the value would be — no
// sparkline element, no empty-state box. WHICH line is the Worker's `seen`
// flag: a source that has reported inside the 30-day read is CONNECTED, so its
// null reads "no recent reading" (no point in this range, a poll that stopped,
// a gauge gone stale); only a source that never reported reads "not
// connected". `spark()` already renders nothing under 2 trend points, so a
// connected-but-thin metric just shows its value with no line. `errorRate` is
// derived from the requests series, so it follows `seen.requests` — except
// while `requests` is live and the range simply holds no request to take a
// rate of (src/tools/repo.ts): that reads a quiet "—" in the same muted slot.
const absentLabel = (seen: boolean): string => (seen ? "no recent reading" : "not connected");
function usageEnv(e: RepoUsageEnv, i: number): string {
  const metric = (label: string, m: RepoUsageMetric | null, stroke: string, valueColor: string, absent: string): string =>
    `<div style="${TOP};padding:12px 0">
      <div style="display:flex;align-items:baseline;justify-content:space-between"><span style="${LABEL_SM}">${label}</span>${
        m
          ? `<span style="font-family:var(--mono);font-size:17px;font-weight:600;white-space:nowrap;${valueColor ? `color:${valueColor}` : ""}">${esc(m.value)}</span>`
          : `<span style="font-size:11.5px;color:var(--fg-40)">${absent}</span>`
      }</div>
      ${m ? spark(m.trend, stroke, 40, 8) : ""}
    </div>`;
  const errC = e.errorRate ? TONE[e.errorRate.tone === "neutral" ? "good" : e.errorRate.tone] : "";
  return `<div style="padding:18px 20px 4px;min-width:0;${i ? LEFT : ""}">
    <div style="display:flex;align-items:center;gap:9px;margin-bottom:10px"><span style="font-size:15px;font-weight:600;flex:1">${esc(e.name)}</span><span style="font-family:var(--mono);font-size:10px;color:var(--fg-40)">${esc(e.host)}</span></div>
    ${metric("Requests", e.requests, "var(--accent)", "", absentLabel(e.seen.requests))}
    ${metric("Error rate", e.errorRate, errC, errC, e.requests ? "—" : absentLabel(e.seen.requests))}
    ${metric("Active users", e.users, "var(--blue)", "", absentLabel(e.seen.users))}
  </div>`;
}

// ── Usage › Product metrics ──────────────────────────────────────────────────
// What the app reports about itself (src/repo/poll.ts → `sap_*` gauges). One
// block per environment; inside it the groups sit in a responsive grid of
// compact label / sparkline / value rows. Every row keeps the SAME three
// columns whatever it holds — a missing sparkline or a "no recent reading"
// leaves its cell in place — so switching range (which only swaps `counts`
// figures; `totals` ignore it) never shifts the layout. Labels and keys
// originate in ANOTHER service: everything interpolated goes through `esc()`.
const PRODUCT_ROW = `display:grid;grid-template-columns:minmax(0,1fr) 52px auto;gap:10px;align-items:center;padding:7px 0;${TOP}`;

/** `spark()` for a table cell: a span (a row holds no block child), fixed width. */
const miniSpark = (trend: number[], stroke: string): string =>
  trend.length < 2 ? `<span></span>` :
  `<span class="repo-spark" style="display:block;width:52px"><svg viewBox="0 0 100 26" preserveAspectRatio="none" style="width:100%;height:18px;display:block"><polyline points="${sparkPoints(trend)}" fill="none" stroke="${stroke}" stroke-width="1.4" vector-effect="non-scaling-stroke"></polyline></svg></span>`;

function productRow(label: string, value: string | null, raw: number | null, trend: number[]): string {
  // The exact integer behind a compacted figure ("1.2K") — not behind a dollar amount.
  const exact = value !== null && raw !== null && value !== String(raw) && !value.startsWith("$") ? ` title="${attr(raw.toLocaleString("en-US"))}"` : "";
  return `<div style="${PRODUCT_ROW}"><span style="font-size:12.5px;color:var(--fg-70);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(label)}</span>${miniSpark(trend, "var(--fg-40)")}${
    value === null
      ? `<span style="font-size:11.5px;color:var(--fg-40);text-align:right;white-space:nowrap">${absentLabel(true)}</span>`
      : `<span${exact} style="font-family:var(--mono);font-size:13px;font-weight:600;text-align:right;white-space:nowrap">${esc(value)}</span>`
  }</div>`;
}

function productGroup(title: string, rows: string[], notes: string[]): string {
  return `<div style="min-width:0;padding:6px 0 8px">
    <div style="${LABEL_SM};margin-bottom:6px;overflow:hidden;text-overflow:ellipsis">${esc(title)}</div>
    ${rows.join("")}
    ${notes.map((n) => `<div style="font-size:11px;line-height:1.5;color:var(--fg-40);margin-top:6px">${esc(n)}</div>`).join("")}
  </div>`;
}

function productEnv(e: RepoProductEnv, range: RepoRange): string {
  const noted = (rows: { label: string; note?: string }[]) => rows.filter((m) => m.note).map((m) => `${m.label}: ${m.note}`);
  const groups = e.groups.map((g) =>
    productGroup(g.title, g.metrics.map((m) => productRow(m.label, m.values[range], m.raw[range], m.trend)), noted(g.metrics)));
  if (e.totals.length) groups.push(productGroup("Right now", e.totals.map((t) => productRow(t.label, t.value, t.raw, t.trend)), noted(e.totals)));
  return groups.length
    ? `<div class="repo-swap" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(min(240px,100%),1fr));gap:6px 32px;margin-top:8px">${groups.join("")}</div>`
    : `<div style="margin-top:8px;padding:10px 0;${TOP};font-size:12.5px;color:var(--fg-40)">This environment has reported no product metrics.</div>`;
}

/** The product blocks under the Usage tab's panels, `--i` staggered from `i`. */
function productBlocks(p: RepoProps, i: number): string {
  const head = (title: string, aside = "") =>
    `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px"><span style="${LABEL};min-width:0;overflow:hidden;text-overflow:ellipsis">${title}</span>${aside}</div>`;
  const envs = okData(p, (d) => d.product);
  if (!envs) {
    const state = sec(p, (d) => d.product ?? { status: "not_connected" }, { nc: "No product metrics reported yet. They appear once the app's metrics endpoint serves `counts` / `totals` and `SAPLING_METRICS_TOKEN` is set.", empty: "No current product reading — the hourly poll of the app's metrics endpoint has gone quiet.", lines: 3 }, () => "");
    return `<div ${rise(i, `${TOP};padding:18px 20px`)}>${head("Product")}${state}</div>`;
  }
  const aside = `<span style="font-size:11px;color:var(--fg-40);white-space:nowrap">reported by the app · counts over ${esc(p.range)}</span>`;
  return envs.map((e, n) => `<div ${rise(i + n, `${TOP};padding:18px 20px 12px;min-width:0`)}>
      ${head(`Product — ${esc(e.name)}`, aside)}
      ${productEnv(e, p.range)}
    </div>`).join("");
}

// ── "Poll now" — the admin's on-demand run of the three hourly usage pollers ──
// "App metrics": the app's own endpoint answers active users AND product metrics in one response.
const POLL_SOURCES: [keyof UsagePollResult, string][] = [["cloudflare", "Cloudflare"], ["railway", "Railway"], ["sapling", "App metrics"]];
const MUTED = "var(--fg-40)";

/** One environment's outcome: `staging ✓ 3 new` / `✓ up to date` / `✗ <detail>` / `– skipped: <detail>`.
 *  An `ok` may carry a detail too (product keys the poll dropped, by name), and
 *  a `failed` may still have written rows (the app's product metrics land even
 *  when its active-users half is refused) — both are said, never hidden. */
function pollOutcome(o: PollOutcome): string {
  const [color, text] =
    o.status === "ok" ? [TONE.good, `${o.written > 0 ? `✓ ${o.written} new` : "✓ up to date"}${o.detail ? ` — ${o.detail}` : ""}`]
    : o.status === "failed" ? [TONE.bad, `✗ ${o.detail ?? "failed"}${o.written > 0 ? ` — ${o.written} new` : ""}`]
    : [MUTED, `– skipped${o.detail ? `: ${o.detail}` : ""}`];
  // "*" is the whole source (an arm that threw), not an environment called "*".
  return `<span><span style="font-family:var(--mono);font-weight:600;color:var(--fg-70)">${esc(o.env === "*" ? "all" : o.env)}</span> <span style="color:${color}">${esc(text)}</span></span>`;
}
const pollSource = (s: UsagePollSource): string =>
  s === "not_configured" || !Array.isArray(s) ? `<span style="color:${MUTED}">not configured</span>`
  : !s.length ? `<span style="color:${MUTED}">no environment configured</span>`
  : s.map(pollOutcome).join(`<span style="color:${MUTED}"> · </span>`);

/** The result strip under the APP USAGE header: one line per source, or the one-line failure. */
function pollStrip(poll: RepoPollState | null): string {
  if (!poll || poll.status === "polling") return "";
  const lines = poll.status === "error"
    ? `<div style="color:${TONE.bad}">Poll failed — try again.</div>`
    : POLL_SOURCES.map(([key, label]) =>
      `<div><span style="font-weight:600;color:var(--fg-70)">${label}</span><span style="color:${MUTED}"> — </span>${pollSource(poll.result[key])}</div>`).join("");
  return `<div class="repo-poll-strip" role="status" style="display:flex;align-items:flex-start;gap:12px;padding:10px 20px;border-bottom:1px solid var(--border);font-size:12px;line-height:1.7;color:var(--fg-55)">
      <div style="flex:1;min-width:0;overflow-wrap:anywhere">${lines}</div>
      <button data-act="repoPollDismiss" title="Dismiss" aria-label="Dismiss poll result" class="cnpy-iconbtn" style="flex:none;width:22px;height:22px;border-radius:6px;display:grid;place-items:center;font-size:14px;line-height:1;color:${MUTED}">×</button>
    </div>`;
}

function usageTab(p: RepoProps): string {
  const usageLive = okData(p, (d) => d.usage) !== null;
  // Admins only, and never in sample mode (which never touches the Worker). A
  // non-admin gets the header exactly as it was — the button and its wrapper
  // exist only for an admin, and the wrapper (not the row) is what wraps at
  // phone width: the button drops above the range buttons, right-aligned.
  const canPoll = p.admin && !p.sample;
  const polling = p.poll?.status === "polling";
  const ranges = `<div class="repo-seg" style="display:flex;align-items:center;gap:3px;padding:3px;border:1px solid var(--border);border-radius:9px">${REPO_RANGES.map((r) =>
    `<button data-act="repoRange" data-arg="${r}" aria-pressed="${p.range === r}" style="padding:4px 12px;border-radius:7px;font-size:12px;font-weight:500;font-family:var(--mono);color:${p.range === r ? "var(--fg)" : "var(--fg-55)"};background:${p.range === r ? "var(--hover)" : "transparent"}">${r}</button>`).join("")}</div>`;

  const usage = sec(p, (d) => d.usage, { nc: "No usage captured yet. Requests and error rate come from the hourly Cloudflare analytics poll (CF_ANALYTICS_TOKEN and CF_ANALYTICS_ACCOUNT_ID); active users come from the app's own metrics endpoint (SAPLING_METRICS_TOKEN). Both need an environment in REPO_ENVIRONMENTS.", empty: "No current usage reading — the hourly polls have gone quiet.", lines: 4 }, (u) =>
    `<div class="repo-swap" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr))">${u[p.range].map(usageEnv).join("")}</div>`);
  // `ok` is gated on the WIDEST range (30d), so a narrower one can legitimately
  // hold no rows — say so, rather than render a titled panel with nothing in it.
  // "Nothing RECORDED", not "no requests": an empty range may be one no poll
  // ever covered, and zero traffic is a claim the capture cannot support.
  const cf = sec(p, (d) => d.cloudflare, { nc: "No Cloudflare analytics captured yet. The hourly poll runs once the CF_ANALYTICS_TOKEN and CF_ANALYTICS_ACCOUNT_ID secrets are set and REPO_ENVIRONMENTS names each environment's Worker; it also feeds the requests and error rate above.", empty: "No Cloudflare metrics in the last 30 days." }, (c) =>
    `<div class="repo-swap">${!c[p.range].length ? `<div style="padding:10px 0;${TOP};font-size:12.5px;color:var(--fg-40)">Nothing recorded in this range.</div>` : ""}${c[p.range].map((w) => `<div style="display:grid;grid-template-columns:84px minmax(0,1fr) 90px;gap:12px;align-items:center;padding:10px 0;${TOP}">
      <span style="font-family:var(--mono);font-size:11.5px;font-weight:600;color:var(--fg-70)">${esc(w.env)}</span>
      <span style="font-size:12.5px;color:var(--fg-55)">${esc(w.label)}</span>
      <span style="font-family:var(--mono);font-size:13px;font-weight:600;text-align:right">${esc(w.value)}</span>
    </div>`).join("")}</div>`);
  const hosting = sec(p, (d) => d.hosting, { nc: "No Railway reading captured yet. The hourly poll runs once an environment's RAILWAY_TOKEN_<ENVIRONMENT> secret is set and REPO_ENVIRONMENTS carries its railwayEnvironmentId and railwayServiceId.", empty: "No fresh hosting reading — the last Railway sample is over 3 hours old." }, (rows) =>
    rows.map((h) => `<div style="display:grid;grid-template-columns:84px minmax(0,1fr) minmax(0,1fr);gap:12px;align-items:center;padding:10px 0;${TOP}">
      <span style="font-family:var(--mono);font-size:11.5px;font-weight:600;color:var(--fg-70)">${esc(h.env)}</span>
      <span style="font-size:12.5px;color:var(--fg-55)">CPU <span style="font-family:var(--mono);font-weight:600;color:var(--fg)">${esc(h.cpu)}</span></span>
      <span style="font-size:12.5px;color:var(--fg-55)">Memory <span style="font-family:var(--mono);font-weight:600;color:var(--fg)">${esc(h.memory)}</span></span>
    </div>`).join(""));

  const pollBtn = `<button data-act="repoPollNow" title="Run the hourly usage polls now" class="cnpy-outlinebtn"${polling ? " disabled" : ""} style="padding:7px 12px;border-radius:9px;border:1px solid var(--border);font-size:12px;font-weight:500;white-space:nowrap;color:var(--fg-55);${polling ? "opacity:.6;cursor:default;pointer-events:none" : ""}">${polling ? "Polling…" : "Poll now"}</button>`;
  const controls = canPoll ? `<div style="display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:8px;min-width:0">${pollBtn}${ranges}</div>` : ranges;

  return `<div ${rise(0, `display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--border)`)}>
      <span style="${LABEL}">App usage</span>${controls}
    </div>
    ${canPoll ? pollStrip(p.poll) : ""}
    <div ${rise(1)}>${usageLive ? usage : `<div style="padding:6px 20px">${usage}</div>`}</div>
    <div ${rise(2, `display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));${TOP};flex:1`)}>
      <div style="padding:18px 20px;min-width:0;display:flex;flex-direction:column">
        <div style="${LABEL};margin-bottom:8px">Cloudflare — frontend Workers</div>
        ${cf}
      </div>
      <div style="padding:18px 20px;${LEFT};min-width:0;display:flex;flex-direction:column">
        <div style="${LABEL}">Hosting — Railway backend</div>
        ${hosting}
      </div>
    </div>
    ${productBlocks(p, 3)}`;
}

// ── Team & Planning ──────────────────────────────────────────────────────────
function planningTab(p: RepoProps): string {
  const sprint = sec(p, (d) => d.sprint, { nc: "Sprints aren't connected.", empty: "No sprint is active — mark one active on the Roadmap.", lines: 2 }, (sp) => {
    const due = sp.due ? new Date(sp.due).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).toUpperCase() : null;
    return `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="${LABEL}">Current sprint</span>
        ${due ? `<span style="margin-left:auto;font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.04em;color:var(--fg-55);border:1px solid var(--border);border-radius:5px;padding:2px 7px;white-space:nowrap">DUE ${esc(due)}</span>` : ""}
      </div>
      <div style="display:flex;align-items:center;gap:12px;margin-top:10px">
        <button data-act="openSprint" data-arg="${sp.id}" class="repo-quiet" style="font-size:16.5px;font-weight:600;letter-spacing:-0.01em;min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;padding:0">${esc(sp.label)}</button>
        <span style="font-family:var(--mono);font-size:13px;font-weight:600;color:var(--accent);flex:none"><span data-count="${sp.pct}">${sp.pct}</span>%</span>
        <span style="font-size:12px;color:var(--fg-40);flex:none;white-space:nowrap">${sp.closed} closed · ${sp.total - sp.closed} open</span>
      </div>
      <div style="height:9px;border-radius:999px;background:var(--hover);overflow:hidden;margin-top:12px"><div class="repo-fill" style="height:100%;width:${sp.pct}%;background:var(--accent);border-radius:999px"></div></div>`;
  });
  const sprintLive = okData(p, (d) => d.sprint) !== null;

  const contributors = sec(p, (d) => d.contributors, { nc: "Contributors aren't connected.", empty: "No pushes, merges or reviews this week.", lines: 4 }, (rows) => {
    // `reviews` is null until a `review` row has ever been captured — never
    // guessed as 0, and excluded from the bar width (not just rendered as "—").
    const max = Math.max(1, ...rows.map((r) => r.pushes + r.merged + (r.reviews ?? 0)));
    return rows.map((r, i) => {
      const color = r.person.color ? `var(--p-${r.person.color})` : "var(--fg-40)";
      return `<div style="display:grid;grid-template-columns:112px minmax(0,1fr) 74px;gap:12px;align-items:center;padding:5.5px 0;${TOP}">
        <span style="display:inline-flex;align-items:center;gap:7px;min-width:0">${avatar(r.person, 20)}<span style="font-family:var(--mono);font-size:11.5px;color:var(--fg-70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(who(r.person))}</span></span>
        <span style="display:block;height:6px;border-radius:999px;background:var(--hover);overflow:hidden"><span class="repo-fill" style="--i:${i};display:block;height:100%;border-radius:999px;background:${color};width:${Math.round(((r.pushes + r.merged + (r.reviews ?? 0)) / max) * 100)}%"></span></span>
        <span style="font-family:var(--mono);font-size:11.5px;color:var(--fg-55);text-align:right">${r.pushes} · ${r.merged} · ${r.reviews === null ? "—" : r.reviews}</span>
      </div>`;
    }).join("");
  });

  const labelData = okData(p, (d) => d.labels);
  const labels = sec(p, (d) => d.labels, { nc: "Issue labels aren't connected.", empty: "No open issues with labels.", lines: 4 }, (l) => {
    const max = Math.max(1, ...l.rows.map((r) => r.count));
    return l.rows.map((r, i) => {
      const bug = r.name.toLowerCase() === "bug";
      return `<div style="display:grid;grid-template-columns:110px minmax(0,1fr) 30px;gap:12px;align-items:center;padding:9px 0;${TOP}">
        <span style="font-family:var(--mono);font-size:11.5px;color:var(--fg-70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.name)}</span>
        <span style="display:block;height:6px;border-radius:999px;background:var(--hover);overflow:hidden"><span class="repo-fill" style="--i:${i};display:block;height:100%;border-radius:999px;background:${bug ? "var(--red)" : "var(--border-strong)"};width:${Math.round((r.count / max) * 100)}%"></span></span>
        <span style="font-family:var(--mono);font-size:12px;font-weight:600;text-align:right;color:${bug ? "var(--red)" : "var(--fg)"}">${r.count}</span>
      </div>`;
    }).join("");
  });

  // `t.delta` is null once the window can't support a trend claim (see
  // `windowDelta` in src/tools/repo.ts) — the count/sparkline still show, but
  // no delta chip and no "since" text (there is nothing to date it from).
  // I2: `empty` now means "a count has landed before, just not in the last 90
  // days", not "nothing has ever scanned this".
  const todos = sec(p, (d) => d.todos, { nc: "No TODO / FIXME count reported yet. It appears once the repo's CI posts a canopy/todo commit status on a push to the default environment branch and the GitHub webhook delivers status events.", empty: "No count reported in the last 90 days." }, (t) =>
    `<div style="display:flex;align-items:baseline;gap:12px;margin-top:10px">
      <span data-count="${t.count}" style="font-family:var(--mono);font-size:31px;font-weight:600;letter-spacing:-0.02em">${t.count}</span>
      ${t.delta === null ? "" : `<span style="font-family:var(--mono);font-size:11.5px;font-weight:600;color:${t.delta <= 0 ? "var(--green)" : "var(--amber)"}">${t.delta < 0 ? "−" : "+"}${Math.abs(t.delta)}</span>
      <span style="font-size:11px;color:var(--fg-40)">since ${esc(t.since)}</span>`}
    </div>
    ${spark(t.trend, "var(--fg-55)", 52, 12)}
    <div style="font-size:11.5px;color:var(--fg-40);margin-top:8px">counted by CI on each push to the default environment branch</div>`);

  return `<div ${rise(0, `padding:20px 22px`)}>${sprintLive ? sprint : `<div style="${LABEL}">Current sprint</div>${sprint}`}</div>
    <div ${rise(1, `display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));${TOP};flex:1`)}>
      <div style="padding:16px 20px;min-width:0">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px"><span style="${LABEL}">Contributors this week</span><span title="pushes · merged PRs · reviews" style="font-family:var(--mono);font-size:10px;color:var(--fg-40);letter-spacing:.04em">P · M · R</span></div>
        ${contributors}
      </div>
      <div style="padding:16px 20px;${LEFT};min-width:0">
        <div style="${LABEL};margin-bottom:6px">Open issues by label${labelData ? ` — ${labelData.total}` : ""}</div>
        ${labels}
      </div>
      <div style="padding:16px 20px;${LEFT};min-width:0;display:flex;flex-direction:column">
        <div style="${LABEL}">TODO / FIXME in source</div>
        ${todos}
      </div>
    </div>`;
}

// ── the screen ───────────────────────────────────────────────────────────────
const SCREEN_LABEL: Record<RepoTab, string> = { overview: "Overview", code: "Code", ci: "CI and Deploys", usage: "Usage", planning: "Planning" };

/** Does the tab in view have a section nothing has been captured for yet? */
function hasUncaptured(p: RepoProps): boolean {
  const d = p.repo.data;
  if (!d) return false;
  const by: Record<RepoTab, RepoSection<unknown>[]> = {
    overview: [d.environments, d.drift, d.stats, d.health],
    code: [d.codeStats, d.bars, d.prs, d.branches],
    ci: [d.deploys, d.ciFailures, d.coverage, d.bundle, d.activity],
    usage: [d.usage, d.cloudflare, d.hosting, d.product ?? { status: "not_connected" }],
    planning: [d.sprint, d.contributors, d.labels, d.todos],
  };
  return by[p.tab].some((s) => s.status === "not_connected");
}

export function repoView(p: RepoProps): string {
  const body = p.tab === "overview" ? overviewTab(p) : p.tab === "code" ? codeTab(p) : p.tab === "ci" ? ciTab(p)
    : p.tab === "usage" ? usageTab(p) : planningTab(p);

  const info = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--fg-40)" stroke-width="1.8" style="flex:none"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16h.01"></path></svg>`;
  const banner = p.sample
    ? `<div class="cnpy-rise" style="display:flex;align-items:center;gap:9px;margin-bottom:16px;font-size:12.5px;color:var(--fg-55)">${info}
        <span><span style="font-family:var(--mono);font-size:11.5px;color:var(--fg);background:var(--hover);border:1px solid var(--border);border-radius:4px;padding:0 5px">sample data</span> — every section shown with placeholder values, not this repo's.</span>
        <button data-act="repoSampleOff" class="repo-textbtn" style="margin-left:auto;font-size:12.5px;font-weight:500;color:var(--accent);padding:0;white-space:nowrap">Back to live data</button>
      </div>`
    : p.repo.data?.degraded
      ? `<div class="cnpy-rise" style="display:flex;align-items:center;gap:9px;margin-bottom:16px;font-size:12.5px;color:var(--fg-55)">${info}Some reads failed, so this view may be incomplete.</div>`
      : "";
  const footer = !p.sample && hasUncaptured(p)
    ? `<div class="cnpy-rise" style="--i:6;display:flex;align-items:center;gap:9px;margin-top:14px;font-size:12px;color:var(--fg-40)">${info}
        <span>Sections marked <span style="color:var(--fg-55)">not connected</span> have had nothing captured yet — each says what it is waiting on.</span>
        <button data-act="repoSampleOn" class="repo-textbtn" style="font-size:12px;font-weight:500;color:var(--accent);padding:0;white-space:nowrap">Preview with sample data</button>
      </div>`
    : "";

  return `<div style="${FRAME}" data-screen-label="${SCREEN_LABEL[p.tab]}">
    ${banner}
    <div class="repo-panel" style="${PANEL}">${body}</div>
    ${footer}
  </div>`;
}
