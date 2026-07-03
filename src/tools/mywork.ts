import type { DashboardData, MyWorkPr, MyWorkTodo } from "@shared/dashboard";
import type { EventRow, PersonRow } from "@shared/rows";
import { type DB, all, first } from "../db";

// My Work: a D1-only projection over captured GitHub events (Task 6). No live
// GitHub reads — this is deliberately the "what already happened + what's
// open" view built entirely from `events` (+ `pr_summaries`, `people`).

// The projection is structurally the /me/dashboard DTO; the shared type is the
// single source of truth so the Worker and web build agree on the shape.
export type MyWork = DashboardData;

const PR_LIMIT = 5;

const EMPTY = (degraded: boolean): MyWork => ({ person: null, previousActivity: [], todo: [], degraded });

// Priority is parsed from a leading "[P0]"–"[P3]" tag on the issue title; the
// tag is stripped from the displayed title.
function priorityOf(title: string): "P0" | "P1" | "P2" | "P3" | null {
  const m = title.match(/^\s*\[(P[0-3])\]/);
  return m ? (m[1] as "P0" | "P1" | "P2" | "P3") : null;
}
function stripPriority(title: string): string {
  return title.replace(/^\s*\[P[0-3]\]\s*/, "").trim();
}

interface PrEventJoinRow extends EventRow {
  summary: string | null;
}

interface RawPr {
  pr: { number: number; title: string; html_url: string; merged: boolean };
}

interface RawIssue {
  issue: {
    number: number;
    title: string;
    html_url: string;
    state: string;
    updated_at: string;
    assignees: { login: string }[];
    labels: string[];
  };
}

interface IssueSnapshotRow {
  ref_number: number;
  raw: string;
}

/**
 * The personal My Work projection for `login`. person comes from `people`
 * (the admin-maintained identity map); an unmapped login is a captured-but-
 * unsurfaced no-op (empty projection, degraded:false — the events themselves
 * are never dropped). Any D1 failure degrades the whole projection to empty
 * with degraded:true rather than throwing.
 */
export async function getMyWork(db: DB, login: string): Promise<MyWork> {
  try {
    const personRow = await first<PersonRow>(db, `SELECT * FROM people WHERE login = ?`, login);
    if (!personRow) return EMPTY(false);

    const prRows = await all<PrEventJoinRow>(
      db,
      `SELECT e.*, s.summary AS summary
         FROM events e
         LEFT JOIN pr_summaries s ON s.semantic_key = e.semantic_key
        WHERE e.event_type IN ('pr_merged', 'pr_closed')
          AND e.subject_login = ?
        ORDER BY e.occurred_at DESC, e.id DESC
        LIMIT ${PR_LIMIT}`,
      login
    );
    const previousActivity: MyWorkPr[] = prRows.map((row) => {
      const parsed = JSON.parse(row.raw) as RawPr;
      return {
        number: parsed.pr.number,
        title: parsed.pr.title,
        url: parsed.pr.html_url,
        merged: parsed.pr.merged,
        occurredAt: row.occurred_at ?? row.recorded_at,
        summary: row.summary,
      };
    });

    // Latest snapshot per ref_number across ALL issue events (not scoped to a
    // known set of numbers — every issue ever captured is a todo candidate).
    const issueRows = await all<IssueSnapshotRow>(
      db,
      `SELECT ref_number, raw FROM (
         SELECT ref_number, raw, ROW_NUMBER() OVER (PARTITION BY ref_number ORDER BY occurred_at DESC, id DESC) rn
         FROM events WHERE event_type = 'issue'
       ) WHERE rn = 1
       ORDER BY ref_number ASC`
    );
    const todo: MyWorkTodo[] = [];
    for (const row of issueRows) {
      const parsed = JSON.parse(row.raw) as RawIssue;
      const issue = parsed.issue;
      if (issue.state !== "open") continue;
      if (!issue.assignees.some((a) => a.login === login)) continue;
      todo.push({
        number: issue.number,
        title: stripPriority(issue.title),
        priority: priorityOf(issue.title),
        labels: issue.labels,
        url: issue.html_url,
        updatedAt: issue.updated_at,
      });
    }

    return { person: personRow.person, previousActivity, todo, degraded: false };
  } catch {
    return EMPTY(true);
  }
}

/** Recent captured GitHub events, optionally filtered by type/subject. The raw
 *  log behind My Work and roadmap progress. */
export async function list_events(
  db: DB,
  filter?: { type?: "pr_merged" | "pr_closed" | "issue"; subject?: string; limit?: number }
): Promise<EventRow[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter?.type) {
    clauses.push(`event_type = ?`);
    params.push(filter.type);
  }
  if (filter?.subject) {
    clauses.push(`subject_login = ?`);
    params.push(filter.subject);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.trunc(Math.min(Math.max(filter?.limit ?? 50, 1), 500));

  return all<EventRow>(
    db,
    `SELECT * FROM events ${where} ORDER BY occurred_at DESC, id DESC LIMIT ${limit}`,
    ...params
  );
}
