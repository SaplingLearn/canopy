// Recognizes the "What changed / Why" markdown convention emitted by the PR
// summarizer (src/tools/summarize.ts) so both the Worker (the backfill's
// already-structured check, src/tools/backfill.ts) and the web build (card
// rendering, web/src/render.ts) agree on what counts as a structured summary.
// No schema change backs this — pr_summaries.summary stays a single markdown
// TEXT column; the structure lives in this convention, not a stored shape, so
// old prose summaries and the deterministic excerpt fallback degrade
// gracefully to a `null` parse instead of erroring.

export interface StructuredPrSummary {
  what: string;
  why: string | null;
}

const STRUCTURED_RE = /\*\*What changed:\*\*\s*([\s\S]*?)(?:\s*\*\*Why:\*\*\s*([\s\S]*))?$/i;

/** Parses "**What changed:** ... **Why:** ..." out of a PR summary's markdown.
 *  Returns null when the text doesn't match (old-style prose, the excerpt
 *  fallback, or a malformed AI response) — callers treat null as "render/treat
 *  as plain prose," never as an error. */
export function parseStructuredSummary(raw: string): StructuredPrSummary | null {
  const m = raw.match(STRUCTURED_RE);
  if (!m) return null;
  const what = m[1].trim();
  if (!what) return null;
  const why = m[2]?.trim() || null;
  return { what, why };
}
