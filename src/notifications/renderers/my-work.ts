import type { PersonRow } from "@shared/rows";
import type { NotificationKind, Section, Window } from "@shared/notifications";
import { type DB, all, first } from "../../db";
import { listOpenAssignedIssues, toMyWorkPr, type PrEventJoinRow } from "../../tools/mywork";
import { escapeHtml, isoOf } from "../html";
import { EMAIL_STYLE as S } from "../assemble";

const DEEP_LINK = "/#mywork";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const pad = (s: string, w: number) => s.padEnd(w);

function numberedRows(items: { number: number; url: string; title: string; note: string | null }[]): string {
  return (
    `<table ${S.table} style="margin-top:4px;">` +
    items
      .map(
        (i) =>
          `<tr><td width="48" style="${S.mono}">#${i.number}</td><td style="${S.body}"><a href="${escapeHtml(i.url)}" style="color:#0a0a0a;text-decoration:none;">${escapeHtml(i.title)}</a>` +
          (i.note ? `<div style="${S.muted}">${escapeHtml(i.note)}</div>` : "") +
          `</td></tr>`
      )
      .join("") +
    `</table>`
  );
}

/**
 * my_work — the event spine, scoped to the window: merged PRs whose occurred_at
 * falls in [start, end), summarized exactly as My Work does (same join, same
 * mapping), plus the user's open assigned issues (not windowed — it is their
 * plate). Same identity gate as the dashboard: an unmapped login renders null.
 */
async function render(db: DB, login: string, window: Window): Promise<Section | null> {
  const person = await first<PersonRow>(db, `SELECT * FROM people WHERE login = ?`, login);
  if (!person) return null;

  const prRows = await all<PrEventJoinRow>(
    db,
    `SELECT e.*, s.title AS s_title, s.what AS s_what, s.why AS s_why, s.impact AS s_impact
       FROM events e
       LEFT JOIN pr_summaries s ON s.semantic_key = e.semantic_key
      WHERE e.event_type = 'pr_merged'
        AND e.subject_login = ?
        AND datetime(e.occurred_at) >= datetime(?)
        AND datetime(e.occurred_at) <  datetime(?)
      ORDER BY e.occurred_at DESC, e.id DESC`,
    login,
    isoOf(window.start),
    isoOf(window.end)
  );
  const merged = prRows.map(toMyWorkPr);
  const todo = await listOpenAssignedIssues(db, login);
  if (merged.length === 0 && todo.length === 0) return null;

  const html: string[] = [];
  const text: string[] = [];
  if (merged.length) {
    html.push(`<div style="${S.label}padding-top:16px;">MERGED</div>`);
    html.push(numberedRows(merged.map((pr) => ({ number: pr.number, url: pr.url, title: pr.displayTitle ?? pr.title, note: pr.what ?? "No summary recorded" }))));
    for (const pr of merged) text.push(`  ${pad("merged", 7)} ${pad(`#${pr.number}`, 5)} ${pr.displayTitle ?? pr.title}`);
  }
  if (todo.length) {
    html.push(`<div style="${S.label}padding-top:${merged.length ? 12 : 16}px;">OPEN &amp; ASSIGNED</div>`);
    html.push(
      numberedRows(
        todo.map((i) => ({
          number: i.number,
          url: i.url,
          title: `${i.priority ? `[${i.priority}] ` : ""}${i.displayTitle ?? i.title}`,
          note: i.nextStep,
        }))
      )
    );
    for (const i of todo) text.push(`  ${pad("open", 7)} ${pad(`#${i.number}`, 5)} ${i.priority ? `[${i.priority}] ` : ""}${i.displayTitle ?? i.title}`);
  }

  const summary = [
    merged.length ? `${plural(merged.length, "PR", "PRs")} merged` : null,
    todo.length ? `${plural(todo.length, "assigned issue", "assigned issues")} open` : null,
  ].filter(Boolean).join(" · ");

  return { heading: "My Work", summary, html: html.join(""), text: text.join("\n"), deepLink: DEEP_LINK, linkLabel: "My Work" };
}

export const myWorkKind: NotificationKind<DB> = {
  id: "my_work",
  label: "My Work",
  description: "Your merged PRs and the issues assigned to you.",
  defaultCadence: "daily",
  allowedCadences: ["daily", "weekly", "off"],
  render,
};
