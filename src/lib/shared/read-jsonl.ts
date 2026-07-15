/**
 * Parse a JSONL (newline-delimited JSON) blob into one parsed value per line.
 *
 * Shared by the transcript, telemetry, debug-log, execution-log, and
 * collaboration-artifact readers, which each hand-rolled the same loop: split
 * on newlines, skip blank lines, `JSON.parse` each line, and tolerate a
 * malformed line by skipping it rather than aborting the whole read (JSONL
 * files are appended line-by-line, so a crash mid-append can leave a partial
 * final line — one bad line must not lose every good one before it).
 *
 * Blank/whitespace-only lines are skipped silently. A line that fails to parse
 * is skipped and reported to `onError` (when supplied) so the caller can log
 * it with its own vocabulary; the parse never throws for a bad line.
 *
 * This does NOT validate the parsed shape — it returns `unknown` per line.
 * Callers that need a typed result should map/validate the output (e.g. via a
 * Zod schema). `\r\n` and `\n` line endings are both handled.
 */

export interface ReadJsonlOptions {
  /**
   * Invoked for each line that fails `JSON.parse`, with the raw line, its
   * zero-based index in the file, and the parse error. The line is skipped
   * regardless.
   */
  onError?(line: string, index: number, error: unknown): void;
}

/** One successfully-parsed line paired with its true zero-based index in the
 * source file — the index BEFORE blank/malformed lines are compacted away. */
export interface JsonlLine {
  value: unknown;
  /** Zero-based line index in the original text, counting blank and malformed
   * lines that were skipped. Use this (not the array position) for diagnostics
   * that must name the on-disk line. */
  lineIndex: number;
}

/**
 * Parse a JSONL blob preserving each surviving value's true source line index.
 *
 * Callers that validate the parsed shape (e.g. via a Zod `safeParse`) and log a
 * per-line diagnostic MUST use this form, not {@link parseJsonl}: the returned
 * array is compacted (blank/malformed lines removed), so indexing into a plain
 * value array names the wrong on-disk line whenever a skipped line precedes a
 * bad one. `onError` still receives the true source index for parse failures.
 */
export function parseJsonlWithIndex(
  text: string,
  options: ReadJsonlOptions = {},
): JsonlLine[] {
  const out: JsonlLine[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim().length === 0) continue;
    try {
      out.push({ value: JSON.parse(line), lineIndex: index });
    } catch (error) {
      options.onError?.(line, index, error);
    }
  }
  return out;
}

export function parseJsonl(
  text: string,
  options: ReadJsonlOptions = {},
): unknown[] {
  return parseJsonlWithIndex(text, options).map((entry) => entry.value);
}
