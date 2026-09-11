import type { MilestoneRow, PlanVersionRow } from "@shared/rows";
import type { NotificationKind, Section, Window } from "@shared/notifications";
import { type DB, first } from "../../db";
import { escapeHtml, isoOf } from "../html";

const DEEP_LINK = "/#roadmap";

// Plan-layer diff between two milestone snapshots. Progress (milestone_progress)
// is not in a snapshot, so a progress-only change can never surface here.
export interface PlanDiffLine {
  kind: "added" | "renamed" | "description" | "reordered" | "done";
  text: string;
}

export function diffMilestones(before: MilestoneRow[], after: MilestoneRow[]): PlanDiffLine[] {
  const lines: PlanDiffLine[] = [];
  const prev = new Map(before.map((m) => [m.id, m]));

  for (const m of after) {
    const old = prev.get(m.id);
    if (!old) {
      lines.push({ kind: "added", text: `Added: ${m.title}` });
      continue;
    }
    if (old.title !== m.title) lines.push({ kind: "renamed", text: `Renamed: ${old.title} → ${m.title}` });
    if ((old.description ?? "") !== (m.description ?? "")) lines.push({ kind: "description", text: `Description changed: ${m.title}` });
    if (old.status !== "done" && m.status === "done") lines.push({ kind: "done", text: `Confirmed done: ${m.title}` });
  }

  // Reorder: the relative order of milestones present in BOTH snapshots changed
  // (snapshots are target_date ASC, id ASC, so a date move shows up here).
  const common = new Set(after.filter((m) => prev.has(m.id)).map((m) => m.id));
  const beforeOrder = before.filter((m) => common.has(m.id)).map((m) => m.id);
  const afterOrder = after.filter((m) => common.has(m.id)).map((m) => m.id);
  const moved = afterOrder.filter((id, i) => beforeOrder[i] !== id);
  if (moved.length) {
    const titles = after.filter((m) => moved.includes(m.id)).map((m) => m.title);
    lines.push({ kind: "reordered", text: `Reordered: ${titles.join(", ")}` });
  }
  return lines;
}

/**
 * roadmap_plan — diff the latest plan version whose created_at falls in the
 * window against the last version BEFORE the window. No version in the window,
 * or no milestone-level change between the two, renders null.
 */
async function render(db: DB, _login: string, window: Window): Promise<Section | null> {
  const start = isoOf(window.start);
  const end = isoOf(window.end);
  const latest = await first<PlanVersionRow>(
    db,
    `SELECT * FROM plan_versions
      WHERE datetime(created_at) >= datetime(?) AND datetime(created_at) < datetime(?)
      ORDER BY version DESC LIMIT 1`,
    start,
    end
  );
  if (!latest) return null;
  const baseline = await first<PlanVersionRow>(
    db,
    `SELECT * FROM plan_versions WHERE datetime(created_at) < datetime(?) ORDER BY version DESC LIMIT 1`,
    start
  );

  const before = baseline ? (JSON.parse(baseline.milestones_json) as MilestoneRow[]) : [];
  const after = JSON.parse(latest.milestones_json) as MilestoneRow[];
  const lines = diffMilestones(before, after);
  if (lines.length === 0) return null;

  const html = `<ul>${lines.map((l) => `<li>${escapeHtml(l.text)}</li>`).join("")}</ul>`;
  const text = lines.map((l) => `- ${l.text}`).join("\n");
  return { heading: "Roadmap plan changes", html, text, deepLink: DEEP_LINK };
}

export const roadmapPlanKind: NotificationKind<DB> = {
  id: "roadmap_plan",
  label: "Roadmap plan",
  description: "Milestones added, renamed, reordered, or confirmed done.",
  defaultCadence: "weekly",
  allowedCadences: ["daily", "weekly", "off"],
  render,
};
