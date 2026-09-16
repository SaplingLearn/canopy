import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { write_plan, get_plan } from "../src/tools/plan";
import { all, first, run } from "../src/db";
import type { SprintRow, PlanVersionRow } from "@shared/rows";
import { upsertProgress } from "../src/tools/progress";

const AUTHOR = "admin";

describe("write_plan", () => {
  it("first write creates version 1 with a snapshot; second write creates version 2; both snapshots remain (non-destructive)", async () => {
    const r1 = await write_plan(
      env.DB,
      { narrative: "v1 narrative", sprints: [{ label: "M1", due: "2026-08-01", status: "upcoming" }] },
      AUTHOR
    );
    expect(r1.version).toBe(1);
    expect(r1.sprints).toHaveLength(1);

    const v1 = await first<PlanVersionRow>(env.DB, `SELECT * FROM plan_versions WHERE version = 1`);
    expect(v1).not.toBeNull();
    const snapshot1 = JSON.parse(v1!.sprints_json) as SprintRow[];
    expect(snapshot1).toHaveLength(1);
    expect(snapshot1[0].title).toBe("M1");
    expect(v1!.created_by).toBe(AUTHOR);

    const r2 = await write_plan(
      env.DB,
      { narrative: "v2 narrative", sprints: [{ label: "M2", due: "2026-09-01", status: "upcoming" }] },
      AUTHOR
    );
    expect(r2.version).toBe(2);
    expect(r2.sprints).toHaveLength(2); // M1 still exists, M2 added

    const versions = await all<PlanVersionRow>(env.DB, `SELECT * FROM plan_versions ORDER BY version ASC`);
    expect(versions.map((v) => v.version)).toEqual([1, 2]); // BOTH snapshots remain
    const snapshot2 = JSON.parse(versions[1].sprints_json) as SprintRow[];
    expect(snapshot2.map((m) => m.title).sort()).toEqual(["M1", "M2"]);
  });

  it("writes every sprint column: the DTO's label/due map onto title/target_date, and the 0025 fields land", async () => {
    const r = await write_plan(
      env.DB,
      {
        narrative: "n",
        sprints: [{
          label: "Ticket queue",
          summary: "One queue the whole org files into.",
          description: "**Tickets** are D1 rows, never GitHub issues.",
          phase: "Now",
          dates: "Sep 16 – Sep 30",
          due: "2026-09-30",
          status: "in_progress",
          urgency: "high",
          lead: "AndresL230",
          domain: "tickets",
          github_ref: [1, 2],
        }],
      },
      AUTHOR
    );
    const row = r.sprints[0];
    expect(row.title).toBe("Ticket queue");                 // label → title
    expect(row.target_date).toBe("2026-09-30");             // due → target_date
    expect(row.summary).toBe("One queue the whole org files into.");
    expect(row.description).toBe("**Tickets** are D1 rows, never GitHub issues.");
    expect(row.phase).toBe("Now");
    expect(row.dates).toBe("Sep 16 – Sep 30");
    expect(row.urgency).toBe("high");
    expect(row.lead).toBe("AndresL230");
    expect(row.domain).toBe("tickets");
    expect(JSON.parse(row.github_ref!)).toEqual([1, 2]);

    // …and the view exposes the same row in the product's vocabulary.
    const view = await get_plan(env.DB);
    expect(view.sprints[0]).toMatchObject({
      label: "Ticket queue", due: "2026-09-30", active: true, urgency: "high", lead: "AndresL230", domain: "tickets",
    });
  });

  it("urgency defaults to 'normal' when the write omits it", async () => {
    const r = await write_plan(env.DB, { narrative: "n", sprints: [{ label: "Plain", due: "2026-08-01", status: "upcoming" }] }, AUTHOR);
    expect(r.sprints[0].urgency).toBe("normal");
  });

  it("update-by-id changes label/status; admin CAN set status:'done' through write_plan", async () => {
    const r1 = await write_plan(
      env.DB,
      { narrative: "n", sprints: [{ label: "Original", due: "2026-08-01", status: "upcoming" }] },
      AUTHOR
    );
    const id = r1.sprints[0].id;

    const r2 = await write_plan(
      env.DB,
      { narrative: "n", sprints: [{ id, label: "Updated", due: "2026-08-01", status: "done" }] },
      AUTHOR
    );

    const m = r2.sprints.find((x) => x.id === id)!;
    expect(m.title).toBe("Updated");
    expect(m.status).toBe("done"); // legal here — admin-authored
  });

  it("unknown id throws 'no such sprint'", async () => {
    await expect(
      write_plan(
        env.DB,
        { narrative: "n", sprints: [{ id: 999, label: "X", due: "2026-08-01", status: "upcoming" }] },
        AUTHOR
      )
    ).rejects.toThrow("no such sprint: 999");
  });

  it("sprints not mentioned in the write are left untouched", async () => {
    const r1 = await write_plan(
      env.DB,
      {
        narrative: "n",
        sprints: [
          { label: "Keep", due: "2026-08-01", status: "upcoming" },
          { label: "Change", due: "2026-08-02", status: "upcoming" },
        ],
      },
      AUTHOR
    );
    const keepId = r1.sprints.find((m) => m.title === "Keep")!.id;
    const changeId = r1.sprints.find((m) => m.title === "Change")!.id;

    const r2 = await write_plan(
      env.DB,
      { narrative: "n", sprints: [{ id: changeId, label: "Changed", due: "2026-08-02", status: "in_progress" }] },
      AUTHOR
    );

    const keep = r2.sprints.find((m) => m.id === keepId)!;
    expect(keep.title).toBe("Keep");
    expect(keep.status).toBe("upcoming"); // untouched
    const changed = r2.sprints.find((m) => m.id === changeId)!;
    expect(changed.title).toBe("Changed");
    expect(changed.status).toBe("in_progress");
  });

  it("re-creates the plan singleton via INSERT OR IGNORE when the row is missing (prod resilience)", async () => {
    await run(env.DB, `DELETE FROM plan`);
    const r = await write_plan(env.DB, { narrative: "n", sprints: [] }, AUTHOR);
    expect(r.version).toBe(1);
    const plan = await first(env.DB, `SELECT * FROM plan WHERE id = 1`);
    expect(plan).not.toBeNull();
  });
});

describe("get_plan", () => {
  it("merges the progress cache; an uncached sprint reads 0/0 (never null)", async () => {
    const r1 = await write_plan(
      env.DB,
      {
        narrative: "the narrative",
        sprints: [
          { label: "Cached", due: "2026-08-01", status: "upcoming" },
          { label: "Uncached", due: "2026-08-02", status: "upcoming" },
        ],
      },
      AUTHOR
    );
    const cachedId = r1.sprints.find((m) => m.title === "Cached")!.id;
    await upsertProgress(env.DB, cachedId, 3, 10, "event");

    const view = await get_plan(env.DB);
    expect(view.narrative).toBe("the narrative");
    expect(view.version).toBe(1);
    expect(view.updated_by).toBe(AUTHOR);
    expect(view.updated_at).not.toBeNull();

    const cached = view.sprints.find((m) => m.id === cachedId)!;
    expect(cached.progress).toEqual({ closed: 3, total: 10, pct: 30 });
    // The view shape drops `source` / `computed_at` (kept exactly to SprintView).
    expect((cached.progress as unknown as Record<string, unknown>).source).toBeUndefined();
    expect((cached.progress as unknown as Record<string, unknown>).computed_at).toBeUndefined();

    // A sprint with no cache row AND no tickets reads 0/0 (the ticket-inclusive
    // rule's "neither" case — see test/sprints.routes.test.ts for the other three).
    const uncached = view.sprints.find((m) => m.label === "Uncached")!;
    expect(uncached.progress).toEqual({ closed: 0, total: 0, pct: 0 });
    // No tickets in the sprint → no members. (A sprint's members ARE its tickets'
    // assignees; the plan write never sets them.)
    expect(uncached.members).toEqual([]);
  });

  it("derives `active` from status: in_progress → true, upcoming/done → false", async () => {
    await write_plan(
      env.DB,
      {
        narrative: "n",
        sprints: [
          { label: "Running", due: "2026-08-01", status: "in_progress" },
          { label: "Later", due: "2026-08-02", status: "upcoming" },
          { label: "Shipped", due: "2026-08-03", status: "done" },
        ],
      },
      AUTHOR
    );
    const view = await get_plan(env.DB);
    const byLabel = new Map(view.sprints.map((s) => [s.label, s.active]));
    expect(byLabel.get("Running")).toBe(true);
    expect(byLabel.get("Later")).toBe(false);
    expect(byLabel.get("Shipped")).toBe(false);
  });

  it("returns a default empty view when the plan singleton row is missing", async () => {
    await run(env.DB, `DELETE FROM plan`);
    const view = await get_plan(env.DB);
    expect(view).toMatchObject({ narrative: "", version: 0, updated_at: null, updated_by: null, sprints: [] });
  });
});
