import { describe, it, expect } from "vitest";
import { detectFileAutocompleteTrigger } from "./file-autocomplete-trigger";

describe("detectFileAutocompleteTrigger", () => {
  it("returns null when text is empty", () => {
    expect(detectFileAutocompleteTrigger("", 0)).toBeNull();
  });

  it("returns null when no @ is present", () => {
    expect(detectFileAutocompleteTrigger("hello world", 5)).toBeNull();
  });

  it("detects @ at the start of text", () => {
    const result = detectFileAutocompleteTrigger("@src", 4);
    expect(result).toEqual({ query: "src", startIndex: 0, endIndex: 4 });
  });

  it("detects @ at the start of a word mid-text", () => {
    const result = detectFileAutocompleteTrigger("fix the @comp issue", 13);
    expect(result).toEqual({ query: "comp", startIndex: 8, endIndex: 13 });
  });

  it("returns empty query when cursor is right after @", () => {
    const result = detectFileAutocompleteTrigger("look at @", 9);
    expect(result).toEqual({ query: "", startIndex: 8, endIndex: 9 });
  });

  it("returns null when @ is in the middle of a word", () => {
    // e.g., email@example.com — @ is not at a word boundary
    expect(detectFileAutocompleteTrigger("email@example.com", 17)).toBeNull();
  });

  it("detects the correct @-word when there are multiple @", () => {
    const result = detectFileAutocompleteTrigger("@first @sec", 11);
    expect(result).toEqual({ query: "sec", startIndex: 7, endIndex: 11 });
  });

  it("returns null when cursor is not within the @-word", () => {
    // cursor is at space after the @-word
    expect(detectFileAutocompleteTrigger("@file ", 6)).toBeNull();
  });

  it("returns null when cursor is before the @", () => {
    expect(detectFileAutocompleteTrigger("hello @file", 3)).toBeNull();
  });

  it("handles @ after newline", () => {
    const result = detectFileAutocompleteTrigger("first line\n@src/com", 19);
    expect(result).toEqual({ query: "src/com", startIndex: 11, endIndex: 19 });
  });

  it("handles @ preceded by a tab", () => {
    const result = detectFileAutocompleteTrigger("\t@src", 5);
    expect(result).toEqual({ query: "src", startIndex: 1, endIndex: 5 });
  });

  it("includes slashes and dots in the query (file paths)", () => {
    const result = detectFileAutocompleteTrigger("use @src/lib/fuzzy.ts", 21);
    expect(result).toEqual({
      query: "src/lib/fuzzy.ts",
      startIndex: 4,
      endIndex: 21,
    });
  });

  it("includes hyphens in the query", () => {
    const result = detectFileAutocompleteTrigger("@file-scanner", 13);
    expect(result).toEqual({
      query: "file-scanner",
      startIndex: 0,
      endIndex: 13,
    });
  });

  it("handles cursor in the middle of the @-word", () => {
    const result = detectFileAutocompleteTrigger("@src/index.ts", 4);
    expect(result).toEqual({
      query: "src",
      startIndex: 0,
      endIndex: 4,
    });
  });
});
