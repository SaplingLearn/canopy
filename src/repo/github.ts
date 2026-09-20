// Service-token reads of the GitHub API for the repo dashboard. NEVER on the
// render path: called from the webhook handler (event-triggered) and scheduled().
import type { DB } from "../db";
import { first, run } from "../db";
import { ingestRepoEvent } from "../consumer";
import { putSnapshot } from "./store";
import type { RepoEnvConfig } from "./config";
import type { RepoEvent } from "./types";
import { repoEventsFromDelivery } from "./capture";

/** At most this many `.../jobs` lookups per `reconcileRepo` call, so a first
 *  Sync over 100 backfilled runs cannot fan out into 100 extra API calls. */
const MAX_JOB_LOOKUPS = 5;

export interface GhOpts { token: string; repo: string; fetchImpl?: typeof fetch }

const DAY = 86_400_000;
const HEADERS = (token: string) => ({ authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "canopy-worker" });

export async function ghJson<T>(opts: GhOpts, path: string): Promise<T> {
  const res = await (opts.fetchImpl ?? fetch)(`https://api.github.com/repos/${opts.repo}${path}`, { headers: HEADERS(opts.token) });
  if (!res.ok) throw new Error(`github ${res.status} ${path}`);
  return (await res.json()) as T;
}

interface GhPull { number: number; title: string; html_url: string; state: string; draft: boolean; merged_at: string | null; updated_at: string; user: { login: string }; head: { ref: string; sha: string }; base: { ref: string } }
interface GhCommit { sha: string; commit: { message: string; committer: { date: string } }; author: { login: string } | null }

const prEvent = (pr: GhPull): RepoEvent => ({
  semantic_key: `gh:prs:${pr.number}:backfill:${pr.updated_at}`,
  kind: "pr", number: pr.number,
  state: pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "review",
  ref: pr.head.ref, sha: pr.head.sha, actor_login: pr.user.login, title: pr.title.slice(0, 300), url: pr.html_url,
  raw: JSON.stringify({ action: "backfill", base: pr.base.ref, draft: pr.draft }),
  provenance: "backfill", occurred_at: pr.merged_at ?? pr.updated_at,
});

/** The same shape/key scheme `reconcileRepo`'s pre-capture commit backfill has
 *  always used (`gh:push:<sha>:<branch>`, `count: 1`, `provenance: "backfill"`),
 *  factored out so the per-environment-head backfill below can reuse it. */
const commitToPushEvent = (c: GhCommit, branch: string): RepoEvent => ({
  semantic_key: `gh:push:${c.sha}:${branch}`, kind: "push", ref: branch, sha: c.sha, actor_login: c.author?.login ?? null,
  count: 1, title: c.commit.message.split("\n")[0].slice(0, 200), raw: JSON.stringify({ backfill: true }),
  provenance: "backfill", occurred_at: c.commit.committer.date,
});

export async function reconcileRepo(db: DB, opts: GhOpts, envs: RepoEnvConfig[], now: number = Date.now()): Promise<{ written: number; unchanged: number }> {
  const out = { written: 0, unchanged: 0 };
  /** Ingests each event through the gate and returns the ones NEWLY WRITTEN
   *  (not `unchanged`) — used by the workflow-run arm to decide which runs are
   *  worth a failing-job lookup. */
  const take = async (events: RepoEvent[]): Promise<RepoEvent[]> => {
    const written: RepoEvent[] = [];
    for (const ev of events) {
      const res = await ingestRepoEvent(db, ev);
      if (res.outcome === "written") { out.written++; written.push(ev); } else out.unchanged++;
    }
    return written;
  };
  // Each list is independent: one failing must not starve the others.
  const safely = async (fn: () => Promise<void>) => { try { await fn(); } catch (e) { console.error("reconcileRepo", e); } };

  // The completeness marker: written only after the OPEN-PR list has been both
  // fetched AND ingested without throwing. `prCaptured` in src/tools/repo.ts
  // gates on THIS snapshot, not on "any pr row exists" — a lone webhook
  // delivery (the first `pull_request` after deploy) must not make the
  // Overview claim a complete open-PR count. A marker (not `provenance =
  // 'backfill'`) because a repo with zero open PRs would otherwise never earn
  // one.
  await safely(async () => {
    const openPrs = await ghJson<GhPull[]>(opts, `/pulls?state=open&sort=updated&direction=desc&per_page=100`);
    await take(openPrs.map(prEvent));
    await putSnapshot(db, "prs_reconciled", { at: new Date(now).toISOString() }, new Date(now).toISOString());
  });
  await safely(async () => { await take((await ghJson<GhPull[]>(opts, `/pulls?state=closed&sort=updated&direction=desc&per_page=50`)).map(prEvent)); });

  // Commits on the default environment branch, ONLY for the stretch before push
  // capture began — a backfilled commit is a count-1 push, and overlapping a real
  // push (count N, same head sha) would shadow it. This fills ONLY the
  // pre-capture stretch: it cannot and does not recover a push missed AFTER
  // capture began (a gap from a webhook outage, say) — that stays lost.
  await safely(async () => {
    const branch = envs[0]?.branch ?? "main";
    const earliest = await first<{ at: string }>(db, `SELECT MIN(occurred_at) AS at FROM repo_events WHERE kind = 'push' AND provenance = 'webhook'`);
    const since = new Date(now - 14 * DAY).toISOString();
    const until = earliest?.at ?? new Date(now).toISOString();
    if (until <= since) return;
    const commits = await ghJson<GhCommit[]>(opts, `/commits?sha=${encodeURIComponent(branch)}&since=${since}&until=${until}&per_page=100`);
    await take(commits.map((c) => commitToPushEvent(c, branch)));
  });

  const asBackfill = (events: RepoEvent[]): RepoEvent[] => events.map((e) => ({ ...e, provenance: "backfill" as const }));

  // Deployments: newest 20, each with its statuses (≤ 21 subrequests).
  await safely(async () => {
    const deployments = await ghJson<Record<string, unknown>[]>(opts, `/deployments?per_page=20`);
    for (const deployment of deployments) {
      const statuses = await ghJson<Record<string, unknown>[]>(opts, `/deployments/${deployment.id as number}/statuses?per_page=10`);
      for (const deployment_status of statuses) {
        await take(asBackfill(repoEventsFromDelivery("deployment_status", { deployment_status, deployment }, envs)));
      }
    }
  });

  // Completed workflow runs. A backfilled run that lands failure/timed_out gets
  // the SAME failing-job enrichment a live webhook delivery gets (src/webhook.ts)
  // — but capped (MAX_JOB_LOOKUPS) so a first Sync over 100 runs cannot fan out
  // into 100 extra `.../jobs` calls. Only NEWLY WRITTEN rows count toward the
  // cap and get looked up — a redelivered/unchanged run was already handled
  // (or is not worth a fresh lookup).
  await safely(async () => {
    const { workflow_runs = [] } = await ghJson<{ workflow_runs?: Record<string, unknown>[] }>(opts, `/actions/runs?status=completed&per_page=100`);
    let jobLookups = 0;
    for (const workflow_run of workflow_runs) {
      const written = await take(asBackfill(repoEventsFromDelivery("workflow_run", { action: "completed", workflow_run }, envs)));
      for (const ev of written) {
        if ((ev.state === "failure" || ev.state === "timed_out") && ev.number && jobLookups < MAX_JOB_LOOKUPS) {
          jobLookups++;
          await fillFailedJob(db, opts, ev.number, ev.semantic_key);
        }
      }
    }
  });

  // Each configured environment branch's HEAD — a push row (so a branch pushed
  // rarely, e.g. production, still has a head sha for "CI on head" to key off —
  // `branchHeads` in src/repo/reads.ts only ever reads captured `push` rows) and
  // that head's check runs (also the frontend deploy record: a Workers Builds
  // check IS a deploy, but only on the branch that environment ships from).
  // Independent per environment AND per list, so one branch's failure never
  // starves another's.
  for (const cfg of envs) {
    await safely(async () => {
      const commits = await ghJson<GhCommit[]>(opts, `/commits?sha=${encodeURIComponent(cfg.branch)}&per_page=1`);
      if (commits[0]) await take([commitToPushEvent(commits[0], cfg.branch)]);
    });
    await safely(async () => {
      const { check_runs = [] } = await ghJson<{ check_runs?: Record<string, unknown>[] }>(opts, `/commits/${encodeURIComponent(cfg.branch)}/check-runs?per_page=100`);
      for (const cr of check_runs) {
        if (cr.status !== "completed") continue;
        const check_run = { ...cr, check_suite: { head_branch: cfg.branch } }; // we asked by branch; the list item may omit it
        await take(asBackfill(repoEventsFromDelivery("check_run", { action: "completed", check_run }, envs)));
      }
    });
  }

  return out;
}

interface GhJobs { jobs: { name: string; conclusion: string | null; steps?: { name: string; conclusion: string | null }[] }[] }

/** Enrichment, not capture: the run row already landed. A failure here costs a label, nothing else. */
export async function fillFailedJob(db: DB, opts: GhOpts, runId: number, semanticKey: string): Promise<void> {
  try {
    const { jobs } = await ghJson<GhJobs>(opts, `/actions/runs/${runId}/jobs?filter=latest&per_page=100`);
    const job = jobs.find((j) => j.conclusion === "failure" || j.conclusion === "timed_out");
    if (!job) return;
    const step = job.steps?.find((s) => s.conclusion === "failure")?.name;
    await run(db, `UPDATE repo_events SET title = ? WHERE semantic_key = ?`, step ? `${job.name} · ${step}` : job.name, semanticKey);
  } catch (e) {
    console.error("fillFailedJob", runId, e);
  }
}
