// Server-side line diff for change_kind classification. web/src/render.ts has a
// `lineDiff` used for the Triage UI, but web/ can't be imported by src/, so the
// LCS core is reimplemented here. We only need the COUNTS (how many lines changed
// relative to the larger side), not the rendered rows.

/**
 * Lines changed (added + deleted) between two texts, via an LCS longest-common-
 * subsequence over lines. `changed = (oldLines - common) + (newLines - common)`.
 */
export function lineChangeStats(oldText: string, newText: string): { changed: number; max: number } {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  // dp[i][j] = length of the LCS of a[i..] and b[j..].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const common = dp[0][0];
  const changed = (n - common) + (m - common);
  return { changed, max: Math.max(n, m) };
}

/**
 * change_kind for an EXISTING promoted body (callers pass `new` themselves when
 * there is no promoted body). `changed / max(old,new) < 0.5` → edit, else rewrite.
 * An empty diff (changed === 0) is an edit by definition.
 */
export function changeKind(promotedBody: string, newBody: string): "edit" | "rewrite" {
  const { changed, max } = lineChangeStats(promotedBody, newBody);
  if (max === 0) return "edit";
  return changed / max < 0.5 ? "edit" : "rewrite";
}
