// DTOs for the personal "My Work" dashboard: two explicitly separate lists off
// the captured-event stream. Lives in shared/ (the only cross-layer location) so
// the Worker (src/) and the web build (web/) agree on the shape.

export interface MyWorkPr {
  number: number;
  title: string;
  url: string;
  merged: boolean;
  occurredAt: string;
  summary: string | null;
}

export interface MyWorkTodo {
  number: number;
  title: string;
  priority: "P0" | "P1" | "P2" | "P3" | null;
  labels: string[];
  url: string;
  updatedAt: string;
}

export interface DashboardData {
  person: string | null; // identity-mapped name; null if unmapped
  previousActivity: MyWorkPr[]; // summarized merged/closed PRs, 5 most recent
  todo: MyWorkTodo[]; // open issues assigned to the person
  degraded: boolean; // D1 projection unavailable
}
