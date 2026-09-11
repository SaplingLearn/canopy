import type { NotificationKind, Section } from "@shared/notifications";
import type { DB } from "../../db";
import { list_proposals, list_adrs } from "../../tools/reads";
import { escapeHtml } from "../html";

const DEEP_LINK = "/#review";
const TOP = 5;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * review_queue — what is waiting for a human: open Proposals (staged doc
 * versions newer than the live doc) and Decisions (draft ADRs). Org-wide, so
 * the userId is not consulted. Null when both queues are empty.
 */
async function render(db: DB): Promise<Section | null> {
  const proposals = await list_proposals(db);
  const decisions = await list_adrs(db, "draft");
  if (proposals.length === 0 && decisions.length === 0) return null;

  const html: string[] = [];
  const text: string[] = [];

  const summary = `${plural(proposals.length, "proposal", "proposals")} and ${plural(decisions.length, "decision", "decisions")} waiting for review.`;
  html.push(`<p>${escapeHtml(summary)}</p>`);
  text.push(summary);

  if (proposals.length) {
    html.push(`<h3>Proposals</h3><ul>`);
    text.push("", "Proposals:");
    for (const p of proposals.slice(0, TOP)) {
      const line = `${p.title} (v${p.version}, ${p.change_kind ?? "edit"} by ${p.author})`;
      html.push(`<li>${escapeHtml(line)}</li>`);
      text.push(`- ${line}`);
    }
    html.push(`</ul>`);
  }
  if (decisions.length) {
    html.push(`<h3>Decisions</h3><ul>`);
    text.push("", "Decisions:");
    for (const d of decisions.slice(0, TOP)) {
      const line = `${d.title} (drafted by ${d.created_by})`;
      html.push(`<li>${escapeHtml(line)}</li>`);
      text.push(`- ${line}`);
    }
    html.push(`</ul>`);
  }

  return { heading: "Review queue", html: html.join(""), text: text.join("\n"), deepLink: DEEP_LINK };
}

export const reviewQueueKind: NotificationKind<DB> = {
  id: "review_queue",
  label: "Review queue",
  description: "Proposals and decisions waiting for a human to confirm.",
  defaultCadence: "daily",
  allowedCadences: ["daily", "off"],
  render,
};
