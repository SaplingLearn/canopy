// Maintenance surface — componentized from Canopy Triage.dc.html (the static
// design output). Occasional housekeeping in two sections: UNPLACED (route or
// discard the loose things agents couldn't place) and IDENTITY (match unmapped
// activity logins to people). Empty is the normal state.
//
// Purely presentational: data arrives through props (fed from triage-mock.ts
// until the backend reads land) and renders to HTML strings; interactions
// dispatch via data-act / data-arg handled in main.ts. No fetching, no inline
// data.

import { esc, attr, avatarCircle, pickRow, primaryBtn, MONO_LABEL } from "./ui";

// ── prop shapes (loose for now — reshaped at wire time) ──────────────────────
export interface UnplacedItem {
  id: string;
  title: string;
  snippet: string;
  reason: string; // e.g. "AGENT FLAGGED" / "LOW CONFIDENCE"
  meta: string; // e.g. "agent · session 9b1e · 2h ago"
  reasonNote: string;
}

/** The assign flow's vocabulary: what a loose thing can be, and where each kind can go. */
export interface AssignOptions {
  kinds: string[];
  targets: Record<string, string[]>;
}

export interface ActivitySample { kind: string; text: string; when: string }

export interface IdentityGroup {
  id: string;
  login: string;
  meta: string; // e.g. "first seen 3w ago"
  countNum: number;
  countLabel: string; // e.g. "14 events waiting on this match"
  sample: ActivitySample[];
}

export interface Person { id: string; name: string; initials: string }

export interface MaintenanceProps {
  unplaced: UnplacedItem[];
  assign: AssignOptions;
  assignOpen: string | null;
  assignKind: string | null;
  assignTarget: string | null;
  identity: IdentityGroup[];
  people: Person[];
  mapPicks: Record<string, string>;
}

// ── shared section chrome ────────────────────────────────────────────────────
export function maintSectionHeader(label: string, hint: string, countLabel: string, first: boolean): string {
  return `<div style="display:flex;align-items:baseline;justify-content:space-between;margin-top:${first ? "38px" : "44px"};padding-bottom:9px;border-bottom:1px solid var(--border-strong)">
    <div style="display:flex;align-items:baseline;gap:10px">
      <div style="font-family:var(--mono);font-size:11px;font-weight:600;letter-spacing:.08em;color:var(--fg-55)">${esc(label)}</div>
      <div style="font-size:11.5px;color:var(--fg-40)">${esc(hint)}</div>
    </div>
    <div style="font-family:var(--mono);font-size:10.5px;font-weight:600;color:var(--fg-40)">${esc(countLabel)}</div>
  </div>`;
}

/** Centered section empty state (the normal state for both sections). */
export function maintEmpty(title: string, sub: string): string {
  return `<div style="padding:30px 0;text-align:center;border-bottom:1px solid var(--border)">
    <div style="font-size:13px;font-weight:500;color:var(--fg-55)">${esc(title)}</div>
    <div style="font-size:12px;color:var(--fg-40);margin-top:3px">${esc(sub)}</div>
  </div>`;
}

// ── UNPLACED ─────────────────────────────────────────────────────────────────
/** The expanded assign flow: pick what it is, then where it goes, then file it. */
export function assignPanel(itemId: string, assign: AssignOptions, kind: string | null, target: string | null): string {
  const kindChips = assign.kinds
    .map((k) => pickRow(esc(k), kind === k, "maintAssignKind", k))
    .join("");
  const targets = kind !== null ? (assign.targets[kind] ?? []) : [];
  const targetRows = kind !== null
    ? `<div style="display:flex;flex-direction:column;gap:5px">${targets.map((t) => pickRow(esc(t), target === t, "maintAssignTarget", t)).join("")}</div>`
    : `<div style="font-size:12.5px;color:var(--fg-40);padding:7px 0">Pick what kind of thing it is first.</div>`;
  const canFile = kind !== null && target !== null;
  return `<div style="border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-top:14px">
    <div style="display:grid;grid-template-columns:190px 1fr;gap:22px">
      <div>
        <div style="${MONO_LABEL};margin-bottom:8px">WHAT IS IT</div>
        <div style="display:flex;flex-direction:column;gap:5px">${kindChips}</div>
      </div>
      <div>
        <div style="${MONO_LABEL};margin-bottom:8px">WHERE IT GOES</div>
        ${targetRows}
      </div>
    </div>
    <div style="display:flex;justify-content:flex-end;margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
      ${primaryBtn("File it", canFile, "maintFile", itemId)}
    </div>
  </div>`;
}

/** One unplaced loose thing: reason chip + meta, title, snippet, and the route/discard affordances. */
export function unplacedRow(u: UnplacedItem, open: boolean, assign: AssignOptions, kind: string | null, target: string | null): string {
  const toggleStyle = open
    ? "background:transparent;border:1px solid var(--border-strong);color:var(--fg-70)"
    : "background:var(--accent-soft);border:1px solid var(--accent);color:var(--accent)";
  return `<div style="border-bottom:1px solid var(--border);padding:18px 0">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:20px">
      <div style="min-width:0;flex:1">
        <div style="display:flex;align-items:center;gap:9px">
          <div style="font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.05em;color:var(--fg-55);border:1px solid var(--border-strong);border-radius:5px;padding:2px 6px">${esc(u.reason)}</div>
          <div style="font-size:11.5px;color:var(--fg-40)">${esc(u.meta)}</div>
        </div>
        <div style="font-size:14px;font-weight:600;letter-spacing:-0.005em;margin-top:10px">${esc(u.title)}</div>
        <div style="border:1px solid var(--border);border-radius:8px;padding:10px 14px;margin-top:8px;font-size:13px;line-height:1.6;color:var(--fg-70)">${esc(u.snippet)}</div>
        <div style="font-size:11.5px;color:var(--fg-40);margin-top:7px">${esc(u.reasonNote)}</div>
      </div>
      <div style="display:flex;gap:7px;flex:none;padding-top:1px">
        <button data-act="maintDiscard" data-arg="${attr(u.id)}" class="cnpy-rejectbtn" style="background:transparent;border:1px solid var(--border);border-radius:7px;padding:5px 11px;font-size:12.5px;font-weight:500;color:var(--fg-70);transition:all .12s ease">Discard</button>
        <button data-act="maintAssignToggle" data-arg="${attr(u.id)}" style="${toggleStyle};border-radius:8px;padding:6px 13px;font-size:12.5px;font-weight:600;transition:all .12s ease;flex:none">${open ? "Close" : "Assign…"}</button>
      </div>
    </div>
    ${open ? assignPanel(u.id, assign, kind, target) : ""}
  </div>`;
}

// ── IDENTITY ─────────────────────────────────────────────────────────────────
/** The "WHO IS THIS" column: pick a person, then confirm the mapping. */
export function personPicker(groupId: string, people: Person[], pick: string | null): string {
  const rows = people
    .map((p) => pickRow(
      `${avatarCircle(p.initials, 22)}<div style="font-size:13px;font-weight:500">${esc(p.name)}</div>`,
      pick === p.id,
      "identityPick",
      `${groupId}:${p.id}`,
      "padding:6px 9px",
    ))
    .join("");
  return `<div style="display:flex;flex-direction:column;gap:5px">${rows}</div>
    ${primaryBtn("Map login", pick !== null, "identityMap", groupId, "width:100%;margin-top:10px")}
    <div style="font-size:11px;color:var(--fg-40);margin-top:8px;line-height:1.5">All captured activity, past and future, flows into their view.</div>`;
}

/** One unmatched login: the activity sample that identifies the person, paired with the picker. */
export function identityCard(g: IdentityGroup, people: Person[], pick: string | null): string {
  const sample = g.sample.map((ev) => `<div style="display:flex;align-items:baseline;gap:9px">
      <div style="font-family:var(--mono);font-size:10px;font-weight:600;letter-spacing:.04em;color:var(--fg-40);border:1px solid var(--border);border-radius:5px;padding:1px 6px;flex:none;width:52px;text-align:center">${esc(ev.kind)}</div>
      <div style="font-size:12.5px;color:var(--fg-70);min-width:0">${esc(ev.text)}</div>
      <div style="font-size:11px;color:var(--fg-40);flex:none">${esc(ev.when)}</div>
    </div>`).join("");
  return `<div style="border-bottom:1px solid var(--border);padding:20px 0">
    <div style="display:grid;grid-template-columns:minmax(0,1fr) 250px;gap:24px">
      <div style="min-width:0">
        <div style="display:flex;align-items:baseline;gap:10px">
          <div style="font-family:var(--mono);font-size:15px;font-weight:600;color:var(--fg)">${esc(g.login)}</div>
          <div style="font-size:11.5px;color:var(--fg-40)">${esc(g.meta)}</div>
        </div>
        <div style="font-size:12px;color:var(--accent);margin-top:3px">${esc(g.countLabel)}</div>
        <div style="display:flex;flex-direction:column;gap:7px;margin-top:13px">${sample}</div>
      </div>
      <div style="border-left:1px solid var(--border);padding-left:22px">
        <div style="${MONO_LABEL};margin-bottom:8px">WHO IS THIS</div>
        ${personPicker(g.id, people, pick)}
      </div>
    </div>
  </div>`;
}

// ── composed surface ─────────────────────────────────────────────────────────
export function maintenanceView(p: MaintenanceProps): string {
  const unplacedCount = p.unplaced.length === 0 ? ""
    : p.unplaced.length === 1 ? "1 item" : `${p.unplaced.length} items`;
  const identityCount = p.identity.length === 0 ? ""
    : `${p.identity.length} login${p.identity.length === 1 ? "" : "s"} · ${p.identity.reduce((n, g) => n + g.countNum, 0)} events waiting`;

  const unplaced = p.unplaced.length > 0
    ? p.unplaced.map((u) => unplacedRow(u, p.assignOpen === u.id, p.assign, p.assignOpen === u.id ? p.assignKind : null, p.assignOpen === u.id ? p.assignTarget : null)).join("")
    : maintEmpty("All clear", "Everything an agent produced found its place on its own.");

  const identity = p.identity.length > 0
    ? p.identity.map((g) => identityCard(g, p.people, p.mapPicks[g.id] ?? null)).join("")
    : maintEmpty("Everyone is accounted for", "Every login in the activity stream is matched to a person.");

  return `<div style="max-width:860px;padding:26px 32px 100px">
    <h1 style="margin:0;font-size:22px;font-weight:600;letter-spacing:-0.02em">Maintenance</h1>
    <div style="font-size:12.5px;color:var(--fg-55);margin-top:3px">Occasional housekeeping. Empty is the normal state.</div>
    ${maintSectionHeader("UNPLACED", "read a loose thing, then route it or throw it away", unplacedCount, true)}
    ${unplaced}
    ${maintSectionHeader("IDENTITY", "recognize a person from their work, then pick them", identityCount, false)}
    ${identity}
  </div>`;
}
