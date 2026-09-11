// Minimal helpers for the email renderers. Everything interpolated into a
// section's html goes through escapeHtml; the text alternative is plain.

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** SQLite-comparable ISO8601 (datetime() parses both the .sss and bare-Z forms). */
export const isoOf = (d: Date): string => d.toISOString();
