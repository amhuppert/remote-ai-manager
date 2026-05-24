export interface FileAutocompleteTriggerResult {
  /** Text after the @ character */
  query: string;
  /** Index of the @ character in the text */
  startIndex: number;
  /** Cursor position (end of the current query segment) */
  endIndex: number;
}

/** Characters that are valid within a file-path token after @ */
function isPathChar(ch: string): boolean {
  // alphanumeric, slash, dot, hyphen, underscore
  return /[\w/.\-]/.test(ch);
}

/** Characters that indicate a word boundary before @ */
function isWordBoundary(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/**
 * Detect whether the cursor is inside an @-triggered file path query.
 *
 * Returns the query text (after @), plus the start/end indices for replacement,
 * or null if no @-trigger is active at the cursor position.
 */
export function detectFileAutocompleteTrigger(
  text: string,
  cursorPosition: number,
): FileAutocompleteTriggerResult | null {
  if (cursorPosition <= 0 || text.length === 0) return null;

  // Walk backward from cursor to find where the current token ends
  // (stop at space or start of string)
  // First, find the end of the token at cursor — we consider everything
  // from cursor backward until a whitespace or start.
  let pos = cursorPosition - 1;

  // Walk backward through path-valid characters
  while (pos >= 0 && isPathChar(text[pos]!)) {
    pos--;
  }

  // pos should now be at the @ character (or we didn't find one)
  if (pos < 0 || text[pos] !== "@") return null;

  // Verify @ is at a word boundary (start of text, or preceded by whitespace)
  if (pos > 0 && !isWordBoundary(text[pos - 1]!)) return null;

  const startIndex = pos;
  const endIndex = cursorPosition;
  const query = text.slice(startIndex + 1, endIndex);

  return { query, startIndex, endIndex };
}
