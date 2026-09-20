// PURE: one verified GitHub delivery → the repo events it implies. No DB, no
// clock, no network. Each arm stores a SLICE of the payload in `raw` (enough to
// re-derive the typed columns), never the whole delivery — commit bodies and PR
// descriptions stay out of D1.
import type { RepoEnvConfig } from "./config";
import type { RepoEvent } from "./types";

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
  const at = str(head?.timestamp) ?? str(commits[commits.length - 1]?.timestamp);
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

export function repoEventsFromDelivery(eventName: string, payload: unknown, _envs: RepoEnvConfig[]): RepoEvent[] {
  const p = obj(payload);
  if (!p) return [];
  switch (eventName) {
    case "push": return fromPush(p);
    case "pull_request": return fromPullRequest(p);
    default: return [];
  }
}
