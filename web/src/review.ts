// Review surface — componentized from Canopy Triage.dc.html (the static design
// output). One queue for everything agent-produced that needs a human verdict:
// doc proposals (diff against live) and drafted decisions (ADR record).
//
// Every component here is purely presentational: data arrives through props
// and renders to an HTML string in the app's template-string idiom.
// Interactions dispatch via data-act / data-arg handled in main.ts. No fetching,
// no inline data.

import { esc, attr, statusBadge, avatarCircle, selectChip, dashedCard, MONO_LABEL } from "./ui";

// ── prop shapes (loose for now — reshaped at wire time) ──────────────────────
export type ReviewKind = "proposal" | "decision";
export type ReviewFilter = "all" | ReviewKind;
export type DiffViewMode = "unified" | "split" | "rendered";

/** One line of a proposal's diff: ctx / add / del, `h` = heading context, `gap` = hunk separator. */
export type DiffEntryKind = "ctx" | "add" | "del" | "gap" | "h" | "ellipsis";
export interface DiffEntry { t: DiffEntryKind; s?: string }

export interface AdrSection { h: string; p: string }

export interface ReviewItem {
  id: string;
  kind: ReviewKind;
  eyebrow: string;
  badge: string;
  badgeColor: string; // CSS var expression, e.g. "var(--amber)"
  title: string;
  summary: string;
  agent: string;
  agentInitials: string;
  time: string;
  /** Gate's scrutinize signal: staged with low_confidence = 1. Rendered as a small marker. */
  flagged?: boolean;
  stale?: boolean;
  staleNote?: string;
  liveVersion?: string; // split-view left header, e.g. "LIVE (v8)"
  diff?: DiffEntry[]; // proposals
  adr?: AdrSection[]; // decisions
}

export interface ReviewProps {
  /** Items still pending a verdict (unfiltered). */
  items: ReviewItem[];
  filter: ReviewFilter;
  /** null → default to the first visible item. */
  selectedId: string | null;
  diffView: DiffViewMode;
}

// ── list pane ────────────────────────────────────────────────────────────────
export function reviewFilterChips(filter: ReviewFilter): string {
  const chips: [ReviewFilter, string][] = [["all", "All"], ["proposal", "Proposals"], ["decision", "Decisions"]];
  return `<div style="display:flex;gap:6px;margin:14px 0 12px">${chips
    .map(([key, label]) => selectChip(label, filter === key, "reviewFilter", key))
    .join("")}</div>`;
}

/** One review queue row: eyebrow + badge, title, 2-line summary, agent + time. */
export function reviewCard(it: ReviewItem, selected: boolean): string {
  return `<button data-act="reviewSelect" data-arg="${attr(it.id)}" class="cnpy-titem">
    ${selected ? `<span class="cnpy-selbar"></span>` : ""}
    <div style="position:relative">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <div style="font-family:var(--mono);font-size:10.5px;font-weight:600;letter-spacing:.06em;color:var(--fg-40)">${esc(it.eyebrow)}</div>
        ${statusBadge(it.badge, it.badgeColor)}${it.flagged ? statusBadge("FLAGGED", "var(--amber)") : ""}
      </div>
      <div style="font-size:14px;font-weight:600;letter-spacing:-0.005em;margin-top:6px;color:var(--fg)">${esc(it.title)}</div>
      <div style="font-size:12.5px;color:var(--fg-55);margin-top:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(it.summary)}</div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:10px">
        ${avatarCircle(it.agentInitials)}
        <div style="font-size:12px;color:var(--fg-55);flex:1">${esc(it.agent)}</div>
        <div style="font-size:11.5px;color:var(--fg-40)">${esc(it.time)}</div>
      </div>
    </div>
  </button>`;
}

export function reviewListEmpty(): string {
  return dashedCard("All clear", "Nothing is waiting for review.");
}

// ── detail pane pieces ───────────────────────────────────────────────────────
export function staleBaseWarning(note: string): string {
  return `<div style="border:1px solid var(--border);border-left:2px solid var(--amber);border-radius:9px;padding:11px 15px;margin-top:18px;display:flex;gap:10px;align-items:baseline">
    <div style="font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.06em;color:var(--amber);flex:none">STALE BASE</div>
    <div style="font-size:12.5px;color:var(--fg-70)">${esc(note)}</div>
  </div>`;
}

// ── diff viewer ──────────────────────────────────────────────────────────────
function diffLineStyle(t: DiffEntryKind): string {
  const base = "font-family:var(--mono);font-size:12.5px;line-height:1.75;padding:2px 16px 2px 12px;white-space:pre-wrap;color:var(--fg-55);border-left:2px solid transparent";
  if (t === "del") return `${base};border-left:2px solid var(--red);background:color-mix(in srgb,var(--red) 7%,transparent)`;
  if (t === "add") return `${base};border-left:2px solid var(--green);background:color-mix(in srgb,var(--green) 7%,transparent);color:var(--fg-70)`;
  if (t === "h") return `${base};color:var(--fg);font-weight:600`;
  return base;
}
const GAP_STYLE = "height:14px;border-bottom:1px solid var(--border);margin-bottom:14px";
const ELLIPSIS_STYLE = "font-family:var(--mono);font-size:11px;letter-spacing:.04em;color:var(--fg-40);text-align:center;padding:6px 16px;border-top:1px dashed var(--border);border-bottom:1px dashed var(--border);margin:6px 0";

function diffPrefix(t: DiffEntryKind): string {
  const color = t === "del" ? "var(--red)" : t === "add" ? "var(--green)" : "var(--fg-40)";
  const ch = t === "del" ? "−" : t === "add" ? "+" : " ";
  return `<span style="display:inline-block;width:18px;flex:none;color:${color}">${ch}</span>`;
}

export function unifiedDiff(entries: DiffEntry[]): string {
  const lines = entries.map((e) => {
    if (e.t === "gap") return `<div style="${GAP_STYLE}"></div>`;
    if (e.t === "ellipsis") return `<div style="${ELLIPSIS_STYLE}">${esc(e.s ?? "")}</div>`;
    return `<div style="${diffLineStyle(e.t)}">${diffPrefix(e.t)}${esc(e.s ?? "")}</div>`;
  }).join("");
  return `<div style="border:1px solid var(--border);border-radius:10px;overflow:hidden;padding:8px 0">${lines}</div>`;
}

type SplitCell = { t: DiffEntryKind | "empty"; text: string };

/** Pair del-runs with add-runs so old and new sit side by side; ctx/h span both columns. */
export function splitDiffRows(entries: DiffEntry[]): { left: SplitCell; right: SplitCell }[] {
  const rows: { left: SplitCell; right: SplitCell }[] = [];
  let i = 0;
  while (i < entries.length) {
    const e = entries[i];
    if (e.t === "gap") { rows.push({ left: { t: "gap", text: "" }, right: { t: "gap", text: "" } }); i++; continue; }
    if (e.t === "ctx" || e.t === "h" || e.t === "ellipsis") {
      const text = e.s ?? "";
      rows.push({ left: { t: e.t, text }, right: { t: e.t, text } });
      i++; continue;
    }
    const dels: string[] = [];
    const adds: string[] = [];
    while (i < entries.length && entries[i].t === "del") { dels.push(entries[i].s ?? ""); i++; }
    while (i < entries.length && entries[i].t === "add") { adds.push(entries[i].s ?? ""); i++; }
    for (let j = 0; j < Math.max(dels.length, adds.length); j++) {
      rows.push({
        left: j < dels.length ? { t: "del", text: dels[j] } : { t: "empty", text: "·" },
        right: j < adds.length ? { t: "add", text: adds[j] } : { t: "empty", text: "·" },
      });
    }
  }
  return rows;
}

function splitCellHtml(c: SplitCell, isLeft: boolean): string {
  const borderRight = isLeft ? ";border-right:1px solid var(--border)" : "";
  if (c.t === "gap") return `<div style="${GAP_STYLE}${borderRight}"></div>`;
  if (c.t === "ellipsis") return `<div style="${ELLIPSIS_STYLE}${borderRight}">${esc(c.text)}</div>`;
  if (c.t === "empty") return `<div style="font-family:var(--mono);font-size:12.5px;line-height:1.75;padding:2px 16px 2px 12px;border-left:2px solid transparent;color:transparent${borderRight}">·</div>`;
  return `<div style="${diffLineStyle(c.t)}${borderRight}">${esc(c.text)}</div>`;
}

export function splitDiff(entries: DiffEntry[], liveLabel: string): string {
  const rows = splitDiffRows(entries).map((r) =>
    `<div style="display:grid;grid-template-columns:1fr 1fr">${splitCellHtml(r.left, true)}${splitCellHtml(r.right, false)}</div>`
  ).join("");
  return `<div style="border:1px solid var(--border);border-radius:10px;overflow:hidden">
    <div style="display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid var(--border)">
      <div style="padding:8px 14px;font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.08em;color:var(--fg-40);border-right:1px solid var(--border)">${esc(liveLabel)}</div>
      <div style="padding:8px 14px;font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.08em;color:var(--accent)">PROPOSED</div>
    </div>
    <div style="padding:8px 0">${rows}</div>
  </div>`;
}

export function renderedPreview(entries: DiffEntry[]): string {
  const blocks = entries.filter((e) => e.t !== "gap").map((e) => {
    const text = e.s ?? "";
    if (e.t === "ellipsis") return `<div style="border-top:1px dashed var(--border);margin:16px 0"></div>`;
    if (e.t === "h") return `<div style="font-size:18px;font-weight:600;letter-spacing:-0.01em;color:var(--fg);margin:18px 0 10px">${esc(text.replace(/^#+\s*/, ""))}</div>`;
    const base = "font-size:15px;line-height:1.72;margin:0 0 10px";
    if (e.t === "del") return `<div style="${base};text-decoration:line-through;color:color-mix(in srgb,var(--red) 75%,transparent);background:color-mix(in srgb,var(--red) 6%,transparent);border-radius:4px;padding:2px 6px">${esc(text)}</div>`;
    if (e.t === "add") return `<div style="${base};color:var(--fg);background:color-mix(in srgb,var(--green) 9%,transparent);border-radius:4px;padding:2px 6px">${esc(text)}</div>`;
    return `<div style="${base};color:var(--fg-70)">${esc(text)}</div>`;
  }).join("");
  return `<div style="border:1px solid var(--border);border-radius:10px;padding:22px 28px 26px">
    ${blocks}
    <div style="display:flex;gap:16px;margin-top:20px;padding-top:14px;border-top:1px solid var(--border)">
      <div style="font-size:11px;color:var(--fg-40)"><span style="color:var(--green)">■</span> added in this proposal</div>
      <div style="font-size:11px;color:var(--fg-40)"><span style="color:var(--red)">■</span> removed (struck)</div>
    </div>
  </div>`;
}

/** "WHAT CHANGED" header + Unified / Side by side / Rendered toggle + the active mode. */
export function diffViewer(entries: DiffEntry[], view: DiffViewMode, liveLabel: string): string {
  const chips: [DiffViewMode, string][] = [["unified", "Unified"], ["split", "Side by side"], ["rendered", "Rendered"]];
  const toggle = chips.map(([key, label]) => selectChip(label, view === key, "reviewDiffView", key, true)).join("");
  const body = view === "split" ? splitDiff(entries, liveLabel)
    : view === "rendered" ? renderedPreview(entries)
    : unifiedDiff(entries);
  return `<div style="display:flex;align-items:center;justify-content:space-between;margin:22px 0 10px">
    <div style="${MONO_LABEL}">WHAT CHANGED</div>
    <div style="display:flex;gap:5px">${toggle}</div>
  </div>
  ${body}`;
}

/** Drafted decision: the proposed ADR record (Context / Decision / Consequences). */
export function adrRecord(sections: AdrSection[]): string {
  const body = sections.map((s) => `<div style="margin-bottom:18px">
      <div style="font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--fg-55);margin-bottom:6px">${esc(s.h)}</div>
      <div style="font-size:14.5px;line-height:1.7;color:var(--fg-70)">${esc(s.p)}</div>
    </div>`).join("");
  return `<div style="display:flex;align-items:center;gap:10px;margin:22px 0 10px">
    <div style="${MONO_LABEL}">PROPOSED RECORD</div>
    <div style="font-size:11.5px;color:var(--fg-40)">new document — no prior version</div>
  </div>
  <div style="border:1px solid var(--border);border-left:2px solid var(--green);border-radius:10px;padding:24px 28px 26px">${body}</div>`;
}

/** Detail pane for the selected item: header + verdict actions + content. */
export function reviewDetail(it: ReviewItem, diffView: DiffViewMode): string {
  const acceptLabel = it.kind === "decision" ? "Ratify" : "Promote";
  const content = it.kind === "decision"
    ? adrRecord(it.adr ?? [])
    : diffViewer(it.diff ?? [], diffView, it.liveVersion ?? "LIVE");
  return `<div style="max-width:920px;padding:24px 32px 100px">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:20px">
      <div style="min-width:0">
        <div style="display:flex;align-items:center;gap:9px">
          <div style="font-family:var(--mono);font-size:10.5px;font-weight:600;letter-spacing:.06em;color:var(--fg-40)">${esc(it.eyebrow)}</div>
          ${statusBadge(it.badge, it.badgeColor)}${it.flagged ? statusBadge("FLAGGED FOR REVIEW", "var(--amber)") : ""}
        </div>
        <h2 style="margin:8px 0 0;font-size:22px;font-weight:600;letter-spacing:-0.02em">${esc(it.title)}</h2>
        <div style="display:flex;align-items:center;gap:8px;margin-top:8px">
          ${avatarCircle(it.agentInitials)}
          <div style="font-size:12px;color:var(--fg-55)">${esc(it.agent)}</div>
          <div style="font-size:11.5px;color:var(--fg-40)">· ${esc(it.time)}</div>
        </div>
      </div>
      <div style="display:flex;gap:8px;flex:none;padding-top:2px">
        <button data-act="reviewReject" data-arg="${attr(it.id)}" class="cnpy-rejectbtn" style="background:transparent;border:1px solid var(--border-strong);border-radius:8px;padding:8px 14px;font-size:12.5px;font-weight:500;color:var(--fg-70);transition:all .12s ease">Reject</button>
        <button data-act="reviewAccept" data-arg="${attr(it.id)}" class="cnpy-accentbtn" style="background:var(--accent);color:var(--accent-fg);border-radius:8px;padding:9px 17px;font-size:13px;font-weight:600">${acceptLabel}</button>
      </div>
    </div>
    ${it.stale && it.staleNote ? staleBaseWarning(it.staleNote) : ""}
    ${content}
  </div>`;
}

export function reviewQueueClear(): string {
  return `<div style="height:100%;display:flex;align-items:center;justify-content:center;padding:40px">
    ${dashedCard("Queue is clear", "Everything an agent produced has been reviewed. New proposals will appear here as sessions finish.", true)}
  </div>`;
}

// ── composed surface ─────────────────────────────────────────────────────────
export function reviewView(p: ReviewProps): string {
  const visible = p.items.filter((it) => p.filter === "all" || it.kind === p.filter);
  // Selection survives a filter that hides it (the detail keeps showing it);
  // with nothing explicitly selected, default to the first visible item.
  const sel = (p.selectedId !== null ? p.items.find((it) => it.id === p.selectedId) : undefined) ?? visible[0] ?? null;

  const list = visible.length > 0
    ? visible.map((it) => reviewCard(it, sel !== null && it.id === sel.id)).join("")
    : reviewListEmpty();

  return `<div style="display:flex;height:100%;min-width:0">
    <div style="width:376px;flex:none;border-right:1px solid var(--border);display:flex;flex-direction:column;min-height:0">
      <div style="padding:22px 20px 0">
        <h1 style="margin:0;font-size:22px;font-weight:600;letter-spacing:-0.02em">Review</h1>
        <div style="font-size:12.5px;color:var(--fg-55);margin-top:3px">Agent-produced changes waiting for a verdict.</div>
        ${reviewFilterChips(p.filter)}
      </div>
      <div class="cnpy-scroll" style="flex:1;overflow-y:auto;padding:2px 14px 80px">${list}</div>
    </div>
    <div class="cnpy-scroll" style="flex:1;min-width:0;overflow-y:auto">
      ${sel ? reviewDetail(sel, p.diffView) : reviewQueueClear()}
    </div>
  </div>`;
}
