import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all } from "../src/db";
import { ingestEvent } from "../src/consumer";
import { storePrSummary } from "../src/tools/summarize";
import { getMyWork } from "../src/tools/mywork";
import type { EventRow } from "@shared/rows";
import type { CapturedEvent } from "@shared/contract";

const NOW = "2026-07-15T12:00:00.000Z";

function daysBefore(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function prEvent(over: Partial<CapturedEvent> & { number: number; login: string; merged?: boolean }): CapturedEvent {
  const { number, login, merged = true, ...rest } = over;
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
}): CapturedEvent {
  const { number, login, action, state, updatedAt, title = `Issue ${number}`, labels = [], assigneeLogin = login } = over;
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
      milestone: null,
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

describe("getMyWork — previous activity windowing", () => {
  it("only includes merged/closed PR events within the last 14 days, with the stored summary joined", async () => {
    const recent = prEvent({ number: 1, login: "AndresL230", occurred_at: daysBefore(NOW, 3) });
    const old = prEvent({ number: 2, login: "AndresL230", occurred_at: daysBefore(NOW, 20) });
    await ingestEvent(env.DB, recent, "github-webhook");
    await ingestEvent(env.DB, old, "github-webhook");
    await storePrSummary(env.DB, null, { semantic_key: recent.semantic_key, pr_number: 1, title: "PR 1", body: "some body" });

    const work = await getMyWork(env.DB, "AndresL230", { now: NOW });
    expect(work.degraded).toBe(false);
    expect(work.person).toBe("Andres");
    expect(work.previousActivity).toHaveLength(1);
    expect(work.previousActivity[0]).toMatchObject({
      number: 1,
      title: "PR 1",
      url: "https://github.com/o/r/pull/1",
      merged: true,
    });
    expect(work.previousActivity[0].summary).toBe("some body"); // excerpt fallback (no summarizer)
  });

  it("does not surface another person's PR events", async () => {
    const mine = prEvent({ number: 3, login: "AndresL230", occurred_at: daysBefore(NOW, 2) });
    const theirs = prEvent({ number: 4, login: "Jose-Gael-Cruz-Lopez", occurred_at: daysBefore(NOW, 2) });
    await ingestEvent(env.DB, mine, "github-webhook");
    await ingestEvent(env.DB, theirs, "github-webhook");

    const work = await getMyWork(env.DB, "AndresL230", { now: NOW });
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

    let work = await getMyWork(env.DB, "AndresL230", { now: NOW });
    expect(work.todo).toHaveLength(1);
    expect(work.todo[0]).toMatchObject({
      number: 7,
      title: "Fix bug",
      priority: "P1",
      labels: ["bug"],
      url: "https://github.com/o/r/issues/7",
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

    work = await getMyWork(env.DB, "AndresL230", { now: NOW });
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

    work = await getMyWork(env.DB, "AndresL230", { now: NOW });
    expect(work.todo).toHaveLength(1);
    expect(work.todo[0].number).toBe(7);
  });
});

describe("getMyWork — unmapped login", () => {
  it("returns an empty, non-degraded projection but leaves captured events in place", async () => {
    const ev = prEvent({ number: 9, login: "stranger", occurred_at: daysBefore(NOW, 1) });
    await ingestEvent(env.DB, ev, "github-webhook");

    const work = await getMyWork(env.DB, "stranger", { now: NOW });
    expect(work).toEqual({ person: null, previousActivity: [], todo: [], degraded: false });

    const rows = await all<EventRow>(env.DB, `SELECT * FROM events`);
    expect(rows).toHaveLength(1); // captured, never dropped
  });
});
