/** Escape text for safe inclusion in HTML. */
export function escapeHtml(value: unknown): string {
  const s = value == null ? "" : String(value);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escape for Markdown inline code / avoid breaking fences naively. */
export function escapeMd(value: unknown): string {
  const s = value == null ? "" : String(value);
  return s.replace(/\|/g, "\\|").replace(/`/g, "\\`");
}
