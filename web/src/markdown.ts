import { marked, type Tokens } from "marked";
import DOMPurify from "dompurify";
import { REPO_URL } from "./github";
import { slugifyHeading } from "./outline";
import { issueRefStart, matchIssueRef } from "./issue-ref";

marked.setOptions({ gfm: true, breaks: false });

// Auto-link GitHub issue/PR refs in prose — bare `#123` (this org's main repo) and
// `owner/repo#123` (that repo; see issue-ref.ts). Runs as an inline extension, so
// it skips code spans/blocks (tokenized separately) and its output is still DOMPurify-sanitized.
marked.use({
  extensions: [
    {
      name: "issueRef",
      level: "inline",
      start(src: string) {
        return issueRefStart(src);
      },
      tokenizer(src: string) {
        const ref = matchIssueRef(src, REPO_URL);
        if (ref) return { type: "issueRef", raw: ref.raw, href: ref.href, text: ref.text } as Tokens.Generic;
        return undefined;
      },
      renderer(token) {
        // `href` is built from a strict owner/repo#N match and `text` is that same
        // match — no quotes or angle brackets can occur — and the result still
        // passes through DOMPurify with everything else.
        const { href, text } = token as unknown as { href: string; text: string };
        return `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
      },
    },
  ],
});

/**
 * Render a markdown doc body to sanitized HTML for innerHTML. Doc bodies are agent-written
 * and reach the DOM via template-string innerHTML, so every body passes through DOMPurify —
 * marked turns the markdown into HTML and DOMPurify strips any embedded <script>/event-handler
 * before it is inserted. This is the one place raw HTML enters the docs reader.
 */
export function renderMarkdown(body: string): string {
  const html = marked.parse(body ?? "", { async: false }) as string;
  const clean = DOMPurify.sanitize(html);
  return enhance(clean);
}

/**
 * Progressive-enhancement pass over the already-sanitized HTML, done in a detached
 * <template> (never re-inserts unsanitized markup):
 *  • wrap each fenced code block in a `.cnpy-code` panel, tagged with its language;
 *  • wrap each table in a `.cnpy-md-tablewrap` so wide tables scroll instead of
 *    overflowing the reader column.
 * Browser-only — the reader is the sole caller at runtime; render tests mock this module.
 */
function enhance(clean: string): string {
  if (typeof document === "undefined") return clean;
  const tpl = document.createElement("template");
  tpl.innerHTML = clean;

  // Anchor ids on every heading (document order, de-duped) so the tree outline
  // can scroll to them. slugifyHeading + this de-dup mirror extractOutline().
  const seen = new Map<string, number>();
  tpl.content.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((h) => {
    let id = slugifyHeading(h.textContent ?? "") || "section";
    const n = seen.get(id) ?? 0;
    seen.set(id, n + 1);
    if (n > 0) id = `${id}-${n}`;
    if (!h.id) h.id = id;
  });

  tpl.content.querySelectorAll("pre").forEach((pre) => {
    const wrap = document.createElement("div");
    wrap.className = "cnpy-code";
    const lang = /language-([A-Za-z0-9+#._-]+)/.exec(pre.querySelector("code")?.className ?? "")?.[1];
    if (lang) {
      const tag = document.createElement("div");
      tag.className = "cnpy-code-lang";
      tag.textContent = lang;
      wrap.appendChild(tag);
    }
    pre.replaceWith(wrap);
    wrap.appendChild(pre);
  });

  tpl.content.querySelectorAll("table").forEach((table) => {
    const wrap = document.createElement("div");
    wrap.className = "cnpy-md-tablewrap";
    table.replaceWith(wrap);
    wrap.appendChild(table);
  });

  return tpl.innerHTML;
}
