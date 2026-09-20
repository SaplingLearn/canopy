// PURE: one verified GitHub delivery → the repo events it implies. No DB, no
// clock, no network. Each arm stores a SLICE of the payload in `raw` (enough to
// re-derive the typed columns), never the whole delivery — commit bodies and PR
// descriptions stay out of D1.
import type { RepoEnvConfig } from "./config";
import type { RepoEvent, RepoMetric } from "./types";

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v !== null && typeof v === "object" ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const subject = (message: unknown): string => (str(message) ?? "").split("\n")[0].slice(0, 200);

/** PR actions that change something the dashboard shows (state, head, title). */
const PR_ACTIONS = ["opened", "reopened", "closed", "ready_for_review", "converted_to_draft", "synchronize", "edited"];

function fromPush(p: Obj): RepoEvent[] {
  const ref = str(p.ref);
  if (!ref?.startsWith("refs/heads/") || p.deleted === true) return [];
  const branch = ref.slice("refs/heads/".length);
  const after = str(p.after);
  if (!after) return [];
  const commits = Array.isArray(p.commits) ? p.commits.map(obj).filter((c): c is Obj => c !== null) : [];
  const head = obj(p.head_commit);
  // A push HAPPENED when GitHub says it did (`repository.pushed_at`, unix
  // seconds) — not when its head commit was originally authored. A rebase or
  // cherry-pick carries an old commit timestamp but is pushed just now; using
  // the commit's own timestamp would land it in a stale day bucket.
  const pushedAt = num(obj(p.repository)?.pushed_at);
  // Second-precision, no milliseconds — matches GitHub's own timestamp shape
  // (every other `occurred_at` on this arm comes straight off the payload).
  const at = pushedAt !== null
    ? new Date(pushedAt * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")
    : str(head?.timestamp) ?? str(commits[commits.length - 1]?.timestamp);
  if (!at) return [];
  return [{
    semantic_key: `gh:push:${after}:${branch}`,
    kind: "push", ref: branch, sha: after,
    actor_login: str(obj(p.sender)?.login) ?? str(obj(p.pusher)?.name),
    count: commits.filter((c) => c.distinct === true).length,
    title: subject(head?.message ?? commits[commits.length - 1]?.message),
    url: str(p.compare),
    raw: JSON.stringify({
      before: str(p.before), forced: p.forced === true,
      commits: commits.map((c) => ({ id: str(c.id), distinct: c.distinct === true, subject: subject(c.message), at: str(c.timestamp), author: str(obj(c.author)?.username) })),
    }),
    provenance: "webhook", occurred_at: at,
  }];
}

function fromPullRequest(p: Obj): RepoEvent[] {
  const action = str(p.action);
  const pr = obj(p.pull_request);
  if (!action || !pr || !PR_ACTIONS.includes(action)) return [];
  const number = num(pr.number);
  const at = str(pr.updated_at) ?? str(pr.merged_at) ?? str(pr.closed_at);
  if (number === null || !at) return [];
  const state = pr.merged === true ? "merged" : str(pr.state) === "closed" ? "closed" : pr.draft === true ? "draft" : "review";
  const head = obj(pr.head);
  return [{
    semantic_key: `gh:prs:${number}:${action}:${at}`,
    kind: "pr", number, state, ref: str(head?.ref), sha: str(head?.sha),
    actor_login: str(obj(pr.user)?.login), title: (str(pr.title) ?? "").slice(0, 300), url: str(pr.html_url),
    raw: JSON.stringify({ action, base: str(obj(pr.base)?.ref), draft: pr.draft === true }),
    provenance: "webhook", occurred_at: at,
  }];
}

function fromDeploymentStatus(p: Obj, envs: RepoEnvConfig[]): RepoEvent[] {
  const st = obj(p.deployment_status);
  const dep = obj(p.deployment);
  const id = num(dep?.id);
  const state = str(st?.state);
  const at = str(st?.created_at);
  const ghEnv = str(dep?.environment);
  if (!st || !dep || id === null || !state || !at || !ghEnv) return [];
  const cfg = envs.find((e) => e.railwayEnv === ghEnv);
  if (!cfg) return []; // preview / unknown environment — not one the dashboard reports on
  return [{
    semantic_key: `gh:deploy:${id}:${state}`,
    kind: "deploy", number: id, env: cfg.key, part: "backend", sha: str(dep.sha), state, name: ghEnv,
    actor_login: str(obj(dep.creator)?.login), url: str(st.log_url),
    raw: JSON.stringify({ ref: str(dep.ref), status_id: num(st.id), deployment_created_at: str(dep.created_at) }),
    provenance: "webhook", occurred_at: at,
  }];
}

function fromCheckRun(p: Obj, envs: RepoEnvConfig[]): RepoEvent[] {
  const action = str(p.action);
  const cr = obj(p.check_run);
  if (!cr || (action !== "created" && action !== "completed")) return [];
  const id = num(cr.id);
  const name = str(cr.name);
  const sha = str(cr.head_sha);
  const at = action === "completed" ? str(cr.completed_at) : str(cr.started_at);
  if (id === null || !name || !sha || !at) return [];
  const ref = str(obj(cr.check_suite)?.head_branch);
  // A Workers Builds check is a DEPLOY only on the branch that environment ships from.
  const cfg = envs.find((e) => e.workerCheck === name && e.branch === ref) ?? null;
  return [{
    semantic_key: `gh:check:${id}:${action}`,
    kind: "check", number: id, sha, ref, name,
    state: action === "completed" ? (str(cr.conclusion) ?? "neutral") : "pending",
    env: cfg?.key ?? null, part: cfg ? "frontend" : null, url: str(cr.details_url),
    raw: JSON.stringify({ app: str(obj(cr.app)?.slug), status: str(cr.status) }),
    provenance: "webhook", occurred_at: at,
  }];
}

function fromWorkflowRun(p: Obj): RepoEvent[] {
  const run = obj(p.workflow_run);
  if (!run || str(p.action) !== "completed") return [];
  const id = num(run.id);
  const at = str(run.updated_at);
  if (id === null || !at) return [];
  const attempt = num(run.run_attempt) ?? 1;
  return [{
    semantic_key: `gh:run:${id}:${attempt}`,
    kind: "run", number: id, name: str(run.name), ref: str(run.head_branch), sha: str(run.head_sha),
    state: str(run.conclusion) ?? "neutral", actor_login: str(obj(run.actor)?.login), url: str(run.html_url), count: attempt,
    raw: JSON.stringify({ event: str(run.event), started_at: str(run.run_started_at) }),
    provenance: "webhook", occurred_at: at,
  }];
}

function fromReview(p: Obj): RepoEvent[] {
  const action = str(p.action);
  const review = obj(p.review);
  const number = num(obj(p.pull_request)?.number);
  if (!review || number === null || (action !== "submitted" && action !== "dismissed")) return [];
  const id = num(review.id);
  const at = str(review.submitted_at);
  if (id === null || !at) return [];
  return [{
    semantic_key: `gh:review:${id}:${action}`,
    kind: "review", number, state: action === "dismissed" ? "dismissed" : (str(review.state) ?? "commented").toLowerCase(),
    actor_login: str(obj(review.user)?.login), url: str(review.html_url),
    raw: JSON.stringify({ action }), provenance: "webhook", occurred_at: at,
  }];
}

/** The commit-status contexts the target repo's CI posts (see
 *  `docs/superpowers/specs/2026-09-20-sapling-ci-metrics.md`) — one status per
 *  metric, `description` carrying the number. */
const STATUS_METRICS: Record<string, string> = { "canopy/coverage": "coverage", "canopy/bundle-kb": "bundle_kb", "canopy/todo": "todo_count" };

/** A commit status whose description is a number, posted by the target repo's
 *  CI — a SIBLING derivation to `repoEventsFromDelivery`, not a branch of it:
 *  a `status` delivery produces `RepoMetric`s, never `RepoEvent` rows. Only a
 *  status on the FIRST configured environment's branch counts (today "main";
 *  falls back to "main" when no environment is configured) — a feature
 *  branch's coverage is not the repo's. An unrelated context (Railway's own
 *  deploy statuses, CodeRabbit's review statuses — frequent once the webhook
 *  subscribes to Statuses) is dropped after one cheap map lookup. */
export function metricsFromStatus(payload: unknown, envs: RepoEnvConfig[]): RepoMetric[] {
  const p = obj(payload);
  if (!p) return [];
  const metric = STATUS_METRICS[str(p.context) ?? ""];
  if (!metric) return [];
  const at = str(p.updated_at) ?? str(p.created_at);
  if (!at) return [];
  const value = Number(str(p.description));
  if (!Number.isFinite(value)) return [];
  const branches = Array.isArray(p.branches) ? p.branches.map((b) => str(obj(b)?.name)) : [];
  if (!branches.includes(envs[0]?.branch ?? "main")) return [];
  return [{ metric, env: "", part: "", value, at }];
}

export function repoEventsFromDelivery(eventName: string, payload: unknown, envs: RepoEnvConfig[]): RepoEvent[] {
  const p = obj(payload);
  if (!p) return [];
  switch (eventName) {
    case "push": return fromPush(p);
    case "pull_request": return fromPullRequest(p);
    case "deployment_status": return fromDeploymentStatus(p, envs);
    case "check_run": return fromCheckRun(p, envs);
    case "workflow_run": return fromWorkflowRun(p);
    case "pull_request_review": return fromReview(p);
    default: return [];
  }
}
