import type { PrSummaryRow } from "@shared/rows";
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

const WORKERS_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct";

/** Workers AI-backed summarizer. Bounded to THAT PR's own title+body — no other
 *  context is sent. Never throws: any failure (network, empty output, malformed
 *  response) resolves to null so the caller falls back to excerptSummary. */
export function workersAiSummarizer(ai: Ai): Summarizer {
  return {
    model: WORKERS_AI_MODEL,
    async summarize({ title, body }) {
      try {
        const result = await ai.run(WORKERS_AI_MODEL, {
          messages: [
            {
              role: "system",
              content:
                "Summarize this one pull request's description in 2-3 short markdown sentences for a team activity feed. Do not speculate beyond the text.",
            },
            { role: "user", content: `Title: ${title}\n\nBody: ${body}` },
          ],
        });
        const response = (result as { response?: unknown } | null)?.response;
        if (typeof response !== "string") return null;
        const trimmed = response.trim();
        return trimmed.length > 0 ? trimmed : null;
      } catch {
        return null;
      }
    },
  };
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

  return { semantic_key: pr.semantic_key, pr_number: pr.pr_number, summary, model, created_at };
}
