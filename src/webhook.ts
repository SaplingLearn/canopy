import type { CapturedEvent } from "@shared/contract";
import type { Env } from "./env";
import { type DB } from "./db";
import { ingestEvent } from "./consumer";
import { type Summarizer, workersAiSummarizer, storePrSummary } from "./tools/summarize";
import { applyEventProgress } from "./tools/progress";

// The GitHub webhook is Canopy's THIRD auth class. Unlike the session cookie
// (humans) and the bearer token (agents), a delivery authenticates itself by an
// HMAC-SHA256 signature over the raw body against GITHUB_WEBHOOK_SECRET. Once the
// HMAC verifies, the delivery's own claims (subject_login, milestone counts) are
// trusted and captured verbatim through ingestEvent. The writer principal is the
// fixed string "github-webhook" — the webhook owner, not any OAuth identity.

// ---------------------------------------------------------------------------
// HMAC verification. GitHub sends `X-Hub-Signature-256: sha256=<hex>`. We decode
// the hex back to bytes and use crypto.subtle.verify (constant-time comparison).
// Any malformed/absent header returns false; nothing here ever throws.
// ---------------------------------------------------------------------------
export async function verifyGithubSignature(
  secret: string,
  rawBody: string,
  sigHeader: string | null
): Promise<boolean> {
  if (!sigHeader || !sigHeader.startsWith("sha256=")) return false;
  const hex = sigHeader.slice("sha256=".length);
  // A valid hex digest is a non-empty, even-length run of hex digits.
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return false;

  const sigBytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < sigBytes.length; i++) {
    sigBytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    return await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(rawBody));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Minimal typed views over the (post-HMAC, trusted) GitHub payloads. Only the
// fields the derivation reads are modeled; everything else is ignored.
// ---------------------------------------------------------------------------
interface GhUser {
  login: string;
}
interface GhMilestone {
  number: number;
  open_issues?: number;
  closed_issues?: number;
}
interface GhLabel {
  name: string;
}
interface GhPullRequest {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  merged: boolean;
  merged_at: string | null;
  closed_at: string | null;
  user: GhUser;
  milestone?: GhMilestone | null;
}
interface GhIssue {
  number: number;
  title: string;
  html_url: string;
  state: string;
  updated_at: string;
  user: GhUser;
  assignees?: GhUser[];
  labels?: (string | GhLabel)[];
  milestone?: GhMilestone | null;
  pull_request?: unknown; // present only when the "issue" is really a PR
}
interface PrPayload {
  action?: string;
  pull_request?: GhPullRequest;
}
interface IssuePayload {
  action?: string;
  issue?: GhIssue;
  assignee?: GhUser;
}

const ISSUE_ACTIONS = [
  "opened",
  "edited",
  "assigned",
  "unassigned",
  "closed",
  "reopened",
  "milestoned",
  "demilestoned",
];

// ---------------------------------------------------------------------------
// PURE: derive the CapturedEvent(s) a single delivery produces. Returns [] for
// anything we do not capture (non-close PRs, PRs masquerading as issues, unknown
// issue actions, unhandled event names, or a non-object payload).
// ---------------------------------------------------------------------------
export function eventsFromDelivery(eventName: string, payload: unknown): CapturedEvent[] {
  if (payload === null || typeof payload !== "object") return [];

  if (eventName === "pull_request") {
    const p = payload as PrPayload;
    if (p.action !== "closed") return [];
    const pr = p.pull_request;
    if (!pr) return [];

    const merged = pr.merged === true;
    const raw = JSON.stringify({
      pr: {
        number: pr.number,
        title: pr.title,
        body: pr.body,
        html_url: pr.html_url,
        merged,
        merged_at: pr.merged_at,
        closed_at: pr.closed_at,
        user: { login: pr.user.login },
        milestone: pr.milestone ? { number: pr.milestone.number } : null,
      },
    });
    return [
      {
        semantic_key: `gh:pr:${pr.number}:${merged ? "merged" : "closed"}`,
        event_type: merged ? "pr_merged" : "pr_closed",
        ref_number: pr.number,
        subject_login: pr.user.login,
        raw,
        provenance: "webhook",
        occurred_at: pr.merged_at ?? pr.closed_at ?? undefined,
      },
    ];
  }

  if (eventName === "issues") {
    const p = payload as IssuePayload;
    const issue = p.issue;
    if (!issue) return [];
    if (issue.pull_request) return []; // a PR delivered on the issues event — not our surface
    const action = p.action ?? "";
    if (!ISSUE_ACTIONS.includes(action)) return [];

    const updatedAt = issue.updated_at;
    const isAssign = action === "assigned" || action === "unassigned";
    const assigneeLogin = p.assignee?.login;
    const assignees = issue.assignees ?? [];

    // assigned/unassigned are ABOUT the assignee; every other action is about the
    // issue's current owner (first assignee, else the author).
    const subjectLogin = isAssign
      ? assigneeLogin ?? issue.user.login
      : assignees[0]?.login ?? issue.user.login;

    // The semantic key carries updated_at so a genuine later edit is a new event,
    // while a redelivery of the same snapshot collapses. assigned/unassigned also
    // embed the assignee so two people assigned in the same tick stay distinct.
    const semanticKey = isAssign
      ? `gh:issue:${issue.number}:${action}:${assigneeLogin}:${updatedAt}`
      : `gh:issue:${issue.number}:${action}:${updatedAt}`;

    const raw = JSON.stringify({
      action,
      issue: {
        number: issue.number,
        title: issue.title,
        html_url: issue.html_url,
        state: issue.state,
        updated_at: updatedAt,
        user: { login: issue.user.login },
        assignees: assignees.map((a) => ({ login: a.login })),
        labels: (issue.labels ?? [])
          .map((l) => (typeof l === "string" ? l : l.name))
          .filter(Boolean),
        milestone: issue.milestone
          ? {
              number: issue.milestone.number,
              open_issues: issue.milestone.open_issues,
              closed_issues: issue.milestone.closed_issues,
            }
          : null,
      },
    });

    return [
      {
        semantic_key: semanticKey,
        event_type: "issue",
        ref_number: issue.number,
        subject_login: subjectLogin,
        raw,
        provenance: "webhook",
        occurred_at: updatedAt,
      },
    ];
  }

  return [];
}

// ---------------------------------------------------------------------------
// PURE: the absolute progress this issue event implies for its milestone, or
// null when the issue carries no milestone. total = open + closed (GitHub's own
// counts), so ordering of deliveries is irrelevant — later writes just overwrite.
// ---------------------------------------------------------------------------
export function progressFromIssueEvent(
  payload: unknown
): { milestoneNumber: number; closed: number; total: number } | null {
  if (payload === null || typeof payload !== "object") return null;
  const issue = (payload as IssuePayload).issue;
  const m = issue?.milestone;
  if (!m || m.open_issues == null || m.closed_issues == null) return null;
  return {
    milestoneNumber: m.number,
    closed: m.closed_issues,
    total: m.open_issues + m.closed_issues,
  };
}

// ---------------------------------------------------------------------------
// Downstream projections, hung off each NEWLY-WRITTEN event. Both seams are
// filled: summarizePrSeam (Task 4) and progressSeam (Task 5). Issue events
// never reach storePrSummary, and PR events never reach progressSeam — the
// branch in handleGithubWebhook keeps them disjoint.
// ---------------------------------------------------------------------------

// Task 4: parse the PR event's own `raw` (its title/body — nothing else) and
// store a capture-time summary. `summarizer` is already resolved by the
// caller (opts?.summarizer ?? (env.AI ? workersAiSummarizer(env.AI) : null));
// storePrSummary itself never throws, so a summary failure never fails capture.
async function summarizePrSeam(db: DB, summarizer: Summarizer | null, event: CapturedEvent): Promise<void> {
  const parsed = JSON.parse(event.raw) as { pr: { number: number; title: string; body: string | null } };
  await storePrSummary(db, summarizer, {
    semantic_key: event.semantic_key,
    pr_number: parsed.pr.number,
    title: parsed.pr.title,
    body: parsed.pr.body ?? "",
  });
}

// Task 5: apply this newly-captured issue event's implication(s) to the
// milestone_progress cache (absolute overwrite — see applyEventProgress).
async function progressSeam(db: DB, payload: unknown): Promise<void> {
  await applyEventProgress(db, payload);
}

// ---------------------------------------------------------------------------
// The webhook branch. HMAC-verify the raw body BEFORE anything else (a bad or
// missing signature — or an unset secret — is a bare 401, mirroring /mcp). Then
// derive events, capture each through the single gate, and hang the (currently
// no-op) summary/progress seams off the newly-written ones.
// ---------------------------------------------------------------------------
export async function handleGithubWebhook(
  request: Request,
  env: Env,
  opts?: { summarizer?: Summarizer | null }
): Promise<Response> {
  const rawBody = await request.text();
  const sig = request.headers.get("x-hub-signature-256");
  if (!env.GITHUB_WEBHOOK_SECRET || !(await verifyGithubSignature(env.GITHUB_WEBHOOK_SECRET, rawBody, sig))) {
    // Bare 401, NO WWW-Authenticate — same shape as the /mcp bearer failure.
    return json({ error: "unauthorized" }, 401);
  }

  const eventName = request.headers.get("x-github-event") ?? "";
  if (eventName !== "pull_request" && eventName !== "issues") {
    // Verified, but not a surface we capture (ping, push, …).
    return json({ ok: true, ignored: true });
  }

  let payload: unknown = null;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    payload = null; // eventsFromDelivery treats a non-object payload as []
  }

  const events = eventsFromDelivery(eventName, payload);
  let captured = 0;
  let unchanged = 0;
  for (const ev of events) {
    const res = await ingestEvent(env.DB, ev, "github-webhook");
    if (res.outcome === "written") {
      captured++;
      if (ev.event_type === "pr_merged" || ev.event_type === "pr_closed") {
        const summarizer = opts?.summarizer ?? (env.AI ? workersAiSummarizer(env.AI) : null);
        await summarizePrSeam(env.DB, summarizer, ev);
      } else {
        await progressSeam(env.DB, payload);
      }
    } else {
      unchanged++;
    }
  }

  return json({ ok: true, captured, unchanged });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
