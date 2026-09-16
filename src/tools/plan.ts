import type { SprintRow, PlanRow } from "@shared/rows";
import type { SprintView } from "@shared/sprints";
import { type DB, first, all, run, nowIso } from "../db";
import { list_sprints } from "./sprints";

/**
 * One sprint as the ADMIN plan write receives it. This is the DTO vocabulary
 * (`label`, `due`), not the column names (`title`, `target_date`) — the seam is
 * documented in shared/sprints.ts and translated in write_plan below.
 */
export interface PlanSprintInput {
  id?: number; // present = update that sprint; absent = create
  label: string;
  summary?: string | null;
  description?: string | null;
  phase?: string | null;
  dates?: string | null;
  due: string;
  status: "upcoming" | "in_progress" | "done"; // 'done' allowed HERE ONLY (admin-authored)
  urgency?: "low" | "normal" | "high";
  lead?: string | null;                        // person handle
  domain?: "notifications" | "tickets" | "gate" | "feed" | "search" | "infra" | null;
  github_ref?: number | number[] | null;
}

export interface PlanWrite {
  narrative: string;
  sprints: PlanSprintInput[];
}

export interface PlanView {
  narrative: string;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
  sprints: SprintView[];
}

const githubRefJson = (ref: number | number[] | null | undefined): string | null =>
  ref === undefined || ref === null ? null : JSON.stringify(ref);

/**
 * ADMIN direct write (promote-class, like promote_doc — NOT the ingestion gate):
 * replace the plan narrative and create/update sprints (including status 'done',
 * which is admin-authored and therefore legal ONLY here) in one non-destructively
 * versioned write. Sprints not mentioned are left untouched — never implicitly
 * deleted. `INSERT OR IGNORE` guards the singleton row for prod resilience (the
 * test harness never deletes it, but a fresh/drifted D1 might be missing it).
 *
 * Ticket membership of a sprint is NOT set here — that is the Tickets UI's job
 * (`POST /tickets/:id/sprint`). The plan write owns the sprint's own fields only.
 */
export async function write_plan(
  db: DB,
  input: PlanWrite,
  author: string
): Promise<{ version: number; sprints: SprintRow[] }> {
  await run(db, `INSERT OR IGNORE INTO plan (id, narrative, current_version) VALUES (1, '', 0)`);

  const plan = await first<PlanRow>(db, `SELECT * FROM plan WHERE id = 1`);
  const version = (plan?.current_version ?? 0) + 1;
  const now = nowIso();

  for (const sp of input.sprints) {
    const github_ref = githubRefJson(sp.github_ref);
    if (sp.id !== undefined) {
      // OMITTED means UNCHANGED. `label`, `due` and `status` are required on the
      // input, so they always overwrite. Every OPTIONAL column is written ONLY
      // when the caller actually supplied it: a plan write that names a sprint
      // without repeating its panel-authored fields (`summary`, `dates`,
      // `urgency`, `lead`, `domain`, `phase`, `description`, `github_ref`) leaves
      // them exactly as they were — `POST /sprints` (the Roadmap's New sprint
      // panel) writes those too, and the plan write must not clobber them.
      // An EXPLICIT `null` still CLEARS the column: `undefined` (absent) and
      // `null` (cleared) are distinct here, and that distinction is the contract.
      const sets: string[] = [`title = ?`, `target_date = ?`, `status = ?`, `updated_at = ?`];
      const binds: unknown[] = [sp.label, sp.due, sp.status, now];
      const optional: [string, unknown][] = [
        ["description", sp.description],
        ["summary", sp.summary],
        ["phase", sp.phase],
        ["dates", sp.dates],
        ["urgency", sp.urgency],
        ["lead", sp.lead],
        ["domain", sp.domain],
        ["github_ref", sp.github_ref === undefined ? undefined : github_ref],
      ];
      for (const [col, value] of optional) {
        if (value === undefined) continue;
        sets.push(`${col} = ?`);
        binds.push(value);
      }
      const res = await run(db, `UPDATE sprints SET ${sets.join(", ")} WHERE id = ?`, ...binds, sp.id);
      if ((res.meta.changes ?? 0) === 0) throw new Error(`no such sprint: ${sp.id}`);
    } else {
      await run(
        db,
        `INSERT INTO sprints (title, description, summary, phase, dates, target_date, status, urgency, lead, domain,
                              github_ref, created_at, created_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        sp.label,
        sp.description ?? null,
        sp.summary ?? null,
        sp.phase ?? null,
        sp.dates ?? null,
        sp.due,
        sp.status,
        sp.urgency ?? "normal",
        sp.lead ?? null,
        sp.domain ?? null,
        github_ref,
        now,
        author,
        now
      );
    }
  }

  const sprints = await all<SprintRow>(db, `SELECT * FROM sprints ORDER BY target_date ASC, id ASC`);

  await run(
    db,
    `UPDATE plan SET narrative = ?, current_version = ?, updated_at = ?, updated_by = ? WHERE id = 1`,
    input.narrative,
    version,
    now,
    author
  );
  await run(
    db,
    `INSERT INTO plan_versions (version, narrative, sprints_json, created_at, created_by) VALUES (?, ?, ?, ?, ?)`,
    version,
    input.narrative,
    JSON.stringify(sprints),
    now,
    author
  );

  return { version, sprints };
}

/**
 * Read the admin plan: narrative + version metadata, plus every sprint
 * (target_date ASC, id ASC, unscheduled last — the roadmap's order) as a
 * SprintView. NO GitHub, NO token — read-only against D1. Returns a default
 * empty view if the plan singleton row is missing.
 *
 * The sprint half is `list_sprints` (tools/sprints.ts), so `progress` is
 * TICKET-INCLUSIVE — the tickets in the sprint plus the cached, event-derived
 * GitHub issue counts — and `members` is the sprint's real distinct assignees.
 * One read model, shared by GET /roadmap, MCP get_roadmap and GET /sprints.
 */
export async function get_plan(db: DB): Promise<PlanView> {
  const plan = await first<PlanRow>(db, `SELECT * FROM plan WHERE id = 1`);
  const sprints = await list_sprints(db);

  return {
    narrative: plan?.narrative ?? "",
    version: plan?.current_version ?? 0,
    updated_at: plan?.updated_at ?? null,
    updated_by: plan?.updated_by ?? null,
    sprints,
  };
}
