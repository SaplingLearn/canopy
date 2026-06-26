import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: false });

/**
 * Render a markdown doc body to sanitized HTML for innerHTML. Doc bodies are agent-written
 * and reach the DOM via template-string innerHTML, so every body passes through DOMPurify —
 * marked turns the markdown into HTML and DOMPurify strips any embedded <script>/event-handler
 * before it is inserted. This is the one place raw HTML enters the docs reader.
 */
export function renderMarkdown(body: string): string {
  const html = marked.parse(body ?? "", { async: false }) as string;
  return DOMPurify.sanitize(html);
}
