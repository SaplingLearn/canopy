# Repo Dashboard Capture — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `GET /repo/dashboard` return real data for every section the Repo dashboard already renders, by capturing what GitHub, Railway, Cloudflare and Sapling expose into D1 and projecting from there.

**Architecture:** Three new D1 tables — `repo_events` (append-only webhook/backfill capture, deduped by a UNIQUE semantic key), `repo_snapshots` (expensive computed results: drift, branches), `repo_metrics` (time series: health, coverage, usage). Capture enters through ONE new gate function (`ingestRepoEvent` in `src/consumer.ts`) fed by the existing HMAC webhook; polling runs off the existing `scheduled()` handler. The dashboard stays a D1-only read: **nothing live is fetched at render**, and a section with no rows yet stays `not_connected` / `empty` exactly as today.

**Tech Stack:** Cloudflare Workers + D1, Hono, TypeScript, Vitest on Miniflare D1. No new dependencies.

**Spec:** No separate spec file exists — the audit was done in conversation on 2026-09-20. Its verified findings are reproduced in "Spec (inline)" below and are the contract this plan argues from. The frontend it feeds is PR #53 (`web/src/repo.ts`, DTO in `shared/repo.ts`).

## Global Constraints

- **No live GitHub / Cloudflare / Railway call on the render path.** `getRepoDashboard` reads D1 only. External reads happen in the webhook handler (event-triggered) or `scheduled()`.
- **Never guess.** A section with no captured rows returns `{status:"not_connected"}` (no capture has ever landed) or `{status:"empty"}` (capture works, nothing in window). Never a fabricated value.
- **Do not write repo telemetry to the `events` table.** `events` drives My Work and identity intake — `ingestEvent` raises an `identity_tasks` row per login, which is wrong for `railway-app[bot]` and for ~150 CI events/week. PR-close and issue capture into `events` stays byte-for-byte unchanged.
- **Ingestion goes through the gate.** New capture = a new per-type gate function in `src/consumer.ts` (CLAUDE.md: "add it to the gate — never a second ingestion surface").
- **Auth: no fourth class.** Everything arrives via the existing HMAC webhook class or is pulled by `scheduled()`. No new inbound endpoint.
- **GitHub/HTTP I/O is dependency-injected** (`fetchImpl?: typeof fetch`). Tests stub at the `Response` level and never hit the network.
- **Tests assert on D1 rows**, real Miniflare D1, never mocks of the store.
- **Cron triggers stay at three.** Replace `0 */6 * * *` with `*/10 * * * *` and gate work by minute/hour in code. Cloudflare weekday fields are `1-7`/`SUN-SAT`, never `0`; a bad cron fails the deploy AFTER the Worker uploads.
- **A push to `main` auto-deploys prod.** Each phase is one PR; apply its migration to prod (`npm run db:migrate:remote`, needs `CLOUDFLARE_ACCOUNT_ID`) BEFORE merging.
- New web tests must be listed in BOTH `tsconfig.worker.json` `exclude` and `tsconfig.web.json` `include`.
- `npm run typecheck` does not run inside `npm test` — run both. One `summarize.test.ts` failure is environmental when `GEMINI_API_KEY` is in `.dev.vars`.
- Commit messages: imperative sentence, body explains why; end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Spec (inline) — verified facts about `SaplingLearn/sapling` (2026-09-20)

| Fact | Evidence |
| --- | --- |
| **staging env deploys from `main`; production env deploys from `production`.** The `staging` git branch is dead (283 behind). | Railway deployment SHAs equal those branch heads. |
| Drift that matters is `production...main` (5 ahead, 1 behind). | `GET /compare/production...main` |
| **Backend = Railway.** Posts GitHub Deployments as `railway-app[bot]`, environments `Sapling / staging` and `Sapling / production`, statuses `in_progress → success → inactive`. | `GET /deployments`, `/deployments/:id/statuses` |
| **Frontend = Cloudflare Workers Builds.** Posts NO GitHub deployment — only check runs from app `cloudflare-workers-and-pages`, named `Workers Builds: frontend-staging` / `Workers Builds: frontend`. The staging build also runs on non-`main` branches, so a frontend *deploy* = that check **on the env's branch**. | `GET /commits/:ref/check-runs` |
| Webhook to `canopy.saplinglearn.com/webhook/github` already subscribes to `issues,pull_request,push`. `push` and non-`closed` PR actions are delivered and dropped (`src/webhook.ts:308`). | `GET /hooks` |
| CI: 144 runs/week across CI, e2e, Evals, integration, Migrate, CodeQL. 8 check runs per `main` head, 2 from third-party apps. | `GET /actions/runs`, check-runs |
| CI measures **no coverage and no bundle size** (`pytest` without `--cov`; frontend is built by Cloudflare, not CI). | `.github/workflows/ci.yml` |
| Health route is **`/api/health`** (`/health` is 404). Frontends: `https://saplinglearn.com`, `https://staging.saplinglearn.com`. APIs: `https://api.saplinglearn.com`, `https://api.staging.saplinglearn.com`. | probed |
| 73 branches. No releases. GitHub milestones are dead → Canopy's active sprint is the right "current milestone". | `GET /branches`, `/releases`, `/milestones` |
| Railway project `3f90b930-b996-4cea-ad06-daa046de18b6`; environment ids `76bb36e5-cf12-4b1e-b47f-d276a56c3b85` (staging), `dd058398-45bc-4c7d-80b1-12d46e3f28fb` (production). Service id: read it from the Railway dashboard. | deployment `environment_url` |

### Source → feature map

| # | Source | Arrives by | Feeds |
| --- | --- | --- | --- |
| A | `pull_request` (all actions) | webhook, already subscribed | Open PRs + Awaiting review tiles, PR list states + head branch, feed |
| B | `push` | webhook, already subscribed | Commits tile, 14-day bars, feed, contributor pushes, per-branch last commit, env-branch head SHA |
| C | `pull_request_review` | webhook, **new subscription** | APPROVED chip, contributor reviews, feed |
| D | `deployment_status` | webhook, **new subscription** | backend deploy dots, env card backend line, feed |
| E | `check_run` | webhook, **new subscription** | frontend deploys, "CI on head N of M", PR checks icon |
| F | `workflow_run` (+1 jobs lookup per failure) | webhook, **new subscription** + service token | CI failures list, 7-day failure rate |
| G | compare API | on push to an env branch, service token | drift strip |
| H | GraphQL refs | 6-hourly cron, service token | branches list, Active branches tile |
| I | HTTP pings | 10-minute cron | health block, HEALTHY/DEGRADED pills |
| J | `status` events carrying numbers from Sapling CI | webhook, **new subscription** + Sapling CI steps | coverage, bundle size, TODO/FIXME |
| K | Cloudflare GraphQL analytics | hourly cron, **new secret** | frontend requests + error rate, Cloudflare panel |
| L | Railway GraphQL metrics | hourly cron, **new secret** | hosting CPU + memory |
| M | Sapling `/api/internal/metrics` | hourly cron, **Sapling must build it** | active users |

### Decisions taken (owner confirmed the audit; these are its recommendations)

1. Environments are labelled truthfully: **`staging`** (note `main`) and **`production`** (note `production`). Drift reads "main is N ahead, M behind production".
2. Each env card shows **two deployables** — `Backend · Railway` and `Frontend · Cloudflare` — and CI & Deploys shows two dot rows per environment.
3. "Deployed by" resolves the bot to the human who pushed that SHA; falls back to the bot login.
4. The D1 row is dropped (Sapling uses Supabase). The Cloudflare panel is Workers requests + errors for the two frontend Workers.
5. CI metrics travel as **commit statuses** (`canopy/coverage`, `canopy/bundle-kb`, `canopy/todo`) through the existing HMAC class.
6. Overview tiles return to the design's four: Open PRs · Awaiting review · Open issues · Open bugs.

### External prerequisites (owner actions, not code)

- [ ] **Before Phase 2 merges:** on `SaplingLearn/sapling` → Settings → Webhooks → the Canopy hook → add events **Deployment statuses, Check runs, Workflow runs, Pull request reviews, Statuses**.
- [ ] **Before Phase 3 merges:** confirm `GITHUB_SERVICE_TOKEN` can read the repo's contents/actions (it already reads issues + PRs).
- [ ] **Phase 4:** merge the CI-steps PR into `SaplingLearn/sapling` (YAML is in Task 14).
- [ ] **Phase 5:** `wrangler secret put CF_ANALYTICS_TOKEN` (Cloudflare custom token, Account → Account Analytics → Read, on the account that hosts the `frontend` / `frontend-staging` Workers), `RAILWAY_TOKEN_STAGING` + `RAILWAY_TOKEN_PRODUCTION` (Railway PROJECT tokens, one per environment, from the project's Settings → Tokens; sent as `Project-Access-Token`, see Task 17's amendment), `SAPLING_METRICS_TOKEN` (a random string, also set on the Sapling backend); `CF_ANALYTICS_ACCOUNT_ID` is NOT a secret — it goes in `wrangler.toml` `[vars]`. **Deliberately NOT named `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`: those are the env vars the wrangler CLI itself authenticates with, and an analytics-read token under that name in a shell or CI would break deploys.** add the Railway service id to `REPO_ENVIRONMENTS`; ship the Sapling metrics endpoint.

## File Structure

```
migrations/0027_repo_capture.sql      repo_events / repo_snapshots / repo_metrics
src/repo/config.ts                    REPO_ENVIRONMENTS → RepoEnvConfig[]          (pure)
src/repo/types.ts                     RepoEvent / RepoEventRow / RepoMetric
src/repo/capture.ts                   delivery → RepoEvent[] / RepoMetric[]        (pure)
src/repo/store.ts                     snapshots + metrics + prune                  (D1)
src/repo/github.ts                    service-token reads: jobs, compare, refs, backfill lists
src/repo/poll.ts                      health pings, Cloudflare, Railway, Sapling metrics
src/repo/cron.ts                      REPO_CRON + the minute/hour dispatcher
src/repo/reads.ts                     every SELECT over the three tables
src/consumer.ts                       + ingestRepoEvent (THE gate fn)
src/webhook.ts                        route verified deliveries to BOTH capture paths
src/tools/repo.ts                     assemble RepoDashboard from events + src/repo/reads
src/tools/backfill.ts                 + repo backfill batch
src/index.ts, src/env.ts, wrangler.toml, vitest.config.ts, scripts/seed/reset.mjs
shared/repo.ts, web/src/repo.ts, web/src/repo-sample.ts   DTO deltas (two deployables, contributor columns)
```

`src/repo/` is new: capture, polling and reads for one feature live together; `src/tools/repo.ts` stays the single assembler the route calls.

---

# Phase 1 — Foundation + the events already arriving (sources A, B)

Ships alone. Needs no GitHub settings change and no secret. Lights up: Open PRs / Awaiting review tiles, PR list with open PRs and real head branches, Commits tile, 14-day commit bars, pushes in the feed, contributor push counts.

### Task 1: Schema, config, store and the gate function

**Files:**
- Create: `migrations/0027_repo_capture.sql`, `src/repo/types.ts`, `src/repo/config.ts`, `src/repo/store.ts`
- Modify: `src/consumer.ts` (append `ingestRepoEvent`), `src/env.ts`, `wrangler.toml` (`[vars]`), `vitest.config.ts` (bindings), `scripts/seed/reset.mjs`
- Test: `test/repo-capture.store.test.ts`

**Interfaces:**
- Produces:
  - `RepoEnvConfig { key; label; note: string|null; branch; railwayEnv; worker; workerCheck; frontendUrl; apiUrl; healthPath; railwayEnvironmentId?: string; railwayServiceId?: string }`
  - `repoEnvironments(env: { REPO_ENVIRONMENTS?: string }): RepoEnvConfig[]` — `[]` on absent/malformed (never throws)
  - `RepoEvent`, `RepoEventRow`, `RepoEventKind = "push"|"pr"|"review"|"deploy"|"check"|"run"`, `RepoMetric { metric; env: string; part: string; value: number; at: string }`
  - `ingestRepoEvent(db: DB, ev: RepoEvent): Promise<{ outcome: "written" | "unchanged" }>`
  - `putSnapshot(db, kind: string, data: unknown, now?: string): Promise<void>`, `getSnapshot<T>(db, kind): Promise<{ data: T; computedAt: string } | null>`
  - `putMetric(db, m: RepoMetric): Promise<void>`, `metricSeries(db, metric, env, part, sinceIso): Promise<{ at: string; value: number }[]>`, `latestMetric(db, metric, env, part): Promise<{ at: string; value: number } | null>`
  - `pruneRepoCapture(db, now: number): Promise<void>`

- [ ] **Step 1: Write the migration**

`migrations/0027_repo_capture.sql`:

```sql
-- Repo dashboard capture (docs/superpowers/plans/2026-09-20-repo-dashboard-capture.md).
-- Deliberately NOT the `events` table: that one drives My Work and raises an
-- identity task per login; this is high-volume repo telemetry, much of it by bots.

-- Append-only. One row per captured fact; typed columns so reads never parse JSON.
--   push   : ref=branch sha=after actor_login=pusher count=distinct commits title=head commit subject url=compare
--   pr     : number state=draft|review|merged|closed ref=head branch sha=head sha actor_login=author title url
--   review : number state=approved|changes_requested|commented|dismissed actor_login=reviewer url
--   deploy : number=deployment id env part='backend' sha state=<github status> name=<github environment> actor_login url=log
--   check  : number=check_run id sha ref=head branch name state=pending|<conclusion> env/part set for a frontend deploy url
--   run    : number=run id name=workflow ref sha state=<conclusion> actor_login url title=failing job · step count=attempt
CREATE TABLE repo_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  semantic_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('push','pr','review','deploy','check','run')),
  ref TEXT,
  sha TEXT,
  number INTEGER,
  env TEXT,
  part TEXT CHECK (part IS NULL OR part IN ('backend','frontend')),
  state TEXT,
  name TEXT,
  actor_login TEXT,
  title TEXT,
  url TEXT,
  count INTEGER,
  raw TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('webhook','backfill')),
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX idx_repo_events_kind_at ON repo_events(kind, occurred_at);
CREATE INDEX idx_repo_events_kind_number ON repo_events(kind, number, occurred_at);
CREATE INDEX idx_repo_events_kind_sha ON repo_events(kind, sha);
CREATE INDEX idx_repo_events_kind_ref ON repo_events(kind, ref, occurred_at);
CREATE INDEX idx_repo_events_deploys ON repo_events(kind, env, part, occurred_at);

-- One row per computed result (drift, branches): costly to compute, cheap to read.
CREATE TABLE repo_snapshots (
  kind TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  computed_at TEXT NOT NULL
);

-- Time series. env/part are '' (not NULL) when a metric has none, so the UNIQUE
-- key dedupes a redelivered status or a double-fired cron.
CREATE TABLE repo_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric TEXT NOT NULL,
  env TEXT NOT NULL DEFAULT '',
  part TEXT NOT NULL DEFAULT '',
  value REAL NOT NULL,
  at TEXT NOT NULL,
  UNIQUE (metric, env, part, at)
);
CREATE INDEX idx_repo_metrics_series ON repo_metrics(metric, env, part, at);
```

- [ ] **Step 2: Add the tables to the test reset**

In `scripts/seed/reset.mjs`, insert directly after the `"DELETE FROM events",` line:

```js
  // Repo dashboard capture (0027) — no FKs in or out.
  "DELETE FROM repo_events",
  "DELETE FROM repo_snapshots",
  "DELETE FROM repo_metrics",
```

- [ ] **Step 3: Write the failing test**

`test/repo-capture.store.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all } from "../src/db";
import { ingestRepoEvent } from "../src/consumer";
import { repoEnvironments } from "../src/repo/config";
import { putSnapshot, getSnapshot, putMetric, metricSeries, latestMetric, pruneRepoCapture } from "../src/repo/store";
import type { RepoEvent, RepoEventRow } from "../src/repo/types";

const push = (over: Partial<RepoEvent> = {}): RepoEvent => ({
  semantic_key: "gh:push:abc1234:main", kind: "push", ref: "main", sha: "abc1234", actor_login: "jose-a",
  count: 2, title: "fix: thing", raw: "{}", provenance: "webhook", occurred_at: "2026-09-20T10:00:00Z", ...over,
});

describe("ingestRepoEvent — the repo capture gate", () => {
  it("writes once and drops a redelivery as unchanged", async () => {
    expect((await ingestRepoEvent(env.DB, push())).outcome).toBe("written");
    expect((await ingestRepoEvent(env.DB, push())).outcome).toBe("unchanged");
    const rows = await all<RepoEventRow>(env.DB, `SELECT * FROM repo_events`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "push", ref: "main", sha: "abc1234", count: 2, env: null, part: null });
  });

  it("never raises an identity task — bots and CI are not people", async () => {
    await ingestRepoEvent(env.DB, push({ actor_login: "railway-app[bot]" }));
    expect(await all(env.DB, `SELECT * FROM identity_tasks`)).toHaveLength(0);
  });
});

describe("repoEnvironments", () => {
  it("parses the configured environments and tolerates junk", () => {
    const envs = repoEnvironments(env);
    expect(envs.map((e) => [e.key, e.branch])).toEqual([["staging", "main"], ["production", "production"]]);
    expect(repoEnvironments({ REPO_ENVIRONMENTS: "not json" })).toEqual([]);
    expect(repoEnvironments({})).toEqual([]);
  });
});

describe("snapshots and metrics", () => {
  it("a snapshot is last-write-wins", async () => {
    await putSnapshot(env.DB, "drift", { ahead: 1 }, "2026-09-20T10:00:00Z");
    await putSnapshot(env.DB, "drift", { ahead: 5 }, "2026-09-20T11:00:00Z");
    expect(await getSnapshot<{ ahead: number }>(env.DB, "drift")).toEqual({ data: { ahead: 5 }, computedAt: "2026-09-20T11:00:00Z" });
    expect(await getSnapshot(env.DB, "nope")).toBeNull();
  });

  it("a metric point is unique per (metric, env, part, at)", async () => {
    const m = { metric: "health_ms", env: "staging", part: "backend", value: 212, at: "2026-09-20T10:00:00Z" };
    await putMetric(env.DB, m);
    await putMetric(env.DB, { ...m, value: 999 }); // a double-fired cron: first write stands
    await putMetric(env.DB, { ...m, at: "2026-09-20T10:10:00Z", value: 148 });
    expect(await metricSeries(env.DB, "health_ms", "staging", "backend", "2026-09-20T00:00:00Z"))
      .toEqual([{ at: "2026-09-20T10:00:00Z", value: 212 }, { at: "2026-09-20T10:10:00Z", value: 148 }]);
    expect(await latestMetric(env.DB, "health_ms", "staging", "backend")).toEqual({ at: "2026-09-20T10:10:00Z", value: 148 });
  });

  it("prune drops old pings and check runs, keeps slow metrics and deploys", async () => {
    const now = Date.parse("2026-09-20T12:00:00Z");
    const old = "2026-07-01T00:00:00Z";
    await putMetric(env.DB, { metric: "health_ms", env: "staging", part: "backend", value: 1, at: old });
    await putMetric(env.DB, { metric: "coverage", env: "", part: "", value: 78.4, at: old });
    await ingestRepoEvent(env.DB, push({ semantic_key: "k1", kind: "check", occurred_at: old }));
    await ingestRepoEvent(env.DB, push({ semantic_key: "k2", kind: "deploy", occurred_at: old }));
    await pruneRepoCapture(env.DB, now);
    expect((await all<{ metric: string }>(env.DB, `SELECT metric FROM repo_metrics`)).map((r) => r.metric)).toEqual(["coverage"]);
    expect((await all<{ kind: string }>(env.DB, `SELECT kind FROM repo_events`)).map((r) => r.kind)).toEqual(["deploy"]);
  });
});
```

- [ ] **Step 4: Run it to make sure it fails**

Run: `npx vitest run test/repo-capture.store.test.ts`
Expected: FAIL — cannot resolve `../src/repo/config`.

- [ ] **Step 5: Implement types, config, store, and the gate function**

`src/repo/types.ts`:

```ts
export type RepoEventKind = "push" | "pr" | "review" | "deploy" | "check" | "run";
export type RepoPart = "backend" | "frontend";

/** One captured repo fact on its way into the gate. Optional = NULL in D1. */
export interface RepoEvent {
  semantic_key: string;
  kind: RepoEventKind;
  ref?: string | null;
  sha?: string | null;
  number?: number | null;
  env?: string | null;
  part?: RepoPart | null;
  state?: string | null;
  name?: string | null;
  actor_login?: string | null;
  title?: string | null;
  url?: string | null;
  count?: number | null;
  raw: string;
  provenance: "webhook" | "backfill";
  occurred_at: string;
}

export interface RepoEventRow {
  id: number; semantic_key: string; kind: RepoEventKind;
  ref: string | null; sha: string | null; number: number | null; env: string | null; part: RepoPart | null;
  state: string | null; name: string | null; actor_login: string | null; title: string | null; url: string | null;
  count: number | null; raw: string; provenance: "webhook" | "backfill"; occurred_at: string; recorded_at: string;
}

export interface RepoMetric { metric: string; env: string; part: string; value: number; at: string }
```

`src/repo/config.ts`:

```ts
// The environments the dashboard reports on. Configuration, not capture: which
// branch deploys where is a fact about the team's setup that no webhook states.
export interface RepoEnvConfig {
  key: string;            // stable id stored on rows: "staging" | "production"
  label: string;          // card title
  note: string | null;    // the branch, shown beside the label
  branch: string;         // the git branch this environment deploys from
  railwayEnv: string;     // GitHub deployment `environment`, e.g. "Sapling / staging"
  worker: string;         // Cloudflare Worker script name
  workerCheck: string;    // the check run Workers Builds posts, e.g. "Workers Builds: frontend-staging"
  frontendUrl: string;
  apiUrl: string;
  healthPath: string;     // appended to apiUrl
  railwayEnvironmentId?: string;
  railwayServiceId?: string;
}

const REQUIRED = ["key", "label", "branch", "railwayEnv", "worker", "workerCheck", "frontendUrl", "apiUrl", "healthPath"] as const;

/** Parse `REPO_ENVIRONMENTS`. Absent or malformed → [] (the dashboard then shows not_connected). */
export function repoEnvironments(env: { REPO_ENVIRONMENTS?: string }): RepoEnvConfig[] {
  if (!env.REPO_ENVIRONMENTS) return [];
  try {
    const parsed = JSON.parse(env.REPO_ENVIRONMENTS) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is RepoEnvConfig =>
      !!e && typeof e === "object" && REQUIRED.every((k) => typeof (e as Record<string, unknown>)[k] === "string"))
      .map((e) => ({ ...e, note: e.note ?? null }));
  } catch { return []; }
}
```

`src/repo/store.ts`:

```ts
import { type DB, all, first, run, nowIso } from "../db";
import type { RepoMetric } from "./types";

const DAY = 86_400_000;
/** High-frequency series and rows that lose their value quickly. */
const FAST_METRICS = ["health_up", "health_ms"];
const FAST_KINDS = ["check"];
const FAST_RETENTION_DAYS = 45;

export async function putSnapshot(db: DB, kind: string, data: unknown, now: string = nowIso()): Promise<void> {
  await run(db,
    `INSERT INTO repo_snapshots (kind, json, computed_at) VALUES (?, ?, ?)
     ON CONFLICT(kind) DO UPDATE SET json = excluded.json, computed_at = excluded.computed_at`,
    kind, JSON.stringify(data), now);
}

export async function getSnapshot<T>(db: DB, kind: string): Promise<{ data: T; computedAt: string } | null> {
  const row = await first<{ json: string; computed_at: string }>(db, `SELECT json, computed_at FROM repo_snapshots WHERE kind = ?`, kind);
  if (!row) return null;
  try { return { data: JSON.parse(row.json) as T, computedAt: row.computed_at }; } catch { return null; }
}

/** First write wins: a redelivered status or a double-fired cron is a no-op. */
export async function putMetric(db: DB, m: RepoMetric): Promise<void> {
  await run(db, `INSERT OR IGNORE INTO repo_metrics (metric, env, part, value, at) VALUES (?, ?, ?, ?, ?)`,
    m.metric, m.env, m.part, m.value, m.at);
}

export async function metricSeries(db: DB, metric: string, env: string, part: string, sinceIso: string): Promise<{ at: string; value: number }[]> {
  return all<{ at: string; value: number }>(db,
    `SELECT at, value FROM repo_metrics WHERE metric = ? AND env = ? AND part = ? AND at >= ? ORDER BY at ASC`,
    metric, env, part, sinceIso);
}

export async function latestMetric(db: DB, metric: string, env: string, part: string): Promise<{ at: string; value: number } | null> {
  return first<{ at: string; value: number }>(db,
    `SELECT at, value FROM repo_metrics WHERE metric = ? AND env = ? AND part = ? ORDER BY at DESC LIMIT 1`, metric, env, part);
}

export async function pruneRepoCapture(db: DB, now: number): Promise<void> {
  const cutoff = new Date(now - FAST_RETENTION_DAYS * DAY).toISOString();
  await run(db, `DELETE FROM repo_metrics WHERE metric IN (${FAST_METRICS.map(() => "?").join(",")}) AND at < ?`, ...FAST_METRICS, cutoff);
  await run(db, `DELETE FROM repo_events WHERE kind IN (${FAST_KINDS.map(() => "?").join(",")}) AND occurred_at < ?`, ...FAST_KINDS, cutoff);
}
```

Append to `src/consumer.ts` (after `ingestEvent`; add `import type { RepoEvent } from "./repo/types";` at the top):

```ts
/**
 * THE GATE for repo-dashboard capture (kinds: push / pr / review / deploy / check
 * / run). Same reconciliation as ingestEvent — a UNIQUE `semantic_key` written
 * INSERT OR IGNORE, so a redelivery or a backfill overlap drops as `unchanged` —
 * and deliberately NOTHING else: no identity intake (most actors here are bots or
 * CI) and no summaries. Reached only from the HMAC-verified webhook and the
 * admin backfill.
 */
export async function ingestRepoEvent(db: DB, ev: RepoEvent): Promise<{ outcome: "written" | "unchanged" }> {
  const res = await run(
    db,
    `INSERT OR IGNORE INTO repo_events
       (semantic_key, kind, ref, sha, number, env, part, state, name, actor_login, title, url, count, raw, provenance, occurred_at, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ev.semantic_key, ev.kind, ev.ref ?? null, ev.sha ?? null, ev.number ?? null, ev.env ?? null, ev.part ?? null,
    ev.state ?? null, ev.name ?? null, ev.actor_login ?? null, ev.title ?? null, ev.url ?? null, ev.count ?? null,
    ev.raw, ev.provenance, ev.occurred_at, nowIso()
  );
  return { outcome: (res.meta.changes ?? 0) > 0 ? "written" : "unchanged" };
}
```

`src/env.ts` — add inside `Env`:

```ts
  REPO_ENVIRONMENTS?: string; // JSON RepoEnvConfig[] (src/repo/config.ts): which branch deploys to which environment, and its URLs
```

`wrangler.toml` — add under `[vars]` (one line; TOML basic string, inner quotes escaped):

```toml
REPO_ENVIRONMENTS = "[{\"key\":\"staging\",\"label\":\"staging\",\"note\":\"main\",\"branch\":\"main\",\"railwayEnv\":\"Sapling / staging\",\"worker\":\"frontend-staging\",\"workerCheck\":\"Workers Builds: frontend-staging\",\"frontendUrl\":\"https://staging.saplinglearn.com\",\"apiUrl\":\"https://api.staging.saplinglearn.com\",\"healthPath\":\"/api/health\",\"railwayEnvironmentId\":\"76bb36e5-cf12-4b1e-b47f-d276a56c3b85\"},{\"key\":\"production\",\"label\":\"production\",\"note\":\"production\",\"branch\":\"production\",\"railwayEnv\":\"Sapling / production\",\"worker\":\"frontend\",\"workerCheck\":\"Workers Builds: frontend\",\"frontendUrl\":\"https://saplinglearn.com\",\"apiUrl\":\"https://api.saplinglearn.com\",\"healthPath\":\"/api/health\",\"railwayEnvironmentId\":\"dd058398-45bc-4c7d-80b1-12d46e3f28fb\"}]"
```

Tests read `wrangler.toml` `[vars]` through `cloudflareTest`, so no `vitest.config.ts` binding is needed for this var.

- [ ] **Step 6: Run the test and the schema-sensitive suites**

Run: `npx vitest run test/repo-capture.store.test.ts test/events-schema.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add migrations/0027_repo_capture.sql src/repo src/consumer.ts src/env.ts wrangler.toml scripts/seed/reset.mjs test/repo-capture.store.test.ts
git commit -m "Add the repo capture store and its gate function"
```

### Task 2: Turn `push` and `pull_request` deliveries into repo events (pure)

**Files:**
- Create: `src/repo/capture.ts`, `test/helpers/repo.ts`, `test/fixtures/gh-push.json`, `test/fixtures/gh-pr-opened.json`
- Test: `test/repo-capture.test.ts`

**Interfaces:**
- Consumes: `RepoEvent`, `RepoEnvConfig` (Task 1)
- Produces: `repoEventsFromDelivery(eventName: string, payload: unknown, envs: RepoEnvConfig[]): RepoEvent[]` — pure; `[]` for anything not captured. Later tasks add arms to THIS function.

- [ ] **Step 1: Add the shared test environments and the fixtures**

`test/helpers/repo.ts` — the two environments every repo test configures. It lives in `helpers/`, NOT in a `.test.ts` file: importing one test file from another re-registers its `describe()` blocks and runs them twice.

```ts
import type { RepoEnvConfig } from "../../src/repo/config";

export const ENVS: RepoEnvConfig[] = [
  { key: "staging", label: "staging", note: "main", branch: "main", railwayEnv: "Sapling / staging", worker: "frontend-staging", workerCheck: "Workers Builds: frontend-staging", frontendUrl: "https://staging.saplinglearn.com", apiUrl: "https://api.staging.saplinglearn.com", healthPath: "/api/health" },
  { key: "production", label: "production", note: "production", branch: "production", railwayEnv: "Sapling / production", worker: "frontend", workerCheck: "Workers Builds: frontend", frontendUrl: "https://saplinglearn.com", apiUrl: "https://api.saplinglearn.com", healthPath: "/api/health" },
];
```

`test/fixtures/gh-push.json` (GitHub's push payload, trimmed to what we read):

```json
{
  "ref": "refs/heads/main",
  "before": "1111111111111111111111111111111111111111",
  "after": "becdbac09eaf5d7c73b9f27019c0e43c4444dd7b",
  "created": false, "deleted": false, "forced": false,
  "compare": "https://github.com/SaplingLearn/sapling/compare/1111111...becdbac",
  "pusher": { "name": "AndresL230" },
  "sender": { "login": "AndresL230" },
  "commits": [
    { "id": "aaaaaaa1", "distinct": true, "message": "rollup: batch D1 reads\n\nbody", "timestamp": "2026-09-20T09:03:00Z", "author": { "username": "AndresL230" } },
    { "id": "aaaaaaa2", "distinct": true, "message": "fix window math", "timestamp": "2026-09-20T09:04:00Z", "author": { "username": "AndresL230" } },
    { "id": "aaaaaaa3", "distinct": false, "message": "already on another branch", "timestamp": "2026-09-19T09:04:00Z", "author": { "username": "lpcooper-arch" } }
  ],
  "head_commit": { "id": "becdbac09eaf5d7c73b9f27019c0e43c4444dd7b", "message": "fix window math", "timestamp": "2026-09-20T09:04:41Z" }
}
```

`test/fixtures/gh-pr-opened.json`:

```json
{
  "action": "opened",
  "number": 482,
  "pull_request": {
    "number": 482, "title": "Batch D1 reads in usage rollup", "html_url": "https://github.com/SaplingLearn/sapling/pull/482",
    "state": "open", "draft": false, "merged": false, "updated_at": "2026-09-20T09:10:00Z",
    "user": { "login": "lpcooper-arch" },
    "head": { "ref": "feature/usage-rollup", "sha": "c91d2aec91d2aec91d2aec91d2aec91d2aec91d2" },
    "base": { "ref": "main" }
  }
}
```

- [ ] **Step 2: Write the failing test**

`test/repo-capture.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { repoEventsFromDelivery } from "../src/repo/capture";
import { ENVS } from "./helpers/repo";
import push from "./fixtures/gh-push.json";
import prOpened from "./fixtures/gh-pr-opened.json";


describe("repoEventsFromDelivery — push", () => {
  it("captures a branch push: distinct commit count, head subject, pusher", () => {
    const [ev, ...rest] = repoEventsFromDelivery("push", push, ENVS);
    expect(rest).toEqual([]);
    expect(ev).toMatchObject({
      semantic_key: "gh:push:becdbac09eaf5d7c73b9f27019c0e43c4444dd7b:main", kind: "push", ref: "main",
      sha: "becdbac09eaf5d7c73b9f27019c0e43c4444dd7b", actor_login: "AndresL230", count: 2,
      title: "fix window math", provenance: "webhook", occurred_at: "2026-09-20T09:04:41Z",
    });
    // raw keeps a slice, never the whole delivery
    expect(JSON.parse(ev.raw).commits).toHaveLength(3);
    expect(ev.raw).not.toContain("body");
  });

  it("ignores tag pushes and branch deletions", () => {
    expect(repoEventsFromDelivery("push", { ...push, ref: "refs/tags/v1" }, ENVS)).toEqual([]);
    expect(repoEventsFromDelivery("push", { ...push, deleted: true }, ENVS)).toEqual([]);
  });
});

describe("repoEventsFromDelivery — pull_request", () => {
  it("maps open/draft/merged/closed onto one `state` column", () => {
    const state = (over: object, action = "opened") =>
      repoEventsFromDelivery("pull_request", { ...prOpened, action, pull_request: { ...prOpened.pull_request, ...over } }, ENVS)[0]?.state;
    expect(state({})).toBe("review");
    expect(state({ draft: true })).toBe("draft");
    expect(state({ state: "closed", merged: true }, "closed")).toBe("merged");
    expect(state({ state: "closed", merged: false }, "closed")).toBe("closed");
  });

  it("keys on action + updated_at so a redelivery collapses and a later edit does not", () => {
    const [ev] = repoEventsFromDelivery("pull_request", prOpened, ENVS);
    expect(ev).toMatchObject({
      semantic_key: "gh:prs:482:opened:2026-09-20T09:10:00Z", kind: "pr", number: 482, ref: "feature/usage-rollup",
      sha: "c91d2aec91d2aec91d2aec91d2aec91d2aec91d2", actor_login: "lpcooper-arch", title: "Batch D1 reads in usage rollup",
    });
  });

  it("skips actions that change nothing the dashboard shows", () => {
    for (const action of ["labeled", "assigned", "review_requested", "locked"]) {
      expect(repoEventsFromDelivery("pull_request", { ...prOpened, action }, ENVS)).toEqual([]);
    }
  });

  it("returns [] for junk", () => {
    expect(repoEventsFromDelivery("pull_request", null, ENVS)).toEqual([]);
    expect(repoEventsFromDelivery("ping", {}, ENVS)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it to make sure it fails**

Run: `npx vitest run test/repo-capture.test.ts`
Expected: FAIL — cannot resolve `../src/repo/capture`.

- [ ] **Step 4: Implement**

`src/repo/capture.ts`:

```ts
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
  const at = str(pr.updated_at);
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
```

- [ ] **Step 5: Run the test**

Run: `npx vitest run test/repo-capture.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/repo/capture.ts test/helpers/repo.ts test/repo-capture.test.ts test/fixtures/gh-push.json test/fixtures/gh-pr-opened.json
git commit -m "Derive repo events from push and pull_request deliveries"
```

### Task 3: Route verified deliveries into both capture paths

The handler today returns `ignored` for anything but `pull_request`/`issues`, and its `else` branch treats every non-PR event as an issue (runs the issue summarizer). Both must change before new event names are let in.

**Files:**
- Modify: `src/webhook.ts` (`handleGithubWebhook`, lines ~300–337)
- Test: `test/webhook.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `repoEventsFromDelivery`, `ingestRepoEvent`, `repoEnvironments`
- Produces: `handleGithubWebhook(request, env, opts?)` where `opts` gains `fetchImpl?: typeof fetch` and `waitUntil?: (p: Promise<unknown>) => void`. Response body gains `repo: { captured: number; unchanged: number }`. `REPO_EVENT_NAMES: readonly string[]` exported for later phases to extend.

- [ ] **Step 1: Write the failing test** — append to `test/webhook.test.ts`:

```ts
import pushFixture from "./fixtures/gh-push.json";
import prOpened from "./fixtures/gh-pr-opened.json";
import type { RepoEventRow } from "../src/repo/types";

describe("handleGithubWebhook — repo capture runs beside the My Work capture", () => {
  it("a push is captured into repo_events and writes nothing to events", async () => {
    const res = await postWebhook("push", pushFixture);
    expect(await res.json()).toMatchObject({ ok: true, captured: 0, repo: { captured: 1, unchanged: 0 } });
    expect(await all<EventRow>(env.DB, `SELECT * FROM events`)).toHaveLength(0);
    expect(await all<RepoEventRow>(env.DB, `SELECT * FROM repo_events`)).toHaveLength(1);
    const again = await postWebhook("push", pushFixture);
    expect(await again.json()).toMatchObject({ repo: { captured: 0, unchanged: 1 } });
  });

  it("an opened PR reaches repo_events only; a merged PR reaches BOTH", async () => {
    await postWebhook("pull_request", prOpened);
    expect(await all(env.DB, `SELECT * FROM events`)).toHaveLength(0);
    await postWebhook("pull_request", prMerged, env, { summarizer: null });
    expect(await all<EventRow>(env.DB, `SELECT event_type FROM events`)).toEqual([{ event_type: "pr_merged" }]);
    const kinds = await all<{ state: string }>(env.DB, `SELECT state FROM repo_events WHERE kind = 'pr' ORDER BY id`);
    expect(kinds.map((k) => k.state)).toEqual(["review", "merged"]);
  });

  it("a push never reaches the issue summarizer", async () => {
    let called = 0;
    const spy: Summarizer<IssueSummary> = async () => { called++; throw new Error("must not run"); };
    await postWebhook("push", pushFixture, env, { issueSummarizer: spy });
    expect(called).toBe(0);
  });

  it("an unhandled event name is still verified-then-ignored", async () => {
    const res = await postWebhook("star", { action: "created" });
    expect(await res.json()).toEqual({ ok: true, ignored: true });
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/webhook.test.ts`
Expected: FAIL — the push response is `{ok:true, ignored:true}`, no `repo` key.

- [ ] **Step 3: Implement** — in `src/webhook.ts` add the imports

```ts
import { ingestEvent, ingestRepoEvent } from "./consumer";
import { repoEventsFromDelivery } from "./repo/capture";
import { repoEnvironments } from "./repo/config";
```

(merge `ingestRepoEvent` into the existing `./consumer` import), add above `handleGithubWebhook`:

```ts
/** Deliveries the My Work capture (`events`) reads. */
const WORK_EVENT_NAMES = ["pull_request", "issues"];
/** Deliveries the repo dashboard capture (`repo_events`) reads. Later phases append. */
export const REPO_EVENT_NAMES: readonly string[] = ["pull_request", "push"];
```

widen the `opts` parameter type with `fetchImpl?: typeof fetch; waitUntil?: (p: Promise<unknown>) => void;`, and replace the body from `const eventName = …` to the final `return json(…)` with:

```ts
  const eventName = request.headers.get("x-github-event") ?? "";
  const forWork = WORK_EVENT_NAMES.includes(eventName);
  const forRepo = REPO_EVENT_NAMES.includes(eventName);
  if (!forWork && !forRepo) {
    // Verified, but not a surface we capture (ping, star, …).
    return json({ ok: true, ignored: true });
  }

  let payload: unknown = null;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    payload = null; // both derivations treat a non-object payload as []
  }

  let captured = 0;
  let unchanged = 0;
  if (forWork) {
    for (const ev of eventsFromDelivery(eventName, payload)) {
      const res = await ingestEvent(env.DB, ev, "github-webhook");
      if (res.outcome !== "written") { unchanged++; continue; }
      captured++;
      if (ev.event_type === "pr_merged" || ev.event_type === "pr_closed") {
        const summarizer = opts?.summarizer ?? (env.GEMINI_API_KEY ? geminiPrSummarizer(env.GEMINI_API_KEY) : null);
        await summarizePrSeam(env.DB, summarizer, ev);
      } else if (ev.event_type === "issue") {
        await progressSeam(env.DB, payload);
        const issueSummarizer = opts?.issueSummarizer ?? (env.GEMINI_API_KEY ? geminiIssueSummarizer(env.GEMINI_API_KEY) : null);
        await summarizeIssueSeam(env.DB, issueSummarizer, ev);
      }
    }
  }

  // The repo dashboard's capture: a second, independent reading of the SAME
  // verified delivery. A failure here must never cost the My Work capture above.
  const repo = { captured: 0, unchanged: 0 };
  if (forRepo) {
    try {
      for (const ev of repoEventsFromDelivery(eventName, payload, repoEnvironments(env))) {
        const res = await ingestRepoEvent(env.DB, ev);
        if (res.outcome === "written") repo.captured++; else repo.unchanged++;
      }
    } catch (e) {
      console.error("repo capture failed", eventName, e);
    }
  }

  return json({ ok: true, captured, unchanged, repo });
```

- [ ] **Step 4: Run the webhook suite**

Run: `npx vitest run test/webhook.test.ts test/events-gate.test.ts`
Expected: PASS — including every pre-existing case (the existing `unhandled event name` case posts `ping`, which is still ignored).

- [ ] **Step 5: Pass `ctx.waitUntil` through** — in `src/index.ts`, where `/webhook/github` is dispatched, change the call to `handleGithubWebhook(request, env, { waitUntil: (p) => ctx.waitUntil(p) })`.

- [ ] **Step 6: Commit**

```bash
git add src/webhook.ts src/index.ts test/webhook.test.ts
git commit -m "Route verified deliveries to the repo capture beside My Work's"
```

### Task 4: Project pushes and PR state into the dashboard

**Files:**
- Create: `src/repo/reads.ts`
- Modify: `shared/repo.ts` (`RepoContributor`), `src/tools/repo.ts`, `web/src/repo.ts` (contributors row + header), `web/src/repo-sample.ts`
- Test: `test/repo-dashboard.test.ts` (append), `test/render.repo.test.ts` (adjust contributors)

**Interfaces:**
- Consumes: `RepoEventRow`, `ingestRepoEvent`
- Produces (all in `src/repo/reads.ts`):
  - `hasCaptured(db, kind: RepoEventKind): Promise<boolean>`
  - `prStatesAsOf(db, asOfIso: string): Promise<RepoEventRow[]>` — the LATEST `pr` row per PR number at that moment
  - `recentPrRows(db, limit: number): Promise<RepoEventRow[]>` — latest row per PR, newest first
  - `commitsByDay(db, sinceIso: string): Promise<Map<string, number>>` — `YYYY-MM-DD` → distinct commits
  - `pushRowsSince(db, sinceIso: string): Promise<RepoEventRow[]>`
  - `RepoContributor` becomes `{ person: RepoPerson; pushes: number; merged: number; reviews: number }` (the design's P · M · R)

- [ ] **Step 1: Write the failing test** — append to `test/repo-dashboard.test.ts`:

```ts
import { ingestRepoEvent } from "../src/consumer";
import type { RepoEvent } from "../src/repo/types";

const prRow = (number: number, state: string, at: string, over: Partial<RepoEvent> = {}): RepoEvent => ({
  semantic_key: `gh:prs:${number}:${state}:${at}`, kind: "pr", number, state, ref: `feat/${number}`, sha: `sha${number}`,
  actor_login: "jose-a", title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`, raw: "{}", provenance: "webhook", occurred_at: at, ...over,
});
const pushRow = (sha: string, ref: string, count: number, at: string, actor = "jose-a"): RepoEvent => ({
  semantic_key: `gh:push:${sha}:${ref}`, kind: "push", ref, sha, actor_login: actor, count, title: `commit ${sha}`, raw: "{}", provenance: "webhook", occurred_at: at,
});
const ingestRepo = async (rows: RepoEvent[]) => { for (const r of rows) await ingestRepoEvent(env.DB, r); };

describe("getRepoDashboard — pushes and PR state (sources A, B)", () => {
  it("counts OPEN PRs from the latest state per PR, with a week-ago delta", async () => {
    await ingestRepo([
      prRow(1, "review", ago(10)),                       // open then and now
      prRow(2, "review", ago(9)), prRow(2, "merged", ago(2)), // open a week ago, merged since
      prRow(3, "draft", ago(1)),                         // new this week, draft
      prRow(4, "review", ago(1)),
    ]);
    const [openPrs, awaiting] = data((await getRepoDashboard(env.DB, "o/r", NOW)).stats);
    expect(openPrs).toMatchObject({ label: "Open PRs", value: 3, delta: 1 });       // was {1,2}, now {1,3,4}
    expect(awaiting).toMatchObject({ label: "Awaiting review", value: 2, delta: 0 }); // non-draft open: was {1,2}, now {1,4}
  });

  it("lists open and recent PRs with their head branch and state", async () => {
    await seedPerson("jose-a");
    await ingestRepo([prRow(7, "draft", ago(3)), prRow(7, "review", ago(1)), prRow(8, "merged", ago(2))]);
    const prs = data((await getRepoDashboard(env.DB, "o/r", NOW)).prs);
    expect(prs.map((p) => [p.number, p.state, p.branch])).toEqual([[7, "review", "feat/7"], [8, "merged", "feat/8"]]);
    expect(prs[0].author.handle).toBe("jose-a");
  });

  it("draws the 14-day bars from COMMITS once pushes are captured", async () => {
    await ingestRepo([pushRow("a1", "main", 3, ago(0, 2)), pushRow("a2", "feat/x", 2, ago(0, 3)), pushRow("a3", "main", 4, ago(13))]);
    const d = await getRepoDashboard(env.DB, "o/r", NOW);
    const bars = data(d.bars);
    expect(bars.title).toBe("Commit activity — last 14 days");
    expect(bars.days[13].count).toBe(5);
    expect(bars.days[0].count).toBe(4);
    expect(bars.note).toBe("9 commits · all branches");
    expect(data(d.codeStats).find((s) => s.label === "Commits this week")).toMatchObject({ value: 5 });
  });

  it("puts pushes in the feed and in the contributor columns", async () => {
    await seedPerson("jose-a");
    await ingestRepo([pushRow("a1", "fix/sse-auth", 1, ago(0, 1)), pushRow("a2", "main", 3, ago(0, 2))]);
    const d = await getRepoDashboard(env.DB, "o/r", NOW);
    const feed = data(d.activity);
    expect(feed[0]).toMatchObject({ kind: "push", text: "pushed 1 commit to fix/sse-auth", actor: { handle: "jose-a" } });
    expect(feed[1].text).toBe("pushed 3 commits to main");
    expect(data(d.contributors)[0]).toMatchObject({ pushes: 2, merged: 0, reviews: 0 });
  });

  it("before any PR capture exists, keeps the merged-PR tiles instead of claiming 0 open PRs", async () => {
    const labels = data((await getRepoDashboard(env.DB, "o/r", NOW)).stats).map((s) => s.label);
    expect(labels).toEqual(["Merged PRs", "Open issues", "Open bugs", "Open tickets"]);
  });
});
```

Also update the existing `contributors tally…` test in the same file: replace its assertion with
`expect(rows.map((r) => [r.person.login, r.pushes, r.merged, r.reviews])).toEqual([["a", 0, 2, 0], ["b", 0, 1, 0]]);`
and in the `buckets merges into 14 UTC days` test keep the title assertion as `"Merge activity — last 14 days"` (no pushes are captured there, so the fallback stands).

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/repo-dashboard.test.ts`
Expected: FAIL — `Open PRs` tile not found / `pushes` undefined.

- [ ] **Step 3: Implement the reads** — `src/repo/reads.ts`:

```ts
// Every SELECT over the repo capture tables. D1 only — nothing here may fetch.
import { type DB, all, first } from "../db";
import type { RepoEventKind, RepoEventRow } from "./types";

export async function hasCaptured(db: DB, kind: RepoEventKind): Promise<boolean> {
  return (await first<{ n: number }>(db, `SELECT 1 AS n FROM repo_events WHERE kind = ? LIMIT 1`, kind)) !== null;
}

/** The latest `pr` row per PR number as of a moment — a PR's state THEN. */
export async function prStatesAsOf(db: DB, asOfIso: string): Promise<RepoEventRow[]> {
  return all<RepoEventRow>(db,
    `SELECT * FROM (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY number ORDER BY occurred_at DESC, id DESC) AS rn
         FROM repo_events WHERE kind = 'pr' AND occurred_at <= ?
     ) WHERE rn = 1`, asOfIso);
}

export async function recentPrRows(db: DB, limit: number): Promise<RepoEventRow[]> {
  return all<RepoEventRow>(db,
    `SELECT * FROM (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY number ORDER BY occurred_at DESC, id DESC) AS rn
         FROM repo_events WHERE kind = 'pr'
     ) WHERE rn = 1 ORDER BY occurred_at DESC, id DESC LIMIT ?`, limit);
}

export async function commitsByDay(db: DB, sinceIso: string): Promise<Map<string, number>> {
  const rows = await all<{ day: string; n: number }>(db,
    `SELECT substr(occurred_at, 1, 10) AS day, SUM(COALESCE(count, 0)) AS n
       FROM repo_events WHERE kind = 'push' AND occurred_at > ? GROUP BY day`, sinceIso);
  return new Map(rows.map((r) => [r.day, r.n]));
}

export async function pushRowsSince(db: DB, sinceIso: string): Promise<RepoEventRow[]> {
  return all<RepoEventRow>(db,
    `SELECT * FROM repo_events WHERE kind = 'push' AND occurred_at > ? ORDER BY occurred_at DESC, id DESC`, sinceIso);
}
```

- [ ] **Step 4: Change the DTO** — in `shared/repo.ts` replace the `RepoContributor` line with:

```ts
/** The design's P · M · R: pushes, merged PRs, reviews — this week. */
export interface RepoContributor { person: RepoPerson; pushes: number; merged: number; reviews: number }
```

- [ ] **Step 5: Assemble** — in `src/tools/repo.ts`:

Add imports: `import { hasCaptured, prStatesAsOf, recentPrRows, commitsByDay, pushRowsSince } from "../repo/reads";` and `import type { RepoEventRow } from "../repo/types";`.

Inside `getRepoDashboard`, after `const tickets = await ticketCounts(db, weekAgo);` add:

```ts
  // ── repo capture (sources A, B) ───────────────────────────────────────────
  const prCaptured = await hasCaptured(db, "pr");
  const isOpen = (r: RepoEventRow) => r.state === "draft" || r.state === "review";
  const prsNow = prCaptured ? (await prStatesAsOf(db, nowAt)).filter(isOpen) : [];
  const prsThen = prCaptured ? (await prStatesAsOf(db, weekAgo)).filter(isOpen) : [];
  const awaiting = (rows: RepoEventRow[]) => rows.filter((r) => r.state === "review").length;
  const pushes = await pushRowsSince(db, twoWeeksAgo);
  const pushesThisWeek = pushes.filter((p) => p.occurred_at > weekAgo);
  const sum = (rows: RepoEventRow[]) => rows.reduce((n, r) => n + (r.count ?? 0), 0);
  const commitsThisWeek = sum(pushesThisWeek);
  const commitsLastWeek = sum(pushes.filter((p) => p.occurred_at <= weekAgo));
```

Replace the `stats` array with:

```ts
  const issueTiles: RepoStat[] = [
    { label: "Open issues", value: openNow.length, delta: openNow.length - openThen.length, tone: backlogTone(openNow.length - openThen.length, false) },
    { label: "Open bugs", value: bugsNow, delta: bugsNow - bugsThen, tone: backlogTone(bugsNow - bugsThen, true) },
  ];
  // Until PR state has been captured (or backfilled) an "Open PRs: 0" would be a lie.
  const stats: RepoStat[] = prCaptured
    ? [
        { label: "Open PRs", value: prsNow.length, delta: prsNow.length - prsThen.length, tone: "neutral" },
        { label: "Awaiting review", value: awaiting(prsNow), delta: awaiting(prsNow) - awaiting(prsThen), tone: "neutral" },
        ...issueTiles,
      ]
    : [
        { label: "Merged PRs", value: mergedThisWeek.length, delta: mergedThisWeek.length - mergedLastWeek.length, tone: "neutral" },
        ...issueTiles,
        { label: "Open tickets", value: tickets.open, delta: tickets.delta, tone: backlogTone(tickets.delta, false) },
      ];
```

Replace the `codeStats` array with:

```ts
  const commitDelta = commitsThisWeek - commitsLastWeek;
  const codeStats: RepoCodeStat[] = [
    prCaptured
      ? { label: "Open PRs", value: prsNow.length, sub: `${awaiting(prsNow)} awaiting review`, tone: "neutral" }
      : { label: "Closed unmerged", value: closedUnmerged.length, sub: "this week", tone: "neutral" },
    { label: "Merged this week", value: mergedThisWeek.length, sub: mergers === 0 ? "this week" : mergers === 1 ? "by 1 person" : `by ${mergers} people`, tone: "neutral" },
    pushes.length
      ? { label: "Commits this week", value: commitsThisWeek, sub: `${commitDelta >= 0 ? "▲" : "▼"} ${Math.abs(commitDelta)} vs last week`, tone: "neutral" }
      : { label: "Issues opened", value: openedThisWeek.length, sub: "this week", tone: "neutral" },
    { label: "Issues closed", value: closedThisWeek.length, sub: "this week", tone: "neutral" },
  ];
```

Replace the `perDay` / `bars` block with:

```ts
  // Commits once pushes are captured; merges (what `events` has always had) until then.
  const commitDays = pushes.length ? await commitsByDay(db, twoWeeksAgo) : null;
  const perDay = new Map<string, number>();
  for (const p of merged) perDay.set(p.at.slice(0, 10), (perDay.get(p.at.slice(0, 10)) ?? 0) + 1);
  const days = lastDays(now, BAR_DAYS).map((date) => ({ date, count: (commitDays ?? perDay).get(date) ?? 0 }));
  const barTotal = days.reduce((n, d) => n + d.count, 0);
  const noun = commitDays ? "commit" : "merged PR";
  const bars: RepoBars = {
    title: `${commitDays ? "Commit" : "Merge"} activity — last ${BAR_DAYS} days`,
    note: `${barTotal} ${noun}${barTotal === 1 ? "" : "s"} · all branches`,
    days,
  };
```

Replace the `prs:` line in the return with a captured-first list. Add above the return:

```ts
  const PR_STATES = ["draft", "review", "approved", "merged", "closed"] as const;
  const capturedPrs: RepoPr[] = prCaptured
    ? (await recentPrRows(db, PR_LIMIT)).map((r) => ({
        number: r.number ?? 0, title: r.title ?? `PR #${r.number}`, url: r.url ?? "",
        author: personOf(people, r.actor_login ?? "unknown"), branch: r.ref,
        state: (PR_STATES as readonly string[]).includes(r.state ?? "") ? (r.state as RepoPr["state"]) : "review",
        checks: null, at: r.occurred_at,
      }))
    : listPrs.map((p) => prOf(people, p));
```

and return `prs: some(capturedPrs),`.

Add pushes to the feed — extend the `activity` expression:

```ts
  const pushActivity: RepoActivity[] = pushes.slice(0, ACTIVITY_LIMIT).map((p) => ({
    kind: "push" as const, actor: p.actor_login ? personOf(people, p.actor_login) : null,
    text: `pushed ${p.count ?? 0} commit${p.count === 1 ? "" : "s"} to ${p.ref ?? "a branch"}`, url: p.url, at: p.occurred_at,
  }));
  const activity = prActivity.concat(issueActivity, pushActivity)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, ACTIVITY_LIMIT);
```

Replace the contributor tally with P · M · R:

```ts
  const tally = new Map<string, { login: string; pushes: number; merged: number; reviews: number }>();
  const bump = (login: string, key: "pushes" | "merged" | "reviews") => {
    const k = login.toLowerCase();
    const row = tally.get(k) ?? { login, pushes: 0, merged: 0, reviews: 0 };
    row[key] += 1;
    tally.set(k, row);
  };
  // A bot's pushes are not a person's week.
  for (const p of pushesThisWeek) if (p.actor_login && !p.actor_login.endsWith("[bot]")) bump(p.actor_login, "pushes");
  for (const p of mergedThisWeek) bump(p.subject_login, "merged");
  const contributors: RepoContributor[] = [...tally.values()]
    .sort((a, b) => (b.pushes + b.merged + b.reviews) - (a.pushes + a.merged + a.reviews) || a.login.localeCompare(b.login))
    .slice(0, CONTRIBUTOR_LIMIT)
    .map((t) => ({ person: personOf(people, t.login), pushes: t.pushes, merged: t.merged, reviews: t.reviews }));
```

- [ ] **Step 6: Update the web contributors row** — in `web/src/repo.ts` `planningTab`:

Replace `const max = Math.max(1, ...rows.map((r) => r.merged));` with
`const max = Math.max(1, ...rows.map((r) => r.pushes + r.merged + r.reviews));`,
the bar width with `${Math.round(((r.pushes + r.merged + r.reviews) / max) * 100)}%`,
the counts cell with `${r.pushes} · ${r.merged} · ${r.reviews}`,
and the header span with `<span title="pushes · merged PRs · reviews" …>P · M · R</span>`.

In `web/src/repo-sample.ts` replace the contributors rows with the design's triples:

```ts
    contributors: { status: "ok", data: ([["jose-a", 14, 3, 6], ["meilin", 11, 4, 8], ["dev-raj", 9, 2, 3], ["sanaok", 7, 1, 5], ["priya-k", 6, 2, 2], ["tom-h", 4, 1, 1], ["ana-r", 3, 0, 4], ["kenji-m", 2, 1, 0]] as [string, number, number, number][])
      .map(([login, pushes, merged, reviews]) => ({ person: person(login), pushes, merged, reviews })) },
```

- [ ] **Step 7: Run everything touched**

Run: `npx vitest run test/repo-dashboard.test.ts test/render.repo.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/repo/reads.ts src/tools/repo.ts shared/repo.ts web/src/repo.ts web/src/repo-sample.ts test/repo-dashboard.test.ts test/render.repo.test.ts
git commit -m "Project pushes and open-PR state into the Repo dashboard"
```

### Task 5: Reconcile — backfill and self-heal from the GitHub API

A webhook can be missed, and history before capture began is absent. One idempotent `reconcileRepo` re-lists what GitHub holds and feeds it through the SAME gate; `INSERT OR IGNORE` makes overlap free. It runs from the 6-hourly cron tick (Task 10 wires the cron) and after the admin "Sync GitHub".

**Files:**
- Create: `src/repo/github.ts`
- Modify: `src/routes.ts` (`POST /admin/backfill`)
- Test: `test/repo-reconcile.test.ts`

**Interfaces:**
- Produces:
  - `GhOpts { token: string; repo: string; fetchImpl?: typeof fetch }`
  - `ghJson<T>(opts: GhOpts, path: string): Promise<T>` — `path` begins with `/` and is relative to `https://api.github.com/repos/<repo>`; throws on non-2xx
  - `reconcileRepo(db: DB, opts: GhOpts, envs: RepoEnvConfig[], now?: number): Promise<{ written: number; unchanged: number }>`

- [ ] **Step 1: Write the failing test** — `test/repo-reconcile.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all } from "../src/db";
import { reconcileRepo } from "../src/repo/github";
import type { RepoEventRow } from "../src/repo/types";
import { ENVS } from "./helpers/repo";

const NOW = Date.parse("2026-09-20T12:00:00Z");

/** A fake api.github.com keyed by path prefix. */
function fakeGithub(routes: Record<string, unknown>): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const hit = Object.keys(routes).find((k) => url.includes(k));
    return hit ? new Response(JSON.stringify(routes[hit]), { status: 200 }) : new Response("[]", { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const openPr = { number: 482, title: "Batch D1 reads", html_url: "https://github.com/o/r/pull/482", state: "open", draft: false, merged_at: null, updated_at: "2026-09-20T09:10:00Z", user: { login: "lpcooper-arch" }, head: { ref: "feature/usage-rollup", sha: "c91d2ae" }, base: { ref: "main" } };
const commit = { sha: "f00d", commit: { message: "old work\n\nbody", committer: { date: "2026-09-10T08:00:00Z" } }, author: { login: "AndresL230" } };

describe("reconcileRepo", () => {
  it("backfills open PRs and older commits through the gate, idempotently", async () => {
    const gh = fakeGithub({ "/pulls?state=open": [openPr], "/pulls?state=closed": [], "/commits?": [commit] });
    const first = await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl }, ENVS, NOW);
    expect(first).toEqual({ written: 2, unchanged: 0 });
    const again = await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl }, ENVS, NOW);
    expect(again).toEqual({ written: 0, unchanged: 2 });

    const rows = await all<RepoEventRow>(env.DB, `SELECT * FROM repo_events ORDER BY kind`);
    expect(rows.map((r) => [r.kind, r.provenance])).toEqual([["pr", "backfill"], ["push", "backfill"]]);
    expect(rows[0]).toMatchObject({ number: 482, state: "review", ref: "feature/usage-rollup" });
    expect(rows[1]).toMatchObject({ ref: "main", sha: "f00d", count: 1, title: "old work", actor_login: "AndresL230" });
  });

  it("sends the service token and never throws on a failing list", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    await expect(reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl }, ENVS, NOW)).resolves.toEqual({ written: 0, unchanged: 0 });
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run test/repo-reconcile.test.ts`
Expected: FAIL — cannot resolve `../src/repo/github`.

- [ ] **Step 3: Implement** — `src/repo/github.ts`:

```ts
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
```

- [ ] **Step 4: Run the admin Sync through it** — in `src/routes.ts`, inside `app.post("/admin/backfill", …)`, after `if (!res.ok) return c.json({ error: res.error }, 503);` add:

```ts
  // Best-effort: the repo dashboard's history rides the same admin action.
  if (c.env.GITHUB_SERVICE_TOKEN && c.env.GITHUB_REPO) {
    await reconcileRepo(c.env.DB, { token: c.env.GITHUB_SERVICE_TOKEN, repo: c.env.GITHUB_REPO }, repoEnvironments(c.env)).catch(() => undefined);
  }
```

with imports `import { reconcileRepo } from "./repo/github";` and `import { repoEnvironments } from "./repo/config";`.

- [ ] **Step 5: Run**

Run: `npx vitest run test/repo-reconcile.test.ts test/backfill.test.ts test/admin-route.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/repo/github.ts src/routes.ts test/repo-reconcile.test.ts
git commit -m "Reconcile repo capture from the GitHub API, through the gate"
```

### Task 6: Phase 1 close-out — docs, full suite, PR

- [ ] **Step 1:** In `CLAUDE.md`: add `0027_repo_capture` to the migrations list; add `src/repo/` to the `src/` layout line; in the Repo dashboard paragraph move "open PRs, commits" from the `not_connected` list to the live list; add `REPO_ENVIRONMENTS` under Vars; add `repo_events`, `repo_snapshots`, `repo_metrics` to the reset-tables list in Conventions.
- [ ] **Step 2:** Run `npm run typecheck && npm test`. Expected: all green except the documented `GEMINI_API_KEY` summarizer case.
- [ ] **Step 3:** `npm run db:migrate:local`, `npm run dev`, open `http://localhost:8787/#repo/code`, click **Sync GitHub** on My Work (admin), reload Repo. Expected: Open PRs tile populated, PR list shows open PRs with head branches.
- [ ] **Step 4:** Apply `0027` to prod (`CLOUDFLARE_ACCOUNT_ID=… npm run db:migrate:remote`) BEFORE merging, then open the PR.

---

# Phase 1 — shipped (PR #54). What execution changed, and what Phase 2 inherits

Phase 1 was executed task-by-task with per-task reviews and one whole-branch review. **Read this before starting Phase 2 — several Task 7–19 snippets below predate these changes.**

**Changed from the plan text above (the code is the truth):**
- `prCaptured` is NOT `hasCaptured(db,"pr")`. It is "the `prs_reconciled` snapshot exists", written by `reconcileRepo` only after the open-PR list was fetched and ingested. One webhook PR row must never flip the tiles. *Task 9's `capturedPrs` / `awaiting` snippets must keep this gate.*
- Week-over-week deltas are emitted only when capture was RECORDING for the whole window: `recordingSince(db, kind)` = `MIN(recorded_at)` (not `occurred_at`). PR tiles need it ≤ `weekAgo`; the commits tile needs it ≤ `twoWeeksAgo`, else `sub: "this week"`. *Apply the same rule to every delta later phases add.*
- `fromPullRequest` takes `at = updated_at ?? merged_at ?? closed_at`.
- `RepoContributor.reviews` is `number | null` — `null` until a `review` row was ever captured. *Task 9 sets the count; it must not reintroduce a bare `0`.*
- Backfilled (`provenance='backfill'`) push rows are excluded from the feed and the P tally (still counted in commit totals and bars). An unrecognized `pr` state drops the row.
- `reconcileRepo` runs once per Sync — `isFinalBackfillBatch(res)` in `src/tools/backfill.ts` — and its counts join the `/admin/backfill` response as `repo`.
- The webhook response gained `repo: {captured, unchanged}`; five exact-`toEqual` assertions in `webhook` / `progress` / `summarize` tests were updated. *Every later change to that response shape must grep for them.*
- `test/env.d.ts` must declare each new `Env` var a test passes to a narrowly-typed function (TS2559 weak-type check) — relevant to Tasks 16–18's new secrets.

**Do FIRST in Phase 2 (parked with rulings in Phase 1):**
1. Add the missing test by name: a webhook-only `pr` row with no `prs_reconciled` marker leaves the merged-PR fallback tiles in place. (Verified live and by inspection; not yet pinned.)
2. Push `occurred_at` → `repository.pushed_at` (unix seconds in the push payload) instead of the head commit's timestamp: a rebase or cherry-pick currently lands commits in an old day bucket, and it is the root of the backfill-shadowing edge. Changes `test/fixtures/gh-push.json` and Task 2's assertions — do it before Task 7 adds arms.
3. `src/repo/reads.ts`: the three window-function reads are `SELECT *` (including `raw`) over every `pr` row with no bound. `synchronize` fires per push to any PR branch. Project only needed columns and bound the scan before volume matters; decide `pr`/`push` retention (today `pruneRepoCapture` covers only `check`).
4. If a Sync hits `MAX_BACKFILL_BATCHES` (10) while still summarizing, no batch is "final" and the reconcile is skipped until the next click — run it on the capped last batch too, and fix CLAUDE.md's "once per Sync" wording.
5. The admin route has no `fetchImpl` seam, so "reconcile on the final batch only" is unit-tested as a pure helper, not end-to-end. Task 13 moves the reconcile into cron, where `handleRepoCron` does take `fetchImpl` — cover it there.
6. Small: hoist `obj`/`str`/`num` in `capture.ts` when Task 7 adds arms; use `db.ts` `ph()` in `store.ts`; comment that `opts.fetchImpl`/`waitUntil` become live in Task 8.

---

# Phase 2 — Deploys, checks, CI runs, reviews (sources C, D, E, F)

**Blocked on the owner adding five webhook events** (see External prerequisites). The code can merge first — unsubscribed events simply never arrive — but nothing lights up until they do. Lights up: environment cards (both deployables), deploy dots, "CI on head", CI failures + 7-day rate, PR checks icon, APPROVED chip, reviews in feed and contributors.

### Task 7: Capture arms for reviews, deployments, check runs and workflow runs (pure)

**Files:**
- Modify: `src/repo/capture.ts`, `src/webhook.ts` (`REPO_EVENT_NAMES`)
- Create: `test/fixtures/gh-deployment-status.json`, `test/fixtures/gh-check-run.json`, `test/fixtures/gh-workflow-run.json`, `test/fixtures/gh-pr-review.json`
- Test: `test/repo-capture.test.ts` (append)

**Interfaces:**
- Consumes: `repoEventsFromDelivery` (Task 2), `RepoEnvConfig`
- Produces: four new arms. Column contract (later tasks read these):
  - `deploy`: `number`=deployment id, `env`=config key (NULL when the GitHub environment matches no config → row is skipped), `part`="backend", `sha`, `state`=GitHub status (`queued|pending|in_progress|success|failure|error|inactive`), `name`=GitHub environment, `actor_login`=deployment creator, `url`=log url
  - `check`: `number`=check run id, `sha`, `ref`=head branch, `name`, `state`=`pending` (action `created`) or the conclusion (action `completed`), `url`=details url; `env`+`part`="frontend" ONLY when `name === cfg.workerCheck && ref === cfg.branch`
  - `run`: `number`=run id, `name`=workflow name, `ref`, `sha`, `state`=conclusion, `actor_login`, `url`, `count`=run attempt, `title`=NULL (Task 8 fills the failing job)
  - `review`: `number`=PR number, `state`=`approved|changes_requested|commented|dismissed`, `actor_login`=reviewer, `url`

- [ ] **Step 1: Add fixtures**

`test/fixtures/gh-deployment-status.json`:

```json
{
  "action": "created",
  "deployment_status": { "id": 9001, "state": "success", "created_at": "2026-09-20T09:05:34Z", "log_url": "https://railway.com/project/3f90b930/logs", "environment_url": "https://railway.com/project/3f90b930" },
  "deployment": { "id": 7001, "sha": "becdbac09eaf5d7c73b9f27019c0e43c4444dd7b", "ref": "becdbac09eaf5d7c73b9f27019c0e43c4444dd7b", "environment": "Sapling / staging", "created_at": "2026-09-20T09:04:47Z", "creator": { "login": "railway-app[bot]" } }
}
```

`test/fixtures/gh-check-run.json`:

```json
{
  "action": "completed",
  "check_run": {
    "id": 5001, "name": "Workers Builds: frontend-staging", "status": "completed", "conclusion": "success",
    "head_sha": "becdbac09eaf5d7c73b9f27019c0e43c4444dd7b", "details_url": "https://dash.cloudflare.com/x/builds/67d2",
    "started_at": "2026-09-20T09:05:00Z", "completed_at": "2026-09-20T09:06:32Z",
    "app": { "slug": "cloudflare-workers-and-pages" }, "check_suite": { "head_branch": "main" }
  }
}
```

`test/fixtures/gh-workflow-run.json`:

```json
{
  "action": "completed",
  "workflow_run": {
    "id": 35501310333, "name": "e2e (browser lane)", "head_branch": "main", "head_sha": "becdbac09eaf5d7c73b9f27019c0e43c4444dd7b",
    "status": "completed", "conclusion": "failure", "run_attempt": 1, "event": "push",
    "html_url": "https://github.com/SaplingLearn/Sapling/actions/runs/35501310333",
    "updated_at": "2026-09-20T09:20:00Z", "run_started_at": "2026-09-20T09:05:00Z", "actor": { "login": "AndresL230" }
  }
}
```

`test/fixtures/gh-pr-review.json`:

```json
{
  "action": "submitted",
  "review": { "id": 3001, "state": "approved", "submitted_at": "2026-09-20T10:00:00Z", "html_url": "https://github.com/SaplingLearn/sapling/pull/480#pullrequestreview-3001", "user": { "login": "Darkest-Teddy" } },
  "pull_request": { "number": 480 }
}
```

- [ ] **Step 2: Write the failing tests** — append to `test/repo-capture.test.ts`:

```ts
import deployStatus from "./fixtures/gh-deployment-status.json";
import checkRun from "./fixtures/gh-check-run.json";
import workflowRun from "./fixtures/gh-workflow-run.json";
import prReview from "./fixtures/gh-pr-review.json";

describe("repoEventsFromDelivery — deployment_status (Railway backend)", () => {
  it("maps the GitHub environment onto the configured env key", () => {
    const [ev] = repoEventsFromDelivery("deployment_status", deployStatus, ENVS);
    expect(ev).toMatchObject({
      semantic_key: "gh:deploy:7001:success", kind: "deploy", number: 7001, env: "staging", part: "backend",
      sha: "becdbac09eaf5d7c73b9f27019c0e43c4444dd7b", state: "success", name: "Sapling / staging",
      actor_login: "railway-app[bot]", occurred_at: "2026-09-20T09:05:34Z",
    });
  });

  it("skips an environment nobody configured (a preview env is not staging)", () => {
    const other = { ...deployStatus, deployment: { ...deployStatus.deployment, environment: "Sapling / pr-482" } };
    expect(repoEventsFromDelivery("deployment_status", other, ENVS)).toEqual([]);
  });
});

describe("repoEventsFromDelivery — check_run", () => {
  it("a Workers Builds check ON THE ENV BRANCH is a frontend deploy", () => {
    const [ev] = repoEventsFromDelivery("check_run", checkRun, ENVS);
    expect(ev).toMatchObject({ semantic_key: "gh:check:5001:completed", kind: "check", number: 5001, ref: "main", name: "Workers Builds: frontend-staging", state: "success", env: "staging", part: "frontend", occurred_at: "2026-09-20T09:06:32Z" });
  });

  it("the same check on another branch is a preview build — a check, not a deploy", () => {
    const preview = { ...checkRun, check_run: { ...checkRun.check_run, check_suite: { head_branch: "feat/x" } } };
    expect(repoEventsFromDelivery("check_run", preview, ENVS)[0]).toMatchObject({ kind: "check", env: null, part: null });
  });

  it("created → pending; other actions are ignored", () => {
    const created = { action: "created", check_run: { ...checkRun.check_run, status: "queued", conclusion: null, completed_at: null } };
    expect(repoEventsFromDelivery("check_run", created, ENVS)[0]).toMatchObject({ semantic_key: "gh:check:5001:created", state: "pending", occurred_at: "2026-09-20T09:05:00Z" });
    expect(repoEventsFromDelivery("check_run", { ...checkRun, action: "rerequested" }, ENVS)).toEqual([]);
  });
});

describe("repoEventsFromDelivery — workflow_run and pull_request_review", () => {
  it("captures only completed runs, keyed by run + attempt", () => {
    expect(repoEventsFromDelivery("workflow_run", workflowRun, ENVS)[0]).toMatchObject({
      semantic_key: "gh:run:35501310333:1", kind: "run", number: 35501310333, name: "e2e (browser lane)", ref: "main", state: "failure", count: 1, actor_login: "AndresL230",
    });
    expect(repoEventsFromDelivery("workflow_run", { ...workflowRun, action: "requested" }, ENVS)).toEqual([]);
  });

  it("captures a submitted review", () => {
    expect(repoEventsFromDelivery("pull_request_review", prReview, ENVS)[0]).toMatchObject({
      semantic_key: "gh:review:3001:submitted", kind: "review", number: 480, state: "approved", actor_login: "Darkest-Teddy",
    });
  });
});
```

- [ ] **Step 3: Run to verify failure** — `npx vitest run test/repo-capture.test.ts` → FAIL (`undefined` is not an object).

- [ ] **Step 4: Implement** — in `src/repo/capture.ts` rename the dispatcher's `_envs` parameter to `envs`, add the four functions above it, and extend the `switch`:

```ts
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
```

```ts
    case "deployment_status": return fromDeploymentStatus(p, envs);
    case "check_run": return fromCheckRun(p, envs);
    case "workflow_run": return fromWorkflowRun(p);
    case "pull_request_review": return fromReview(p);
```

In `src/webhook.ts` extend the list:

```ts
export const REPO_EVENT_NAMES: readonly string[] = ["pull_request", "push", "pull_request_review", "deployment_status", "check_run", "workflow_run"];
```

- [ ] **Step 5: Run** — `npx vitest run test/repo-capture.test.ts test/webhook.test.ts` → PASS.
- [ ] **Step 6: Commit** — `git commit -am "Capture deployments, check runs, workflow runs and reviews"` (after `git add test/fixtures`).

### Task 8: Name the failing job on a failed run

`workflow_run` says a run failed, not which job. The design's row shows "auth flow · shard 1/2". One jobs lookup per FAILED run, at capture time, off the response path.

**Files:**
- Modify: `src/repo/github.ts`, `src/webhook.ts`
- Test: `test/repo-failed-job.test.ts`

**Interfaces:**
- Consumes: `GhOpts`, `ghJson`
- Produces: `fillFailedJob(db: DB, opts: GhOpts, runId: number, semanticKey: string): Promise<void>` — sets `repo_events.title` to `"<job> · <step>"`; never throws.

- [ ] **Step 1: Failing test** — `test/repo-failed-job.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { first } from "../src/db";
import { ingestRepoEvent } from "../src/consumer";
import { fillFailedJob } from "../src/repo/github";

const jobs = { jobs: [
  { name: "lint", conclusion: "success", steps: [] },
  { name: "e2e", conclusion: "failure", steps: [{ name: "Checkout", conclusion: "success" }, { name: "Run supabase/setup-cli@v1", conclusion: "failure" }, { name: "Teardown", conclusion: "failure" }] },
] };

describe("fillFailedJob", () => {
  it("records the first failing job and its first failing step", async () => {
    await ingestRepoEvent(env.DB, { semantic_key: "gh:run:9:1", kind: "run", number: 9, name: "e2e", state: "failure", raw: "{}", provenance: "webhook", occurred_at: "2026-09-20T09:20:00Z" });
    const fetchImpl = (async (u: RequestInfo | URL) => {
      expect(String(u)).toBe("https://api.github.com/repos/o/r/actions/runs/9/jobs?filter=latest&per_page=100");
      return new Response(JSON.stringify(jobs), { status: 200 });
    }) as typeof fetch;
    await fillFailedJob(env.DB, { token: "t", repo: "o/r", fetchImpl }, 9, "gh:run:9:1");
    expect(await first(env.DB, `SELECT title FROM repo_events WHERE semantic_key = 'gh:run:9:1'`)).toEqual({ title: "e2e · Run supabase/setup-cli@v1" });
  });

  it("leaves the row alone when GitHub fails", async () => {
    await ingestRepoEvent(env.DB, { semantic_key: "gh:run:9:1", kind: "run", number: 9, state: "failure", raw: "{}", provenance: "webhook", occurred_at: "2026-09-20T09:20:00Z" });
    const fetchImpl = (async () => new Response("no", { status: 502 })) as typeof fetch;
    await expect(fillFailedJob(env.DB, { token: "t", repo: "o/r", fetchImpl }, 9, "gh:run:9:1")).resolves.toBeUndefined();
    expect(await first(env.DB, `SELECT title FROM repo_events WHERE semantic_key = 'gh:run:9:1'`)).toEqual({ title: null });
  });
});
```

- [ ] **Step 2: Run → FAIL** (`fillFailedJob` is not exported).

- [ ] **Step 3: Implement** — append to `src/repo/github.ts` (add `run` to the `../db` import):

```ts
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
```

- [ ] **Step 4: Trigger it from the webhook** — in `src/webhook.ts`, inside the repo loop, replace `if (res.outcome === "written") repo.captured++; else repo.unchanged++;` with:

```ts
        if (res.outcome !== "written") { repo.unchanged++; continue; }
        repo.captured++;
        if (ev.kind === "run" && ev.state === "failure" && ev.number && env.GITHUB_SERVICE_TOKEN && env.GITHUB_REPO) {
          const job = fillFailedJob(env.DB, { token: env.GITHUB_SERVICE_TOKEN, repo: env.GITHUB_REPO, fetchImpl: opts?.fetchImpl }, ev.number, ev.semantic_key);
          // Off the response path when the runtime allows; GitHub gives a hook 10s.
          if (opts?.waitUntil) opts.waitUntil(job); else await job;
        }
```

and import `fillFailedJob` from `./repo/github`.

- [ ] **Step 5: Run** — `npx vitest run test/repo-failed-job.test.ts test/webhook.test.ts` → PASS.
- [ ] **Step 6: Commit** — `git commit -am "Name the failing job on a failed workflow run"`.

### Task 9: Two deployables per environment — DTO, reads, projection, screen

**Files:**
- Modify: `shared/repo.ts`, `src/repo/reads.ts`, `src/tools/repo.ts`, `src/routes.ts` (pass envs), `web/src/repo.ts`, `web/src/repo-sample.ts`
- Test: `test/repo-dashboard.deploys.test.ts`, `test/render.repo.test.ts` (append)

**Interfaces:**
- Consumes: capture columns (Task 7), `RepoEnvConfig`
- Produces — DTO (replace the existing `RepoEnv`, `RepoDeployRow`):

```ts
export type RepoPartName = "backend" | "frontend";
export interface RepoEnvPart {
  part: RepoPartName;
  host: "Railway" | "Cloudflare";
  sha: string | null;          // null = no deploy captured for this half yet
  deployedAt: string | null;
  deployedBy: string | null;   // the human who pushed that sha; the bot when unknown
  result: "ok" | "fail" | "cancel" | "running" | null;
}
export interface RepoEnv {
  key: string; name: string; note: string | null;
  tone: RepoTone; pill: string;              // HEALTHY | DEGRADED | FAILING | UNKNOWN
  parts: RepoEnvPart[];
  ci: string; ciTone: RepoTone;              // "All 8 checks passing" | "1 of 8 checks failing — e2e"
  url: string;
}
export interface RepoDeployRow { env: string; part: RepoPartName; label: string; deploys: RepoDeploy[] }
```

- `getRepoDashboard(db, repo, now?, envs?: RepoEnvConfig[])` — 4th parameter, default `[]`.
- reads: `deployHistory(db, envKey, part, limit): Promise<RepoDeploy[]>` (oldest→newest), `branchHead(db, branch): Promise<string|null>`, `headChecks(db, sha): Promise<{name:string; state:string}[]>`, `pusherOf(db, sha): Promise<string|null>`, `checksBySha(db, shas: string[]): Promise<Map<string,"pass"|"fail"|"run">>`, `approvedPrs(db, numbers: number[]): Promise<Set<number>>`, `ciFailureRows(db, sinceIso, limit)`, `ciDailyRates(db, now): Promise<number[]>`, `reviewRowsSince(db, sinceIso)`.

- [ ] **Step 1: Failing test** — `test/repo-dashboard.deploys.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { ingestRepoEvent } from "../src/consumer";
import { getRepoDashboard } from "../src/tools/repo";
import type { RepoEvent } from "../src/repo/types";
import { ENVS } from "./helpers/repo";

const NOW = Date.parse("2026-09-20T12:00:00Z");
const at = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString();
const put = async (rows: RepoEvent[]) => { for (const r of rows) await ingestRepoEvent(env.DB, r); };
const base = { raw: "{}", provenance: "webhook" as const };
const deploy = (id: number, state: string, sha: string, mins: number, envKey = "staging"): RepoEvent =>
  ({ ...base, semantic_key: `gh:deploy:${id}:${state}`, kind: "deploy", number: id, env: envKey, part: "backend", sha, state, actor_login: "railway-app[bot]", occurred_at: at(mins) });
const check = (id: number, name: string, state: string, sha: string, mins: number, over: Partial<RepoEvent> = {}): RepoEvent =>
  ({ ...base, semantic_key: `gh:check:${id}:${state === "pending" ? "created" : "completed"}`, kind: "check", number: id, name, state, sha, ref: "main", occurred_at: at(mins), ...over });
const ok = <T>(s: { status: string; data?: T }): T => { expect(s.status).toBe("ok"); return (s as { data: T }).data; };

describe("environment cards", () => {
  it("not_connected until an environment is configured AND something deployed", async () => {
    expect((await getRepoDashboard(env.DB, "o/r", NOW, ENVS)).environments.status).toBe("not_connected");
  });

  it("shows both deployables, resolves the bot to the pusher, and summarises head checks", async () => {
    await put([
      { ...base, semantic_key: "gh:push:abc:main", kind: "push", ref: "main", sha: "abc", actor_login: "AndresL230", count: 1, occurred_at: at(30) },
      deploy(1, "in_progress", "abc", 28), deploy(1, "success", "abc", 26),
      check(10, "Workers Builds: frontend-staging", "success", "abc", 25, { env: "staging", part: "frontend" }),
      check(11, "Backend (pytest)", "success", "abc", 24),
      check(12, "e2e", "failure", "abc", 20),
    ]);
    const [staging, production] = ok((await getRepoDashboard(env.DB, "o/r", NOW, ENVS)).environments);
    expect(staging).toMatchObject({ key: "staging", name: "staging", note: "main", pill: "DEGRADED", tone: "warn", ci: "1 of 3 checks failing — e2e", ciTone: "bad", url: "https://staging.saplinglearn.com" });
    expect(staging.parts).toEqual([
      { part: "backend", host: "Railway", sha: "abc", deployedAt: at(26), deployedBy: "AndresL230", result: "ok" },
      { part: "frontend", host: "Cloudflare", sha: "abc", deployedAt: at(25), deployedBy: "AndresL230", result: "ok" },
    ]);
    // Production has no capture yet: the card exists, honestly empty.
    expect(production).toMatchObject({ pill: "UNKNOWN", tone: "neutral", ci: "No checks captured" });
    expect(production.parts.map((p) => p.sha)).toEqual([null, null]);
  });

  it("a superseded deploy (success → inactive) still counts as deployed; a never-succeeded one is cancelled", async () => {
    await put([deploy(1, "success", "a", 300), deploy(1, "inactive", "a", 200), deploy(2, "in_progress", "b", 190), deploy(2, "inactive", "b", 180), deploy(3, "failure", "c", 100), deploy(4, "success", "d", 10)]);
    const rows = ok((await getRepoDashboard(env.DB, "o/r", NOW, ENVS)).deploys);
    const backend = rows.find((r) => r.env === "staging" && r.part === "backend")!;
    expect(backend.label).toBe("staging · api");
    expect(backend.deploys.map((d) => [d.sha, d.result])).toEqual([["a", "ok"], ["b", "cancel"], ["c", "fail"], ["d", "ok"]]);
  });
});

describe("CI failures", () => {
  it("lists failed runs with their job, and a 7-day rate over decisive runs only", async () => {
    const run = (id: number, state: string, mins: number, title: string | null = null): RepoEvent =>
      ({ ...base, semantic_key: `gh:run:${id}:1`, kind: "run", number: id, name: "e2e (browser lane)", ref: "main", sha: "abc", state, title, url: `https://github.com/o/r/actions/runs/${id}`, occurred_at: at(mins) });
    await put([run(1, "success", 500), run(2, "success", 400), run(3, "failure", 60, "e2e · Run supabase/setup-cli@v1"), run(4, "cancelled", 30), run(5, "success", 20)]);
    const f = ok((await getRepoDashboard(env.DB, "o/r", NOW, ENVS)).ciFailures);
    expect(f.rate).toBe(25);                     // 1 failure / 4 decisive (cancelled excluded)
    expect(f.trend).toHaveLength(7);
    expect(f.rows).toEqual([{ workflow: "e2e (browser lane)", branch: "main", job: "e2e · Run supabase/setup-cli@v1", at: at(60), url: "https://github.com/o/r/actions/runs/3" }]);
  });
});
```

- [ ] **Step 2: Run → FAIL** (`getRepoDashboard` ignores the 4th argument; `environments` stays `not_connected`).

- [ ] **Step 3: Reads** — append to `src/repo/reads.ts`:

```ts
import type { RepoDeploy } from "@shared/repo";

const DECISIVE = ["success", "failure", "timed_out"];

/** Last `limit` deploys for one half of one environment, OLDEST first (the dots read left→right). */
export async function deployHistory(db: DB, envKey: string, part: "backend" | "frontend", limit: number): Promise<RepoDeploy[]> {
  // One deployment (backend) or check run (frontend) = several status rows; fold them.
  const rows = await all<{ number: number; sha: string | null; states: string; at: string; actor: string | null }>(db,
    `SELECT number, MAX(sha) AS sha, GROUP_CONCAT(state) AS states, MAX(occurred_at) AS at, MAX(actor_login) AS actor
       FROM repo_events WHERE kind = ? AND env = ? AND part = ? GROUP BY number ORDER BY MIN(occurred_at) DESC LIMIT ?`,
    part === "backend" ? "deploy" : "check", envKey, part, limit);
  const out: RepoDeploy[] = [];
  for (const r of rows.reverse()) {
    const s = r.states.split(",");
    const result = s.includes("success") ? "ok" : s.some((x) => x === "failure" || x === "error" || x === "timed_out") ? "fail"
      : s.some((x) => x === "inactive" || x === "cancelled") ? "cancel" : null;
    if (!result) continue; // still running — not a dot yet
    out.push({ sha: (r.sha ?? "").slice(0, 7), at: r.at, by: (r.sha ? await pusherOf(db, r.sha) : null) ?? r.actor ?? "unknown", result });
  }
  return out;
}

/** Who pushed this commit — the human behind a bot's deployment. */
export async function pusherOf(db: DB, sha: string): Promise<string | null> {
  const row = await first<{ actor_login: string | null }>(db, `SELECT actor_login FROM repo_events WHERE kind = 'push' AND sha = ? ORDER BY id ASC LIMIT 1`, sha);
  return row?.actor_login ?? null;
}

export async function branchHead(db: DB, branch: string): Promise<string | null> {
  const row = await first<{ sha: string | null }>(db, `SELECT sha FROM repo_events WHERE kind = 'push' AND ref = ? ORDER BY occurred_at DESC, id DESC LIMIT 1`, branch);
  return row?.sha ?? null;
}

/** The latest state of every check on a commit (a re-run supersedes its earlier result). */
export async function headChecks(db: DB, sha: string): Promise<{ name: string; state: string }[]> {
  return all<{ name: string; state: string }>(db,
    `SELECT name, state FROM (
       SELECT name, state, ROW_NUMBER() OVER (PARTITION BY name ORDER BY occurred_at DESC, id DESC) AS rn
         FROM repo_events WHERE kind = 'check' AND sha = ?
     ) WHERE rn = 1 ORDER BY name`, sha);
}

export async function checksBySha(db: DB, shas: string[]): Promise<Map<string, "pass" | "fail" | "run">> {
  const out = new Map<string, "pass" | "fail" | "run">();
  for (const sha of [...new Set(shas)]) {
    const checks = await headChecks(db, sha);
    if (!checks.length) continue;
    out.set(sha, checks.some((c) => c.state === "failure" || c.state === "timed_out") ? "fail" : checks.some((c) => c.state === "pending") ? "run" : "pass");
  }
  return out;
}

/** PRs whose latest review per reviewer includes an approval and no standing change request. */
export async function approvedPrs(db: DB, numbers: number[]): Promise<Set<number>> {
  if (!numbers.length) return new Set();
  const rows = await all<{ number: number; state: string }>(db,
    `SELECT number, state FROM (
       SELECT number, state, ROW_NUMBER() OVER (PARTITION BY number, actor_login ORDER BY occurred_at DESC, id DESC) AS rn
         FROM repo_events WHERE kind = 'review' AND state IN ('approved','changes_requested','dismissed')
          AND number IN (${numbers.map(() => "?").join(",")})
     ) WHERE rn = 1`, ...numbers);
  const blocked = new Set(rows.filter((r) => r.state === "changes_requested").map((r) => r.number));
  return new Set(rows.filter((r) => r.state === "approved" && !blocked.has(r.number)).map((r) => r.number));
}

export async function ciFailureRows(db: DB, sinceIso: string, limit: number): Promise<RepoEventRow[]> {
  return all<RepoEventRow>(db, `SELECT * FROM repo_events WHERE kind = 'run' AND state IN ('failure','timed_out') AND occurred_at > ? ORDER BY occurred_at DESC LIMIT ?`, sinceIso, limit);
}

/** Failure rate (%) per UTC day for the last 7 days, oldest first; cancelled/skipped runs are not decisive. */
export async function ciDailyRates(db: DB, now: number): Promise<{ days: number[]; rate: number }> {
  const since = new Date(now - 7 * 86_400_000).toISOString();
  const rows = await all<{ day: string; state: string; n: number }>(db,
    `SELECT substr(occurred_at, 1, 10) AS day, state, COUNT(*) AS n FROM repo_events
      WHERE kind = 'run' AND occurred_at > ? AND state IN (${DECISIVE.map(() => "?").join(",")}) GROUP BY day, state`, since, ...DECISIVE);
  let bad = 0, total = 0;
  const days: number[] = [];
  for (let i = 6; i >= 0; i--) {
    const day = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
    const of = rows.filter((r) => r.day === day);
    const t = of.reduce((n, r) => n + r.n, 0);
    const b = of.filter((r) => r.state !== "success").reduce((n, r) => n + r.n, 0);
    bad += b; total += t;
    days.push(t ? Math.round((b / t) * 1000) / 10 : 0);
  }
  return { days, rate: total ? Math.round((bad / total) * 1000) / 10 : 0 };
}

export async function reviewRowsSince(db: DB, sinceIso: string): Promise<RepoEventRow[]> {
  return all<RepoEventRow>(db, `SELECT * FROM repo_events WHERE kind = 'review' AND occurred_at > ? ORDER BY occurred_at DESC`, sinceIso);
}
```

- [ ] **Step 4: DTO** — in `shared/repo.ts` replace `RepoEnv` and `RepoDeployRow` with the definitions in **Interfaces** above (add `RepoPartName`, `RepoEnvPart`).

- [ ] **Step 5: Assemble** — in `src/tools/repo.ts`:

Change the signature to `export async function getRepoDashboard(db: DB, repo: string, now: number = Date.now(), envs: RepoEnvConfig[] = []): Promise<RepoDashboard>` and remove `environments`, `deploys`, `ciFailures` from `UNCAPTURED`. Add (before the return):

```ts
  // ── environments: two deployables each (Railway backend, Cloudflare frontend) ─
  const HOSTS = { backend: "Railway", frontend: "Cloudflare" } as const;
  const deployRows: RepoDeployRow[] = [];
  const envCards: RepoEnv[] = [];
  for (const cfg of envs) {
    const parts: RepoEnvPart[] = [];
    for (const part of ["backend", "frontend"] as const) {
      const history = await deployHistory(db, cfg.key, part, 10);
      if (history.length) deployRows.push({ env: cfg.key, part, label: `${cfg.label} · ${part === "backend" ? "api" : "web"}`, deploys: history });
      const last = history[history.length - 1] ?? null;
      parts.push({ part, host: HOSTS[part], sha: last?.sha ?? null, deployedAt: last?.at ?? null, deployedBy: last?.by ?? null, result: last?.result ?? null });
    }
    const head = await branchHead(db, cfg.branch);
    const checks = head ? await headChecks(db, head) : [];
    const failing = checks.filter((c) => c.state === "failure" || c.state === "timed_out").map((c) => c.name);
    const settled = checks.filter((c) => c.state !== "pending");
    const ci = !checks.length ? "No checks captured"
      : failing.length ? `${failing.length} of ${checks.length} checks failing — ${failing[0]}`
      : settled.length < checks.length ? `${settled.length} of ${checks.length} checks finished`
      : `All ${checks.length} checks passing`;
    const known = parts.some((p) => p.result !== null) || checks.length > 0;
    const failed = parts.some((p) => p.result === "fail");
    envCards.push({
      key: cfg.key, name: cfg.label, note: cfg.note, parts, url: cfg.frontendUrl, ci,
      ciTone: !checks.length ? "neutral" : failing.length ? "bad" : "good",
      pill: !known ? "UNKNOWN" : failed ? "FAILING" : failing.length ? "DEGRADED" : "HEALTHY",
      tone: !known ? "neutral" : failed ? "bad" : failing.length ? "warn" : "good",
    });
  }
  const anyDeployCapture = envCards.some((e) => e.pill !== "UNKNOWN");

  const ci = await ciDailyRates(db, now);
  const failureRows = await ciFailureRows(db, weekAgo, 5);
  const runCaptured = await hasCaptured(db, "run");
```

and in the returned object:

```ts
    environments: envs.length && anyDeployCapture ? ok(envCards) : NOT_CONNECTED,
    deploys: deployRows.length ? ok(deployRows) : envs.length && anyDeployCapture ? EMPTY : NOT_CONNECTED,
    ciFailures: runCaptured
      ? ok({ rate: ci.rate, trend: ci.days, rows: failureRows.map((r) => ({ workflow: r.name ?? "workflow", branch: r.ref ?? "", job: r.title ?? "—", at: r.occurred_at, url: r.url ?? "" })) })
      : NOT_CONNECTED,
```

Upgrade the PR list with checks + approvals — replace the `capturedPrs` mapping from Task 4:

```ts
  const prRows = prCaptured ? await recentPrRows(db, PR_LIMIT) : [];
  const checkBySha = await checksBySha(db, prRows.map((r) => r.sha ?? "").filter(Boolean));
  const approved = await approvedPrs(db, prRows.filter((r) => r.state === "review").map((r) => r.number ?? 0));
  const capturedPrs: RepoPr[] = prCaptured
    ? prRows.map((r) => ({
        number: r.number ?? 0, title: r.title ?? `PR #${r.number}`, url: r.url ?? "",
        author: personOf(people, r.actor_login ?? "unknown"), branch: r.ref,
        state: r.state === "review" && approved.has(r.number ?? -1) ? "approved"
          : (PR_STATES as readonly string[]).includes(r.state ?? "") ? (r.state as RepoPr["state"]) : "review",
        checks: checkBySha.get(r.sha ?? "") ?? null, at: r.occurred_at,
      }))
    : listPrs.map((p) => prOf(people, p));
```

"Awaiting review" now excludes approved PRs — replace `awaiting` with a version that takes the approved set:

```ts
  const approvedNow = await approvedPrs(db, prsNow.map((r) => r.number ?? 0));
  const awaiting = (rows: RepoEventRow[], done: Set<number> = new Set()) => rows.filter((r) => r.state === "review" && !done.has(r.number ?? -1)).length;
```

and use `awaiting(prsNow, approvedNow)` for the current value (the week-ago value keeps the no-approval form — review history before capture began is unknowable).

Add reviews and deploys to the feed and the contributor tally:

```ts
  const reviews = await reviewRowsSince(db, twoWeeksAgo);
  for (const r of reviews.filter((x) => x.occurred_at > weekAgo)) if (r.actor_login) bump(r.actor_login, "reviews");
  const REVIEW_TEXT: Record<string, string> = { approved: "approved", changes_requested: "requested changes on", commented: "commented on", dismissed: "dismissed a review on" };
  const reviewActivity: RepoActivity[] = reviews.slice(0, ACTIVITY_LIMIT).map((r) => ({
    kind: "review" as const, actor: r.actor_login ? personOf(people, r.actor_login) : null,
    text: `${REVIEW_TEXT[r.state ?? "commented"] ?? "reviewed"} #${r.number}`, url: r.url, at: r.occurred_at,
  }));
  const deployActivity: RepoActivity[] = deployRows.flatMap((row) => row.deploys.filter((d) => d.result === "ok").map((d) => ({
    kind: "deploy" as const, actor: null, text: `${d.sha} deployed to ${row.label}`, url: null, at: d.at,
  })));
```

and concat both into `activity`. (Move the `bump` calls so the reviews loop runs before `contributors` is built.)

Imports to add: `deployHistory, branchHead, headChecks, checksBySha, approvedPrs, ciFailureRows, ciDailyRates, reviewRowsSince` from `../repo/reads`; `RepoEnvConfig` from `../repo/config`; `RepoEnv, RepoEnvPart, RepoDeployRow` from `@shared/repo`.

In `src/routes.ts` pass the config: `getRepoDashboard(c.env.DB, repo, Date.now(), repoEnvironments(c.env))`.

- [ ] **Step 6: Screen** — in `web/src/repo.ts` `overviewTab`, replace the single `kv("Deployed", …)` row with one row per part:

```ts
        ${e.parts.map((pt) => kv(pt.part === "backend" ? "Backend" : "Frontend",
          pt.sha
            ? `<div style="font-size:13.5px;line-height:1.6;color:var(--fg-70);display:flex;align-items:center;gap:9px;flex-wrap:wrap"><span style="${CODE}">${esc(pt.sha)}</span><span style="font-size:12px;color:var(--fg-40);white-space:nowrap">${esc(ago(pt.deployedAt ?? "", now))} ago · by ${esc(pt.deployedBy ?? "unknown")} · ${pt.host}</span>${pt.result === "fail" ? `<span style="font-family:var(--mono);font-size:10px;font-weight:600;color:var(--red)">FAILED</span>` : ""}</div>`
            : `<div style="font-size:12.5px;color:var(--fg-40)">No ${pt.host} deploy captured yet</div>`)).join("")}
```

use `e.ciTone` for the CI row's color (`TONE[e.ciTone]`, glyph `✓` when `good`, `✕` when `bad`, `●` otherwise), and label deploy rows with `row.label` instead of `row.env` in `ciTab` (widen the label cell from `64px` to `118px`). In `web/src/repo-sample.ts` rewrite `environments` and `deploys` to the new shape — staging: backend `a3f82c1`/26m/dev-raj + frontend `a3f82c1`/24m/dev-raj, `ci: "1 of 6 checks failing — e2e-smoke"`, `ciTone: "bad"`; production likewise healthy; four deploy rows labelled `staging · api`, `staging · web`, `production · api`, `production · web` (reuse the two existing dot arrays for api; copy them with the last entry's time shifted +2 minutes for web).

Append to `test/render.repo.test.ts`:

```ts
it("an environment card shows a line per deployable and says when one has no capture", () => {
  const data = live({ environments: { status: "ok", data: [{ key: "staging", name: "staging", note: "main", tone: "good", pill: "HEALTHY", ci: "All 8 checks passing", ciTone: "good", url: "https://staging.saplinglearn.com",
    parts: [{ part: "backend", host: "Railway", sha: "abc1234", deployedAt: new Date().toISOString(), deployedBy: "AndresL230", result: "ok" }, { part: "frontend", host: "Cloudflare", sha: null, deployedAt: null, deployedBy: null, result: null }] }] } });
  const html = repoView(props({ repo: { status: "ok", data } }));
  expect(html).toContain("Backend");
  expect(html).toContain("by AndresL230 · Railway");
  expect(html).toContain("No Cloudflare deploy captured yet");
});
```

- [ ] **Step 7: Run** — `npx vitest run test/repo-dashboard.deploys.test.ts test/repo-dashboard.test.ts test/render.repo.test.ts && npm run typecheck` → PASS.
- [ ] **Step 8: Commit** — `git commit -am "Show both deployables per environment, CI failures and check state"`.

### Task 10: Reconcile deployments, runs and head checks; Phase 2 close-out

**Files:** Modify `src/repo/github.ts`; Test `test/repo-reconcile.test.ts` (append).

**Interfaces:** `reconcileRepo` gains three more `safely` blocks; signature unchanged.

- [ ] **Step 1: Failing test** — append:

```ts
it("backfills Railway deployments with their statuses, recent runs, and env-head checks", async () => {
  const gh = fakeGithub({
    "/deployments?": [{ id: 7001, sha: "becdbac", ref: "becdbac", environment: "Sapling / staging", created_at: "2026-09-20T09:04:47Z", creator: { login: "railway-app[bot]" } }],
    "/deployments/7001/statuses": [{ id: 2, state: "success", created_at: "2026-09-20T09:05:34Z", log_url: "https://railway.com/l" }, { id: 1, state: "in_progress", created_at: "2026-09-20T09:04:47Z", log_url: null }],
    "/actions/runs?": { workflow_runs: [{ id: 99, name: "CI", head_branch: "main", head_sha: "becdbac", status: "completed", conclusion: "success", run_attempt: 1, event: "push", html_url: "https://github.com/o/r/actions/runs/99", updated_at: "2026-09-20T09:10:00Z", run_started_at: "2026-09-20T09:05:00Z", actor: { login: "AndresL230" } }] },
    "/commits/main/check-runs": { check_runs: [{ id: 5001, name: "Workers Builds: frontend-staging", status: "completed", conclusion: "success", head_sha: "becdbac", details_url: "https://dash", started_at: "2026-09-20T09:05:00Z", completed_at: "2026-09-20T09:06:32Z", app: { slug: "cloudflare-workers-and-pages" }, check_suite: { head_branch: "main" } }] },
  });
  await reconcileRepo(env.DB, { token: "t", repo: "o/r", fetchImpl: gh.fetchImpl }, ENVS, NOW);
  const kinds = await all<{ kind: string; n: number }>(env.DB, `SELECT kind, COUNT(*) AS n FROM repo_events GROUP BY kind ORDER BY kind`);
  expect(kinds).toEqual([{ kind: "check", n: 1 }, { kind: "deploy", n: 2 }, { kind: "run", n: 1 }]);
  // The check-runs list omits check_suite.head_branch reliably only per-ref: the branch we ASKED for is the branch.
  expect(await all(env.DB, `SELECT env, part FROM repo_events WHERE kind = 'check'`)).toEqual([{ env: "staging", part: "frontend" }]);
});
```

- [ ] **Step 2: Run → FAIL** (only `pr`/`push` kinds written).

- [ ] **Step 3: Implement** — the API list shapes equal the webhook's inner objects, so reuse the pure arms by re-wrapping. Add `import { repoEventsFromDelivery } from "./capture";` and, inside `reconcileRepo` before `return out;`:

```ts
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

  await safely(async () => {
    const { workflow_runs } = await ghJson<{ workflow_runs: Record<string, unknown>[] }>(opts, `/actions/runs?status=completed&per_page=100`);
    for (const workflow_run of workflow_runs) await take(asBackfill(repoEventsFromDelivery("workflow_run", { action: "completed", workflow_run }, envs)));
  });

  // Head checks per environment branch — also the frontend deploy record.
  for (const cfg of envs) {
    await safely(async () => {
      const { check_runs } = await ghJson<{ check_runs: Record<string, unknown>[] }>(opts, `/commits/${encodeURIComponent(cfg.branch)}/check-runs?per_page=100`);
      for (const cr of check_runs) {
        if (cr.status !== "completed") continue;
        const check_run = { ...cr, check_suite: { head_branch: cfg.branch } }; // we asked by branch; the list item may omit it
        await take(asBackfill(repoEventsFromDelivery("check_run", { action: "completed", check_run }, envs)));
      }
    });
  }
```

- [ ] **Step 4: Run** — `npx vitest run test/repo-reconcile.test.ts` → PASS.
- [ ] **Step 5: Close-out** — update `CLAUDE.md` (move environments / deploys / CI failures / checks to the live list; document the two-deployable rule and that a Workers Builds check is a deploy only on the env branch). `npm run typecheck && npm test`. Open the PR. **After merge, the owner adds the five webhook events**, then an admin clicks Sync GitHub once to backfill.
- [ ] **Step 6: Commit** — `git commit -am "Reconcile deployments, workflow runs and head checks"`.

---

# Phase 3 — Drift, branches, health (sources G, H, I)

No GitHub settings change, no new secret. Lights up: drift strip, branches list + Active branches tile, health block, and health feeding the HEALTHY/DEGRADED pill.

### Task 11: Drift snapshot — `production...main`, grouped by PR

**Files:** Modify `src/repo/github.ts`, `src/webhook.ts`, `src/tools/repo.ts`; Test `test/repo-drift.test.ts`.

**Interfaces:**
- Consumes: `GhOpts`, `ghJson`, `putSnapshot`/`getSnapshot`, `RepoDrift` (`shared/repo.ts`, unchanged: `{ head, base, ahead, behind, groups }`)
- Produces: `refreshDrift(db: DB, opts: GhOpts, envs: RepoEnvConfig[]): Promise<void>` — compares `envs[0].branch` (head, e.g. `main`) against `envs[envs.length-1].branch` (base, e.g. `production`) and stores snapshot kind `"drift"`. No-op with fewer than two environments. Never throws.

- [ ] **Step 1: Failing test** — `test/repo-drift.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { refreshDrift } from "../src/repo/github";
import { getSnapshot } from "../src/repo/store";
import { ingestRepoEvent } from "../src/consumer";
import type { RepoDrift } from "@shared/repo";
import { ENVS } from "./helpers/repo";

const c = (sha: string, message: string, date: string, login = "AndresL230") => ({ sha, commit: { message, committer: { date } }, author: { login } });

describe("refreshDrift", () => {
  it("groups ahead commits by squash-merge PR number, keeps direct pushes and the behind side apart", async () => {
    await ingestRepoEvent(env.DB, { semantic_key: "gh:prs:482:opened:x", kind: "pr", number: 482, state: "merged", title: "Batch D1 reads in usage rollup", actor_login: "lpcooper-arch", raw: "{}", provenance: "webhook", occurred_at: "2026-09-20T08:00:00Z" });
    const fetchImpl = (async (u: RequestInfo | URL) => {
      const url = String(u);
      if (url.endsWith("/compare/production...main")) return new Response(JSON.stringify({ ahead_by: 3, behind_by: 1, commits: [
        c("c91d2aeXXXX", "rollup: batch D1 reads (#482)", "2026-09-20T09:00:00Z", "lpcooper-arch"),
        c("b02f1cdXXXX", "fix window math (#482)", "2026-09-20T09:30:00Z", "lpcooper-arch"),
        c("7f92b45XXXX", "docs: note D1 batch limits", "2026-09-20T07:00:00Z"),
      ] }), { status: 200 });
      if (url.endsWith("/compare/main...production")) return new Response(JSON.stringify({ ahead_by: 1, behind_by: 3, commits: [c("2f19c3aXXXX", "hotfix: clamp digest window", "2026-09-20T06:00:00Z")] }), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    await refreshDrift(env.DB, { token: "t", repo: "o/r", fetchImpl }, ENVS);
    const snap = await getSnapshot<RepoDrift>(env.DB, "drift");
    expect(snap?.data).toMatchObject({ head: "main", base: "production", ahead: 3, behind: 1 });
    expect(snap?.data.groups.map((g) => [g.tag, g.kind, g.title, g.commits.length])).toEqual([
      ["#482", "pr", "Batch D1 reads in usage rollup", 2],
      ["PUSH", "push", "Direct pushes to main", 1],
      ["BEHIND", "behind", "Only on production — not yet on main", 1],
    ]);
    expect(snap?.data.groups[0].commits[0]).toEqual({ sha: "b02f1cd", msg: "fix window math (#482)", at: "2026-09-20T09:30:00Z" });
    expect(snap?.data.groups[0].meta).toBe("lpcooper-arch · 2 commits");
  });

  it("keeps the previous snapshot when GitHub fails", async () => {
    const fetchImpl = (async () => new Response("no", { status: 500 })) as typeof fetch;
    await expect(refreshDrift(env.DB, { token: "t", repo: "o/r", fetchImpl }, ENVS)).resolves.toBeUndefined();
    expect(await getSnapshot(env.DB, "drift")).toBeNull();
  });
});
```

- [ ] **Step 2: Run → FAIL** (`refreshDrift` not exported).

- [ ] **Step 3: Implement** — append to `src/repo/github.ts` (import `putSnapshot` from `./store`, `all` from `../db`, types `RepoDrift`, `RepoDriftGroup` from `@shared/repo`):

```ts
interface GhCompare { ahead_by: number; behind_by: number; commits: GhCommit[] }
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export async function refreshDrift(db: DB, opts: GhOpts, envs: RepoEnvConfig[]): Promise<void> {
  if (envs.length < 2) return;
  const head = envs[0].branch;
  const base = envs[envs.length - 1].branch;
  if (head === base) return;
  try {
    // GitHub returns only the AHEAD side's commits, so the behind side is a second compare.
    const ahead = await ghJson<GhCompare>(opts, `/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
    const behind = ahead.behind_by > 0 ? await ghJson<GhCompare>(opts, `/compare/${encodeURIComponent(head)}...${encodeURIComponent(base)}`) : null;

    const toCommit = (c: GhCommit) => ({ sha: c.sha.slice(0, 7), msg: c.commit.message.split("\n")[0].slice(0, 160), at: c.commit.committer.date });
    const newestFirst = <T extends { at: string }>(rows: T[]) => rows.sort((a, b) => (a.at < b.at ? 1 : -1));

    // A squash merge ends "(#123)" — the repo's merge style. Anything else is a direct push.
    const byPr = new Map<number, GhCommit[]>();
    const direct: GhCommit[] = [];
    for (const c of ahead.commits) {
      const m = c.commit.message.split("\n")[0].match(/\(#(\d+)\)\s*$/);
      if (m) byPr.set(Number(m[1]), [...(byPr.get(Number(m[1])) ?? []), c]); else direct.push(c);
    }
    const numbers = [...byPr.keys()];
    const titles = numbers.length
      ? await all<{ number: number; title: string | null; actor_login: string | null }>(db,
          `SELECT number, MAX(title) AS title, MAX(actor_login) AS actor_login FROM repo_events WHERE kind = 'pr' AND number IN (${numbers.map(() => "?").join(",")}) GROUP BY number`, ...numbers)
      : [];

    const groups: RepoDriftGroup[] = [];
    for (const [number, commits] of [...byPr.entries()].sort((a, b) => b[0] - a[0])) {
      const known = titles.find((t) => t.number === number);
      groups.push({
        tag: `#${number}`, kind: "pr", title: known?.title ?? commits[0].commit.message.split("\n")[0],
        meta: `${known?.actor_login ?? commits[0].author?.login ?? "unknown"} · ${plural(commits.length, "commit")}`,
        commits: newestFirst(commits.map(toCommit)),
      });
    }
    if (direct.length) groups.push({ tag: "PUSH", kind: "push", title: `Direct pushes to ${head}`, meta: plural(direct.length, "commit"), commits: newestFirst(direct.map(toCommit)) });
    if (behind?.commits.length) groups.push({ tag: "BEHIND", kind: "behind", title: `Only on ${base} — not yet on ${head}`, meta: plural(behind.commits.length, "commit"), commits: newestFirst(behind.commits.map(toCommit)) });

    const drift: RepoDrift = { head, base, ahead: ahead.ahead_by, behind: ahead.behind_by, groups };
    await putSnapshot(db, "drift", drift);
  } catch (e) {
    console.error("refreshDrift", e); // the last good snapshot stands
  }
}
```

- [ ] **Step 4: Trigger + project.** In `src/webhook.ts`, inside the repo loop after the `run` block:

```ts
        const cfgs = repoEnvironments(env);
        if (ev.kind === "push" && cfgs.some((c) => c.branch === ev.ref) && env.GITHUB_SERVICE_TOKEN && env.GITHUB_REPO) {
          const drift = refreshDrift(env.DB, { token: env.GITHUB_SERVICE_TOKEN, repo: env.GITHUB_REPO, fetchImpl: opts?.fetchImpl }, cfgs);
          if (opts?.waitUntil) opts.waitUntil(drift); else await drift;
        }
```

In `src/tools/repo.ts` remove `drift` from `UNCAPTURED` and return
`drift: await getSnapshot<RepoDrift>(db, "drift").then((s) => (s ? ok(s.data) : NOT_CONNECTED)),`.

- [ ] **Step 5: Run** — `npx vitest run test/repo-drift.test.ts test/webhook.test.ts test/repo-dashboard.test.ts` → PASS.
- [ ] **Step 6: Commit** — `git commit -am "Snapshot branch drift between the environment branches"`.

### Task 12: Branches snapshot — one GraphQL query

**Files:** Modify `src/repo/github.ts`, `src/tools/repo.ts`; Test `test/repo-branches.test.ts`.

**Interfaces:**
- Produces: `refreshBranches(db: DB, opts: GhOpts, envs: RepoEnvConfig[], now?: number): Promise<void>` → snapshot kind `"branches"` holding `RepoBranches` (`{ active, stale, rows }`, unchanged DTO). Stale = no commit for 14 days.

> **GraphQL gotcha:** `Ref.compare(headRef: "main")` treats THE BRANCH as base and `main` as head. So its `aheadBy` = commits on `main` the branch lacks (the branch is **behind** by that many) and `behindBy` = commits only on the branch (the branch is **ahead**). Invert them.

- [ ] **Step 1: Failing test** — `test/repo-branches.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { refreshBranches } from "../src/repo/github";
import { getSnapshot } from "../src/repo/store";
import type { RepoBranches } from "@shared/repo";
import { ENVS } from "./helpers/repo";

const NOW = Date.parse("2026-09-20T12:00:00Z");
const node = (name: string, date: string, aheadBy: number, behindBy: number) => ({ name, target: { committedDate: date }, compare: { aheadBy, behindBy } });

describe("refreshBranches", () => {
  it("pages refs, inverts compare, flags stale, and leaves the environment branches out", async () => {
    const pages = [
      { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [node("main", "2026-09-20T09:00:00Z", 0, 0), node("feature/usage-rollup", "2026-09-20T11:36:00Z", 0, 4)] },
      { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node("spike/edge-cache", "2026-09-04T00:00:00Z", 31, 7), node("production", "2026-09-18T00:00:00Z", 5, 1)] },
    ];
    let call = 0;
    const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit) => {
      expect(String(u)).toBe("https://api.github.com/graphql");
      expect(JSON.parse(String(init?.body)).variables).toMatchObject({ owner: "o", name: "r", head: "main" });
      return new Response(JSON.stringify({ data: { repository: { refs: pages[call++] } } }), { status: 200 });
    }) as typeof fetch;

    await refreshBranches(env.DB, { token: "t", repo: "o/r", fetchImpl }, ENVS, NOW);
    const snap = (await getSnapshot<RepoBranches>(env.DB, "branches"))!.data;
    expect(snap).toMatchObject({ active: 1, stale: 1 });
    expect(snap.rows).toEqual([
      { name: "feature/usage-rollup", at: "2026-09-20T11:36:00Z", ahead: 4, behind: 0, stale: false },
      { name: "spike/edge-cache", at: "2026-09-04T00:00:00Z", ahead: 7, behind: 31, stale: true },
    ]);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — append to `src/repo/github.ts`:

```ts
const REFS_QUERY = `query($owner:String!,$name:String!,$head:String!,$after:String){
  repository(owner:$owner,name:$name){ refs(refPrefix:"refs/heads/",first:100,after:$after,orderBy:{field:TAG_COMMIT_DATE,direction:DESC}){
    pageInfo{hasNextPage endCursor}
    nodes{ name target{ ... on Commit { committedDate } } compare(headRef:$head){ aheadBy behindBy } } } } }`;
interface RefNode { name: string; target: { committedDate?: string } | null; compare: { aheadBy: number; behindBy: number } | null }
const STALE_DAYS = 14;
const BRANCH_ROWS = 8;

export async function refreshBranches(db: DB, opts: GhOpts, envs: RepoEnvConfig[], now: number = Date.now()): Promise<void> {
  try {
    const [owner, name] = opts.repo.split("/");
    const head = envs[0]?.branch ?? "main";
    const skip = new Set(envs.map((e) => e.branch));
    const nodes: RefNode[] = [];
    let after: string | null = null;
    for (let page = 0; page < 5; page++) { // 500 branches is a ceiling, not a target
      const res = await (opts.fetchImpl ?? fetch)("https://api.github.com/graphql", {
        method: "POST", headers: { ...HEADERS(opts.token), "content-type": "application/json" },
        body: JSON.stringify({ query: REFS_QUERY, variables: { owner, name, head, after } }),
      });
      if (!res.ok) throw new Error(`graphql ${res.status}`);
      const body = (await res.json()) as { data?: { repository?: { refs?: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RefNode[] } } } };
      const refs = body.data?.repository?.refs;
      if (!refs) throw new Error("graphql: no refs");
      nodes.push(...refs.nodes);
      if (!refs.pageInfo.hasNextPage) break;
      after = refs.pageInfo.endCursor;
    }
    const cutoff = new Date(now - STALE_DAYS * DAY).toISOString();
    const rows = nodes.filter((n) => !skip.has(n.name) && n.target?.committedDate).map((n) => ({
      name: n.name, at: n.target!.committedDate!,
      ahead: n.compare?.behindBy ?? 0,   // inverted on purpose — see the gotcha in the plan
      behind: n.compare?.aheadBy ?? 0,
      stale: n.target!.committedDate! < cutoff,
    })).sort((a, b) => (a.at < b.at ? 1 : -1));
    const stale = rows.filter((r) => r.stale);
    const fresh = rows.filter((r) => !r.stale);
    // The list shows the live work first, then the stalest-but-unmerged — the ones worth deleting.
    const shown = [...fresh.slice(0, BRANCH_ROWS - Math.min(3, stale.length)), ...stale.filter((r) => r.ahead > 0).slice(0, 3)];
    await putSnapshot(db, "branches", { active: fresh.length, stale: stale.length, rows: shown });
  } catch (e) {
    console.error("refreshBranches", e);
  }
}
```

- [ ] **Step 4: Project** — in `src/tools/repo.ts` remove `branches` from `UNCAPTURED`; read `const branchSnap = await getSnapshot<RepoBranches>(db, "branches");`; return `branches: branchSnap ? ok(branchSnap.data) : NOT_CONNECTED,`; and make the 4th `codeStats` tile `branchSnap ? { label: "Active branches", value: branchSnap.data.active, sub: `${branchSnap.data.stale} stale`, tone: branchSnap.data.stale ? "warn" : "neutral" } : <the existing Issues closed tile>`.

- [ ] **Step 5: Run → PASS. Step 6: Commit** — `git commit -am "Snapshot branches with ahead/behind in one GraphQL query"`.

### Task 13: Health pings, the 10-minute cron, pruning

**Files:**
- Create: `src/repo/poll.ts`, `src/repo/cron.ts`
- Modify: `src/index.ts` (`scheduled`), `wrangler.toml` (`[triggers]`), `src/tools/repo.ts`
- Test: `test/repo-cron.test.ts`

**Interfaces:**
- Produces:
  - `pingHealth(db: DB, envs: RepoEnvConfig[], now: number, fetchImpl?: typeof fetch): Promise<void>` — two targets per env (`part` `frontend` = `frontendUrl`, `backend` = `apiUrl + healthPath`); writes `health_up` (0/1) and `health_ms`, `at` floored to the 10-minute bucket.
  - `REPO_CRON = "*/10 * * * *"`, `handleRepoCron(env: Env, scheduledTime: number, fetchImpl?: typeof fetch): Promise<void>`

- [ ] **Step 1: Failing test** — `test/repo-cron.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all } from "../src/db";
import { pingHealth } from "../src/repo/poll";
import { handleRepoCron, REPO_CRON } from "../src/repo/cron";
import { getRepoDashboard } from "../src/tools/repo";
import { ENVS } from "./helpers/repo";

const T = Date.parse("2026-09-20T12:07:31Z");

describe("pingHealth", () => {
  it("records up/ms per target in a 10-minute bucket, and a throw as down", async () => {
    const fetchImpl = (async (u: RequestInfo | URL) => {
      if (String(u) === "https://api.saplinglearn.com/api/health") throw new Error("connect timeout");
      return new Response("ok", { status: String(u).includes("staging.sapling") ? 200 : 503 });
    }) as typeof fetch;
    await pingHealth(env.DB, ENVS, T, fetchImpl);
    await pingHealth(env.DB, ENVS, T + 60_000, fetchImpl); // same bucket → no second row
    const up = await all<{ env: string; part: string; value: number; at: string }>(env.DB, `SELECT env, part, value, at FROM repo_metrics WHERE metric = 'health_up' ORDER BY env, part`);
    expect(up).toEqual([
      { env: "production", part: "backend", value: 0, at: "2026-09-20T12:00:00.000Z" },
      { env: "production", part: "frontend", value: 0, at: "2026-09-20T12:00:00.000Z" },
      { env: "staging", part: "backend", value: 1, at: "2026-09-20T12:00:00.000Z" },
      { env: "staging", part: "frontend", value: 1, at: "2026-09-20T12:00:00.000Z" },
    ]);
  });

  it("feeds the health block and drags the pill to DEGRADED when a target is down", async () => {
    const fetchImpl = (async (u: RequestInfo | URL) => new Response("x", { status: String(u).includes("api.staging") ? 500 : 200 })) as typeof fetch;
    await pingHealth(env.DB, ENVS, T, fetchImpl);
    const d = await getRepoDashboard(env.DB, "o/r", T, ENVS);
    expect(d.health.status).toBe("ok");
    const rows = (d.health as { data: { env: string; up: boolean }[] }).data;
    expect(rows.map((r) => [r.env, r.up])).toEqual([["staging · web", true], ["staging · api", false], ["production · web", true], ["production · api", true]]);
  });
});

describe("handleRepoCron", () => {
  it("is the cron expression wrangler.toml declares", () => expect(REPO_CRON).toBe("*/10 * * * *"));

  it("pings every tick; with no service token it does nothing else and never throws", async () => {
    const fetchImpl = (async () => new Response("ok", { status: 200 })) as typeof fetch;
    await handleRepoCron({ ...env, GITHUB_SERVICE_TOKEN: undefined }, T, fetchImpl);
    expect((await all(env.DB, `SELECT 1 FROM repo_metrics WHERE metric = 'health_up'`)).length).toBe(4);
    expect((await all(env.DB, `SELECT 1 FROM repo_snapshots`)).length).toBe(0);
  });
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — `src/repo/poll.ts`:

```ts
// Scheduled pulls for the repo dashboard. Each writes repo_metrics; none may throw
// — a dead target or a bad token costs one data point, never the cron tick.
import type { DB } from "../db";
import type { RepoEnvConfig } from "./config";
import { putMetric } from "./store";

const TEN_MIN = 600_000;
const PING_TIMEOUT_MS = 8_000;

export async function pingHealth(db: DB, envs: RepoEnvConfig[], now: number, fetchImpl: typeof fetch = fetch): Promise<void> {
  const at = new Date(Math.floor(now / TEN_MIN) * TEN_MIN).toISOString();
  for (const cfg of envs) {
    for (const [part, url] of [["frontend", cfg.frontendUrl], ["backend", cfg.apiUrl + cfg.healthPath]] as const) {
      const started = Date.now();
      let up = 0;
      try {
        const res = await fetchImpl(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(PING_TIMEOUT_MS), headers: { "user-agent": "canopy-health" } });
        up = res.ok ? 1 : 0;
      } catch { up = 0; }
      await putMetric(db, { metric: "health_up", env: cfg.key, part, value: up, at });
      await putMetric(db, { metric: "health_ms", env: cfg.key, part, value: Date.now() - started, at });
    }
  }
}
```

`src/repo/cron.ts`:

```ts
// One cron trigger, three cadences. Cloudflare bills triggers per Worker and this
// one replaced "0 */6 * * *", so the count stays at three; the cadence lives here.
import type { Env } from "../env";
import { recomputeAllProgress } from "../tools/progress";
import { repoEnvironments } from "./config";
import { reconcileRepo, refreshBranches, refreshDrift } from "./github";
import { pingHealth } from "./poll";
import { pruneRepoCapture } from "./store";

export const REPO_CRON = "*/10 * * * *";

export async function handleRepoCron(env: Env, scheduledTime: number, fetchImpl?: typeof fetch): Promise<void> {
  const envs = repoEnvironments(env);
  const when = new Date(scheduledTime);
  const safely = async (label: string, fn: () => Promise<unknown>) => { try { await fn(); } catch (e) { console.error("repo cron", label, e); } };

  await safely("health", () => pingHealth(env.DB, envs, scheduledTime, fetchImpl));
  if (when.getUTCMinutes() !== 0) return;

  // hourly polls land here in Phase 5

  if (when.getUTCHours() % 6 !== 0) return;
  if (env.GITHUB_SERVICE_TOKEN && env.GITHUB_REPO) {
    const gh = { token: env.GITHUB_SERVICE_TOKEN, repo: env.GITHUB_REPO, fetchImpl };
    // The progress backstop this trigger has always run.
    await safely("progress", () => recomputeAllProgress(env.DB, gh));
    await safely("reconcile", () => reconcileRepo(env.DB, gh, envs, scheduledTime));
    await safely("branches", () => refreshBranches(env.DB, gh, envs, scheduledTime));
    await safely("drift", () => refreshDrift(env.DB, gh, envs));
  }
  await safely("prune", () => pruneRepoCapture(env.DB, scheduledTime));
}
```

In `src/index.ts` `scheduled()`, replace the last two lines (the service-token guard + `recomputeAllProgress`) with:

```ts
    if (controller.cron === REPO_CRON) await handleRepoCron(env, controller.scheduledTime);
```

(import `REPO_CRON, handleRepoCron` from `./repo/cron`; drop the now-unused `recomputeAllProgress` import). In `wrangler.toml`:

```toml
crons = ["*/10 * * * *", "0 * * * *", "0 * * * SUN,MON"]
```

If a test asserts `scheduled()` calls the progress recompute on the old expression (`grep -rn '\*/6' test/`), update it to fire `*/10 * * * *` at a `scheduledTime` of `…T06:00:00Z`.

- [ ] **Step 4: Project** — in `src/tools/repo.ts` remove `health` from `UNCAPTURED` and add (import `latestMetric` from `../repo/store`):

```ts
  const health: RepoHealth[] = [];
  for (const cfg of envs) {
    for (const [part, label, url] of [["frontend", "web", cfg.frontendUrl], ["backend", "api", cfg.apiUrl + cfg.healthPath]] as const) {
      const up = await latestMetric(db, "health_up", cfg.key, part);
      const ms = await latestMetric(db, "health_ms", cfg.key, part);
      if (up) health.push({ env: `${cfg.label} · ${label}`, url, up: up.value === 1, ms: Math.round(ms?.value ?? 0) });
    }
  }
```

return `health: health.length ? ok(health) : NOT_CONNECTED,`, and in the env-card loop fold health into the pill: compute `const down = health.some((h) => h.env.startsWith(`${cfg.label} ·`) && !h.up);` (build `health` BEFORE the env loop) and use `pill: !known ? "UNKNOWN" : failed || down ? (down ? "DOWN" : "FAILING") : failing.length ? "DEGRADED" : "HEALTHY"` with `tone: … failed || down ? "bad" …`.

- [ ] **Step 5: Run** — `npx vitest run test/repo-cron.test.ts test/notifications.cron.test.ts test/progress.test.ts && npm run typecheck` → PASS.
- [ ] **Step 6: Close-out** — `CLAUDE.md`: replace the `0 */6 * * *` description in "Env / bindings" and the Roadmap section with the `*/10` trigger and its three cadences; move drift / branches / health to the live list. `npm test`. `npx wrangler deploy --dry-run` to validate the cron expression BEFORE merging. Open the PR.
- [ ] **Step 7: Commit** — `git commit -am "Ping environment health and fold the repo polls into one cron trigger"`.

---

# Phase 4 — CI-reported numbers (source J)

Needs the `Statuses` webhook event (already in the Phase 2 prerequisite list) and a PR to `SaplingLearn/sapling`. Lights up: coverage, bundle size, TODO/FIXME.

### Task 14: `status` events → metrics, and the Sapling CI steps

**Files:** Modify `src/repo/capture.ts`, `src/webhook.ts`, `src/tools/repo.ts`; Test `test/repo-capture.test.ts` (append), `test/repo-dashboard.test.ts` (append). Out-of-repo: `.github/workflows/ci.yml` in `SaplingLearn/sapling`.

**Interfaces:**
- Produces: `metricsFromStatus(payload: unknown, envs: RepoEnvConfig[]): RepoMetric[]` — pure. Contexts: `canopy/coverage` → metric `coverage`, `canopy/bundle-kb` → `bundle_kb`, `canopy/todo` → `todo_count`. `description` must parse as a finite number. Only statuses whose `branches[].name` includes `envs[0].branch` count (a feature branch's coverage is not the repo's).

- [ ] **Step 1: Failing tests** — append to `test/repo-capture.test.ts`:

```ts
import { metricsFromStatus } from "../src/repo/capture";

describe("metricsFromStatus", () => {
  const status = (context: string, description: string, branch = "main") =>
    ({ sha: "abc", context, description, state: "success", updated_at: "2026-09-20T09:30:00Z", branches: [{ name: branch }] });

  it("reads the three canopy contexts as numbers", () => {
    expect(metricsFromStatus(status("canopy/coverage", "78.4"), ENVS)).toEqual([{ metric: "coverage", env: "", part: "", value: 78.4, at: "2026-09-20T09:30:00Z" }]);
    expect(metricsFromStatus(status("canopy/bundle-kb", "412"), ENVS)[0]).toMatchObject({ metric: "bundle_kb", value: 412 });
    expect(metricsFromStatus(status("canopy/todo", "43"), ENVS)[0]).toMatchObject({ metric: "todo_count", value: 43 });
  });

  it("ignores other contexts, non-numbers, and other branches", () => {
    expect(metricsFromStatus(status("Sapling - sapling", "Success"), ENVS)).toEqual([]);
    expect(metricsFromStatus(status("canopy/coverage", "n/a"), ENVS)).toEqual([]);
    expect(metricsFromStatus(status("canopy/coverage", "61.0", "feat/x"), ENVS)).toEqual([]);
  });
});
```

and to `test/repo-dashboard.test.ts`:

```ts
import { putMetric } from "../src/repo/store";

it("coverage, bundle and TODO read as value + trend + delta from repo_metrics", async () => {
  const pts: [string, number][] = [[ago(30), 77.2], [ago(10), 78.0], [ago(1), 78.4]];
  for (const [at, value] of pts) await putMetric(env.DB, { metric: "coverage", env: "", part: "", value, at });
  await putMetric(env.DB, { metric: "todo_count", env: "", part: "", value: 61, at: ago(40) });
  await putMetric(env.DB, { metric: "todo_count", env: "", part: "", value: 43, at: ago(1) });
  const d = await getRepoDashboard(env.DB, "o/r", NOW);
  expect(data(d.coverage)).toMatchObject({ value: "78.4%", trend: [77.2, 78, 78.4], delta: "+1.2", tone: "good" });
  expect(data(d.todos)).toMatchObject({ count: 43, delta: -18, trend: [61, 43] });
  expect(d.bundle.status).toBe("not_connected");
});
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** — append to `src/repo/capture.ts` (import `RepoMetric` from `./types`):

```ts
const STATUS_METRICS: Record<string, string> = { "canopy/coverage": "coverage", "canopy/bundle-kb": "bundle_kb", "canopy/todo": "todo_count" };

/** A commit status whose description is a number, posted by the target repo's CI. */
export function metricsFromStatus(payload: unknown, envs: RepoEnvConfig[]): RepoMetric[] {
  const p = obj(payload);
  const metric = STATUS_METRICS[str(p?.context) ?? ""];
  const at = str(p?.updated_at) ?? str(p?.created_at);
  if (!p || !metric || !at) return [];
  const value = Number(str(p.description));
  if (!Number.isFinite(value)) return [];
  const branches = Array.isArray(p.branches) ? p.branches.map((b) => str(obj(b)?.name)) : [];
  if (!branches.includes(envs[0]?.branch ?? "main")) return [];
  return [{ metric, env: "", part: "", value, at }];
}
```

In `src/webhook.ts` append `"status"` to `REPO_EVENT_NAMES`, and inside the repo `try`, after the events loop:

```ts
      if (eventName === "status") {
        for (const m of metricsFromStatus(payload, repoEnvironments(env))) { await putMetric(env.DB, m); repo.captured++; }
      }
```

In `src/tools/repo.ts` remove `coverage`, `bundle`, `todos` from `UNCAPTURED` and add:

```ts
  const monthAgo = new Date(now - 30 * DAY).toISOString();
  const fixed = (n: number, d: number) => (Math.round(n * 10 ** d) / 10 ** d).toString();
  const signed = (n: number, d: number, unit = "") => `${n > 0 ? "+" : n < 0 ? "−" : ""}${fixed(Math.abs(n), d)}${unit}`;
  /** Last 10 points of a repo-wide metric over 30 days. */
  const series = async (metric: string) => (await metricSeries(db, metric, "", "", monthAgo)).slice(-10).map((p) => p.value);

  const cov = await series("coverage");
  const coverage: RepoSection<RepoTrend> = cov.length
    ? ok({ value: `${fixed(cov[cov.length - 1], 1)}%`, trend: cov, delta: signed(cov[cov.length - 1] - cov[0], 1), tone: cov[cov.length - 1] >= cov[0] ? "good" : "warn", note: "over 30 days" })
    : NOT_CONNECTED;
  const bun = await series("bundle_kb");
  const bundle: RepoSection<RepoTrend> = bun.length
    ? ok({ value: `${fixed(bun[bun.length - 1], 0)} KB`, trend: bun, delta: signed(bun[bun.length - 1] - bun[0], 0, " KB"), tone: bun[bun.length - 1] > bun[0] ? "warn" : "good", note: "over 30 days · gzip" })
    : NOT_CONNECTED;
  const todoAll = await metricSeries(db, "todo_count", "", "", new Date(now - 90 * DAY).toISOString());
  const todos: RepoSection<RepoTodos> = todoAll.length
    ? ok({ count: todoAll[todoAll.length - 1].value, delta: todoAll[todoAll.length - 1].value - todoAll[0].value,
        since: new Date(todoAll[0].at).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }), trend: todoAll.slice(-10).map((p) => p.value) })
    : NOT_CONNECTED;
```

and return `coverage, bundle, todos`.

- [ ] **Step 4: Run → PASS. Commit** — `git commit -am "Read coverage, bundle size and TODO counts from CI commit statuses"`.

- [ ] **Step 5: Open the PR on `SaplingLearn/sapling`.** In `.github/workflows/ci.yml`:

  1. Add at workflow level: `permissions: { contents: read, statuses: write }`.
  2. Backend job — `pytest-cov` must be added to `backend/requirements.lock` **with hashes** (the install uses `--require-hashes`); then change the pytest line to append `--cov=. --cov-report=json:coverage.json` and add:

```yaml
      - name: Report coverage to Canopy
        if: github.ref == 'refs/heads/main' && github.event_name == 'push'
        env: { GH_TOKEN: "${{ github.token }}" }
        run: |
          PCT=$(python -c "import json;print(round(json.load(open('coverage.json'))['totals']['percent_covered'],1))")
          gh api "repos/${{ github.repository }}/statuses/${{ github.sha }}" -f state=success -f context=canopy/coverage -f description="$PCT"
```

  3. Any job with a checkout — the TODO count:

```yaml
      - name: Report TODO/FIXME count to Canopy
        if: github.ref == 'refs/heads/main' && github.event_name == 'push'
        env: { GH_TOKEN: "${{ github.token }}" }
        run: |
          N=$(grep -rIE --include='*.py' --include='*.ts' --include='*.tsx' -e 'TODO|FIXME' backend frontend/src | wc -l | tr -d ' ')
          gh api "repos/${{ github.repository }}/statuses/${{ github.sha }}" -f state=success -f context=canopy/todo -f description="$N"
```

  4. **Bundle size is optional** — CI does not build the frontend (Cloudflare does), and an OpenNext build adds minutes. Skip it unless the owner wants the cost; the dashboard shows `not_connected` for it until a `canopy/bundle-kb` status exists. If wanted: after `npm ci` in the frontend job run `npx opennextjs-cloudflare build`, then `KB=$(gzip -c .open-next/worker.js | wc -c | awk '{print int($1/1024)}')` and post it as `canopy/bundle-kb`.

---

# Phase 5 — External analytics (sources K, L, M)

Needs new secrets, and M needs a Sapling change. Lights up the whole Usage tab. **Each poller is independent — ship K first; L and M can follow or be dropped.**

### Task 15: Usage DTO — a metric can be individually unconnected

**Files:** Modify `shared/repo.ts`, `web/src/repo.ts`, `web/src/repo-sample.ts`; Test `test/render.repo.test.ts`.

Requests come from Cloudflare, users from Sapling; one may exist without the other. Replace `RepoUsageEnv`:

```ts
export interface RepoUsageMetric { value: string; trend: number[]; tone: RepoTone }
export interface RepoUsageEnv { name: string; host: string; requests: RepoUsageMetric | null; errorRate: RepoUsageMetric | null; users: RepoUsageMetric | null }
```

- [ ] **Step 1: Failing render test** — append to `test/render.repo.test.ts`:

```ts
it("a usage metric with no source says so in place, without blanking its neighbours", () => {
  const envRow = { name: "staging", host: "staging.saplinglearn.com", requests: { value: "12.4K", trend: [1, 2, 3], tone: "neutral" as const }, errorRate: { value: "2.41%", trend: [1, 2], tone: "warn" as const }, users: null };
  const data = live({ usage: { status: "ok", data: { "24h": [envRow], "7d": [envRow], "30d": [envRow] } } });
  const html = repoView(props({ tab: "usage", repo: { status: "ok", data } }));
  expect(html).toContain("12.4K");
  expect(html).toContain("Active users");
  expect(html).toContain("not connected");
});
```

- [ ] **Step 2: Implement** — in `web/src/repo.ts` `usageEnv`, change `metric` to accept `m: RepoUsageMetric | null` and render, when null, the label row with `<span style="font-size:11.5px;color:var(--fg-40)">not connected</span>` in place of the value and no sparkline; otherwise as today with `m.value`, `m.trend`, and `TONE[m.tone]` for the error metric. Update `web/src/repo-sample.ts`'s `env()` helper to build the three `RepoUsageMetric`s (`tone: "neutral"` for requests/users; the existing warn/good for errors, `value: err.toFixed(2) + "%"`).
- [ ] **Step 3: Run render tests → PASS. Commit** — `git commit -am "Let each usage metric be unconnected on its own"`.

### Task 16: Cloudflare Workers analytics (source K)

**Files:** Modify `src/repo/poll.ts`, `src/repo/cron.ts`, `src/env.ts`, `src/tools/repo.ts`; Test `test/repo-poll.cloudflare.test.ts`.

**Interfaces:**
- Produces: `pollCloudflare(db, cf: { token: string; accountId: string }, envs: RepoEnvConfig[], now: number, fetchImpl?: typeof fetch): Promise<void>` — writes hourly `cf_requests` and `cf_errors` (`env`=config key, `part`="frontend") for the last 3 complete hours (overlap heals a missed tick; `INSERT OR IGNORE` dedupes).
- `Env` gains `CF_ANALYTICS_TOKEN?: string; CF_ANALYTICS_ACCOUNT_ID?: string;`

- [ ] **Step 1: Verify the dataset against the live API before writing the parser** (one manual call; needs the token):

```bash
curl -s https://api.cloudflare.com/client/v4/graphql -H "authorization: Bearer $CF_ANALYTICS_TOKEN" -H 'content-type: application/json' \
  -d '{"query":"query($a:String!,$s:String!,$from:Time!,$to:Time!){viewer{accounts(filter:{accountTag:$a}){workersInvocationsAdaptive(limit:100,filter:{scriptName:$s,datetime_geq:$from,datetime_leq:$to},orderBy:[datetimeHour_ASC]){dimensions{datetimeHour} sum{requests errors}}}}}","variables":{"a":"'$CF_ANALYTICS_ACCOUNT_ID'","s":"frontend-staging","from":"2026-09-20T00:00:00Z","to":"2026-09-20T12:00:00Z"}}' | jq .
```

Expected: `data.viewer.accounts[0].workersInvocationsAdaptive[]` rows of `{dimensions:{datetimeHour}, sum:{requests, errors}}`. If the field names differ, correct the query AND the fixture below to match before continuing.

- [ ] **Step 2: Failing test** — `test/repo-poll.cloudflare.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all } from "../src/db";
import { pollCloudflare } from "../src/repo/poll";
import { ENVS } from "./helpers/repo";

const NOW = Date.parse("2026-09-20T12:05:00Z");

describe("pollCloudflare", () => {
  it("stores hourly requests and errors per frontend Worker", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      const v = JSON.parse(String(init?.body)).variables;
      seen.push(v.s);
      expect(v).toMatchObject({ a: "acct", from: "2026-09-20T09:00:00.000Z", to: "2026-09-20T12:00:00.000Z" });
      return new Response(JSON.stringify({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [
        { dimensions: { datetimeHour: "2026-09-20T10:00:00Z" }, sum: { requests: 500, errors: 12 } },
        { dimensions: { datetimeHour: "2026-09-20T11:00:00Z" }, sum: { requests: 640, errors: 3 } },
      ] }] } } }), { status: 200 });
    }) as typeof fetch;
    await pollCloudflare(env.DB, { token: "t", accountId: "acct" }, ENVS, NOW, fetchImpl);
    expect(seen).toEqual(["frontend-staging", "frontend"]);
    const rows = await all<{ metric: string; env: string; value: number }>(env.DB, `SELECT metric, env, value FROM repo_metrics WHERE env = 'staging' ORDER BY metric, at`);
    expect(rows).toEqual([{ metric: "cf_errors", env: "staging", value: 12 }, { metric: "cf_errors", env: "staging", value: 3 }, { metric: "cf_requests", env: "staging", value: 500 }, { metric: "cf_requests", env: "staging", value: 640 }]);
  });

  it("a rejected token writes nothing and does not throw", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ errors: [{ message: "unauthorized" }] }), { status: 403 })) as typeof fetch;
    await expect(pollCloudflare(env.DB, { token: "bad", accountId: "acct" }, ENVS, NOW, fetchImpl)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Implement** — append to `src/repo/poll.ts`:

```ts
const HOUR = 3_600_000;
const CF_QUERY = `query($a:String!,$s:String!,$from:Time!,$to:Time!){viewer{accounts(filter:{accountTag:$a}){workersInvocationsAdaptive(limit:100,filter:{scriptName:$s,datetime_geq:$from,datetime_leq:$to},orderBy:[datetimeHour_ASC]){dimensions{datetimeHour} sum{requests errors}}}}}`;
interface CfRow { dimensions: { datetimeHour: string }; sum: { requests: number; errors: number } }

export async function pollCloudflare(db: DB, cf: { token: string; accountId: string }, envs: RepoEnvConfig[], now: number, fetchImpl: typeof fetch = fetch): Promise<void> {
  const to = new Date(Math.floor(now / HOUR) * HOUR);
  const from = new Date(to.getTime() - 3 * HOUR);
  for (const cfg of envs) {
    try {
      const res = await fetchImpl("https://api.cloudflare.com/client/v4/graphql", {
        method: "POST", headers: { authorization: `Bearer ${cf.token}`, "content-type": "application/json" },
        body: JSON.stringify({ query: CF_QUERY, variables: { a: cf.accountId, s: cfg.worker, from: from.toISOString(), to: to.toISOString() } }),
      });
      if (!res.ok) throw new Error(`cloudflare ${res.status}`);
      const body = (await res.json()) as { data?: { viewer?: { accounts?: { workersInvocationsAdaptive?: CfRow[] }[] } } };
      for (const row of body.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive ?? []) {
        const at = new Date(row.dimensions.datetimeHour).toISOString();
        await putMetric(db, { metric: "cf_requests", env: cfg.key, part: "frontend", value: row.sum.requests, at });
        await putMetric(db, { metric: "cf_errors", env: cfg.key, part: "frontend", value: row.sum.errors, at });
      }
    } catch (e) {
      console.error("pollCloudflare", cfg.key, e);
    }
  }
}
```

In `src/repo/cron.ts`, at the `// hourly polls land here` marker:

```ts
  if (env.CF_ANALYTICS_TOKEN && env.CF_ANALYTICS_ACCOUNT_ID) {
    await safely("cloudflare", () => pollCloudflare(env.DB, { token: env.CF_ANALYTICS_TOKEN!, accountId: env.CF_ANALYTICS_ACCOUNT_ID! }, envs, scheduledTime, fetchImpl));
  }
```

- [ ] **Step 4: Project the Usage tab** — in `src/tools/repo.ts` remove `usage` and `cloudflare` from `UNCAPTURED`, and add:

```ts
  const compact = (n: number): string => n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(Math.round(n));
  const RANGES: Record<RepoRange, { hours: number; bucket: "hour" | "day" }> = { "24h": { hours: 24, bucket: "hour" }, "7d": { hours: 168, bucket: "day" }, "30d": { hours: 720, bucket: "day" } };
  /** Sum hourly points into the range's buckets, oldest first. */
  const bucketed = (points: { at: string; value: number }[], bucket: "hour" | "day"): number[] => {
    const by = new Map<string, number>();
    for (const p of points) { const k = p.at.slice(0, bucket === "hour" ? 13 : 10); by.set(k, (by.get(k) ?? 0) + p.value); }
    return [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v);
  };

  const usageData = {} as Record<RepoRange, RepoUsageEnv[]>;
  const cfData = {} as Record<RepoRange, RepoCfRow[]>;
  let anyUsage = false;
  for (const range of REPO_RANGES) {
    const since = new Date(now - RANGES[range].hours * 3_600_000).toISOString();
    usageData[range] = []; cfData[range] = [];
    for (const cfg of envs) {
      const req = await metricSeries(db, "cf_requests", cfg.key, "frontend", since);
      const err = await metricSeries(db, "cf_errors", cfg.key, "frontend", since);
      const usr = await metricSeries(db, `active_users_${range}`, cfg.key, "", since);
      const total = req.reduce((n, p) => n + p.value, 0);
      const errors = err.reduce((n, p) => n + p.value, 0);
      const rate = total ? (errors / total) * 100 : 0;
      const reqBuckets = bucketed(req, RANGES[range].bucket);
      const errBuckets = bucketed(err, RANGES[range].bucket);
      if (req.length || usr.length) anyUsage = true;
      usageData[range].push({
        name: cfg.label, host: cfg.frontendUrl.replace(/^https?:\/\//, ""),
        requests: req.length ? { value: compact(total), trend: reqBuckets, tone: "neutral" } : null,
        errorRate: req.length ? { value: `${rate.toFixed(2)}%`, trend: errBuckets.map((e, i) => (reqBuckets[i] ? (e / reqBuckets[i]) * 100 : 0)), tone: rate >= 1 ? "warn" : "good" } : null,
        users: usr.length ? { value: compact(usr[usr.length - 1].value), trend: usr.map((p) => p.value), tone: "neutral" } : null,
      });
      if (req.length) cfData[range].push({ env: cfg.label, label: "Workers requests", value: compact(total) }, { env: cfg.label, label: "Workers errors", value: compact(errors) });
    }
  }
```

return `usage: anyUsage ? ok(usageData) : NOT_CONNECTED, cloudflare: cfData["7d"].length ? ok(cfData) : NOT_CONNECTED,` (import `REPO_RANGES`, `RepoRange`, `RepoUsageEnv`, `RepoCfRow`). In `web/src/repo.ts` retitle the panel `Cloudflare — frontend Workers`.

- [ ] **Step 5: Run** — `npx vitest run test/repo-poll.cloudflare.test.ts test/repo-dashboard.test.ts && npm run typecheck` → PASS. **Commit** — `git commit -am "Poll Cloudflare Workers analytics for the frontend's requests and errors"`.
- [ ] **Step 6:** `wrangler secret put CF_ANALYTICS_TOKEN`; add `CF_ANALYTICS_ACCOUNT_ID` to `wrangler.toml` `[vars]` (not sensitive — it appears in every public Workers Builds check-run URL); document both in `CLAUDE.md` › Env.

### Task 17: Railway CPU and memory (source L)

> **AMENDED 2026-09-20 (owner confirmed how Railway tokens work for this project) — this block WINS over the snippets below.**
> Railway tokens here are **PROJECT tokens, one per environment** (created in the project's Settings → Tokens, each bound to a single environment). Two consequences, both verified against Railway's public API docs:
> 1. They are sent as the header **`Project-Access-Token: <token>`** — NOT `Authorization: Bearer` (that header is for account / workspace tokens and a project token is rejected there).
> 2. One token reaches ONE environment, so there are TWO secrets, named from the environment `key` upper-cased: **`RAILWAY_TOKEN_STAGING`** and **`RAILWAY_TOKEN_PRODUCTION`**. There is no `RAILWAY_TOKEN`.
>
> So: `pollRailway(db, tokens: Record<string, string | undefined>, envs, now, fetchImpl?)` where `tokens[cfg.key]` is that environment's token; an environment with no token (or no `railwayEnvironmentId` / `railwayServiceId`) is skipped — the other still polls. `Env` gains `RAILWAY_TOKEN_STAGING?: string; RAILWAY_TOKEN_PRODUCTION?: string;` and the cron builds the map as `{ staging: env.RAILWAY_TOKEN_STAGING, production: env.RAILWAY_TOKEN_PRODUCTION }` — keep that mapping in ONE small helper keyed on `cfg.key.toUpperCase()` so a third environment is one line. Tests assert the header name and that each environment's request carries ITS OWN token and never the other's.
> This is also the safer shape: a project token can touch one environment of one project, where a workspace token could touch everything in the workspace. It is still not read-only — Railway has no read-only scope.
> The Railway project id is `3f90b930-b996-4cea-ad06-daa046de18b6` (owner-confirmed; not a secret). The `metrics` query needs `environmentId` + `serviceId`, not the project id. Whether `metrics` is permitted to a project token is NOT confirmed by Railway's docs — Step 1's manual call decides it; if it is refused, STOP and leave `hosting` `not_connected`.


**Files:** Modify `src/repo/poll.ts`, `src/repo/cron.ts`, `src/env.ts`, `src/tools/repo.ts`, `wrangler.toml` (add `railwayServiceId` to each `REPO_ENVIRONMENTS` entry); Test `test/repo-poll.railway.test.ts`.

**Interfaces:** `pollRailway(db, token: string, envs: RepoEnvConfig[], now: number, fetchImpl?): Promise<void>` → hourly `rw_cpu` (vCPU) and `rw_mem_mb`, `part`="backend". Skips an env missing `railwayEnvironmentId` or `railwayServiceId`. `Env` gains `RAILWAY_TOKEN?: string`.

- [ ] **Step 1: Verify Railway's public GraphQL API before writing the parser** — Railway's schema is theirs to change and is not vendored here:

```bash
curl -s https://backboard.railway.com/graphql/v2 -H "Project-Access-Token: $RAILWAY_TOKEN_STAGING" -H 'content-type: application/json' \
  -d '{"query":"query($e:String!,$s:String!,$start:DateTime!){metrics(environmentId:$e,serviceId:$s,startDate:$start,measurements:[CPU_USAGE,MEMORY_USAGE_GB],sampleRateSeconds:3600){measurement values{ts value}}}","variables":{"e":"76bb36e5-cf12-4b1e-b47f-d276a56c3b85","s":"<service id>","start":"2026-09-20T00:00:00Z"}}' | jq .
```

Expected: `data.metrics[]` of `{measurement, values:[{ts (unix seconds), value}]}`. If the shape differs, fix the query and the fixture together. If Railway's API does not expose metrics to this token type, STOP this task and leave `hosting` as `not_connected` — report it rather than approximating.

- [ ] **Step 2: Failing test** — `test/repo-poll.railway.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all } from "../src/db";
import { pollRailway } from "../src/repo/poll";
import { ENVS } from "./helpers/repo";

const NOW = Date.parse("2026-09-20T12:05:00Z");
const WITH_IDS = ENVS.map((e, i) => ({ ...e, railwayEnvironmentId: `env-${i}`, railwayServiceId: i === 0 ? "svc-0" : undefined }));

describe("pollRailway", () => {
  it("stores hourly CPU and memory for configured services, skipping an env without a service id", async () => {
    let calls = 0;
    const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      expect(JSON.parse(String(init?.body)).variables).toMatchObject({ e: "env-0", s: "svc-0" });
      return new Response(JSON.stringify({ data: { metrics: [
        { measurement: "CPU_USAGE", values: [{ ts: 1789905600, value: 0.12 }] },
        { measurement: "MEMORY_USAGE_GB", values: [{ ts: 1789905600, value: 0.4 }] },
      ] } }), { status: 200 });
    }) as typeof fetch;
    await pollRailway(env.DB, "t", WITH_IDS, NOW, fetchImpl);
    expect(calls).toBe(1);
    const rows = await all<{ metric: string; value: number }>(env.DB, `SELECT metric, value FROM repo_metrics ORDER BY metric`);
    expect(rows).toEqual([{ metric: "rw_cpu", value: 0.12 }, { metric: "rw_mem_mb", value: 409.6 }]);
  });
});
```

- [ ] **Step 3: Implement** — append to `src/repo/poll.ts`:

```ts
const RW_QUERY = `query($e:String!,$s:String!,$start:DateTime!){metrics(environmentId:$e,serviceId:$s,startDate:$start,measurements:[CPU_USAGE,MEMORY_USAGE_GB],sampleRateSeconds:3600){measurement values{ts value}}}`;

export async function pollRailway(db: DB, token: string, envs: RepoEnvConfig[], now: number, fetchImpl: typeof fetch = fetch): Promise<void> {
  const start = new Date(Math.floor(now / HOUR) * HOUR - 3 * HOUR).toISOString();
  for (const cfg of envs) {
    if (!cfg.railwayEnvironmentId || !cfg.railwayServiceId) continue;
    try {
      const res = await fetchImpl("https://backboard.railway.com/graphql/v2", {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ query: RW_QUERY, variables: { e: cfg.railwayEnvironmentId, s: cfg.railwayServiceId, start } }),
      });
      if (!res.ok) throw new Error(`railway ${res.status}`);
      const body = (await res.json()) as { data?: { metrics?: { measurement: string; values: { ts: number; value: number }[] }[] } };
      for (const m of body.data?.metrics ?? []) {
        const metric = m.measurement === "CPU_USAGE" ? "rw_cpu" : m.measurement === "MEMORY_USAGE_GB" ? "rw_mem_mb" : null;
        if (!metric) continue;
        for (const v of m.values) {
          await putMetric(db, { metric, env: cfg.key, part: "backend", value: metric === "rw_mem_mb" ? Math.round(v.value * 1024 * 10) / 10 : v.value, at: new Date(v.ts * 1000).toISOString() });
        }
      }
    } catch (e) {
      console.error("pollRailway", cfg.key, e);
    }
  }
}
```

Cron (hourly block): `if (env.RAILWAY_TOKEN) await safely("railway", () => pollRailway(env.DB, env.RAILWAY_TOKEN!, envs, scheduledTime, fetchImpl));`

Projection — remove `hosting` from `UNCAPTURED`:

```ts
  const hosting: RepoHosting[] = [];
  for (const cfg of envs) {
    const cpu = await latestMetric(db, "rw_cpu", cfg.key, "backend");
    const mem = await latestMetric(db, "rw_mem_mb", cfg.key, "backend");
    if (cpu || mem) hosting.push({ env: cfg.label, cpu: cpu ? `${cpu.value.toFixed(2)} vCPU` : "—", memory: mem ? `${Math.round(mem.value)} MB` : "—" });
  }
```

return `hosting: hosting.length ? ok(hosting) : NOT_CONNECTED,`. In `web/src/repo.ts` retitle the block `Hosting — Railway backend`.

- [ ] **Step 4: Run → PASS. Commit** — `git commit -am "Poll Railway for the backend's CPU and memory"`. Then `wrangler secret put RAILWAY_TOKEN_STAGING` and `RAILWAY_TOKEN_PRODUCTION`; add the backend's service id to each `REPO_ENVIRONMENTS` entry.

### Task 18: Active users — the Sapling metrics contract (source M)

Canopy cannot compute active users; only Sapling's database knows. This task builds Canopy's side and fixes the contract Sapling implements.

**Contract** — `GET {apiUrl}/api/internal/metrics`, header `Authorization: Bearer <SAPLING_METRICS_TOKEN>`, `200` →

```json
{ "active_users": { "24h": 74, "7d": 318, "30d": 318 } }
```

Distinct authenticated users with any request in the window. Anything else (401/404/5xx/malformed) → Canopy writes nothing and the row reads "not connected".

**Files:** Modify `src/repo/poll.ts`, `src/repo/cron.ts`, `src/env.ts`; Test `test/repo-poll.sapling.test.ts`.

**Interfaces:** `pollSaplingMetrics(db, token: string, envs: RepoEnvConfig[], now: number, fetchImpl?): Promise<void>` → hourly `active_users_24h` / `_7d` / `_30d` (`env`=key, `part`=""). `Env` gains `SAPLING_METRICS_TOKEN?: string`. The projection in Task 16 already reads `active_users_<range>`.

- [ ] **Step 1: Failing test** — `test/repo-poll.sapling.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all } from "../src/db";
import { pollSaplingMetrics } from "../src/repo/poll";
import { ENVS } from "./helpers/repo";

const NOW = Date.parse("2026-09-20T12:05:00Z");

describe("pollSaplingMetrics", () => {
  it("stores the three windows per environment at the hour, with the bearer token", async () => {
    const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer s3cret");
      return String(u).startsWith("https://api.staging")
        ? new Response(JSON.stringify({ active_users: { "24h": 6, "7d": 9, "30d": 9 } }), { status: 200 })
        : new Response("nope", { status: 404 });
    }) as typeof fetch;
    await pollSaplingMetrics(env.DB, "s3cret", ENVS, NOW, fetchImpl);
    const rows = await all<{ metric: string; env: string; value: number; at: string }>(env.DB, `SELECT metric, env, value, at FROM repo_metrics ORDER BY metric`);
    expect(rows).toEqual([
      { metric: "active_users_24h", env: "staging", value: 6, at: "2026-09-20T12:00:00.000Z" },
      { metric: "active_users_30d", env: "staging", value: 9, at: "2026-09-20T12:00:00.000Z" },
      { metric: "active_users_7d", env: "staging", value: 9, at: "2026-09-20T12:00:00.000Z" },
    ]);
  });
});
```

- [ ] **Step 2: Implement** — append to `src/repo/poll.ts`:

```ts
export async function pollSaplingMetrics(db: DB, token: string, envs: RepoEnvConfig[], now: number, fetchImpl: typeof fetch = fetch): Promise<void> {
  const at = new Date(Math.floor(now / HOUR) * HOUR).toISOString();
  for (const cfg of envs) {
    try {
      const res = await fetchImpl(`${cfg.apiUrl}/api/internal/metrics`, { headers: { authorization: `Bearer ${token}`, "user-agent": "canopy-metrics" }, signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`sapling ${res.status}`);
      const users = ((await res.json()) as { active_users?: Record<string, unknown> }).active_users ?? {};
      for (const range of ["24h", "7d", "30d"]) {
        const v = users[range];
        if (typeof v === "number" && Number.isFinite(v)) await putMetric(db, { metric: `active_users_${range}`, env: cfg.key, part: "", value: v, at });
      }
    } catch (e) {
      console.error("pollSaplingMetrics", cfg.key, e);
    }
  }
}
```

Cron (hourly block): `if (env.SAPLING_METRICS_TOKEN) await safely("sapling", () => pollSaplingMetrics(env.DB, env.SAPLING_METRICS_TOKEN!, envs, scheduledTime, fetchImpl));`

- [ ] **Step 3: Run → PASS. Commit** — `git commit -am "Poll Sapling's metrics endpoint for active users"`.
- [ ] **Step 4: File the Sapling-side issue** with the contract above (FastAPI route under `backend/routes/`, constant-time token compare against an env var, one `COUNT(DISTINCT user_id)` per window over the request/session log). Until it ships, Active users reads "not connected" — by design.

### Task 19: Final close-out

- [ ] `CLAUDE.md`: the Repo dashboard paragraph lists every section as live with its source; `UNCAPTURED` is empty or gone; Env section documents `REPO_ENVIRONMENTS`, `CF_ANALYTICS_TOKEN`, `CF_ANALYTICS_ACCOUNT_ID`, `RAILWAY_TOKEN_STAGING`, `RAILWAY_TOKEN_PRODUCTION`, `SAPLING_METRICS_TOKEN`; the cron paragraph describes the `*/10` trigger's three cadences.
- [ ] `web/src/repo.ts`: delete `notConnected` copy that names a capture path that now exists; keep the state itself (a fresh install still starts unconnected).
- [ ] `npm run typecheck && npm test`; run the app, Sync GitHub, and walk all five tabs in live mode against the sample mode side by side.

---

## Self-review

**Spec coverage** — every row of the source→feature map has a task: A,B → T2–T5 · C,D,E,F → T7–T10 · G → T11 · H → T12 · I → T13 · J → T14 · K → T15–T16 · L → T17 · M → T18. Decisions 1–6 → T1 config (1), T9 (2, 3), T16 (4), T14 (5), T4 (6).

**Known limits, stated rather than hidden:** "Awaiting review" a week ago ignores approvals (review history before capture is unknowable). Backfilled commits count 1 per commit and only cover the stretch before push capture began. Bundle size stays `not_connected` unless the owner accepts a CI build step. Railway's and Cloudflare's GraphQL shapes are verified by a manual call in-task before the parser is trusted, because neither schema is vendored here.

**Type consistency** — `RepoEvent`/`RepoEventRow`/`RepoMetric` (T1) are used unchanged through T18; `getRepoDashboard(db, repo, now?, envs?)` gains its 4th parameter in T9 and every later test passes it; `RepoContributor` changes once (T4), `RepoEnv`/`RepoDeployRow` once (T9), `RepoUsageEnv` once (T15), each with its screen and sample update in the same task.
