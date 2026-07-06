import type { PrSummaryRow, IssueSummaryRow } from "@shared/rows";
import { type DB, run, nowIso } from "../db";

// Capture-time completed-PR summarizer. Runs ONCE, when the webhook captures a
// newly-written pr_merged/pr_closed event (src/webhook.ts) — never at render
// time. A summary failure (throw, empty response) must never fail capture; the
// deterministic excerpt fallback guarantees storePrSummary always succeeds.

/** One completed PR's title+body in, a short markdown summary (or null) out.
 *  `model` is the provenance recorded on the stored row. */
export interface Summarizer {
  readonly model: string;
  summarize(input: { title: string; body: string }): Promise<string | null>;
}

// @cf/meta/llama-3.1-8b-instruct was retired from the Workers AI catalog
// (silently — every call threw "model not found," caught by the try/catch
// below, always falling back to the excerpt summarizer). gemma-4-26b-a4b-it
// is Google's current flagship open model on Workers AI — comfortably within
// the free daily Neuron allocation for this workload (~5 neurons/call).
const WORKERS_AI_MODEL = "@cf/google/gemma-4-26b-a4b-it";

// Both prompts: 2-3 sentences of plain prose, no headings/bullets/preamble,
// grounded only in the provided title+body, output the summary text only.
// Kept in sync by hand — there's no shared style-rule constant, just the two
// prompts below and this comment as the source of truth for both.

export const SUMMARIZER_SYSTEM_PROMPT =
  "Summarize this pull request for a team activity feed — what shipped. " +
  "Lead with the concrete change the PR made; do not just restate the title. " +
  "Where the description supports it, add the meaningful detail: what behavior changed, " +
  "what it fixes or enables, and any caveat a teammate would want to know. " +
  "The description is a record of work that already happened — report what it states, never extrapolate beyond it. " +
  "Write 2 to 3 sentences of plain prose: no headings, no bullet points, no preamble like \"This PR\". " +
  "If the description is empty or too thin to add anything beyond the title, output the title verbatim — do not pad. " +
  "Output the summary text only, nothing else.";

export const ISSUE_SUMMARIZER_SYSTEM_PROMPT =
  "Summarize this GitHub issue for a personal to-do list: what it is, and — only where the issue " +
  "actually states or clearly implies one — what needs doing about it. " +
  "Start with a plain restatement of what the issue is about, grounded only in its title and description. " +
  "If the description states or clearly implies an action, add what needs doing. " +
  "If the description is vague, aspirational, or states no clear action, stop at the plain restatement — " +
  "never invent a next step, a plan, or a scope the issue itself never stated. " +
  "Write 2 to 3 sentences of plain prose: no headings, no bullet points, no preamble like \"This issue\". " +
  "If the description is empty or too thin to add anything beyond the title, output the title verbatim — do not pad. " +
  "Output the summary text only, nothing else.";

// Workers AI model families shape ai.run()'s resolved value differently:
// older/smaller models return the classic flat {response: string}; newer
// ones (e.g. gemma-4-26b-a4b-it) return an OpenAI-style Chat Completions
// shape ({choices: [{message: {content: string}}]}). A model swap that
// changes which shape comes back must not silently regress to the excerpt
// fallback forever, so both are recognized here.
function extractResponseText(result: unknown): string | null {
  const r = result as { response?: unknown; choices?: Array<{ message?: { content?: unknown } }> } | null;
  if (typeof r?.response === "string") return r.response;
  const chatContent = r?.choices?.[0]?.message?.content;
  if (typeof chatContent === "string") return chatContent;
  return null;
}

/** Shared Workers AI call machinery for both summarizers — only the system
 *  prompt differs. Never throws: any failure (network, empty output,
 *  malformed response) resolves to null so the caller falls back to
 *  excerptSummary. */
function makeWorkersAiSummarizer(ai: Ai, systemPrompt: string): Summarizer {
  return {
    model: WORKERS_AI_MODEL,
    async summarize({ title, body }) {
      try {
        const result = await ai.run(WORKERS_AI_MODEL, {
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Title: ${title}\n\nBody: ${body}` },
          ],
        });
        const response = extractResponseText(result);
        if (response === null) return null;
        const trimmed = response.trim();
        return trimmed.length > 0 ? trimmed : null;
      } catch (err) {
        // TEMPORARY diagnostic logging — remove once the production failure
        // mode under sustained backfill load is identified (see tail output).
        const kind = systemPrompt === SUMMARIZER_SYSTEM_PROMPT ? "pr" : "issue";
        console.error(`workersAiSummarizer (${kind}) failed:`, err instanceof Error ? err.message : err);
        return null;
      }
    },
  };
}

/** PR summarizer. Bounded to that PR's own title+body — no other context is sent. */
export function workersAiPrSummarizer(ai: Ai): Summarizer {
  return makeWorkersAiSummarizer(ai, SUMMARIZER_SYSTEM_PROMPT);
}

/** Issue summarizer. Bounded to that issue's own title+body — no other context is sent. */
export function workersAiIssueSummarizer(ai: Ai): Summarizer {
  return makeWorkersAiSummarizer(ai, ISSUE_SUMMARIZER_SYSTEM_PROMPT);
}

const EXCERPT_MAX = 280;

/** Deterministic fallback: first 280 chars of the body with whitespace
 *  collapsed, suffixed `…` when truncated. Empty body → the title verbatim. */
export function excerptSummary(title: string, body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return title;
  if (collapsed.length <= EXCERPT_MAX) return collapsed;
  return collapsed.slice(0, EXCERPT_MAX) + "…";
}

/**
 * Try the summarizer, fall back to excerptSummary (model:'excerpt') on any
 * null/throw. INSERT OR REPLACE so a re-summarize (future re-run) overwrites
 * the one row per semantic_key. NEVER throws — a summary failure must not
 * fail the webhook capture that triggered it.
 */
export async function storePrSummary(
  db: DB,
  summarizer: Summarizer | null,
  pr: { semantic_key: string; pr_number: number; title: string; body: string }
): Promise<PrSummaryRow> {
  let summary: string | null = null;
  let model = "excerpt";

  if (summarizer) {
    try {
      summary = await summarizer.summarize({ title: pr.title, body: pr.body });
      if (summary) model = summarizer.model;
    } catch {
      summary = null;
    }
  }

  if (!summary) {
    summary = excerptSummary(pr.title, pr.body);
    model = "excerpt";
  }

  const created_at = nowIso();
  await run(
    db,
    `INSERT OR REPLACE INTO pr_summaries (semantic_key, pr_number, summary, model, created_at) VALUES (?, ?, ?, ?, ?)`,
    pr.semantic_key,
    pr.pr_number,
    summary,
    model,
    created_at
  );

  return {
    semantic_key: pr.semantic_key,
    pr_number: pr.pr_number,
    summary,
    model,
    created_at,
    title: null,
    what: null,
    why: null,
    impact: null,
  };
}

/**
 * Try the summarizer, fall back to excerptSummary (model:'excerpt') on any
 * null/throw. INSERT OR REPLACE so a re-summarize overwrites the one row per
 * issue_number (an issue can be reassigned/edited many times; only the
 * current summary matters). NEVER throws.
 */
export async function storeIssueSummary(
  db: DB,
  summarizer: Summarizer | null,
  issue: { issue_number: number; title: string; body: string }
): Promise<IssueSummaryRow> {
  let summary: string | null = null;
  let model = "excerpt";

  if (summarizer) {
    try {
      summary = await summarizer.summarize({ title: issue.title, body: issue.body });
      if (summary) model = summarizer.model;
    } catch {
      summary = null;
    }
  }

  if (!summary) {
    summary = excerptSummary(issue.title, issue.body);
    model = "excerpt";
  }

  const created_at = nowIso();
  await run(
    db,
    `INSERT OR REPLACE INTO issue_summaries (issue_number, summary, model, created_at) VALUES (?, ?, ?, ?)`,
    issue.issue_number,
    summary,
    model,
    created_at
  );

  return {
    issue_number: issue.issue_number,
    summary,
    model,
    created_at,
    title: null,
    next_step: null,
  };
}
