import { describe, expect, it } from "vitest";
import { normalizeCollabMarkdown } from "./text-normalizer";

describe("normalizeCollabMarkdown", () => {
  it("decodes a literal \\n into a real newline", () => {
    expect(normalizeCollabMarkdown("line one\\nline two")).toBe(
      "line one\nline two",
    );
  });

  it("decodes consecutive \\n\\n into a paragraph break", () => {
    expect(normalizeCollabMarkdown("para one\\n\\npara two")).toBe(
      "para one\n\npara two",
    );
  });

  it("decodes literal unicode escapes \\u2013 and \\u2192", () => {
    expect(normalizeCollabMarkdown("pc1\\u2013pc9 \\u2192 covered")).toBe(
      "pc1\u2013pc9 \u2192 covered",
    );
  });

  it("decodes literal \\t into a real tab", () => {
    expect(normalizeCollabMarkdown("col1\\tcol2")).toBe("col1\tcol2");
  });

  it("leaves real newlines untouched", () => {
    expect(normalizeCollabMarkdown("line one\nline two")).toBe(
      "line one\nline two",
    );
  });

  it("leaves unrelated backslash sequences intact", () => {
    // Regex/path-like content should round-trip without mangling.
    expect(normalizeCollabMarkdown("path \\d+ pattern")).toBe(
      "path \\d+ pattern",
    );
  });

  it("returns an empty string unchanged", () => {
    expect(normalizeCollabMarkdown("")).toBe("");
  });
});
