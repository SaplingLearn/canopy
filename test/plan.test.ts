import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { write_plan, get_plan } from "../src/tools/plan";
import { all, first, run } from "../src/db";
import type { MilestoneRow, PlanVersionRow } from "@shared/rows";
import { upsertProgress } from "../src/tools/progress";

const AUTHOR = "admin";

describe("write_plan", () => {
  it("first write creates version 1 with a snapshot; second write creates version 2; both snapshots remain (non-destructive)", async () => {
    const r1 = await write_plan(
      env.DB,
      { narrative: "v1 narrative", milestones: [{ title: "M1", target_date: "2026-08-01", status: "upcoming" }] },
      AUTHOR
    );
    expect(r1.version).toBe(1);
    expect(r1.milestones).toHaveLength(1);

    const v1 = await first<PlanVersionRow>(env.DB, `SELECT * FROM plan_versions WHERE version = 1`);
    expect(v1).not.toBeNull();
    const snapshot1 = JSON.parse(v1!.milestones_json) as MilestoneRow[];
    expect(snapshot1).toHaveLength(1);
    expect(snapshot1[0].title).toBe("M1");
    expect(v1!.created_by).toBe(AUTHOR);

    const r2 = await write_plan(
      env.DB,
      { narrative: "v2 narrative", milestones: [{ title: "M2", target_date: "2026-09-01", status: "upcoming" }] },
      AUTHOR
    );
    expect(r2.version).toBe(2);
    expect(r2.milestones).toHaveLength(2); // M1 still exists, M2 added

    const versions = await all<PlanVersionRow>(env.DB, `SELECT * FROM plan_versions ORDER BY version ASC`);
    expect(versions.map((v) => v.version)).toEqual([1, 2]); // BOTH snapshots remain
    const snapshot2 = JSON.parse(versions[1].milestones_json) as MilestoneRow[];
    expect(snapshot2.map((m) => m.title).sort()).toEqual(["M1", "M2"]);
  });

  it("update-by-id changes title/status; admin CAN set status:'done' through write_plan", async () => {
    const r1 = await write_plan(
      env.DB,
      { narrative: "n", milestones: [{ title: "Original", target_date: "2026-08-01", status: "upcoming" }] },
      AUTHOR
    );
    const id = r1.milestones[0].id;

    const r2 = await write_plan(
      env.DB,
      { narrative: "n", milestones: [{ id, title: "Updated", target_date: "2026-08-01", status: "done" }] },
      AUTHOR
    );

    const m = r2.milestones.find((x) => x.id === id)!;
    expect(m.title).toBe("Updated");
    expect(m.status).toBe("done"); // legal here — admin-authored
  });

  it("unknown id throws 'no such milestone'", async () => {
    await expect(
      write_plan(
        env.DB,
        { narrative: "n", milestones: [{ id: 999, title: "X", target_date: "2026-08-01", status: "upcoming" }] },
        AUTHOR
      )
    ).rejects.toThrow("no such milestone: 999");
  });

  it("milestones not mentioned in the write are left untouched", async () => {
    const r1 = await write_plan(
      env.DB,
      {
        narrative: "n",
        milestones: [
          { title: "Keep", target_date: "2026-08-01", status: "upcoming" },
          { title: "Change", target_date: "2026-08-02", status: "upcoming" },
        ],
      },
      AUTHOR
    );
    const keepId = r1.milestones.find((m) => m.title === "Keep")!.id;
    const changeId = r1.milestones.find((m) => m.title === "Change")!.id;

    const r2 = await write_plan(
      env.DB,
      { narrative: "n", milestones: [{ id: changeId, title: "Changed", target_date: "2026-08-02", status: "in_progress" }] },
      AUTHOR
    );

    const keep = r2.milestones.find((m) => m.id === keepId)!;
    expect(keep.title).toBe("Keep");
    expect(keep.status).toBe("upcoming"); // untouched
    const changed = r2.milestones.find((m) => m.id === changeId)!;
    expect(changed.title).toBe("Changed");
    expect(changed.status).toBe("in_progress");
  });

  it("re-creates the plan singleton via INSERT OR IGNORE when the row is missing (prod resilience)", async () => {
    await run(env.DB, `DELETE FROM plan`);
    const r = await write_plan(env.DB, { narrative: "n", milestones: [] }, AUTHOR);
    expect(r.version).toBe(1);
    const plan = await first(env.DB, `SELECT * FROM plan WHERE id = 1`);
    expect(plan).not.toBeNull();
  });
});

describe("get_plan", () => {
  it("merges the progress cache; uncached milestones get progress:null", async () => {
    const r1 = await write_plan(
      env.DB,
      {
        narrative: "the narrative",
        milestones: [
          { title: "Cached", target_date: "2026-08-01", status: "upcoming" },
          { title: "Uncached", target_date: "2026-08-02", status: "upcoming" },
        ],
      },
      AUTHOR
    );
    const cachedId = r1.milestones.find((m) => m.title === "Cached")!.id;
    await upsertProgress(env.DB, cachedId, 3, 10, "event");

    const view = await get_plan(env.DB);
    expect(view.narrative).toBe("the narrative");
    expect(view.version).toBe(1);
    expect(view.updated_by).toBe(AUTHOR);
    expect(view.updated_at).not.toBeNull();

    const cached = view.milestones.find((m) => m.id === cachedId)!;
    expect(cached.progress).toMatchObject({ closed: 3, total: 10 });
    expect(cached.progress!.computed_at).toBeTruthy();
    // The view shape drops `source` (kept exactly to the brief's PlanView shape).
    expect((cached.progress as unknown as Record<string, unknown>).source).toBeUndefined();

    const uncached = view.milestones.find((m) => m.title === "Uncached")!;
    expect(uncached.progress).toBeNull();
  });

  it("returns a default empty view when the plan singleton row is missing", async () => {
    await run(env.DB, `DELETE FROM plan`);
    const view = await get_plan(env.DB);
    expect(view).toMatchObject({ narrative: "", version: 0, updated_at: null, updated_by: null, milestones: [] });
  });
});
