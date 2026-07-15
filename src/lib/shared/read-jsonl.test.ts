import { describe, expect, it, vi } from "vitest";
import { parseJsonl, parseJsonlWithIndex } from "./read-jsonl";

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
