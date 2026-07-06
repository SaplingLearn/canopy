// DTOs for the personal "My Work" dashboard: two explicitly separate lists off
// the captured-event stream. Lives in shared/ (the only cross-layer location) so
// the Worker (src/) and the web build (web/) agree on the shape.

export interface MyWorkPr {
  number: number;
  title: string;
  displayTitle: string | null; // humanized title from the summarizer; render falls back to the raw GitHub title
  url: string;
  merged: boolean;
  occurredAt: string;
  summary: string | null;
  what: string | null; // structured "What changed" (null → render falls back to summary prose)
  why: string | null; // motivation, only when the PR body stated one
  impact: string | null; // plain-language outcome sentence (never a file list)
  baseRef: string | null; // PR base branch (footer "into main" suffix; hidden when null)
}

export interface MyWorkTodo {
  number: number;
  title: string;
  displayTitle: string | null; // humanized title from the summarizer; render falls back to the raw GitHub title
  priority: "P0" | "P1" | "P2" | "P3" | null;
  labels: string[];
  url: string;
  updatedAt: string;
  summary: string | null;
  milestone: { title: string; dueOn: string | null } | null; // issue milestone
  nextStep: string | null; // suggested next step from the summarizer
}

export interface DashboardData {
  person: string | null; // identity-mapped name; null if unmapped
  previousActivity: MyWorkPr[]; // summarized merged/closed PRs, 5 most recent
  todo: MyWorkTodo[]; // open issues assigned to the person
  degraded: boolean; // D1 projection unavailable
}
