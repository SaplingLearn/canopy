import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { getMyDashboard } from "../src/tools/dashboard";
import { ingestFocusUpdate } from "../src/consumer";
import { append_feed } from "../src/tools/writes";

const ROADMAP = `# Sapling Roadmap

## Team & Responsibilities

| Person     | Role      | Owns                          |
| ---------- | --------- | ----------------------------- |
| **Andres** | Fullstack | Integration, releases         |

## Weeks 3–4 (~2026-06-22 → 2026-07-05)

- **Andres** — semesters API + GPA #138.

## July — Agent Migration

- **Andres** — migration decision record.
`;

const ISSUES = [
  { number: 138, title: "[P1] semesters API", html_url: "https://github.com/o/r/issues/138", updated_at: "2026-06-25T00:00:00Z", labels: [{ name: "backend" }] },
];

function stubGh(): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/contents/ROADMAP.md")) return new Response(ROADMAP, { status: 200 });
    if (u.includes("/issues?assignee=")) return new Response(JSON.stringify(ISSUES), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("getMyDashboard", () => {
  it("assembles focus + feed + parsed roadmap + assigned issues", async () => {
    await ingestFocusUpdate(env.DB, { working_on: "wire My Work #999", next_up: "polish" }, "AndresL230");
    await append_feed(env.DB, { author: "AndresL230", summary: "landed the route", artifacts: { prs: [], commits: [], issues: [] } });

    const d = await getMyDashboard({
      db: env.DB, login: "AndresL230", token: "t", repo: "o/r", today: "2026-06-26", fetchImpl: stubGh(),
    });

    expect(d.person).toBe("Andres");
    expect(d.role).toBe("Fullstack");
    expect(d.focus).toMatchObject({ workingOn: "wire My Work #999", nextUp: "polish" });
    expect(d.workingNow?.title).toBe("Weeks 3–4");
    expect(d.comingUp.map((p) => p.title)).toEqual(["July — Agent Migration"]);
    expect(d.assignedIssues.map((i) => i.number)).toEqual([138]);
    expect(d.feed).toHaveLength(1);
    expect(d.degraded).toBe(false);
  });

  it("degrades without a token: focus + feed still returned, roadmap/issues empty, no throw", async () => {
    await ingestFocusUpdate(env.DB, { working_on: "x" }, "AndresL230");
    await append_feed(env.DB, { author: "AndresL230", summary: "y", artifacts: { prs: [], commits: [], issues: [] } });

    const d = await getMyDashboard({
      db: env.DB, login: "AndresL230", token: null, repo: "o/r", today: "2026-06-26",
    });

    expect(d.degraded).toBe(true);
    expect(d.focus?.workingOn).toBe("x");
    expect(d.feed).toHaveLength(1);
    expect(d.workingNow).toBeNull();
    expect(d.comingUp).toEqual([]);
    expect(d.assignedIssues).toEqual([]);
  });
});
