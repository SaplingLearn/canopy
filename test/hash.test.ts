/**
 * Phase 5a — the SPA's hash router (`web/src/hash.ts`).
 *
 * `parseHash` / `hashForRoute` are pure (no `location`, no DOM), which is the
 * whole reason they live in their own module: main.ts is the only place that
 * touches the real URL, and the ROUTING RULE is unit-tested here.
 *
 * Runs in the same Vitest pool-workers harness as everything else; nothing here
 * needs D1.
 */
import { describe, it, expect } from "vitest";
import { parseHash, hashForRoute } from "../web/src/hash";

describe("parseHash", () => {
  it("parses the four ticket/sprint routes (§C.11)", () => {
    expect(parseHash("#tickets")).toEqual({ screen: "tickets", ticketId: null, sprintId: null });
    expect(parseHash("#tickets/new")).toEqual({ screen: "newticket", ticketId: null, sprintId: null });
    expect(parseHash("#tickets/42")).toEqual({ screen: "ticketdetail", ticketId: 42, sprintId: null });
    expect(parseHash("#sprints/7")).toEqual({ screen: "sprint", ticketId: null, sprintId: 7 });
  });

  it("accepts a hash with or without the leading #", () => {
    expect(parseHash("tickets/42")).toEqual({ screen: "ticketdetail", ticketId: 42, sprintId: null });
  });

  it("still parses every pre-existing plain screen", () => {
    for (const s of ["mywork", "feed", "docs", "roadmap", "review", "maintenance", "search", "settings", "guide", "unsubscribe"]) {
      expect(parseHash(`#${s}`)).toEqual({ screen: s, ticketId: null, sprintId: null });
    }
  });

  it("falls back to My Work for junk, empty, and malformed ids", () => {
    const none = { screen: "mywork", ticketId: null, sprintId: null };
    expect(parseHash("")).toEqual(none);
    expect(parseHash("#")).toEqual(none);
    expect(parseHash("#nope")).toEqual(none);
    expect(parseHash("#tickets/abc")).toEqual(none);        // not an id, not "new"
    expect(parseHash("#tickets/1/2")).toEqual(none);        // too deep
    expect(parseHash("#tickets/0")).toEqual(none);          // ids are positive
    expect(parseHash("#tickets/-3")).toEqual(none);
    expect(parseHash("#sprints")).toEqual(none);            // a sprint route needs an id
    expect(parseHash("#sprints/x")).toEqual(none);
    expect(parseHash("#onboard")).toEqual(none);            // handled by boot, never a Screen
  });

  it("does not treat a numeric-looking id with junk as an id", () => {
    expect(parseHash("#tickets/42x")).toEqual({ screen: "mywork", ticketId: null, sprintId: null });
  });
});

describe("hashForRoute", () => {
  it("writes back exactly the forms parseHash reads", () => {
    expect(hashForRoute({ screen: "tickets", ticketId: null, sprintId: null })).toBe("#tickets");
    expect(hashForRoute({ screen: "newticket", ticketId: null, sprintId: null })).toBe("#tickets/new");
    expect(hashForRoute({ screen: "ticketdetail", ticketId: 42, sprintId: null })).toBe("#tickets/42");
    expect(hashForRoute({ screen: "sprint", ticketId: null, sprintId: 7 })).toBe("#sprints/7");
    expect(hashForRoute({ screen: "feed", ticketId: null, sprintId: null })).toBe("#feed");
  });

  it("round-trips every route through parseHash", () => {
    const routes = [
      { screen: "tickets", ticketId: null, sprintId: null },
      { screen: "newticket", ticketId: null, sprintId: null },
      { screen: "ticketdetail", ticketId: 9, sprintId: null },
      { screen: "sprint", ticketId: null, sprintId: 3 },
      { screen: "mywork", ticketId: null, sprintId: null },
      { screen: "settings", ticketId: null, sprintId: null },
      { screen: "site", ticketId: null, sprintId: null }, // the landing page, reopened from the sidebar logo
      { screen: "repo", ticketId: null, sprintId: null, repoTab: "overview" },
      { screen: "repo", ticketId: null, sprintId: null, repoTab: "ci" },
    ] as const;
    for (const r of routes) expect(parseHash(hashForRoute(r))).toEqual(r);
  });

  it("routes the Repo dashboard's tabs, with the bare #repo as Overview", () => {
    expect(parseHash("#repo")).toEqual({ screen: "repo", ticketId: null, sprintId: null, repoTab: "overview" });
    expect(parseHash("#repo/planning")).toEqual({ screen: "repo", ticketId: null, sprintId: null, repoTab: "planning" });
    expect(parseHash("#repo/overview").repoTab).toBe("overview");
    expect(hashForRoute({ screen: "repo", ticketId: null, sprintId: null, repoTab: "overview" })).toBe("#repo");
    expect(hashForRoute({ screen: "repo", ticketId: null, sprintId: null, repoTab: "usage" })).toBe("#repo/usage");
    // An unknown tab is a junk hash like any other.
    expect(parseHash("#repo/nope").screen).toBe("mywork");
    expect(parseHash("#repo/ci/extra").screen).toBe("mywork");
  });

  it("degrades to the parent screen when the id is missing", () => {
    expect(hashForRoute({ screen: "ticketdetail", ticketId: null, sprintId: null })).toBe("#tickets");
    expect(hashForRoute({ screen: "sprint", ticketId: null, sprintId: null })).toBe("#roadmap");
  });
});
