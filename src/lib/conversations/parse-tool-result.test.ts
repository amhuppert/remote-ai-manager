import { describe, it, expect } from "vitest";
import { parseToolResultMetrics } from "./parse-tool-result";

describe("parseToolResultMetrics", () => {
  it("returns empty object when content is undefined", () => {
    expect(parseToolResultMetrics("Read", undefined)).toEqual({});
  });

  it("returns empty object when content is empty string", () => {
    expect(parseToolResultMetrics("Read", "")).toEqual({});
  });

  describe("Read", () => {
    it("counts lines from numbered output", () => {
      const content = "     1\tfirst line\n     2\tsecond line\n     3\tthird";
      expect(parseToolResultMetrics("Read", content)).toEqual({ lineCount: 3 });
    });

    it("counts a single line", () => {
      expect(parseToolResultMetrics("Read", "     1\tonly line")).toEqual({
        lineCount: 1,
      });
    });

    it("ignores SDK system-reminder suffix when counting numbered lines", () => {
      const content =
        "     1\tline\n     2\tanother\n\n<system-reminder>foo</system-reminder>";
      expect(parseToolResultMetrics("Read", content)).toEqual({ lineCount: 2 });
    });

    it("falls back to raw newline count when not numbered", () => {
      const content = "raw\nline\noutput";
      expect(parseToolResultMetrics("Read", content)).toEqual({ lineCount: 3 });
    });
  });

  describe("Grep", () => {
    it("counts matches by line", () => {
      const content = "src/a.ts:12: foo\nsrc/b.ts:5: foo\nsrc/c.ts:99: foo bar";
      expect(parseToolResultMetrics("Grep", content)).toEqual({
        matchCount: 3,
      });
    });

    it("parses 'Found N files' header from files_with_matches mode", () => {
      const content = "Found 7 files\nsrc/a.ts\nsrc/b.ts";
      expect(parseToolResultMetrics("Grep", content)).toEqual({ fileCount: 7 });
    });

    it("parses singular 'Found 1 file'", () => {
      const content = "Found 1 file\nsrc/a.ts";
      expect(parseToolResultMetrics("Grep", content)).toEqual({ fileCount: 1 });
    });

    it("returns matchCount 0 for 'No matches found'", () => {
      expect(parseToolResultMetrics("Grep", "No matches found")).toEqual({
        matchCount: 0,
      });
    });
  });

  describe("Glob", () => {
    it("counts file paths", () => {
      const content = "src/a.ts\nsrc/b.ts\nsrc/c.tsx";
      expect(parseToolResultMetrics("Glob", content)).toEqual({ fileCount: 3 });
    });

    it("ignores blank lines when counting", () => {
      const content = "src/a.ts\n\nsrc/b.ts\n";
      expect(parseToolResultMetrics("Glob", content)).toEqual({ fileCount: 2 });
    });

    it("returns 0 for 'No files found'", () => {
      expect(parseToolResultMetrics("Glob", "No files found")).toEqual({
        fileCount: 0,
      });
    });
  });

  describe("other tools", () => {
    it("returns empty for Bash", () => {
      expect(
        parseToolResultMetrics("Bash", "some output\nmore output"),
      ).toEqual({});
    });

    it("returns empty for Write", () => {
      expect(
        parseToolResultMetrics("Write", "File created successfully at /tmp/x"),
      ).toEqual({});
    });

    it("returns empty for Edit", () => {
      expect(
        parseToolResultMetrics("Edit", "The file /tmp/x has been updated."),
      ).toEqual({});
    });

    it("returns empty for unknown tool", () => {
      expect(parseToolResultMetrics("Unknown", "output")).toEqual({});
    });
  });
});
