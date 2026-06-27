// DTOs for the personal "My Work" dashboard. Lives in shared/ (the only cross-layer
// location) so the Worker (src/) and the web build (web/) agree on the shape.
import type { FeedRow } from "./rows";

export interface RoadmapPhase {
  title: string;          // e.g. "Weeks 3–4"
  window: string | null;  // raw parenthetical, e.g. "~2026-06-22 → 2026-07-05"
  bullet: string;         // the person's cleaned bullet text
  issueRefs: number[];    // GitHub issue numbers mentioned, in order
}

export interface AssignedIssue {
  number: number;
  title: string;                          // priority tag stripped
  priority: "P0" | "P1" | "P2" | "P3" | null;
  labels: string[];
  url: string;
  updatedAt: string;
}

export interface Focus {
  workingOn: string;
  nextUp: string | null;
  updatedAt: string;      // ISO
}

export interface DashboardData {
  person: string | null;        // mapped roadmap name; null if unmapped
  role: string | null;          // from Team & Responsibilities
  owns: string | null;          // from Team & Responsibilities ("Owns" column)
  focus: Focus | null;          // self-reported headline; null until first set
  workingNow: RoadmapPhase | null;   // roadmap "now" (context / headline fallback)
  comingUp: RoadmapPhase[];          // roadmap upcoming phases
  assignedIssues: AssignedIssue[];
  feed: FeedRow[];              // capped (~8) most-recent
  degraded: boolean;           // GitHub-derived data unavailable (no/expired token)
}
