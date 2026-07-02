import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, run, nowIso } from "../src/db";
import type { EventRow, PersonRow } from "@shared/rows";

describe("0012 stores", () => {
  it("events.semantic_key is UNIQUE and INSERT OR IGNORE dedupes", async () => {
    const now = nowIso();
    const ins = (key: string) =>
      run(env.DB, `INSERT OR IGNORE INTO events (semantic_key, event_type, ref_number, subject_login, raw, provenance, occurred_at, recorded_at, recorded_by)
                   VALUES (?, 'pr_merged', 42, 'AndresL230', '{}', 'webhook', ?, ?, 'github-webhook')`, key, now, now);
    const first = await ins("gh:pr:42:merged");
    expect(first.meta.changes).toBe(1);
    const dup = await ins("gh:pr:42:merged");
    expect(dup.meta.changes).toBe(0);
    expect((await all<EventRow>(env.DB, `SELECT * FROM events`)).length).toBe(1);
  });

  it("people is seeded from the old LOGIN_TO_PERSON object", async () => {
    const people = await all<PersonRow>(env.DB, `SELECT * FROM people ORDER BY login`);
    expect(people.map((p) => [p.login, p.person])).toEqual([
      ["AndresL230", "Andres"],
      ["Darkest-Teddy", "Jack"],
      ["Jose-Gael-Cruz-Lopez", "Jose"],
      ["lpcooper-arch", "Luke"],
    ]);
  });

  it("milestones has a phase column and plan/plan_versions exist", async () => {
    await run(env.DB, `INSERT INTO milestones (title, target_date, status, phase, created_at, created_by) VALUES ('m', '2026-08-01', 'upcoming', 'Phase 1', ?, 'a')`, nowIso());
    const rows = await all<{ phase: string | null }>(env.DB, `SELECT phase FROM milestones`);
    expect(rows[0].phase).toBe("Phase 1");
    expect(await all(env.DB, `SELECT * FROM plan_versions`)).toEqual([]);
  });
});
