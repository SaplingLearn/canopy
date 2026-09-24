// The URL-hash ↔ route seam, as two pure functions so it is unit-testable
// without a DOM (main.ts is the only module that reads `location`).
//
// Routes (§C.11 of the tickets brief):
//   #tickets          → the queue
//   #tickets/new      → the new-ticket form
//   #tickets/<id>     → one ticket's detail
//   #sprints/<id>     → one sprint's screen
//   #repo             → the Repo dashboard's Overview
//   #repo/<tab>       → one of its other tabs (code / ci / usage / planning)
//   #handoffs         → the handoffs inbox; #handoffs/new the form; #handoffs/<id> one handoff
//   #prompts          → the Prompt Library; #prompts/new the editor; #prompts/<slug> one
//                       prompt; #prompts/<slug>/edit and #prompts/<slug>/version its editor
//   #docs/new         → the new-doc form
//   #maintenance      → Maintenance › Unplaced; #maintenance/identity and #maintenance/people
//   #<screen>         → every other screen, named exactly as the Screen union
//                       (`#site` is the landing page, reopened from inside the app)
// Anything unrecognised falls back to My Work — the same rule the app has always
// had for a junk hash.

import type { Screen } from "./render";
import { isRepoTab, type RepoTab } from "@shared/repo";
import { MAINT_TABS, type MaintTab } from "./maintenance";

/** Every screen addressable by its bare name (`#feed`). The compound ticket /
 *  sprint routes are parsed separately below. */
const PLAIN_SCREENS: Screen[] = [
  "mywork", "feed", "docs", "roadmap", "review",
  "search", "settings", "guide", "unsubscribe", "tickets", "site", "handoffs", "prompts",
];

export interface Route {
  screen: Screen;
  /** Set only on `ticketdetail`. */
  ticketId: number | null;
  /** Set only on `sprint`. */
  sprintId: number | null;
  /** Set only on `repo` (absent everywhere else, so older routes compare equal). */
  repoTab?: RepoTab;
  /** Set only on `handoff` (a positive integer, rendered `#12`). */
  handoffId?: number;
  /** Set only on `prompt` and on `promptedit` for an existing prompt. */
  promptSlug?: string;
  /** Set only on `promptedit`. */
  promptMode?: "new" | "edit" | "version";
  /** Set only on `maintenance`. */
  maintTab?: MaintTab;
}

/** Whether two routes name the same place (the hashchange no-op check). */
export function sameRoute(a: Route, b: Route): boolean {
  return a.screen === b.screen && a.ticketId === b.ticketId && a.sprintId === b.sprintId && a.repoTab === b.repoTab
    && a.handoffId === b.handoffId && a.promptSlug === b.promptSlug && a.promptMode === b.promptMode && a.maintTab === b.maintTab;
}

/** A URL path segment decoded, or null when it is malformed. */
function seg(v: string): string | null {
  try { const d = decodeURIComponent(v); return d ? d : null; } catch { return null; }
}

/** A positive integer path segment, or null (so `#tickets/abc` is not a detail route). */
function intSeg(v: string): number | null {
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Parse a location hash (with or without the leading `#`) into a route. */
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const none: Route = { screen: "mywork", ticketId: null, sprintId: null };
  if (!raw) return none;

  const parts = raw.split("/");
  if (parts[0] === "tickets") {
    if (parts.length === 1) return { screen: "tickets", ticketId: null, sprintId: null };
    if (parts.length === 2) {
      if (parts[1] === "new") return { screen: "newticket", ticketId: null, sprintId: null };
      const id = intSeg(parts[1]);
      if (id !== null) return { screen: "ticketdetail", ticketId: id, sprintId: null };
    }
    return none;
  }
  if (parts[0] === "sprints" && parts.length === 2) {
    const id = intSeg(parts[1]);
    if (id !== null) return { screen: "sprint", ticketId: null, sprintId: id };
    return none;
  }
  if (parts[0] === "repo") {
    if (parts.length === 1) return { screen: "repo", ticketId: null, sprintId: null, repoTab: "overview" };
    // `#repo/overview` is not canonical (the bare `#repo` is), but it still resolves.
    if (parts.length === 2 && isRepoTab(parts[1])) return { screen: "repo", ticketId: null, sprintId: null, repoTab: parts[1] };
    return none;
  }
  const base = { ticketId: null, sprintId: null };
  if (parts[0] === "handoffs" && parts.length === 2) {
    if (parts[1] === "new") return { screen: "newhandoff", ...base };
    const id = intSeg(parts[1]);
    return id !== null ? { screen: "handoff", ...base, handoffId: id } : none;
  }
  if (parts[0] === "prompts" && (parts.length === 2 || parts.length === 3)) {
    if (parts.length === 2 && parts[1] === "new") return { screen: "promptedit", ...base, promptMode: "new" };
    const slug = seg(parts[1]);
    if (!slug) return none;
    if (parts.length === 2) return { screen: "prompt", ...base, promptSlug: slug };
    if (parts[2] === "edit" || parts[2] === "version") return { screen: "promptedit", ...base, promptSlug: slug, promptMode: parts[2] };
    return none;
  }
  if (parts[0] === "docs" && parts.length === 2 && parts[1] === "new") return { screen: "newdoc", ...base };
  if (parts[0] === "maintenance") {
    if (parts.length === 1) return { screen: "maintenance", ...base, maintTab: "unplaced" };
    if (parts.length === 2 && (MAINT_TABS as readonly string[]).includes(parts[1])) return { screen: "maintenance", ...base, maintTab: parts[1] as MaintTab };
    return none;
  }
  if (parts.length === 1 && (PLAIN_SCREENS as string[]).includes(parts[0])) {
    return { screen: parts[0] as Screen, ticketId: null, sprintId: null };
  }
  return none;
}

/** The inverse: the hash the rerender writes back for the current route. Always
 *  round-trips through parseHash (asserted in test/hash.test.ts). */
export function hashForRoute(r: Route): string {
  if (r.screen === "ticketdetail") return r.ticketId !== null ? `#tickets/${r.ticketId}` : "#tickets";
  if (r.screen === "newticket") return "#tickets/new";
  if (r.screen === "repo") return !r.repoTab || r.repoTab === "overview" ? "#repo" : `#repo/${r.repoTab}`;
  if (r.screen === "sprint") return r.sprintId !== null ? `#sprints/${r.sprintId}` : "#roadmap";
  if (r.screen === "handoff") return r.handoffId ? `#handoffs/${r.handoffId}` : "#handoffs";
  if (r.screen === "newhandoff") return "#handoffs/new";
  if (r.screen === "prompt") return r.promptSlug ? `#prompts/${encodeURIComponent(r.promptSlug)}` : "#prompts";
  if (r.screen === "promptedit") {
    if (r.promptMode === "edit" || r.promptMode === "version") return r.promptSlug ? `#prompts/${encodeURIComponent(r.promptSlug)}/${r.promptMode}` : "#prompts";
    return "#prompts/new";
  }
  if (r.screen === "newdoc") return "#docs/new";
  if (r.screen === "maintenance") return !r.maintTab || r.maintTab === "unplaced" ? "#maintenance" : `#maintenance/${r.maintTab}`;
  return `#${r.screen}`;
}
