import { marked, type Tokens } from "marked";
import DOMPurify from "dompurify";
import { REPO_URL } from "./github";

marked.setOptions({ gfm: true, breaks: false });

// Auto-link bare GitHub issue/PR refs like #123 in prose. Runs as an inline extension, so
// it skips code spans/blocks (tokenized separately) and its output is still DOMPurify-sanitized.
marked.use({
  extensions: [
    {
      name: "issueRef",
      level: "inline",
      start(src: string) {
        const i = src.indexOf("#");
        return i < 0 ? undefined : i;
      },
      tokenizer(src: string) {
        const m = /^#(\d+)\b/.exec(src);
        if (m) return { type: "issueRef", raw: m[0], num: m[1] } as Tokens.Generic;
        return undefined;
      },
      renderer(token) {
        const num = (token as Tokens.Generic).num as string;
        return `<a href="${REPO_URL}/issues/${num}" target="_blank" rel="noopener">#${num}</a>`;
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
  if (typeof document === "undefined" || (!clean.includes("<pre") && !clean.includes("<table"))) return clean;
  const tpl = document.createElement("template");
  tpl.innerHTML = clean;

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
