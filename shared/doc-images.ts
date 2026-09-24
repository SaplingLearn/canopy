// Doc images — the reference format and the body scan, ONCE (zod-free: the SPA may
// import it). A doc embeds an image as `![alt](/img/<sha256>)`; the bytes live in R2
// at `doc-images/<sha256>` behind the session-cookie route GET /img/<sha256>. Every
// ref is content-addressed, so a promoted doc version renders the same forever.
// Spec: docs/superpowers/specs/2026-09-24-doc-images-design.md.

/** `/img/<64 hex>` — the only image source a doc body may use. */
export const DOC_IMAGE_PATH_RE = /^\/img\/([0-9a-f]{64})$/;

export const docImageRef = (sha256: string): string => `/img/${sha256}`;

/** The R2 key an image's bytes live at (same bucket as artifacts, its own prefix). */
export const docImageKey = (sha256: string): string => `doc-images/${sha256}`;

export interface DocImageScan {
  /** Distinct sha256s referenced as `/img/<sha>`, in first-seen order. */
  shas: string[];
  /** Every OTHER image source (external URL, data: URI, any other path), in order. */
  others: string[];
}

/**
 * Every image source a markdown body would render: `![alt](src "title")` (also the
 * `<src>` form) and raw `<img src="…">` (marked passes HTML through and DOMPurify
 * keeps <img>). Fenced code blocks and inline code are skipped — a doc that explains
 * image syntax is not embedding an image. Reference-style images (`![a][id]`) resolve
 * to a `[id]: src` definition, so those definitions are scanned too.
 */
export function scanDocImages(body: string): DocImageScan {
  const text = stripCode(body ?? "");
  const srcs: string[] = [];
  for (const m of text.matchAll(/!\[[^\]]*\]\(\s*(?:<([^>]*)>|([^)\s]+))/g)) srcs.push((m[1] ?? m[2] ?? "").trim());
  for (const m of text.matchAll(/<img\b[^>]*?\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) srcs.push((m[1] ?? m[2] ?? m[3] ?? "").trim());
  const refIds = new Set([...text.matchAll(/!\[[^\]]*\]\[([^\]]*)\]/g)].map((m) => m[1].trim().toLowerCase()));
  if (refIds.size) {
    for (const m of text.matchAll(/^ {0,3}\[([^\]]+)\]:\s*<?(\S+?)>?(?:\s|$)/gm)) {
      if (refIds.has(m[1].trim().toLowerCase())) srcs.push(m[2].trim());
    }
  }
  const shas: string[] = [];
  const others: string[] = [];
  for (const src of srcs) {
    const m = DOC_IMAGE_PATH_RE.exec(src);
    if (m) { if (!shas.includes(m[1])) shas.push(m[1]); }
    else others.push(src);
  }
  return { shas, others };
}

/** Blank out fenced blocks and inline code spans (keeping line structure). */
function stripCode(body: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of body.split("\n")) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      out.push("");
      continue;
    }
    if (f) { fence = f[1]; out.push(""); continue; }
    out.push(line.replace(/(`+)[\s\S]*?\1/g, ""));
  }
  return out.join("\n");
}
