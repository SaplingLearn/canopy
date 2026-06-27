import { describe, it, expect } from "vitest";
import { getMyDashboard } from "../src/tools/dashboard";

// A DB stub whose every query throws — simulates a missing table (e.g. a migration not
// applied to the remote D1) or a D1 outage. getMyDashboard must degrade, never throw.
const throwingDb = {
  prepare() {
    throw new Error("D1_ERROR: no such table: focus");
  },
} as unknown as Parameters<typeof getMyDashboard>[0]["db"];

describe("getMyDashboard resilience", () => {
  it("returns a safe degraded payload (never throws) when D1 reads fail", async () => {
    const d = await getMyDashboard({
      db: throwingDb,
      login: "AndresL230",
      token: null,
      repo: "o/r",
      today: "2026-06-26",
    });
    expect(d.focus).toBeNull();
    expect(d.feed).toEqual([]);
    expect(d.degraded).toBe(true);
    expect(d.workingNow).toBeNull();
    expect(d.assignedIssues).toEqual([]);
    expect(d.person).toBe("Andres"); // pure login→person map, no DB needed
  });
});
