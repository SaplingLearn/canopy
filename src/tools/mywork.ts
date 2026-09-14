import type { DashboardData, MyWorkPr, MyWorkTodo } from "@shared/dashboard";
import type { EventRow, PersonRow } from "@shared/rows";
import { type DB, all, first } from "../db";
import { getPerson, listIdentities } from "../auth/persons";

// My Work: a D1-only projection over captured GitHub events (Task 6). No live
// GitHub reads — this is deliberately the "what already happened + what's
// open" view built entirely from `events` (+ `pr_summaries`, `issue_summaries`,
// `persons`/`identities`).

// The projection is structurally the /me/dashboard DTO; the shared type is the
// single source of truth so the Worker and web build agree on the shape.
export type MyWork = DashboardData;

const PR_LIMIT = 6;
const TODO_LIMIT = 6;

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

/** The person a GitHub login belongs to, via the github identity row; null when unmapped. */
export async function resolvePersonForLogin(db: DB, login: string): Promise<PersonRow | null> {
  return first<PersonRow>(db,
    `SELECT p.* FROM identities i JOIN persons p ON p.handle = i.person WHERE i.provider = 'github' AND i.subject = ?`, login);
}

export interface PrEventJoinRow extends EventRow {
  s_title: string | null;
  s_what: string | null;
  s_why: string | null;
  s_impact: string | null;
}

interface RawPr {
  pr: { number: number; title: string; html_url: string; merged: boolean; base?: { ref: string } | null };
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
    milestone?: { title?: string | null; due_on?: string | null } | null;
  };
}

interface IssueSnapshotRow {
  ref_number: number;
  raw: string;
  summary: string | null;
  s_title: string | null;
  s_next_step: string | null;
}

/** One captured PR event (+ its summary join) → the My Work card shape. Shared
 *  with the my_work email renderer so both surfaces summarize identically. */
export function toMyWorkPr(row: PrEventJoinRow): MyWorkPr {
  const parsed = JSON.parse(row.raw) as RawPr;
  return {
    number: parsed.pr.number,
    title: parsed.pr.title,
    url: parsed.pr.html_url,
    merged: parsed.pr.merged,
    occurredAt: row.occurred_at ?? row.recorded_at,
    displayTitle: row.s_title,
    what: row.s_what,
    why: row.s_why,
    impact: row.s_impact,
    baseRef: parsed.pr.base?.ref ?? null,
  };
}

/**
 * Every open issue assigned to any of `logins`, newest-updated first, uncapped.
 * Built from the latest snapshot per ref_number across ALL issue events (not
 * scoped to a known set of numbers — every issue ever captured is a todo
 * candidate). `logins` is every GitHub identity of one person (usually one).
 * The dashboard caps this; the email renderer lists it whole.
 */
export async function listOpenAssignedIssues(db: DB, logins: string[]): Promise<MyWorkTodo[]> {
  const issueRows = await all<IssueSnapshotRow>(
    db,
    `SELECT e.ref_number, e.raw, s.summary AS summary, s.title AS s_title, s.next_step AS s_next_step
     FROM (
       SELECT ref_number, raw, ROW_NUMBER() OVER (PARTITION BY ref_number ORDER BY occurred_at DESC, id DESC) rn
       FROM events WHERE event_type = 'issue'
     ) e
     LEFT JOIN issue_summaries s ON s.issue_number = e.ref_number
     WHERE e.rn = 1
     ORDER BY e.ref_number ASC`
  );
  const todo: MyWorkTodo[] = [];
  for (const row of issueRows) {
    const parsed = JSON.parse(row.raw) as RawIssue;
    const issue = parsed.issue;
    if (issue.state !== "open") continue;
    if (!issue.assignees.some((a) => logins.includes(a.login))) continue;
    const m = issue.milestone;
    todo.push({
      number: issue.number,
      title: stripPriority(issue.title),
      priority: priorityOf(issue.title),
      labels: issue.labels,
      url: issue.html_url,
      updatedAt: issue.updated_at,
      summary: row.summary,
      displayTitle: row.s_title,
      // legacy raws captured before 0018 lack a milestone title — hide the row.
      milestone: m?.title ? { title: m.title, dueOn: m.due_on ?? null } : null,
      nextStep: row.s_next_step,
    });
  }
  // Most recently updated first (updated_at is a GitHub ISO-8601 UTC string —
  // lexicographic order is chronological).
  todo.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return todo;
}

/**
 * The personal My Work projection for `handle` (a person handle). person comes
 * from `persons` directly; an unmapped/unknown handle is a captured-but-
 * unsurfaced no-op (empty projection, degraded:false — the events themselves
 * are never dropped). The GitHub logins to query are every `identities` row
 * for the person — usually just the one login that IS their handle. A person
 * with no GitHub identity at all (e.g. Google-only) surfaces with empty lists.
 * Any D1 failure degrades the whole projection to empty with degraded:true
 * rather than throwing.
 */
export async function getMyWork(db: DB, handle: string): Promise<MyWork> {
  try {
    const me = await getPerson(db, handle);
    if (!me) return EMPTY(false);

    const logins = (await listIdentities(db, handle)).filter((i) => i.provider === "github").map((i) => i.subject);
    if (logins.length === 0) return { person: me.name ?? me.handle, previousActivity: [], todo: [], degraded: false };

    const prRows = await all<PrEventJoinRow>(
      db,
      `SELECT e.*, s.title AS s_title, s.what AS s_what, s.why AS s_why, s.impact AS s_impact
         FROM events e
         LEFT JOIN pr_summaries s ON s.semantic_key = e.semantic_key
        WHERE e.event_type IN ('pr_merged', 'pr_closed')
          AND e.subject_login IN (${logins.map(() => "?").join(",")})
        ORDER BY e.occurred_at DESC, e.id DESC
        LIMIT ${PR_LIMIT}`,
      ...logins
    );
    const previousActivity: MyWorkPr[] = prRows.map(toMyWorkPr);
    const todo = await listOpenAssignedIssues(db, logins);

    return { person: me.name ?? me.handle, previousActivity, todo: todo.slice(0, TODO_LIMIT), degraded: false };
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
