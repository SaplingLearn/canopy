// @mention autocomplete — the three pure helpers behind the ticket comment
// box's picker. No DOM, no state, no fetching: main.ts owns the textarea and
// the caret, tickets.ts owns the markup, and everything decidable from
// (text, caret, persons) is decided here so it can be unit-tested.
//
// Comments are stored as RAW text; `mentionize()` in tickets.ts paints the
// `@handle` / `@Firstname` forms at render time. The picker only ever helps a
// writer type one of those forms — it never changes what is stored.

import type { PersonSummary } from "./api";

/** The `@…` token the caret is sitting in: where the `@` is, and what follows it. */
export interface MentionToken {
  /** Index of the `@` itself in `text`. */
  start: number;
  /** The characters between the `@` and the caret (may be empty). */
  query: string;
}

/** A mention token is `@` + these; anything else ends it. */
const TOKEN_CHAR = /[A-Za-z0-9_-]/;

/**
 * The open mention token at `caret`, or null when the caret isn't in one.
 *
 * A token counts only when its `@` starts the text or follows whitespace (so
 * `a@b` is an email-ish fragment, not a mention) and the caret sits after that
 * `@` — a caret BEFORE the `@` is outside the token and closes the picker.
 */
export function mentionTokenAt(text: string, caret: number): MentionToken | null {
  if (caret < 0 || caret > text.length) return null;
  // Walk back over the token characters immediately before the caret.
  let i = caret;
  while (i > 0 && TOKEN_CHAR.test(text[i - 1])) i--;
  const at = i - 1;
  if (at < 0 || text[at] !== "@") return null;
  // The `@` must open a word: start of text, or right after whitespace/newline.
  if (at > 0 && !/\s/.test(text[at - 1])) return null;
  return { start: at, query: text.slice(i, caret) };
}

/**
 * Persons whose handle — or any whitespace-separated word of their name —
 * starts with `query`, case-insensitively. An empty query lists everyone.
 * An exact handle match sorts first; the rest go by `name ?? handle` ascending.
 */
export function mentionCandidates(persons: PersonSummary[], query: string, limit = 6): PersonSummary[] {
  const q = query.toLowerCase();
  const hit = persons.filter((p) => {
    if (!q) return true;
    if (p.handle.toLowerCase().startsWith(q)) return true;
    return (p.name ?? "").split(/\s+/).filter(Boolean).some((w) => w.toLowerCase().startsWith(q));
  });
  // `filter` already copied, so this sort never mutates the caller's array.
  hit.sort((a, b) => {
    const ax = q && a.handle.toLowerCase() === q ? 0 : 1;
    const bx = q && b.handle.toLowerCase() === q ? 0 : 1;
    if (ax !== bx) return ax - bx;
    return (a.name ?? a.handle).localeCompare(b.name ?? b.handle);
  });
  return hit.slice(0, limit);
}

/**
 * Replace the token `[start, caret)` with `@<handle> ` (trailing space), and
 * report where the caret lands — right after that space, so the writer keeps
 * typing the sentence rather than extending the mention.
 */
export function applyMention(
  text: string, start: number, caret: number, handle: string,
): { text: string; caret: number } {
  const insert = `@${handle} `;
  return {
    text: text.slice(0, start) + insert + text.slice(caret),
    caret: start + insert.length,
  };
}
