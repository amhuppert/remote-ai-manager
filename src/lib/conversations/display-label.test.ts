import { describe, it, expect } from "vitest";
import { resolveDisplayLabel } from "./display-label";

describe("resolveDisplayLabel", () => {
  it("returns the conversation name when present", () => {
    expect(
      resolveDisplayLabel({
        conversationName: "Investigate perf",
        summary: "should be ignored",
        firstPromptSnippet: "also ignored",
        conversationId: "abc",
      }),
    ).toBe("Investigate perf");
  });

  it("falls back to summary when name is null", () => {
    expect(
      resolveDisplayLabel({
        conversationName: null,
        summary: "Refactor prompt serializer",
        firstPromptSnippet: "ignored",
        conversationId: "abc",
      }),
    ).toBe("Refactor prompt serializer");
  });

  it("falls back to firstPromptSnippet when name and summary are null", () => {
    expect(
      resolveDisplayLabel({
        conversationName: null,
        summary: null,
        firstPromptSnippet: "Hello, let's fix the build",
        conversationId: "abc",
      }),
    ).toBe("Hello, let's fix the build");
  });

  it("falls back to conversationId when nothing else is present", () => {
    expect(
      resolveDisplayLabel({
        conversationName: null,
        summary: null,
        firstPromptSnippet: null,
        conversationId: "abc-123",
      }),
    ).toBe("abc-123");
  });

  it("treats whitespace-only name as absent", () => {
    expect(
      resolveDisplayLabel({
        conversationName: "   ",
        summary: "the summary",
        firstPromptSnippet: null,
        conversationId: "abc",
      }),
    ).toBe("the summary");
  });

  it("treats empty-string summary as absent", () => {
    expect(
      resolveDisplayLabel({
        conversationName: null,
        summary: "",
        firstPromptSnippet: "snippet",
        conversationId: "abc",
      }),
    ).toBe("snippet");
  });

  it("flattens newlines in summary to spaces", () => {
    expect(
      resolveDisplayLabel({
        conversationName: null,
        summary: "line one\nline two\n\nline three",
        firstPromptSnippet: null,
        conversationId: "abc",
      }),
    ).toBe("line one line two line three");
  });

  it("flattens newlines in firstPromptSnippet to spaces and trims", () => {
    expect(
      resolveDisplayLabel({
        conversationName: null,
        summary: null,
        firstPromptSnippet: "  hello\n\nworld  ",
        conversationId: "abc",
      }),
    ).toBe("hello world");
  });

  it("flattens newlines in name to spaces", () => {
    expect(
      resolveDisplayLabel({
        conversationName: "line\none",
        summary: null,
        firstPromptSnippet: null,
        conversationId: "abc",
      }),
    ).toBe("line one");
  });
});
