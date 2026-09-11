import type { PersonRow } from "@shared/rows";
import type { NotificationKind, Section, Window } from "@shared/notifications";
import { type DB, all, first } from "../../db";
import { listOpenAssignedIssues, toMyWorkPr, type PrEventJoinRow } from "../../tools/mywork";
import { escapeHtml, isoOf } from "../html";

const DEEP_LINK = "/#mywork";

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
    html.push(`<h3>Merged</h3><ul>`);
    text.push("Merged:");
    for (const pr of merged) {
      const title = pr.displayTitle ?? pr.title;
      const what = pr.what ?? "No summary recorded";
      html.push(
        `<li><a href="${escapeHtml(pr.url)}">#${pr.number} ${escapeHtml(title)}</a> — ${escapeHtml(what)}` +
          (pr.impact ? ` <em>${escapeHtml(pr.impact)}</em>` : "") +
          `</li>`
      );
      text.push(`- #${pr.number} ${title}: ${what}${pr.impact ? ` (${pr.impact})` : ""} ${pr.url}`);
    }
    html.push(`</ul>`);
  }

  if (todo.length) {
    html.push(`<h3>Open issues</h3><ul>`);
    if (merged.length) text.push("");
    text.push("Open issues:");
    for (const issue of todo) {
      const title = issue.displayTitle ?? issue.title;
      const prio = issue.priority ? `[${issue.priority}] ` : "";
      html.push(
        `<li>${escapeHtml(prio)}<a href="${escapeHtml(issue.url)}">#${issue.number} ${escapeHtml(title)}</a>` +
          (issue.nextStep ? ` — ${escapeHtml(issue.nextStep)}` : "") +
          `</li>`
      );
      text.push(`- ${prio}#${issue.number} ${title}${issue.nextStep ? `: ${issue.nextStep}` : ""} ${issue.url}`);
    }
    html.push(`</ul>`);
  }

  return { heading: "My Work", html: html.join(""), text: text.join("\n"), deepLink: DEEP_LINK };
}

export const myWorkKind: NotificationKind<DB> = {
  id: "my_work",
  label: "My Work",
  description: "Your merged PRs in the window and your open assigned issues.",
  defaultCadence: "daily",
  allowedCadences: ["daily", "weekly", "off"],
  render,
};
