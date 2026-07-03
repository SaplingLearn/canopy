import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, first } from "../src/db";
import { ingestEvent } from "../src/consumer";
import { map_identity } from "../src/tools/writes";
import type { IdentityTaskRow, PersonRow } from "@shared/rows";
import type { CapturedEvent } from "@shared/contract";

const ev = (over: Partial<CapturedEvent> = {}): CapturedEvent => ({
  semantic_key: "gh:pr:7:merged",
  event_type: "pr_merged",
  ref_number: 7,
  subject_login: "mystery-dev",
  raw: JSON.stringify({ pr: { number: 7, title: "t", body: "b" } }),
  provenance: "webhook",
  occurred_at: "2026-07-01T10:00:00Z",
  ...over,
});

describe("map_identity — people's only runtime write path", () => {
  it("writes the people row and soft-resolves the task with audit columns", async () => {
    await ingestEvent(env.DB, ev(), "github-webhook");

    const res = await map_identity(env.DB, "mystery-dev", "Casey", "andres");
    expect(res).toEqual({ login: "mystery-dev", person: "Casey", status: "resolved" });

    const person = await first<PersonRow>(env.DB, `SELECT * FROM people WHERE login = 'mystery-dev'`);
    expect(person?.person).toBe("Casey");

    // Soft resolve: the row remains, flipped with the audit trail.
    const task = await first<IdentityTaskRow>(env.DB, `SELECT * FROM identity_tasks WHERE login = 'mystery-dev'`);
    expect(task?.status).toBe("resolved");
    expect(task?.resolved_by).toBe("andres");
    expect(task?.resolved_at).toBeTruthy();
  });

  it("double-map is idempotent-safe: surfaces the recorded mapping, never re-writes", async () => {
    await ingestEvent(env.DB, ev(), "github-webhook");
    await map_identity(env.DB, "mystery-dev", "Casey", "andres");

    const second = await map_identity(env.DB, "mystery-dev", "Somebody Else", "jose");
    expect(second).toEqual({ login: "mystery-dev", person: "Casey", status: "resolved" }); // the FIRST mapping stands

    const people = await all<PersonRow>(env.DB, `SELECT * FROM people WHERE login = 'mystery-dev'`);
    expect(people.length).toBe(1);
    expect(people[0].person).toBe("Casey");
    const task = await first<IdentityTaskRow>(env.DB, `SELECT * FROM identity_tasks WHERE login = 'mystery-dev'`);
    expect(task?.resolved_by).toBe("andres"); // audit trail untouched by the replay
  });

  it("throws on a login with no identity task (people is never written)", async () => {
    await expect(map_identity(env.DB, "nobody-here", "Ghost", "andres")).rejects.toThrow("no such identity task: nobody-here");
    expect(await first<PersonRow>(env.DB, `SELECT * FROM people WHERE login = 'nobody-here'`)).toBeNull();
  });
});
