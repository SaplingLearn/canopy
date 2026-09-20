import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { createSession } from "../src/auth/session";
import { hmacSeal } from "../src/auth/crypto";
import { ingestEvent } from "../src/consumer";
import { getRepoDashboard } from "../src/tools/repo";
import { create_sprint, set_sprint_active } from "../src/tools/sprints";
import { seedPerson } from "./helpers/persons";
import type { CapturedEvent } from "@shared/contract";
import type { RepoDashboard } from "@shared/repo";
import { SprintCreate } from "@shared/sprints";

const NOW = Date.parse("2026-09-20T12:00:00Z");
const ago = (days: number, hours = 0): string => new Date(NOW - days * 86_400_000 - hours * 3_600_000).toISOString();

async function cookieFor(login: string): Promise<string> {
  await seedPerson(login);
  const { id } = await createSession(env.DB, login);
  return `session=${await hmacSeal(id, "test-cookie-secret")}`;
}

function prEvent(number: number, login: string, at: string, merged = true): CapturedEvent {
  return {
    semantic_key: `gh:pr:${number}:${merged ? "merged" : "closed"}`,
    event_type: merged ? "pr_merged" : "pr_closed",
    ref_number: number,
    subject_login: login,
    raw: JSON.stringify({
      pr: {
        number, title: `PR ${number}`, body: "a long body that must never reach the DTO",
        html_url: `https://github.com/o/r/pull/${number}`, merged, merged_at: merged ? at : null, closed_at: at,
        user: { login }, milestone: null, base: { ref: "main" },
      },
    }),
    provenance: "webhook",
    occurred_at: at,
  };
}

function issueEvent(number: number, login: string, at: string, action: string, state: "open" | "closed", labels: string[] = []): CapturedEvent {
  return {
    semantic_key: `gh:issue:${number}:${action}:${at}`,
    event_type: "issue",
    ref_number: number,
    subject_login: login,
    raw: JSON.stringify({
      action,
      issue: {
        number, title: `Issue ${number}`, body: "body", html_url: `https://github.com/o/r/issues/${number}`,
        state, updated_at: at, user: { login }, assignees: [], labels, milestone: null,
      },
    }),
    provenance: "webhook",
    occurred_at: at,
  };
}

const ingestAll = async (events: CapturedEvent[]) => { for (const e of events) await ingestEvent(env.DB, e, "github-webhook"); };
const data = <T>(s: { status: string; data?: T }): T => {
  expect(s.status).toBe("ok");
  return (s as { data: T }).data;
};

describe("getRepoDashboard — a D1-only projection", () => {
  it("an empty store is all `empty` / `not_connected`, never an error", async () => {
    const d = await getRepoDashboard(env.DB, "o/r", NOW);
    expect(d.repo).toBe("o/r");
    expect(d.degraded).toBe(false);
    expect(d.prs.status).toBe("empty");
    expect(d.activity.status).toBe("empty");
    expect(d.sprint.status).toBe("empty");
    expect(d.bars.status).toBe("empty");
    // The tiles are counts, so zero is still an answer.
    expect(data(d.stats).map((s) => s.value)).toEqual([0, 0, 0, 0]);
  });

  it("sections with no capture path are not_connected — never guessed", async () => {
    const d = await getRepoDashboard(env.DB, "o/r", NOW);
    for (const k of ["environments", "drift", "health", "branches", "deploys", "ciFailures", "coverage", "bundle", "usage", "cloudflare", "hosting", "todos"] as const) {
      expect(d[k].status, k).toBe("not_connected");
    }
  });

  it("counts merged PRs week over week and lists the latest closes", async () => {
    await seedPerson("jose-a");
    await ingestAll([
      prEvent(10, "jose-a", ago(1)), prEvent(11, "jose-a", ago(2)), prEvent(12, "meilin", ago(3)),
      prEvent(13, "meilin", ago(4), false),
      prEvent(5, "jose-a", ago(9)),
    ]);
    const d = await getRepoDashboard(env.DB, "o/r", NOW);
    const merged = data(d.stats)[0];
    expect(merged).toMatchObject({ label: "Merged PRs", value: 3, delta: 2 });

    const prs = data(d.prs);
    expect(prs.map((p) => p.number)).toEqual([10, 11, 12, 13, 5]);
    expect(prs[0]).toMatchObject({ state: "merged", branch: "→ main", checks: null });
    expect(prs[3].state).toBe("closed");
    // A mapped login resolves to its person; an unmapped one keeps the bare login.
    expect(prs[0].author).toMatchObject({ login: "jose-a", handle: "jose-a" });
    expect(prs[2].author).toMatchObject({ login: "meilin", handle: null, color: null });
    expect(JSON.stringify(d)).not.toContain("a long body");

    const code = data(d.codeStats);
    expect(code[0]).toMatchObject({ label: "Merged this week", value: 3, sub: "by 2 people" });
    expect(code[1]).toMatchObject({ label: "Closed unmerged", value: 1 });
  });

  it("buckets merges into 14 UTC days, oldest first", async () => {
    await ingestAll([prEvent(1, "a", ago(0, 1)), prEvent(2, "a", ago(0, 2)), prEvent(3, "a", ago(13))]);
    const bars = data((await getRepoDashboard(env.DB, "o/r", NOW)).bars);
    expect(bars.days).toHaveLength(14);
    expect(bars.days[13]).toEqual({ date: "2026-09-20", count: 2 });
    expect(bars.days[0]).toEqual({ date: "2026-09-07", count: 1 });
    expect(bars.note).toBe("3 merged PRs · all branches");
  });

  it("open issues are the LATEST snapshot per issue, with a week-ago delta", async () => {
    await ingestAll([
      issueEvent(1, "a", ago(10), "opened", "open", ["bug"]),
      issueEvent(2, "a", ago(9), "opened", "open", ["docs"]),
      issueEvent(2, "a", ago(2), "closed", "closed", ["docs"]),  // closed this week
      issueEvent(3, "a", ago(1), "opened", "open", ["bug", "infra"]),
      issueEvent(3, "a", ago(0, 3), "edited", "open", ["bug", "infra"]),
    ]);
    const d = await getRepoDashboard(env.DB, "o/r", NOW);
    const [, issues, bugs] = data(d.stats);
    expect(issues).toMatchObject({ value: 2, delta: 0, tone: "neutral" }); // was {1,2}, now {1,3}
    expect(bugs).toMatchObject({ value: 2, delta: 1, tone: "warn" });

    const labels = data(d.labels);
    expect(labels.total).toBe(2);
    expect(labels.rows).toEqual([{ name: "bug", count: 2 }, { name: "infra", count: 1 }]);
  });

  it("the feed merges PR closes and issue moves, newest first, and skips edit noise", async () => {
    await seedPerson("jose-a");
    await ingestAll([
      prEvent(10, "jose-a", ago(0, 5)),
      issueEvent(3, "jose-a", ago(0, 1), "opened", "open"),
      issueEvent(3, "jose-a", ago(0, 2), "edited", "open"),
      issueEvent(4, "jose-a", ago(0, 3), "closed", "closed"),
    ]);
    const feed = data((await getRepoDashboard(env.DB, "o/r", NOW)).activity);
    expect(feed.map((a) => a.kind)).toEqual(["issue", "close", "merge"]);
    expect(feed[0]).toMatchObject({ text: "opened #3 “Issue 3”", actor: { handle: "jose-a" } });
    // Nothing captured says who closed or merged — so the row never claims an actor.
    expect(feed[1].actor).toBeNull();
    expect(feed[2].text).toBe("#10 “PR 10” by @jose-a was merged");
  });

  it("contributors tally this week's merges and issue closes per login", async () => {
    await ingestAll([
      prEvent(1, "a", ago(1)), prEvent(2, "a", ago(2)), prEvent(3, "b", ago(1)),
      prEvent(4, "b", ago(12)), // outside the week
      issueEvent(9, "b", ago(1), "closed", "closed"),
    ]);
    const rows = data((await getRepoDashboard(env.DB, "o/r", NOW)).contributors);
    expect(rows.map((r) => [r.person.login, r.merged, r.closed])).toEqual([["a", 2, 0], ["b", 1, 1]]);
  });

  it("the current sprint is the one a person marked active, with the Roadmap's ticket progress", async () => {
    await seedPerson("jose-a");
    const sp = await create_sprint(env.DB, SprintCreate.parse({ label: "Notifications GA" }), "jose-a");
    expect((await getRepoDashboard(env.DB, "o/r", NOW)).sprint.status).toBe("empty");
    await set_sprint_active(env.DB, sp.id, true);
    const sprint = data((await getRepoDashboard(env.DB, "o/r", NOW)).sprint);
    expect(sprint).toMatchObject({ id: sp.id, label: "Notifications GA", closed: 0, total: 0, pct: 0 });
  });
});

describe("GET /repo/dashboard", () => {
  it("is session-gated", async () => {
    const res = await app.request("/repo/dashboard", {}, env);
    expect(res.status).toBe(401);
  });

  it("returns the projection for a signed-in member", async () => {
    const cookie = await cookieFor("jose-a");
    await ingestAll([prEvent(10, "jose-a", new Date().toISOString())]);
    const res = await app.request("/repo/dashboard", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    const d = (await res.json()) as RepoDashboard;
    expect(d.prs.status).toBe("ok");
    expect(d.deploys.status).toBe("not_connected");
    expect(d.sample).toBeUndefined();
  });
});
