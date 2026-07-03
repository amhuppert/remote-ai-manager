import { describe, expect, it } from "vitest";
import {
  getCodexToolPromptHint,
  parseCodexStructuredResponse,
  wrapCodexPrompt,
} from "./codex-output";

describe("wrapCodexPrompt", () => {
  it("prepends instructions and preserves the original prompt", () => {
    const wrapped = wrapCodexPrompt("Fix the login bug");
    expect(wrapped).toContain("memory-bank/codex/");
    expect(wrapped).toContain("summary");
    expect(wrapped).toContain("referenceDocuments");
    expect(wrapped).toContain("Fix the login bug");
  });

  it("includes the 1000-character limit instruction", () => {
    const wrapped = wrapCodexPrompt("Do something");
    expect(wrapped).toContain("1000");
  });

  it("places the original prompt after the instructions", () => {
    const wrapped = wrapCodexPrompt("Do something");
    const instructionsEnd = wrapped.indexOf("Task:");
    const promptStart = wrapped.indexOf("Do something");
    expect(instructionsEnd).toBeGreaterThan(-1);
    expect(promptStart).toBeGreaterThan(instructionsEnd);
  });
});

describe("parseCodexStructuredResponse", () => {
  it("parses valid structured JSON", () => {
    const input = JSON.stringify({
      summary: "Fixed the bug",
      referenceDocuments: [
        { filePath: "memory-bank/codex/report.md", description: "Details" },
      ],
    });

    expect(parseCodexStructuredResponse(input)).toEqual({
      summary: "Fixed the bug",
      referenceDocuments: [
        { filePath: "memory-bank/codex/report.md", description: "Details" },
      ],
    });
  });

  it("returns null for non-JSON text", () => {
    expect(parseCodexStructuredResponse("just plain text")).toBeNull();
  });

  it("returns null when summary is missing", () => {
    const input = JSON.stringify({
      referenceDocuments: [],
    });
    expect(parseCodexStructuredResponse(input)).toBeNull();
  });

  it("returns null when referenceDocuments is missing", () => {
    const input = JSON.stringify({
      summary: "done",
    });
    expect(parseCodexStructuredResponse(input)).toBeNull();
  });

  it("returns null when referenceDocuments items have wrong shape", () => {
    const input = JSON.stringify({
      summary: "done",
      referenceDocuments: [{ path: "wrong-key" }],
    });
    expect(parseCodexStructuredResponse(input)).toBeNull();
  });

  it("accepts empty referenceDocuments array", () => {
    const input = JSON.stringify({
      summary: "No files needed",
      referenceDocuments: [],
    });
    expect(parseCodexStructuredResponse(input)).toEqual({
      summary: "No files needed",
      referenceDocuments: [],
    });
  });
});

describe("getCodexToolPromptHint", () => {
  it("returns null when disabled", () => {
    expect(getCodexToolPromptHint(false)).toBeNull();
  });

  it("returns a hint pointing at the cctl codex CLI when enabled", () => {
    const hint = getCodexToolPromptHint(true);
    expect(hint).not.toBeNull();
    expect(hint).toContain("cctl codex run");
    expect(hint).toContain("summary");
    expect(hint).toContain("referenceDocuments");
  });
});
