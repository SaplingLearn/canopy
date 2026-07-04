// Maintenance surface — componentized from Canopy Triage.dc.html (the static
// design output). Occasional housekeeping in two sections: UNPLACED (route or
// discard the loose things agents couldn't place) and IDENTITY (match unmapped
// activity logins to people). Empty is the normal state.
//
// Purely presentational: data arrives through props and renders to HTML strings;
// interactions dispatch via data-act / data-arg handled in main.ts. No fetching,
// no inline data.

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

export type AssignKind = "doc" | "adr" | "milestone" | "feed";

/** The assign flow's REAL vocabulary: the four gate types, and the targets each
 *  accepts (doc → section + optional space; feed → optional multi-select tags;
 *  adr/milestone → no target). Values come from @shared/vocabulary via the
 *  mapping layer — components never hardcode them. */
export interface AssignOptions {
  kinds: { key: AssignKind; label: string }[];
  sections: string[];
  spaces: string[];
  tags: string[];
}

export interface ActivitySample { kind: string; text: string; when: string }

export interface IdentityGroup {
  id: string;          // the login — there is no numeric id; also the map route's path param
  login: string;
  meta: string;        // e.g. "first seen 3w ago"
  countLabel: string;  // accent line; the read returns samples, not a total — no fabricated count
  sample: ActivitySample[];
}

export interface Person { id: string; name: string; initials: string }

export interface MaintenanceProps {
  unplaced: UnplacedItem[];
  assign: AssignOptions;
  assignOpen: string | null;
  assignKind: AssignKind | null;
  assignSection: string | null;
  assignSpace: string | null;
  assignTags: string[];
  identity: IdentityGroup[];
  people: Person[];
  mapPicks: Record<string, string>;
  /** Login currently in the map confirm step (two-step guard) — null when none. */
  mapConfirm: string | null;
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
/** The expanded assign flow: pick what it is, then the real per-type target, then file it. */
export function assignPanel(itemId: string, assign: AssignOptions, kind: AssignKind | null, section: string | null, space: string | null, tags: string[]): string {
  const kindChips = assign.kinds
    .map((k) => pickRow(esc(k.label), kind === k.key, "maintAssignKind", k.key))
    .join("");
  let targetCol: string;
  if (kind === null) {
    targetCol = `<div style="font-size:12.5px;color:var(--fg-40);padding:7px 0">Pick what kind of thing it is first.</div>`;
  } else if (kind === "doc") {
    const sectionRows = assign.sections.map((t) => pickRow(esc(t), section === t, "maintAssignSection", t)).join("");
    const spaceRows = assign.spaces.map((t) => pickRow(esc(t), space === t, "maintAssignSpace", t)).join("");
    targetCol = `<div style="display:flex;flex-direction:column;gap:5px">${sectionRows}</div>
      <div style="${MONO_LABEL};margin:12px 0 8px">SPACE (OPTIONAL)</div>
      <div style="display:flex;flex-direction:column;gap:5px">${spaceRows}</div>`;
  } else if (kind === "feed") {
    const tagRows = assign.tags.map((t) => pickRow(esc(t), tags.includes(t), "maintAssignTag", t)).join("");
    targetCol = `<div style="display:flex;flex-direction:column;gap:5px">${tagRows}</div>
      <div style="font-size:11.5px;color:var(--fg-40);margin-top:8px">Tags are optional — pick any that apply.</div>`;
  } else {
    targetCol = `<div style="font-size:12.5px;color:var(--fg-40);padding:7px 0">No target needed — this files as a new ${kind === "adr" ? "decision draft" : "milestone proposal"}.</div>`;
  }
  const canFile = kind !== null && (kind !== "doc" || section !== null);
  return `<div style="border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-top:14px">
    <div style="display:grid;grid-template-columns:190px 1fr;gap:22px">
      <div>
        <div style="${MONO_LABEL};margin-bottom:8px">WHAT IS IT</div>
        <div style="display:flex;flex-direction:column;gap:5px">${kindChips}</div>
      </div>
      <div>
        <div style="${MONO_LABEL};margin-bottom:8px">WHERE IT GOES</div>
        ${targetCol}
      </div>
    </div>
    <div style="display:flex;justify-content:flex-end;margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
      ${primaryBtn("File it", canFile, "maintFile", itemId)}
    </div>
  </div>`;
}

/** One unplaced loose thing: reason chip + meta, title, snippet, and the route/discard affordances. */
export function unplacedRow(u: UnplacedItem, open: boolean, assign: AssignOptions, kind: AssignKind | null, section: string | null, space: string | null, tags: string[]): string {
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
    ${open ? assignPanel(u.id, assign, kind, section, space, tags) : ""}
  </div>`;
}

// ── IDENTITY ─────────────────────────────────────────────────────────────────
/** The "WHO IS THIS" column: pick a person, see the concrete effect, then confirm. */
export function personPicker(groupId: string, people: Person[], pick: string | null, confirming: boolean): string {
  const rows = people
    .map((p) => pickRow(
      `${avatarCircle(p.initials, 22)}<div style="font-size:13px;font-weight:500">${esc(p.name)}</div>`,
      pick === p.id,
      "identityPick",
      `${groupId}:${p.id}`,
      "padding:6px 9px",
    ))
    .join("");
  const pickedName = pick !== null ? (people.find((p) => p.id === pick)?.name ?? pick) : null;
  const confirmNote = confirming && pickedName !== null
    ? `<div style="border:1px solid var(--amber);border-radius:8px;padding:9px 11px;margin-top:10px;font-size:12px;line-height:1.5;color:var(--fg-70)">This attributes <b style="font-family:var(--mono)">${esc(groupId)}</b>&rsquo;s activity to <b>${esc(pickedName)}</b> — past and future captured events surface as theirs.</div>`
    : "";
  return `<div style="display:flex;flex-direction:column;gap:5px">${rows}</div>
    ${confirmNote}
    ${primaryBtn(confirming && pick !== null ? "Confirm mapping" : "Map login", pick !== null, "identityMap", groupId, "width:100%;margin-top:10px")}
    <div style="font-size:11px;color:var(--fg-40);margin-top:8px;line-height:1.5">All captured activity, past and future, flows into their view.</div>`;
}

/** One unmatched login: the activity sample that identifies the person, paired with the picker. */
export function identityCard(g: IdentityGroup, people: Person[], pick: string | null, confirming: boolean): string {
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
        ${personPicker(g.id, people, pick, confirming)}
      </div>
    </div>
  </div>`;
}

// ── composed surface ─────────────────────────────────────────────────────────
export function maintenanceView(p: MaintenanceProps): string {
  const unplacedCount = p.unplaced.length === 0 ? ""
    : p.unplaced.length === 1 ? "1 item" : `${p.unplaced.length} items`;
  const identityCount = p.identity.length === 0 ? ""
    : `${p.identity.length} login${p.identity.length === 1 ? "" : "s"} to match`;

  const unplaced = p.unplaced.length > 0
    ? p.unplaced.map((u) => {
        const open = p.assignOpen === u.id;
        return unplacedRow(u, open, p.assign, open ? p.assignKind : null, open ? p.assignSection : null, open ? p.assignSpace : null, open ? p.assignTags : []);
      }).join("")
    : maintEmpty("All clear", "Everything an agent produced found its place on its own.");

  const identity = p.identity.length > 0
    ? p.identity.map((g) => identityCard(g, p.people, p.mapPicks[g.id] ?? null, p.mapConfirm === g.id)).join("")
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
