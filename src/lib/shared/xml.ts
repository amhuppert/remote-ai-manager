/**
 * Escape a string for use inside a double-quoted XML attribute. Newlines and
 * tabs are flattened to single spaces so the attribute stays on one line.
 */
export function escapeXmlAttr(value: string): string {
  const flattened = value.replace(/[\r\n\t]+/g, " ").replace(/  +/g, " ");
  return flattened
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Decode the entities produced by {@link escapeXmlAttr}. */
export function decodeXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
