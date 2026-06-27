import { describe, it, expect } from "vitest";
import { listAssignedIssues } from "../src/tools/dashboard";

function stub(payload: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
}

/** URL-aware stub: asserts the requested URL looks right, else returns 404. */
function stubUrlAware(payload: unknown): typeof fetch {
  return (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/repos/o/r/issues") && u.includes("assignee=") && u.includes("state=open")) {
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("listAssignedIssues", () => {
  it("maps issues, parses priority + labels, and filters out PRs", async () => {
    const fetchImpl = stubUrlAware([
      { number: 124, title: "[P0] realtime chat ciphertext", html_url: "https://github.com/o/r/issues/124", updated_at: "2026-06-20T00:00:00Z", labels: [{ name: "security" }, "backend"] },
      { number: 74, title: "[P1] SSE deltas", html_url: "https://github.com/o/r/issues/74", updated_at: "2026-06-19T00:00:00Z", labels: [] },
      { number: 9, title: "[P2] a pull request", html_url: "https://github.com/o/r/pull/9", updated_at: "x", pull_request: { url: "u" } },
      { number: 50, title: "no priority tag", html_url: "https://github.com/o/r/issues/50", updated_at: "2026-06-18T00:00:00Z" },
    ]);
    const { issues, ok } = await listAssignedIssues({ token: "t", repo: "o/r", login: "andres", fetchImpl });
    expect(ok).toBe(true);
    expect(issues.map((i) => i.number)).toEqual([124, 74, 50]); // PR #9 filtered
    expect(issues[0]).toMatchObject({ number: 124, title: "realtime chat ciphertext", priority: "P0", labels: ["security", "backend"] });
    expect(issues[1].priority).toBe("P1");
    expect(issues[2].priority).toBeNull();
  });

  it("returns ok:false and [] on a non-OK response (expired token), never throws", async () => {
    const { issues, ok } = await listAssignedIssues({ token: "stale", repo: "o/r", login: "a", fetchImpl: stub({}, 401) });
    expect(ok).toBe(false);
    expect(issues).toEqual([]);
  });
});
