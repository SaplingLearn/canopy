import type { PrSummaryRow, IssueSummaryRow } from "@shared/rows";
import { type DB, run, nowIso } from "../db";

// Capture-time completed-PR summarizer. Runs ONCE, when the webhook captures a
// newly-written pr_merged/pr_closed event (src/webhook.ts) — never at render
// time. A summary failure (throw, empty response) must never fail capture; the
// deterministic excerpt fallback guarantees storePrSummary always succeeds.

/** Structured PR summary — the JSON object the PR prompt demands. */
export interface PrSummary {
  title: string;          // humanized display title, grounded in the real title+body
  what: string;           // the concrete change that shipped
  why: string | null;     // motivation, only when the body states one
  impact: string | null;  // one user-facing outcome sentence, never files
}

/** Structured issue summary — the JSON object the issue prompt demands. */
export interface IssueSummary {
  title: string;
  summary: string;          // plain restatement of what the issue is
  next_step: string | null; // only when the issue states/implies an action
}

/** One PR/issue's title+body in, a validated structured summary (or null) out.
 *  `model` is the provenance recorded on the stored row. */
export interface Summarizer<T> {
  readonly model: string;
  summarize(input: { title: string; body: string }): Promise<T | null>;
}

// @cf/meta/llama-3.1-8b-instruct was retired from the Workers AI catalog
// (silently — every call threw "model not found," caught by the try/catch
// below, always falling back to the excerpt summarizer). gemma-4-26b-a4b-it
// is Google's current flagship open model on Workers AI — comfortably within
// the free daily Neuron allocation for this workload (~5 neurons/call).
const WORKERS_AI_MODEL = "@cf/google/gemma-4-26b-a4b-it";

// The 26B model is slow but bounded — a healthy call resolves in a few seconds.
// When the daily Neuron budget is exhausted or the model is overloaded, ai.run
// has been observed to hang indefinitely (never resolves, never rejects), which
// would wedge the /admin/backfill request the browser waits on. This ceiling
// races every call against a timer so a hang degrades to the excerpt fallback
// instead of a permanent stall; 15s is comfortably above a healthy call's latency.
export const WORKERS_AI_TIMEOUT_MS = 15000;

export const SUMMARIZER_SYSTEM_PROMPT =
  "Summarize this pull request for a team activity feed — what shipped. " +
  "Respond with a SINGLE JSON object and nothing else — no code fences, no preamble: " +
  '{"title": string, "what": string, "why": string or null, "impact": string or null}. ' +
  '"title": a short humanized sentence-case rewrite of what the PR did, grounded only in the provided title and description — never invent scope. ' +
  '"what": 1-2 sentences leading with the concrete change that shipped; do not just restate the title. ' +
  '"why": the motivation, only where the description states one; else null. ' +
  '"impact": one sentence on the outcome for people using the product — what it enables or fixes; NEVER a list of files touched; null when the description does not support one. ' +
  "The description records work that already happened — report what it states, never extrapolate beyond it. " +
  'If the description is empty or too thin to add anything beyond the title, use the title verbatim for "title" and "what" and null for "why" and "impact".';

export const ISSUE_SUMMARIZER_SYSTEM_PROMPT =
  "Summarize this GitHub issue for a personal to-do list. " +
  "Respond with a SINGLE JSON object and nothing else — no code fences, no preamble: " +
  '{"title": string, "summary": string, "next_step": string or null}. ' +
  '"title": a short humanized sentence-case rewrite of what the issue is about, grounded only in its title and description. ' +
  '"summary": 1-3 sentences plainly restating what the issue is, grounded only in its title and description. ' +
  '"next_step": what needs doing, ONLY where the issue states or clearly implies an action; if the issue is vague, aspirational, or states no clear action, use null — never invent a next step, a plan, or a scope the issue never stated. ' +
  'If the description is empty or too thin, use the title verbatim for "title" and "summary" and null for "next_step".';

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

/** Extracts the single JSON object a summarizer prompt demands. Strips an
 *  accidental markdown fence, then tolerates any prose the model prepends or
 *  appends around the object by slicing from the first `{` to the last `}`;
 *  anything that isn't one JSON object → null. */
export function parseStructuredJson(text: string): Record<string, unknown> | null {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const first = stripped.indexOf("{");
  const last = stripped.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  try {
    const parsed: unknown = JSON.parse(stripped.slice(first, last + 1));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Field coercion: required = non-empty string after trim (else the whole
// object is rejected); nullable = trimmed string, '' / null / undefined → null,
// any other type rejects the whole object (undefined is the reject marker).
function reqStr(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}
function nullableStr(v: unknown): string | null | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

export function validatePrSummary(o: Record<string, unknown>): PrSummary | null {
  const title = reqStr(o.title);
  const what = reqStr(o.what);
  if (title === null || what === null) return null;
  const why = nullableStr(o.why);
  const impact = nullableStr(o.impact);
  if (why === undefined || impact === undefined) return null;
  return { title, what, why, impact };
}

export function validateIssueSummary(o: Record<string, unknown>): IssueSummary | null {
  const title = reqStr(o.title);
  const summary = reqStr(o.summary);
  if (title === null || summary === null) return null;
  const next_step = nullableStr(o.next_step);
  if (next_step === undefined) return null;
  return { title, summary, next_step };
}

/** Shared Workers AI call machinery for both summarizers — only the prompt and
 *  validator differ. Never throws: any failure (network, empty output, prose
 *  instead of JSON, malformed/mistyped fields) resolves to null so the caller
 *  falls back to excerptSummary. */
function makeWorkersAiSummarizer<T>(
  ai: Ai,
  systemPrompt: string,
  validate: (o: Record<string, unknown>) => T | null,
  timeoutMs: number = WORKERS_AI_TIMEOUT_MS
): Summarizer<T> {
  return {
    model: WORKERS_AI_MODEL,
    async summarize({ title, body }) {
      // A hung ai.run neither resolves nor rejects, so the try/catch alone can't
      // save us — race it against a timer whose rejection lands in the same catch
      // and degrades to the excerpt fallback. Promise.race only stops WAITING,
      // though; the losing ai.run keeps its inference subrequest alive and keeps
      // consuming capacity. So thread an AbortSignal into the call and abort it
      // when the timer wins, actually cancelling the in-flight request. clearTimeout
      // in finally so a healthy call doesn't leave the timer pending.
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          ai.run(
            WORKERS_AI_MODEL,
            {
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: `Title: ${title}\n\nBody: ${body}` },
              ],
            },
            { signal: controller.signal }
          ),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error(`Workers AI timed out after ${timeoutMs}ms`));
            }, timeoutMs);
          }),
        ]);
        const response = extractResponseText(result);
        if (response === null) return null;
        const obj = parseStructuredJson(response);
        if (obj === null) return null;
        return validate(obj);
      } catch (err) {
        // A timeout, a thrown error (e.g. model-not-found), or malformed output
        // all land here and degrade to the excerpt fallback. Logged so a spike in
        // timeouts (exhausted Neuron budget) is visible in `wrangler tail`.
        const kind = systemPrompt === SUMMARIZER_SYSTEM_PROMPT ? "pr" : "issue";
        console.error(`workersAiSummarizer (${kind}) failed:`, err instanceof Error ? err.message : err);
        return null;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}

/** PR summarizer. Bounded to that PR's own title+body — no other context is sent.
 *  `timeoutMs` (injectable for tests) caps the ai.run call; a hang → null → excerpt. */
export function workersAiPrSummarizer(ai: Ai, timeoutMs?: number): Summarizer<PrSummary> {
  return makeWorkersAiSummarizer(ai, SUMMARIZER_SYSTEM_PROMPT, validatePrSummary, timeoutMs);
}

/** Issue summarizer. Bounded to that issue's own title+body — no other context is sent.
 *  `timeoutMs` (injectable for tests) caps the ai.run call; a hang → null → excerpt. */
export function workersAiIssueSummarizer(ai: Ai, timeoutMs?: number): Summarizer<IssueSummary> {
  return makeWorkersAiSummarizer(ai, ISSUE_SUMMARIZER_SYSTEM_PROMPT, validateIssueSummary, timeoutMs);
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
 * Try the summarizer, fall back to excerptSummary (model:'excerpt', NULL
 * structured columns) on any null/throw. On structured success `summary`
 * mirrors `what` — sane prose for any reader of the old column. INSERT OR
 * REPLACE keeps one row per semantic_key. NEVER throws — a summary failure
 * must not fail the webhook capture that triggered it.
 */
export async function storePrSummary(
  db: DB,
  summarizer: Summarizer<PrSummary> | null,
  pr: { semantic_key: string; pr_number: number; title: string; body: string }
): Promise<PrSummaryRow> {
  let structured: PrSummary | null = null;
  let model = "excerpt";
  if (summarizer) {
    try {
      structured = await summarizer.summarize({ title: pr.title, body: pr.body });
      if (structured) model = summarizer.model;
    } catch {
      structured = null;
    }
  }
  const summary = structured ? structured.what : excerptSummary(pr.title, pr.body);
  const created_at = nowIso();
  await run(
    db,
    `INSERT OR REPLACE INTO pr_summaries (semantic_key, pr_number, summary, model, created_at, title, what, why, impact)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    pr.semantic_key,
    pr.pr_number,
    summary,
    model,
    created_at,
    structured?.title ?? null,
    structured?.what ?? null,
    structured?.why ?? null,
    structured?.impact ?? null
  );
  return {
    semantic_key: pr.semantic_key,
    pr_number: pr.pr_number,
    summary,
    model,
    created_at,
    title: structured?.title ?? null,
    what: structured?.what ?? null,
    why: structured?.why ?? null,
    impact: structured?.impact ?? null,
  };
}

/**
 * Issue mirror of storePrSummary: `summary` is the structured summary field on
 * success, the excerpt on fallback; title/next_step NULL on fallback. INSERT OR
 * REPLACE keeps one row per issue_number. NEVER throws.
 */
export async function storeIssueSummary(
  db: DB,
  summarizer: Summarizer<IssueSummary> | null,
  issue: { issue_number: number; title: string; body: string }
): Promise<IssueSummaryRow> {
  let structured: IssueSummary | null = null;
  let model = "excerpt";
  if (summarizer) {
    try {
      structured = await summarizer.summarize({ title: issue.title, body: issue.body });
      if (structured) model = summarizer.model;
    } catch {
      structured = null;
    }
  }
  const summary = structured ? structured.summary : excerptSummary(issue.title, issue.body);
  const created_at = nowIso();
  await run(
    db,
    `INSERT OR REPLACE INTO issue_summaries (issue_number, summary, model, created_at, title, next_step)
     VALUES (?, ?, ?, ?, ?, ?)`,
    issue.issue_number,
    summary,
    model,
    created_at,
    structured?.title ?? null,
    structured?.next_step ?? null
  );
  return {
    issue_number: issue.issue_number,
    summary,
    model,
    created_at,
    title: structured?.title ?? null,
    next_step: structured?.next_step ?? null,
  };
}
