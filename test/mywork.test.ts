import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, run } from "../src/db";
import { ingestEvent } from "../src/consumer";
import { storePrSummary, storeIssueSummary, type Summarizer, type PrSummary, type IssueSummary } from "../src/tools/summarize";
import { getMyWork } from "../src/tools/mywork";
import type { EventRow } from "@shared/rows";
import type { CapturedEvent } from "@shared/contract";

const NOW = "2026-07-15T12:00:00.000Z";

function daysBefore(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function prEvent(over: Partial<CapturedEvent> & { number: number; login: string; merged?: boolean; baseRef?: string | null }): CapturedEvent {
  const { number, login, merged = true, baseRef = null, ...rest } = over;
  const raw = JSON.stringify({
    pr: {
      number,
      title: `PR ${number}`,
      body: "some body",
      html_url: `https://github.com/o/r/pull/${number}`,
      merged,
      merged_at: merged ? NOW : null,
      closed_at: NOW,
      user: { login },
      milestone: null,
      base: baseRef ? { ref: baseRef } : null,
    },
  });
  return {
    semantic_key: `gh:pr:${number}:${merged ? "merged" : "closed"}`,
    event_type: merged ? "pr_merged" : "pr_closed",
    ref_number: number,
    subject_login: login,
    raw,
    provenance: "webhook",
    occurred_at: NOW,
    ...rest,
  };
}

function issueEvent(over: {
  number: number;
  login: string;
  action: string;
  state: "open" | "closed";
  updatedAt: string;
  title?: string;
  labels?: string[];
  assigneeLogin?: string;
  milestone?: { title?: string | null; due_on?: string | null; number?: number } | null;
}): CapturedEvent {
  const { number, login, action, state, updatedAt, title = `Issue ${number}`, labels = [], assigneeLogin = login, milestone = null } = over;
  const raw = JSON.stringify({
    action,
    issue: {
      number,
      title,
      html_url: `https://github.com/o/r/issues/${number}`,
      state,
      updated_at: updatedAt,
      user: { login },
      assignees: [{ login: assigneeLogin }],
      labels,
      milestone: milestone ?? null,
    },
  });
  return {
    semantic_key: `gh:issue:${number}:${action}:${updatedAt}`,
    event_type: "issue",
    ref_number: number,
    subject_login: assigneeLogin,
    raw,
    provenance: "webhook",
    occurred_at: updatedAt,
  };
}

describe("getMyWork — previous activity cap", () => {
  it("returns only the 6 most recent merged/closed PR events, with the stored structured columns joined", async () => {
    for (let n = 1; n <= 7; n++) {
      await ingestEvent(env.DB, prEvent({ number: n, login: "AndresL230", occurred_at: daysBefore(NOW, 7 - n) }), "github-webhook");
    }
    await storePrSummary(env.DB, null, { semantic_key: "gh:pr:7:merged", pr_number: 7, title: "PR 7", body: "some body" });

    const work = await getMyWork(env.DB, "AndresL230");
    expect(work.degraded).toBe(false);
    expect(work.person).toBe("Andres");
    expect(work.previousActivity.map((p) => p.number)).toEqual([7, 6, 5, 4, 3, 2]); // newest first, oldest one cut
    expect(work.previousActivity[0]).toMatchObject({
      number: 7,
      title: "PR 7",
      url: "https://github.com/o/r/pull/7",
      merged: true,
      // Not yet populated by capture/summarize — null until the follow-up lands.
      displayTitle: null,
      what: null,
      why: null,
      impact: null,
      baseRef: null,
    });
  });

  it("does not surface another person's PR events", async () => {
    const mine = prEvent({ number: 3, login: "AndresL230", occurred_at: daysBefore(NOW, 2) });
    const theirs = prEvent({ number: 4, login: "Jose-Gael-Cruz-Lopez", occurred_at: daysBefore(NOW, 2) });
    await ingestEvent(env.DB, mine, "github-webhook");
    await ingestEvent(env.DB, theirs, "github-webhook");

    const work = await getMyWork(env.DB, "AndresL230");
    expect(work.previousActivity.map((p) => p.number)).toEqual([3]);
  });
});

describe("getMyWork — todo latest-snapshot semantics", () => {
  it("reflects only the LATEST snapshot per issue: open→closed drops it, reopen brings it back", async () => {
    const opened = issueEvent({
      number: 7,
      login: "AndresL230",
      action: "opened",
      state: "open",
      updatedAt: "2026-07-01T10:00:00.000Z",
      title: "[P1] Fix bug",
      labels: ["bug"],
    });
    await ingestEvent(env.DB, opened, "github-webhook");

    let work = await getMyWork(env.DB, "AndresL230");
    expect(work.todo).toHaveLength(1);
    expect(work.todo[0]).toMatchObject({
      number: 7,
      title: "Fix bug",
      priority: "P1",
      labels: ["bug"],
      url: "https://github.com/o/r/issues/7",
      // Not yet populated by capture/summarize — null until the follow-up lands.
      displayTitle: null,
      milestone: null,
      nextStep: null,
    });

    const closed = issueEvent({
      number: 7,
      login: "AndresL230",
      action: "closed",
      state: "closed",
      updatedAt: "2026-07-02T10:00:00.000Z",
      title: "[P1] Fix bug",
      labels: ["bug"],
    });
    await ingestEvent(env.DB, closed, "github-webhook");

    work = await getMyWork(env.DB, "AndresL230");
    expect(work.todo).toHaveLength(0);

    const reopened = issueEvent({
      number: 7,
      login: "AndresL230",
      action: "reopened",
      state: "open",
      updatedAt: "2026-07-03T10:00:00.000Z",
      title: "[P1] Fix bug",
      labels: ["bug"],
    });
    await ingestEvent(env.DB, reopened, "github-webhook");

    work = await getMyWork(env.DB, "AndresL230");
    expect(work.todo).toHaveLength(1);
    expect(work.todo[0].number).toBe(7);
  });
});

describe("getMyWork — todo cap", () => {
  it("returns only the 6 most recently updated open assigned issues, newest first", async () => {
    for (let n = 1; n <= 7; n++) {
      await ingestEvent(
        env.DB,
        issueEvent({
          number: n,
          login: "AndresL230",
          action: "assigned",
          state: "open",
          updatedAt: daysBefore(NOW, 7 - n), // issue 7 is the freshest
        }),
        "github-webhook"
      );
    }

    const work = await getMyWork(env.DB, "AndresL230");
    expect(work.todo.map((t) => t.number)).toEqual([7, 6, 5, 4, 3, 2]); // newest first, oldest one cut — mirrors the PR cap
  });
});

describe("getMyWork — unmapped login", () => {
  it("returns an empty, non-degraded projection but leaves captured events in place", async () => {
    const ev = prEvent({ number: 9, login: "stranger", occurred_at: daysBefore(NOW, 1) });
    await ingestEvent(env.DB, ev, "github-webhook");

    const work = await getMyWork(env.DB, "stranger");
    expect(work).toEqual({ person: null, previousActivity: [], todo: [], degraded: false });

    const rows = await all<EventRow>(env.DB, `SELECT * FROM events`);
    expect(rows).toHaveLength(1); // captured, never dropped
  });
});

describe("getMyWork — todo carries the issue summary", () => {
  it("joins issue_summaries by issue number; null until a summary exists", async () => {
    const assigned = issueEvent({
      number: 8,
      login: "AndresL230",
      action: "assigned",
      state: "open",
      updatedAt: "2026-07-01T10:00:00.000Z",
    });
    await ingestEvent(env.DB, assigned, "github-webhook");

    let work = await getMyWork(env.DB, "AndresL230");
    expect(work.todo.find((t) => t.number === 8)?.summary).toBeNull();

    await storeIssueSummary(env.DB, null, { issue_number: 8, title: "Issue 8", body: "some body" });
    work = await getMyWork(env.DB, "AndresL230");
    expect(work.todo.find((t) => t.number === 8)?.summary).toBe("some body"); // excerpt fallback (no summarizer)
  });
});

describe("getMyWork — structured fields", () => {
  it("projects the structured PR summary columns and base.ref into the DTO", async () => {
    await run(env.DB, `INSERT INTO people (login, person) VALUES ('dev', 'Dev')`);
    await ingestEvent(env.DB, prEvent({ number: 7, login: "dev", baseRef: "main" }), "github-webhook");
    const stub: Summarizer<PrSummary> = {
      model: "stub-model",
      summarize: async () => ({ title: "Humanized seven", what: "Did the thing.", why: "It was broken.", impact: "Users can log in." }),
    };
    await storePrSummary(env.DB, stub, { semantic_key: "gh:pr:7:merged", pr_number: 7, title: "t", body: "b" });

    const work = await getMyWork(env.DB, "dev");
    expect(work.previousActivity[0]).toMatchObject({
      number: 7,
      displayTitle: "Humanized seven",
      what: "Did the thing.",
      why: "It was broken.",
      impact: "Users can log in.",
      baseRef: "main",
    });
  });

  it("projects the structured issue summary columns and the milestone into the todo", async () => {
    await run(env.DB, `INSERT INTO people (login, person) VALUES ('dev', 'Dev')`);
    await ingestEvent(
      env.DB,
      issueEvent({ number: 9, login: "dev", action: "assigned", state: "open", updatedAt: NOW, milestone: { number: 3, title: "Reliable event capture", due_on: "2026-07-20T07:00:00Z" } }),
      "github-webhook"
    );
    const stub: Summarizer<IssueSummary> = {
      model: "stub-model",
      summarize: async () => ({ title: "Humanized nine", summary: "What it is.", next_step: "Do the fix." }),
    };
    await storeIssueSummary(env.DB, stub, { issue_number: 9, title: "t", body: "b" });

    const work = await getMyWork(env.DB, "dev");
    expect(work.todo[0]).toMatchObject({
      number: 9,
      displayTitle: "Humanized nine",
      summary: "What it is.",
      nextStep: "Do the fix.",
      milestone: { title: "Reliable event capture", dueOn: "2026-07-20T07:00:00Z" },
    });
  });

  it("yields nulls for a legacy raw (no base, milestone without title) and a prose-era summary row", async () => {
    await run(env.DB, `INSERT INTO people (login, person) VALUES ('dev', 'Dev')`);
    await ingestEvent(env.DB, prEvent({ number: 8, login: "dev" }), "github-webhook");
    await ingestEvent(
      env.DB,
      issueEvent({ number: 10, login: "dev", action: "assigned", state: "open", updatedAt: NOW, milestone: { number: 3 } }),
      "github-webhook"
    );
    const work = await getMyWork(env.DB, "dev");
    expect(work.previousActivity[0]).toMatchObject({ number: 8, displayTitle: null, what: null, why: null, impact: null, baseRef: null });
    expect(work.todo[0]).toMatchObject({ number: 10, displayTitle: null, nextStep: null, milestone: null });
  });
});
