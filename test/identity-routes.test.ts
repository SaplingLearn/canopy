import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { createSession } from "../src/auth/session";
import { hmacSeal } from "../src/auth/crypto";
import { all, first } from "../src/db";
import { ingestEvent } from "../src/consumer";
import { getMyWork } from "../src/tools/mywork";
import type { IdentityTaskWithSample } from "../src/tools/reads";
import type { IdentityTaskRow, PersonRow } from "@shared/rows";
import type { CapturedEvent } from "@shared/contract";

async function authedCookie(login: string): Promise<string> {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (github_login, name, created_at) VALUES (?, ?, ?)`
  ).bind(login, login, "2026-01-01T00:00:00Z").run();
  const { id } = await createSession(env.DB, login);
  return `session=${await hmacSeal(id, "test-cookie-secret")}`;
}

const post = (path: string, cookie: string, body?: unknown) =>
  app.request(
    path,
    { method: "POST", headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
    env
  );
const getJson = async <T>(path: string, cookie: string): Promise<T> =>
  (await (await app.request(path, { headers: { cookie } }, env)).json()) as T;

// A merged-PR event whose raw carries everything getMyWork's projection parses
// (number, title, html_url, merged) — so the retroactive test is end-to-end real.
const prEvent = (n: number, login: string, title: string, occurredAt: string): CapturedEvent => ({
  semantic_key: `gh:pr:${n}:merged`,
  event_type: "pr_merged",
  ref_number: n,
  subject_login: login,
  raw: JSON.stringify({
    pr: { number: n, title, body: "b", html_url: `https://github.com/SaplingLearn/sapling/pull/${n}`, merged: true, merged_at: occurredAt, closed_at: occurredAt, user: { login }, milestone: null },
  }),
  provenance: "webhook",
  occurred_at: occurredAt,
});

describe("GET /identity-tasks", () => {
  it("lists pending tasks with a small LIVE sample: newest-first, capped at 3, titles extracted from raw", async () => {
    const cookie = await authedCookie("andres");
    for (let i = 1; i <= 4; i++) {
      await ingestEvent(env.DB, prEvent(i, "mystery-dev", `PR number ${i}`, `2026-07-0${i}T10:00:00Z`), "github-webhook");
    }

    const { tasks } = await getJson<{ tasks: IdentityTaskWithSample[] }>("/identity-tasks", cookie);
    expect(tasks.length).toBe(1);
    expect(tasks[0].login).toBe("mystery-dev");
    expect(tasks[0].status).toBe("pending");
    expect(tasks[0].sample.length).toBe(3); // capped — 4 events captured
    expect(tasks[0].sample[0]).toMatchObject({
      semantic_key: "gh:pr:4:merged",
      event_type: "pr_merged",
      ref_number: 4,
      title: "PR number 4", // extracted from the event's own raw
      occurred_at: "2026-07-04T10:00:00Z",
    });
  });

  it("a malformed raw yields title:null instead of failing the list", async () => {
    const cookie = await authedCookie("andres");
    await ingestEvent(
      env.DB,
      { ...prEvent(5, "glitchy-dev", "x", "2026-07-05T10:00:00Z"), raw: "not json at all" },
      "github-webhook"
    );
    const { tasks } = await getJson<{ tasks: IdentityTaskWithSample[] }>("/identity-tasks", cookie);
    expect(tasks[0].sample[0].title).toBeNull();
  });

  it("returns 401 without a session cookie", async () => {
    const res = await app.request("/identity-tasks", {}, env);
    expect(res.status).toBe(401);
  });
});

describe("POST /identity-tasks/:login/map", () => {
  it("maps the login, resolves the task, and drops it from the pending list", async () => {
    const cookie = await authedCookie("andres");
    await ingestEvent(env.DB, prEvent(1, "mystery-dev", "t", "2026-07-01T10:00:00Z"), "github-webhook");

    const res = await post("/identity-tasks/mystery-dev/map", cookie, { person: "Casey" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, login: "mystery-dev", person: "Casey", status: "resolved" });

    expect((await first<PersonRow>(env.DB, `SELECT * FROM people WHERE login = 'mystery-dev'`))?.person).toBe("Casey");
    const { tasks } = await getJson<{ tasks: unknown[] }>("/identity-tasks", cookie);
    expect(tasks.length).toBe(0); // leaves the queue
    const row = await first<IdentityTaskRow>(env.DB, `SELECT * FROM identity_tasks WHERE login = 'mystery-dev'`);
    expect(row?.status).toBe("resolved"); // soft — the row remains
    expect(row?.resolved_by).toBe("andres");
  });

  it("400 on a missing/empty person and on an unknown login", async () => {
    const cookie = await authedCookie("andres");
    await ingestEvent(env.DB, prEvent(1, "mystery-dev", "t", "2026-07-01T10:00:00Z"), "github-webhook");
    expect((await post("/identity-tasks/mystery-dev/map", cookie, {})).status).toBe(400);
    expect((await post("/identity-tasks/mystery-dev/map", cookie, { person: "   " })).status).toBe(400);
    expect((await post("/identity-tasks/nobody-here/map", cookie, { person: "Ghost" })).status).toBe(400);
  });

  it("returns 401 without a session cookie (and does not mutate)", async () => {
    await ingestEvent(env.DB, prEvent(1, "mystery-dev", "t", "2026-07-01T10:00:00Z"), "github-webhook");
    const res = await app.request("/identity-tasks/mystery-dev/map", { method: "POST" }, env);
    expect(res.status).toBe(401);
    expect(await first<PersonRow>(env.DB, `SELECT * FROM people WHERE login = 'mystery-dev'`)).toBeNull();
  });

  // Settled decision 5: identity mapping is retroactive for free — My Work
  // resolves login→person at READ time, so one people row surfaces all of the
  // login's already-captured events with no backfill job.
  it("retroactively surfaces already-captured events in My Work — no backfill", async () => {
    const cookie = await authedCookie("andres");
    await ingestEvent(env.DB, prEvent(1, "mystery-dev", "First PR", "2026-07-01T10:00:00Z"), "github-webhook");
    await ingestEvent(env.DB, prEvent(2, "mystery-dev", "Second PR", "2026-07-02T10:00:00Z"), "github-webhook");

    // Before mapping: captured but unsurfaced (empty projection, degraded:false).
    const before = await getMyWork(env.DB, "mystery-dev");
    expect(before).toEqual({ person: null, previousActivity: [], todo: [], degraded: false });

    expect((await post("/identity-tasks/mystery-dev/map", cookie, { person: "Casey" })).status).toBe(200);

    // After mapping: BOTH pre-existing events surface, purely at read time.
    const after = await getMyWork(env.DB, "mystery-dev");
    expect(after.person).toBe("Casey");
    expect(after.previousActivity.length).toBe(2);
    expect(after.previousActivity[0].title).toBe("Second PR"); // newest first
    expect(after.degraded).toBe(false);
  });
});
