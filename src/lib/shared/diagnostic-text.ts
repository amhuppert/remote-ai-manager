/**
 * Located diagnostics are rendered ONE PER LINE (`  <path>: <message>`), and
 * they quote values straight out of a document that failed validation — a
 * malformed id is precisely what they exist to describe. A raw newline in one
 * of those values splits a single issue across two lines, and the second line
 * is indistinguishable from a genuine located issue: an authored file could
 * forge diagnostics about paths it never touched.
 *
 * Two jobs, two functions, because they protect different spans:
 *
 * - {@link escapeDiagnosticValue} guards a value about to be interpolated into
 *   a message, usually inside quotes. It escapes the quote and backslash too,
 *   so a value cannot fake the end of the span that contains it.
 * - {@link flattenDiagnosticText} guards a WHOLE assembled diagnostic at the
 *   surface that renders it as a line. It leaves quotes and backslashes alone
 *   (they are ordinary punctuation in a finished sentence) and neutralizes only
 *   what could break the line.
 *
 * Both escape rather than strip, so an author still sees what they wrote, and
 * both leave well-formed text byte-identical — the everyday rendering is
 * unchanged, and applying either twice changes nothing the second time.
 *
 * U+2028/U+2029 are escaped alongside the C0 controls because several readers
 * downstream of a diagnostic treat them as line terminators too.
 */

const SHORTHAND: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

const CONTROLS = "\\u0000-\\u001f\\u007f\\u2028\\u2029";
// eslint-disable-next-line no-control-regex
const LINE_BREAKING = new RegExp(`[${CONTROLS}]`, "g");
// eslint-disable-next-line no-control-regex
const QUOTED_VALUE = new RegExp(`["\\\\${CONTROLS}]`, "g");

function escapeChar(char: string): string {
  return (
    SHORTHAND[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

/** Escape a value being interpolated into a diagnostic message. */
export function escapeDiagnosticValue(value: string): string {
  return value.replace(QUOTED_VALUE, escapeChar);
}

/**
 * Flatten a complete diagnostic to a single line's worth of text.
 *
 * Applied where a surface renders `  <path>: <message>` rather than only where
 * this project's own messages are built: a message can be assembled anywhere —
 * including inside Zod — and the one-line contract belongs to whoever promises
 * it, not to every producer remembering to.
 */
export function flattenDiagnosticText(text: string): string {
  return text.replace(LINE_BREAKING, escapeChar);
}
