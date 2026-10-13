import { open } from "node:fs/promises";

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

/** Positional reads, as `FileHandle` offers them. */
export interface ByteRangeReader {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
}

/** One `split("\n")` segment of a byte range. */
export interface ByteRangeLine {
  /** The segment decoded as UTF-8, without its LF. */
  text: string;
  /** Offset just past the segment's LF; the range end for the final segment. */
  end: number;
  /** False only for the final segment: the bytes after the range's last LF. */
  terminated: boolean;
}

const LINE_READ_CHUNK_BYTES = 1024 * 1024;

/**
 * Yield the `split("\n")` segments of the byte range `[start, end)`, decoding
 * each one on its own. A JSONL file can outgrow V8's maximum string length
 * (~512 MiB), and decoding it whole then throws `RangeError: Invalid string
 * length`; segment order and count still match `split("\n")` of the whole
 * range. Lines split on the LF byte, not with `readline`, which also splits on
 * U+2028/U+2029 that JSON leaves raw inside strings. A range that ends early
 * because the file is shorter yields what was read.
 */
export async function* readLines(
  reader: ByteRangeReader,
  start: number,
  end: number,
): AsyncGenerator<ByteRangeLine> {
  let pending: Buffer[] = [];
  let position = start;
  while (position < end) {
    const chunk = Buffer.allocUnsafe(
      Math.min(LINE_READ_CHUNK_BYTES, end - position),
    );
    const { bytesRead } = await reader.read(chunk, 0, chunk.length, position);
    if (bytesRead <= 0) break;
    const bytes = chunk.subarray(0, bytesRead);
    let lineStart = 0;
    for (
      let newline = bytes.indexOf(0x0a);
      newline !== -1;
      newline = bytes.indexOf(0x0a, lineStart)
    ) {
      const piece = bytes.subarray(lineStart, newline);
      const text =
        pending.length === 0
          ? piece.toString("utf-8")
          : Buffer.concat([...pending, piece]).toString("utf-8");
      pending = [];
      lineStart = newline + 1;
      yield { text, end: position + lineStart, terminated: true };
    }
    if (lineStart < bytes.length) pending.push(bytes.subarray(lineStart));
    position += bytesRead;
  }
  yield {
    text: Buffer.concat(pending).toString("utf-8"),
    end: position,
    terminated: false,
  };
}

/** The text of every `split("\n")` segment of a file; see {@link readLines}. */
export async function* readFileLines(filePath: string): AsyncGenerator<string> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    for await (const line of readLines(handle, 0, size)) yield line.text;
  } finally {
    await handle.close();
  }
}
