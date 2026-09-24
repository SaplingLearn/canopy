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
//   #artifacts        → the Artifacts library
//   #artifacts/new    → the new-artifact form
//   #artifacts/<slug>[/v<n>]           → one artifact (a version other than the latest)
//   #artifacts/<slug>/diff/<a>..<b>    → two of its versions compared
//   #<screen>         → every other screen, named exactly as the Screen union
//                       (`#site` is the landing page, reopened from inside the app)
// Anything unrecognised falls back to My Work — the same rule the app has always
// had for a junk hash.

import type { Screen } from "./render";
import { isRepoTab, type RepoTab } from "@shared/repo";
import type { ArtRoute } from "./artifacts";

/** Every screen addressable by its bare name (`#feed`). The compound ticket /
 *  sprint routes are parsed separately below. */
const PLAIN_SCREENS: Screen[] = [
  "mywork", "feed", "docs", "roadmap", "review", "maintenance",
  "search", "settings", "guide", "unsubscribe", "tickets", "site",
];

export interface Route {
  screen: Screen;
  /** Set only on `ticketdetail`. */
  ticketId: number | null;
  /** Set only on `sprint`. */
  sprintId: number | null;
  /** Set only on `repo` (absent everywhere else, so older routes compare equal). */
  repoTab?: RepoTab;
  /** Set only on `artifact` (absent everywhere else, like `repoTab`). */
  art?: ArtRoute;
}

/** An artifact slug: lowercase words joined by dashes (`new` is the form, never a slug). */
const isArtSlug = (v: string): boolean => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v) && v !== "new";

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
  if (parts[0] === "artifacts") {
    if (parts.length === 1) return { screen: "artifacts", ticketId: null, sprintId: null };
    if (parts.length === 2 && parts[1] === "new") return { screen: "artifactnew", ticketId: null, sprintId: null };
    if (!isArtSlug(parts[1] ?? "")) return none;
    const one = (v: number | null, diff: ArtRoute["diff"]): Route => ({ screen: "artifact", ticketId: null, sprintId: null, art: { slug: parts[1], v, diff } });
    if (parts.length === 2) return one(null, null);
    const v = parts.length === 3 && /^v\d+$/.test(parts[2]) ? intSeg(parts[2].slice(1)) : null;
    if (v !== null) return one(v, null);
    const d = parts.length === 4 && parts[2] === "diff" ? /^(\d+)\.\.(\d+)$/.exec(parts[3]) : null;
    const a = d ? intSeg(d[1]) : null;
    const b = d ? intSeg(d[2]) : null;
    if (a !== null && b !== null) return one(null, { a, b });
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
  if (r.screen === "artifactnew") return "#artifacts/new";
  if (r.screen === "artifact") {
    const a = r.art;
    if (!a?.slug) return "#artifacts";
    if (a.diff) return `#artifacts/${a.slug}/diff/${a.diff.a}..${a.diff.b}`;
    return a.v !== null ? `#artifacts/${a.slug}/v${a.v}` : `#artifacts/${a.slug}`;
  }
  if (r.screen === "sprint") return r.sprintId !== null ? `#sprints/${r.sprintId}` : "#roadmap";
  return `#${r.screen}`;
}
