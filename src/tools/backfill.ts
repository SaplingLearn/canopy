import type { Env } from "../env";
import { nowIso } from "../db";
import { ingestEvent } from "../consumer";
import { eventsFromDelivery } from "../webhook";
import { type Summarizer, workersAiSummarizer, storePrSummary } from "./summarize";
import { applyEventProgress } from "./progress";

// Admin-triggered server-side GitHub backfill. Unlike scripts/backfill-events.mjs
// (which signs synthetic webhook deliveries with the webhook secret), this runs
// INSIDE the Worker with GITHUB_SERVICE_TOKEN — the same token the scheduled()
// progress recompute uses — so it fetches GitHub REST directly, no webhook secret.
//
// It reconstructs the SAME deliveries the webhook would have received, reuses the
// PURE eventsFromDelivery() derivation (never duplicated here), post-maps each
// event's provenance to "backfill", and writes through the ONE gate fn ingestEvent
// — but with the ADMIN principal as the writer (an authenticated identity), not
// the fixed "github-webhook" string. Downstream projections (PR summaries, issue
// progress) mirror handleGithubWebhook, hung off newly-written events only.

const GH_API = "application/vnd.github+json";
const USER_AGENT = "canopy";
const DAYS_BACK = 14;

export interface BackfillResult {
  ok: boolean;
  error?: string;
  captured: number;
  unchanged: number;
  prs: number;
  issues: number;
}

// Minimal typed views over the GitHub REST list items — only the fields the
// delivery synthesizers below read are modeled; everything else is ignored.
interface GhUserLite {
  login: string;
}
interface GhMilestoneLite {
  number: number;
  open_issues?: number;
  closed_issues?: number;
}
interface GhPrListItem {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  merged_at: string | null;
  closed_at: string | null;
  updated_at: string;
  user: GhUserLite;
  milestone?: GhMilestoneLite | null;
}
interface GhIssueListItem {
  number: number;
  title: string;
  html_url: string;
  state: string;
  updated_at: string;
  user: GhUserLite;
  assignees?: GhUserLite[];
  assignee?: GhUserLite | null;
  labels?: (string | { name: string })[];
  milestone?: GhMilestoneLite | null;
  pull_request?: unknown; // present only when the "issue" is really a PR
}

// The `rel="next"` URL from a GitHub Link header, or null when there is no next page.
function nextLink(res: Response): string | null {
  const link = res.headers.get("link");
  const next = link?.split(",").find((part) => part.includes('rel="next"'));
  return next ? (next.match(/<([^>]+)>/)?.[1] ?? null) : null;
}

// Synthesize the delivery bodies eventsFromDelivery reads — SAME raw slice shapes
// as scripts/backfill-events.mjs (test/fixtures/*.json). PR list items carry no
// `merged` boolean (that's single-PR-fetch only), so derive it from merged_at.
function prClosedDelivery(pr: GhPrListItem) {
  return {
    action: "closed",
    number: pr.number,
    pull_request: {
      number: pr.number,
      title: pr.title,
      body: pr.body,
      html_url: pr.html_url,
      merged: pr.merged_at != null,
      merged_at: pr.merged_at,
      closed_at: pr.closed_at,
      user: { login: pr.user.login },
      milestone: pr.milestone
        ? { number: pr.milestone.number, open_issues: pr.milestone.open_issues, closed_issues: pr.milestone.closed_issues }
        : null,
    },
  };
}

function issueDelivery(issue: GhIssueListItem) {
  const assignee = issue.assignees?.[0] ?? issue.assignee ?? null;
  const action = assignee ? "assigned" : "opened";
  return {
    action,
    ...(assignee ? { assignee: { login: assignee.login } } : {}),
    issue: {
      number: issue.number,
      title: issue.title,
      html_url: issue.html_url,
      state: issue.state,
      updated_at: issue.updated_at,
      user: { login: issue.user.login },
      assignees: (issue.assignees ?? []).map((a) => ({ login: a.login })),
      labels: issue.labels ?? [],
      milestone: issue.milestone
        ? { number: issue.milestone.number, open_issues: issue.milestone.open_issues, closed_issues: issue.milestone.closed_issues }
        : null,
    },
  };
}

export async function runBackfill(
  env: Env,
  principalLogin: string,
  opts?: { fetchImpl?: typeof fetch; summarizer?: Summarizer | null; now?: string }
): Promise<BackfillResult> {
  const token = env.GITHUB_SERVICE_TOKEN;
  const repo = env.GITHUB_REPO;
  if (!token || !repo) {
    return { ok: false, error: "service token or repo not configured", captured: 0, unchanged: 0, prs: 0, issues: 0 };
  }

  const doFetch = opts?.fetchImpl ?? fetch;
  const summarizer = opts?.summarizer ?? (env.AI ? workersAiSummarizer(env.AI) : null);
  const headers = {
    authorization: `Bearer ${token}`,
    accept: GH_API,
    "user-agent": USER_AGENT,
    "x-github-api-version": "2022-11-28",
  };
  const cutoffMs = new Date(opts?.now ?? nowIso()).getTime() - DAYS_BACK * 24 * 60 * 60 * 1000;

  // (a) Closed PRs updated in the last 14 days. Sorted updated-desc, so we stop
  //     paginating at the first item whose updated_at predates the cutoff.
  const prList: GhPrListItem[] = [];
  {
    let url: string | null = `https://api.github.com/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`;
    let done = false;
    while (url && !done) {
      const res: Response = await doFetch(url, { headers });
      if (!res.ok) break;
      const page = (await res.json()) as GhPrListItem[];
      for (const pr of page) {
        if (pr.updated_at && new Date(pr.updated_at).getTime() < cutoffMs) {
          done = true;
          break;
        }
        prList.push(pr);
      }
      url = done ? null : nextLink(res);
    }
  }

  // (b) All open issues, paginated. The issues endpoint also returns PRs — those
  //     carry a `pull_request` field and are not our surface, so skip them.
  const issueList: GhIssueListItem[] = [];
  {
    let url: string | null = `https://api.github.com/repos/${repo}/issues?state=open&per_page=100`;
    while (url) {
      const res: Response = await doFetch(url, { headers });
      if (!res.ok) break;
      const page = (await res.json()) as GhIssueListItem[];
      for (const issue of page) {
        if (issue.pull_request) continue;
        issueList.push(issue);
      }
      url = nextLink(res);
    }
  }

  let captured = 0;
  let unchanged = 0;

  for (const pr of prList) {
    const payload = prClosedDelivery(pr);
    for (const base of eventsFromDelivery("pull_request", payload)) {
      const ev = { ...base, provenance: "backfill" as const };
      const res = await ingestEvent(env.DB, ev, principalLogin);
      if (res.outcome === "written") {
        captured++;
        // Mirror handleGithubWebhook's summary seam: parse THIS PR's own raw and
        // store a capture-time summary (storePrSummary never throws).
        const parsed = JSON.parse(ev.raw) as { pr: { number: number; title: string; body: string | null } };
        await storePrSummary(env.DB, summarizer, {
          semantic_key: ev.semantic_key,
          pr_number: parsed.pr.number,
          title: parsed.pr.title,
          body: parsed.pr.body ?? "",
        });
      } else {
        unchanged++;
      }
    }
  }

  for (const issue of issueList) {
    const payload = issueDelivery(issue);
    for (const base of eventsFromDelivery("issues", payload)) {
      const ev = { ...base, provenance: "backfill" as const };
      const res = await ingestEvent(env.DB, ev, principalLogin);
      if (res.outcome === "written") {
        captured++;
        // Mirror handleGithubWebhook's progress seam for newly-written issues.
        await applyEventProgress(env.DB, payload);
      } else {
        unchanged++;
      }
    }
  }

  return { ok: true, captured, unchanged, prs: prList.length, issues: issueList.length };
}
