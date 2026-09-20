// The Repo dashboard DTO — shared by the Worker (`src/tools/repo.ts`) and the web
// build (`web/src/repo.ts`). Zod-free on purpose: the SPA imports REPO_TABS as a
// VALUE, and the browser bundle never drags zod in (see the `*-core.ts` rule).
//
// Every section travels as a `RepoSection<T>` so the screen can tell "nothing
// happened" (`empty`) from "Canopy has no capture path for this yet"
// (`not_connected`). The projection is D1-only; anything it cannot read from D1
// is `not_connected`, never guessed.

import type { PersonColor } from "./rows";

export const REPO_TABS = [
  ["overview", "Overview"],
  ["code", "Code"],
  ["ci", "CI & Deploys"],
  ["usage", "Usage"],
  ["planning", "Team & Planning"],
] as const;
export type RepoTab = (typeof REPO_TABS)[number][0];
export const isRepoTab = (v: string): v is RepoTab => REPO_TABS.some(([k]) => k === v);

export const REPO_RANGES = ["24h", "7d", "30d"] as const;
export type RepoRange = (typeof REPO_RANGES)[number];

export type RepoSection<T> =
  | { status: "ok"; data: T }
  | { status: "empty" }
  | { status: "not_connected" };

/** Status colors carry meaning only: good = green, warn = amber, bad = red. */
export type RepoTone = "neutral" | "good" | "warn" | "bad";

/** A GitHub login, resolved to a person when the github identity is mapped. */
export interface RepoPerson {
  login: string;
  handle: string | null;
  name: string | null;
  color: PersonColor | null;
}

// ── Overview ────────────────────────────────────────────────────────────────
export interface RepoEnv {
  name: string;
  /** e.g. "production" beside `main`. */
  note: string | null;
  tone: RepoTone;
  pill: string;
  sha: string;
  deployedAt: string;
  deployedBy: string;
  ci: string;
  url: string;
}
export interface RepoDriftCommit { sha: string; msg: string; at: string }
export interface RepoDriftGroup {
  /** "#482", or the two non-PR buckets "PUSH" / "BEHIND". */
  tag: string;
  kind: "pr" | "push" | "behind";
  title: string;
  meta: string;
  commits: RepoDriftCommit[];
}
export interface RepoDrift { head: string; base: string; ahead: number; behind: number; groups: RepoDriftGroup[] }
export interface RepoStat { label: string; value: number; delta: number; tone: RepoTone }
export interface RepoHealth { env: string; url: string; up: boolean; ms: number }

// ── Code ────────────────────────────────────────────────────────────────────
export interface RepoCodeStat { label: string; value: number; sub: string; tone: RepoTone }
export interface RepoBars { title: string; note: string; days: { date: string; count: number }[] }
export type RepoPrState = "draft" | "review" | "approved" | "merged" | "closed";
export interface RepoPr {
  number: number;
  title: string;
  url: string;
  author: RepoPerson;
  /** The head branch when known, else `→ <base>` from the captured base ref. */
  branch: string | null;
  state: RepoPrState;
  /** Absent when no check data is captured — the column then renders nothing. */
  checks: "pass" | "fail" | "run" | null;
  at: string;
}
export interface RepoBranch { name: string; at: string; ahead: number; behind: number; stale: boolean }
export interface RepoBranches { active: number; stale: number; rows: RepoBranch[] }

// ── CI & Deploys ────────────────────────────────────────────────────────────
export interface RepoDeploy { sha: string; at: string; by: string; result: "ok" | "fail" | "cancel" }
export interface RepoDeployRow { env: string; deploys: RepoDeploy[] }
export interface RepoCiFailure { workflow: string; branch: string; job: string; at: string; url: string }
export interface RepoCiFailures { rate: number; trend: number[]; rows: RepoCiFailure[] }
export interface RepoTrend { value: string; trend: number[]; delta: string; tone: RepoTone; note: string }
export type RepoActivityKind = "push" | "merge" | "deploy" | "issue" | "close" | "release" | "review";
export interface RepoActivity {
  kind: RepoActivityKind;
  /** Null when the capture does not say who acted (an issue closing, a PR merging). */
  actor: RepoPerson | null;
  text: string;
  url: string | null;
  at: string;
}

// ── Usage ───────────────────────────────────────────────────────────────────
export interface RepoUsageEnv {
  name: string;
  host: string;
  requests: string; requestsTrend: number[];
  errorRate: number; errorTrend: number[]; errorTone: RepoTone;
  users: string; usersTrend: number[];
}
export interface RepoCfRow { env: string; label: string; value: string }
export interface RepoHosting { env: string; cpu: string; memory: string }

// ── Team & Planning ─────────────────────────────────────────────────────────
export interface RepoSprint {
  id: number;
  label: string;
  due: string | null;
  closed: number;
  total: number;
  pct: number;
}
export interface RepoContributor { person: RepoPerson; merged: number; closed: number }
export interface RepoLabels { total: number; rows: { name: string; count: number }[] }
export interface RepoTodos { count: number; delta: number; since: string; trend: number[] }

export interface RepoDashboard {
  /** `GITHUB_REPO`, e.g. "SaplingLearn/sapling". */
  repo: string;
  generatedAt: string;
  /** True when a D1 read failed and the sections fell back to `empty`. */
  degraded: boolean;
  /** True only for the client-side sample set — never sent by the Worker. */
  sample?: boolean;

  environments: RepoSection<RepoEnv[]>;
  drift: RepoSection<RepoDrift>;
  stats: RepoSection<RepoStat[]>;
  health: RepoSection<RepoHealth[]>;

  codeStats: RepoSection<RepoCodeStat[]>;
  bars: RepoSection<RepoBars>;
  prs: RepoSection<RepoPr[]>;
  branches: RepoSection<RepoBranches>;

  deploys: RepoSection<RepoDeployRow[]>;
  ciFailures: RepoSection<RepoCiFailures>;
  coverage: RepoSection<RepoTrend>;
  bundle: RepoSection<RepoTrend>;
  activity: RepoSection<RepoActivity[]>;

  usage: RepoSection<Record<RepoRange, RepoUsageEnv[]>>;
  cloudflare: RepoSection<Record<RepoRange, RepoCfRow[]>>;
  hosting: RepoSection<RepoHosting[]>;

  sprint: RepoSection<RepoSprint>;
  contributors: RepoSection<RepoContributor[]>;
  labels: RepoSection<RepoLabels>;
  todos: RepoSection<RepoTodos>;
}
