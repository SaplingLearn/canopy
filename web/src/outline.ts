// Doc outline — the per-page table of contents shown in the docs tree, and the
// anchor ids the reader's headings carry. Both sides derive ids from the SAME
// slugify + de-dup logic so a tree link always resolves to a reader heading.

export interface OutlineItem {
  level: number; // 2 or 3
  text: string;
  id: string;
}

/** GitHub-ish anchor slug: lowercase, strip inline marks/punctuation, dash-join. */
export function slugifyHeading(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // [label](url) -> label
    .replace(/[`*_~]/g, "") // inline emphasis / code marks
    .replace(/[^\w\s-]/g, "") // drop remaining punctuation
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * H2/H3 outline of a markdown body, skipping fenced code blocks. De-dups ids
 * across ALL heading levels (h1–h6) in document order so the counters match the
 * ids assigned to every rendered heading in markdown.ts.
 */
export function extractOutline(body: string): OutlineItem[] {
  const out: OutlineItem[] = [];
  const seen = new Map<string, number>();
  let inFence = false;
  for (const line of (body ?? "").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const level = m[1].length;
    let id = slugifyHeading(m[2]) || "section";
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    if (n > 0) id = `${id}-${n}`;
    if (level === 2 || level === 3) {
      const text = m[2].replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[`*_~]/g, "").trim();
      out.push({ level, text, id });
    }
  }
  return out;
}
