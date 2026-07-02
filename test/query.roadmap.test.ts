import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { query } from "../src/tools/reads";
import { write_plan } from "../src/tools/plan";
import { upsertProgress } from "../src/tools/progress";
import { all } from "../src/db";

const AUTHOR = "tester";

// The exact statement test/apply-migrations.ts runs beforeEach (roadmap-relevant:
// it UPDATE-resets the plan singleton and DELETEs milestones).
const HARNESS_TRUNCATION =
  "DELETE FROM pr_summaries; DELETE FROM events; DELETE FROM milestone_progress; DELETE FROM plan_versions; UPDATE plan SET narrative = '', current_version = 0, updated_at = NULL, updated_by = NULL; DELETE FROM focus; DELETE FROM milestone_proposals; DELETE FROM milestones; DELETE FROM doc_versions; DELETE FROM docs; DELETE FROM feed; DELETE FROM entry_tags; DELETE FROM adrs; DELETE FROM needs_triage; DELETE FROM sessions; DELETE FROM mcp_tokens; DELETE FROM users;";

async function roadmapFtsCount(): Promise<number> {
  const rows = await all<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM roadmap_fts`);
  return rows[0].n;
}

describe("query() learns the roadmap (plan + milestones via FTS)", () => {
  it("a milestone is a milestone-typed hit; the plan carries the narrative body", async () => {
    const { milestones } = await write_plan(
      env.DB,
      {
        narrative: "The vector search rollout brings semantic retrieval online this quarter.",
        milestones: [
          { title: "Vectorize GA", description: "Ship the Vectorize index to production", phase: "Now", target_date: "2026-08-01", status: "in_progress" },
        ],
      },
      AUTHOR
    );
    const mid = milestones[0].id;

    // 1. A term unique to the milestone → a milestone-typed hit for it.
    const r1 = await query(env.DB, { q: "vectorize", include_staged: true });
    const hit = r1.primary.find((p) => p.id === `milestone:${mid}`);
    expect(hit).toBeDefined();
    expect(hit!.type).toBe("milestone");
    expect(hit!.title).toBe("Vectorize GA");
    expect(hit!.authority).toBe("live");
    expect(hit!.body).toContain("Ship the Vectorize index");

    // 2. A phrase only in the narrative → the plan row, carrying the narrative body.
    const r2 = await query(env.DB, { q: "semantic retrieval online", include_staged: true });
    const plan = r2.primary.find((p) => p.id === "plan");
    expect(plan).toBeDefined();
    expect(plan!.type).toBe("milestone");
    expect(plan!.title).toBe("Roadmap plan");
    expect(plan!.authority).toBe("live");
    expect(plan!.body).toContain("vector search rollout");
  });

  it("milestone participates in the DEFAULT types (no explicit types needed)", async () => {
    await write_plan(
      env.DB,
      {
        narrative: "n",
        milestones: [{ title: "Quokka Launch", description: "the quokka milestone", target_date: "2026-09-01", status: "upcoming" }],
      },
      AUTHOR
    );
    const r = await query(env.DB, { q: "quokka", include_staged: true }); // no types → defaults include milestone
    expect(r.primary.some((p) => p.type === "milestone" && p.title === "Quokka Launch")).toBe(true);
  });

  it("cached progress is appended as a final body line", async () => {
    const { milestones } = await write_plan(
      env.DB,
      {
        narrative: "n",
        milestones: [{ title: "Progress Milestone", description: "aardvark subsystem", target_date: "2026-10-01", status: "in_progress" }],
      },
      AUTHOR
    );
    const mid = milestones[0].id;
    await upsertProgress(env.DB, mid, 2, 5, "recompute");

    const r = await query(env.DB, { q: "aardvark", types: ["milestone"], include_staged: true });
    const hit = r.primary.find((p) => p.id === `milestone:${mid}`)!;
    expect(hit.body).toContain("Progress: 2/5 closed");
  });

  it("section/space filter excludes milestone (docsOnly)", async () => {
    await write_plan(
      env.DB,
      { narrative: "n", milestones: [{ title: "Mango Milestone", description: "mango note", target_date: "2026-11-01", status: "upcoming" }] },
      AUTHOR
    );
    const r = await query(env.DB, { q: "mango", section: "reference", include_staged: true });
    expect(r.primary.some((p) => p.type === "milestone")).toBe(false);
    expect(r.pointers.some((p) => p.type === "milestone")).toBe(false);
  });

  it("the harness truncation cascades into roadmap_fts (no leaked rows)", async () => {
    await write_plan(
      env.DB,
      {
        narrative: "some narrative that indexes the plan row",
        milestones: [{ title: "Iso Milestone", description: "d", phase: "Now", target_date: "2026-12-01", status: "upcoming" }],
      },
      AUTHOR
    );
    // 1 plan row (non-empty narrative) + 1 milestone row.
    expect(await roadmapFtsCount()).toBe(2);

    // Run the EXACT statement the harness runs beforeEach.
    await env.DB.exec(HARNESS_TRUNCATION);

    // Milestone DELETE cascades out; the plan UPDATE-to-'' deletes the plan row.
    expect(await roadmapFtsCount()).toBe(0);
  });
});
