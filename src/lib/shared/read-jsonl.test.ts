import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseJsonl,
  parseJsonlWithIndex,
  readFileLines,
  readLines,
  type ByteRangeReader,
} from "./read-jsonl";

describe("parseJsonl", () => {
  it("parses one value per non-blank line", () => {
    const text = '{"a":1}\n{"b":2}\n{"c":3}';
    expect(parseJsonl(text)).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("skips blank and whitespace-only lines", () => {
    const text = '{"a":1}\n\n   \n{"b":2}\n';
    expect(parseJsonl(text)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("handles both \\n and \\r\\n line endings", () => {
    const text = '{"a":1}\r\n{"b":2}\r\n';
    expect(parseJsonl(text)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("skips a malformed line but keeps the good ones before and after", () => {
    const text = '{"a":1}\nnot json\n{"b":2}';
    expect(parseJsonl(text)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("tolerates a truncated final line (partial append)", () => {
    const text = '{"a":1}\n{"b":2}\n{"c":';
    expect(parseJsonl(text)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("reports each failing line to onError with its raw text and index", () => {
    const onError = vi.fn();
    const text = '{"a":1}\nbroken\n{"b":2}';
    const result = parseJsonl(text, { onError });

    expect(result).toEqual([{ a: 1 }, { b: 2 }]);
    expect(onError).toHaveBeenCalledTimes(1);
    const [line, index, error] = onError.mock.calls[0]!;
    expect(line).toBe("broken");
    expect(index).toBe(1);
    expect(error).toBeInstanceOf(Error);
  });

  it("returns an empty array for empty input", () => {
    expect(parseJsonl("")).toEqual([]);
    expect(parseJsonl("\n\n")).toEqual([]);
  });

  it("preserves non-object JSON values (numbers, strings, arrays)", () => {
    const text = '1\n"two"\n[3,4]';
    expect(parseJsonl(text)).toEqual([1, "two", [3, 4]]);
  });
});

describe("parseJsonlWithIndex", () => {
  it("pairs each parsed value with its true zero-based source line index", () => {
    const text = '{"a":1}\n{"b":2}\n{"c":3}';
    expect(parseJsonlWithIndex(text)).toEqual([
      { value: { a: 1 }, lineIndex: 0 },
      { value: { b: 2 }, lineIndex: 1 },
      { value: { c: 3 }, lineIndex: 2 },
    ]);
  });

  it("keeps the SOURCE line index across skipped blank and malformed lines", () => {
    // Blank at 0, malformed at 2 — the surviving value on line 3 must report
    // lineIndex 3, not the compacted position 0.
    const text = '\n{"a":1}\nnot json\n{"b":2}';
    expect(parseJsonlWithIndex(text)).toEqual([
      { value: { a: 1 }, lineIndex: 1 },
      { value: { b: 2 }, lineIndex: 3 },
    ]);
  });

  it("reports each failing line to onError with its raw text and true source index", () => {
    const onError = vi.fn();
    const text = '\n{"a":1}\nbroken\n{"b":2}';
    const result = parseJsonlWithIndex(text, { onError });

    expect(result).toEqual([
      { value: { a: 1 }, lineIndex: 1 },
      { value: { b: 2 }, lineIndex: 3 },
    ]);
    expect(onError).toHaveBeenCalledTimes(1);
    const [line, index, error] = onError.mock.calls[0]!;
    expect(line).toBe("broken");
    expect(index).toBe(2);
    expect(error).toBeInstanceOf(Error);
  });

  it("returns an empty array for empty or blank-only input", () => {
    expect(parseJsonlWithIndex("")).toEqual([]);
    expect(parseJsonlWithIndex("\n\n")).toEqual([]);
  });
});

/** Serves `bytes` at most `maxPerRead` bytes per call, as a short read may. */
function bufferReader(bytes: Buffer, maxPerRead: number): ByteRangeReader {
  return {
    async read(buffer, offset, length, position) {
      const bytesRead = Math.max(
        0,
        Math.min(length, maxPerRead, bytes.length - position),
      );
      bytes.copy(buffer, offset, position, position + bytesRead);
      return { bytesRead };
    },
  };
}

async function collect<T>(lines: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const line of lines) out.push(line);
  return out;
}

// U+2028 is valid raw inside a JSON string; only the LF byte ends a line.
const MIXED_TEXT =
  '{"a":"caf\u00e9 \ud83d\ude80"}\n\n{"b":"x\u2028y"}\r\n{"c":';

describe("readLines", () => {
  it("yields the segments split('\\n') would, across short reads and multi-byte characters", async () => {
    const bytes = Buffer.from(MIXED_TEXT, "utf-8");

    const lines = await collect(
      readLines(bufferReader(bytes, 3), 0, bytes.length),
    );

    expect(lines.map((line) => line.text)).toEqual(MIXED_TEXT.split("\n"));
    expect(lines.map((line) => line.terminated)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(lines.map((line) => line.end)).toEqual([
      bytes.indexOf(0x0a) + 1,
      bytes.indexOf(0x0a) + 2,
      bytes.lastIndexOf(0x0a) + 1,
      bytes.length,
    ]);
  });

  it("reads only the requested byte range and reports absolute offsets", async () => {
    const bytes = Buffer.from('{"a":1}\n{"b":2}\n{"c":3}\n', "utf-8");

    const lines = await collect(readLines(bufferReader(bytes, 64), 8, 16));

    expect(lines).toEqual([
      { text: '{"b":2}', end: 16, terminated: true },
      { text: "", end: 16, terminated: false },
    ]);
  });

  it("yields what was read when the range ends early", async () => {
    const bytes = Buffer.from('{"a":1}\n{"b"', "utf-8");

    const lines = await collect(readLines(bufferReader(bytes, 64), 0, 100));

    expect(lines).toEqual([
      { text: '{"a":1}', end: 8, terminated: true },
      { text: '{"b"', end: bytes.length, terminated: false },
    ]);
  });
});

describe("readFileLines", () => {
  it("yields every split('\\n') segment of the file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cc-read-jsonl-"));
    try {
      const filePath = path.join(dir, "lines.jsonl");
      await writeFile(filePath, MIXED_TEXT, "utf-8");

      expect(await collect(readFileLines(filePath))).toEqual(
        MIXED_TEXT.split("\n"),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
