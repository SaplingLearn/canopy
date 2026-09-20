// Service-token reads of the GitHub API for the repo dashboard. NEVER on the
// render path: called from the webhook handler (event-triggered) and scheduled().
import type { DB } from "../db";
import { first } from "../db";
import { ingestRepoEvent } from "../consumer";
import type { RepoEnvConfig } from "./config";
import type { RepoEvent } from "./types";

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

export async function reconcileRepo(db: DB, opts: GhOpts, envs: RepoEnvConfig[], now: number = Date.now()): Promise<{ written: number; unchanged: number }> {
  const out = { written: 0, unchanged: 0 };
  const take = async (events: RepoEvent[]) => {
    for (const ev of events) {
      const res = await ingestRepoEvent(db, ev);
      if (res.outcome === "written") out.written++; else out.unchanged++;
    }
  };
  // Each list is independent: one failing must not starve the others.
  const safely = async (fn: () => Promise<void>) => { try { await fn(); } catch (e) { console.error("reconcileRepo", e); } };

  await safely(async () => take((await ghJson<GhPull[]>(opts, `/pulls?state=open&sort=updated&direction=desc&per_page=100`)).map(prEvent)));
  await safely(async () => take((await ghJson<GhPull[]>(opts, `/pulls?state=closed&sort=updated&direction=desc&per_page=50`)).map(prEvent)));

  // Commits on the default environment branch, ONLY for the stretch before push
  // capture began — a backfilled commit is a count-1 push, and overlapping a real
  // push (count N, same head sha) would shadow it.
  await safely(async () => {
    const branch = envs[0]?.branch ?? "main";
    const earliest = await first<{ at: string }>(db, `SELECT MIN(occurred_at) AS at FROM repo_events WHERE kind = 'push' AND provenance = 'webhook'`);
    const since = new Date(now - 14 * DAY).toISOString();
    const until = earliest?.at ?? new Date(now).toISOString();
    if (until <= since) return;
    const commits = await ghJson<GhCommit[]>(opts, `/commits?sha=${encodeURIComponent(branch)}&since=${since}&until=${until}&per_page=100`);
    await take(commits.map((c): RepoEvent => ({
      semantic_key: `gh:push:${c.sha}:${branch}`, kind: "push", ref: branch, sha: c.sha, actor_login: c.author?.login ?? null,
      count: 1, title: c.commit.message.split("\n")[0].slice(0, 200), raw: JSON.stringify({ backfill: true }),
      provenance: "backfill", occurred_at: c.commit.committer.date,
    })));
  });

  return out;
}
