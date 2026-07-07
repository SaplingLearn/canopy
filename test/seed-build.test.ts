import { describe, it, expect } from "vitest";
import { buildSeedStatements, targetsRemote } from "../scripts/seed/build.mjs";
import { RESET_STATEMENTS } from "../scripts/seed/reset.mjs";

describe("buildSeedStatements", () => {
  it("prepends the canonical reset, in order", () => {
    const out = buildSeedStatements({});
    expect(out.slice(0, RESET_STATEMENTS.length)).toEqual(RESET_STATEMENTS);
  });

  it("escapes single quotes in values", () => {
    const out = buildSeedStatements({ docs: { docs: [{ slug: "s", section: "reference", title: "O'Hara", body: "b", current_version: 1, updated_at: "t", updated_by: "u", versions: [] }] } });
    const insert = out.find((s) => s.startsWith("INSERT INTO docs"));
    expect(insert).toContain("'O''Hara'");
  });

  it("serializes event raw as a JSON string literal with no literal newline", () => {
    const out = buildSeedStatements({ events: { events: [{ semantic_key: "k", event_type: "pr_merged", ref_number: 1, subject_login: "AndresL230", provenance: "backfill", occurred_at: "t", recorded_at: "t", raw: { pr: { body: "line1\nline2" } } }] } });
    const insert = out.find((s) => s.startsWith("INSERT INTO events"));
    expect(insert).toBeDefined();
    expect(insert).toContain("line1\\nline2");
    expect(insert!.includes("\n")).toBe(false);
  });

  it("emits a milestone_progress insert only when progress is present", () => {
    const withP = buildSeedStatements({ roadmap: { narrative: "n", version: 1, milestones: [{ id: 1, title: "m", target_date: "2026-01-01", status: "done", progress: { closed: 2, total: 2, computed_at: "t" } }] } });
    const without = buildSeedStatements({ roadmap: { narrative: "n", version: 1, milestones: [{ id: 2, title: "m2", target_date: "2026-01-01", status: "upcoming" }] } });
    expect(withP.some((s) => s.startsWith("INSERT INTO milestone_progress"))).toBe(true);
    expect(without.some((s) => s.startsWith("INSERT INTO milestone_progress"))).toBe(false);
  });

  it("targetsRemote detects the --remote flag", () => {
    expect(targetsRemote(["--remote"])).toBe(true);
    expect(targetsRemote(["--local"])).toBe(false);
  });
});
