import type { PersonRow } from "@shared/rows";
import type { NotificationKind, Section, Window } from "@shared/notifications";
import { type DB, all, first } from "../../db";
import { listOpenAssignedIssues, toMyWorkPr, type PrEventJoinRow } from "../../tools/mywork";
import { escapeHtml, isoOf } from "../html";
import { EMAIL_STYLE as S, EMAIL_CARD as K } from "../assemble";

const DEEP_LINK = "/#mywork";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const pad = (s: string, w: number) => s.padEnd(w);

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Sep 20" from a date-only or ISO string; empty when unparseable. */
function shortDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}` : "";
}
const TOP = 5;

/** A merged PR card, mirroring the app's prActivityCard: title + number pill, What changed / Why / Impact rows, MERGED chip. */
function prCard(pr: ReturnType<typeof toMyWorkPr>): string {
  const rows: string[] = [];
  if (pr.what !== null) {
    rows.push(K.row("What changed", K.prose(escapeHtml(pr.what))));
    if (pr.why) rows.push(K.row("Why", K.prose(escapeHtml(pr.why))));
  } else {
    rows.push(K.row("What changed", "No summary recorded for this PR."));
  }
  if (pr.impact) rows.push(K.row("Impact", K.prose(escapeHtml(pr.impact))));
  const into = pr.baseRef ? `<span style="padding-left:8px;">into <span style="font-family:'Geist Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;">${escapeHtml(pr.baseRef)}</span></span>` : "";
  return K.card(K.title(escapeHtml(pr.displayTitle ?? pr.title), pr.number, escapeHtml(pr.url)) + K.rows(rows) + K.footer(`${K.chip("MERGED", "green")}${into}`));
}

/** An assigned-issue card, mirroring todoCard: Summary / Milestone / Next step rows, priority + label chips. */
function issueCard(i: Awaited<ReturnType<typeof listOpenAssignedIssues>>[number]): string {
  const rows: string[] = [];
  if (i.summary) rows.push(K.row("Summary", K.prose(escapeHtml(i.summary))));
  if (i.milestone) {
    const due = i.milestone.dueOn ? ` <span style="font-size:11.5px;">&middot; due ${escapeHtml(shortDate(i.milestone.dueOn))}</span>` : "";
    rows.push(K.row("Milestone", `${escapeHtml(i.milestone.title)}${due}`));
  }
  if (i.nextStep) rows.push(K.row("Next step", K.prose(escapeHtml(i.nextStep)), "accent"));
  const chips = [
    i.priority ? K.chip(escapeHtml(i.priority), "amber") : "",
    ...i.labels.slice(0, 3).map((l) => K.chip(escapeHtml(l), "muted")),
  ].filter(Boolean).join(" ");
  return K.card(K.title(escapeHtml(i.displayTitle ?? i.title), i.number, escapeHtml(i.url)) + K.rows(rows) + (chips ? K.footer(chips) : ""));
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
    const shown = merged.slice(0, TOP);
    html.push(`<div style="${S.label}padding-top:16px;">MERGED</div>`);
    html.push(shown.map(prCard).join(""));
    if (merged.length > TOP) html.push(`<div style="${S.muted}padding-top:10px;">+${merged.length - TOP} more in My Work</div>`);
    for (const pr of shown) {
      text.push(`  ${pad("merged", 7)} ${pad(`#${pr.number}`, 5)} ${pr.displayTitle ?? pr.title}`);
      if (pr.what) text.push(`  ${pad("", 13)} What changed: ${pr.what}`);
    }
    if (merged.length > TOP) text.push(`  ${pad("", 13)} +${merged.length - TOP} more in My Work`);
  }
  if (todo.length) {
    html.push(`<div style="${S.label}padding-top:${merged.length ? 18 : 16}px;">OPEN &amp; ASSIGNED</div>`);
    html.push(todo.map(issueCard).join(""));
    for (const i of todo) {
      text.push(`  ${pad("open", 7)} ${pad(`#${i.number}`, 5)} ${i.priority ? `[${i.priority}] ` : ""}${i.displayTitle ?? i.title}`);
      if (i.nextStep) text.push(`  ${pad("", 13)} Next step: ${i.nextStep}`);
    }
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
