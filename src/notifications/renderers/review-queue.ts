import type { NotificationKind, Section } from "@shared/notifications";
import type { DB } from "../../db";
import { list_proposals, list_adrs } from "../../tools/reads";
import { escapeHtml } from "../html";
import { EMAIL_STYLE as S } from "../assemble";

const DEEP_LINK = "/#review";
const TOP = 5;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * review_queue — what is waiting for a human: open Proposals (staged doc
 * versions newer than the live doc) and Decisions (draft ADRs). Org-wide, so
 * the userId is not consulted. Null when both queues are empty.
 */
async function render(db: DB): Promise<Section | null> {
  const proposals = await list_proposals(db);
  const decisions = await list_adrs(db, "draft");
  if (proposals.length === 0 && decisions.length === 0) return null;

  const lines: { main: string; meta: string }[] = [
    ...proposals.slice(0, TOP).map((p) => ({
      main: `${cap(p.section)} / ${p.title} — ${p.summary ?? `${p.change_kind ?? "edit"} v${p.version}`}`,
      meta: `(${p.author}${p.confidence ? `, ${p.confidence} confidence` : ""})`,
    })),
    ...decisions.slice(0, TOP).map((d) => ({ main: `ADR-${String(d.id).padStart(3, "0")} — ${d.title}, ready to ratify`, meta: `(${d.created_by})` })),
  ];

  const html =
    `<table ${S.table} style="margin-top:12px;">` +
    lines.map((l) => `<tr><td style="${S.body}line-height:1.6;padding:3px 0;">${escapeHtml(l.main)} <span style="color:#8a8a8a;">${escapeHtml(l.meta)}</span></td></tr>`).join("") +
    `</table>`;
  const text = lines.map((l) => `  ${l.main} ${l.meta}`).join("\n");
  const parts = [proposals.length ? plural(proposals.length, "proposal", "proposals") : null, decisions.length ? plural(decisions.length, "decision", "decisions") : null].filter(Boolean);
  const summary = `${parts.join(", ")} waiting on review`;

  return { heading: "Review queue", summary, html, text, deepLink: DEEP_LINK, linkLabel: "Review" };
}

export const reviewQueueKind: NotificationKind<DB> = {
  id: "review_queue",
  label: "Review queue",
  description: "What is waiting on your review in Triage.",
  defaultCadence: "daily",
  allowedCadences: ["daily", "off"],
  render,
};
