import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { readTranscript } from "./transcript";

const TEST_DIR = path.join("/tmp", "csm-transcript-test-" + Date.now());

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

describe("readTranscript", () => {
  it("returns empty array for non-existent file", async () => {
    const result = await readTranscript("/tmp/does-not-exist.jsonl");
    expect(result).toEqual([]);
  });

  it("parses user and assistant messages with string content", async () => {
    const filePath = path.join(TEST_DIR, "transcript.jsonl");
    const lines = [
      JSON.stringify({
        type: "user",
        message: { content: "Hello Claude" },
        timestamp: "2024-01-01T00:00:00Z",
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: "Hello! How can I help?" },
        timestamp: "2024-01-01T00:00:01Z",
      }),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const result = await readTranscript(filePath);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      role: "user",
      content: [{ type: "text", text: "Hello Claude" }],
      timestamp: "2024-01-01T00:00:00Z",
    });
    expect(result[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Hello! How can I help?" }],
      timestamp: "2024-01-01T00:00:01Z",
    });
  });

  it("parses content block arrays (text blocks only)", async () => {
    const filePath = path.join(TEST_DIR, "blocks.jsonl");
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "First paragraph" },
            { type: "tool_use", id: "abc", name: "Read" },
            { type: "text", text: "Second paragraph" },
          ],
        },
      }),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const result = await readTranscript(filePath);
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toEqual([
      { type: "text", text: "First paragraph\nSecond paragraph" },
    ]);
  });

  it("skips non-message entries (tool events, etc.)", async () => {
    const filePath = path.join(TEST_DIR, "mixed.jsonl");
    const lines = [
      JSON.stringify({ type: "tool_use", id: "abc" }),
      JSON.stringify({ type: "user", message: { content: "prompt" } }),
      JSON.stringify({ type: "permission", action: "allow" }),
      JSON.stringify({ type: "assistant", message: { content: "response" } }),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const result = await readTranscript(filePath);
    expect(result).toHaveLength(2);
    expect(result[0]!.role).toBe("user");
    expect(result[1]!.role).toBe("assistant");
  });

  it("skips malformed JSON lines", async () => {
    const filePath = path.join(TEST_DIR, "malformed.jsonl");
    const lines = [
      "not valid json",
      JSON.stringify({ type: "user", message: { content: "valid" } }),
      "{ broken",
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const result = await readTranscript(filePath);
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toEqual([{ type: "text", text: "valid" }]);
  });

  it("skips messages with empty or whitespace-only content", async () => {
    const filePath = path.join(TEST_DIR, "empty.jsonl");
    const lines = [
      JSON.stringify({ type: "user", message: { content: "" } }),
      JSON.stringify({ type: "user", message: { content: "   " } }),
      JSON.stringify({ type: "user", message: { content: "real content" } }),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const result = await readTranscript(filePath);
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toEqual([
      { type: "text", text: "real content" },
    ]);
  });

  it("returns null timestamp when not provided", async () => {
    const filePath = path.join(TEST_DIR, "notime.jsonl");
    const lines = [
      JSON.stringify({ type: "user", message: { content: "no timestamp" } }),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const result = await readTranscript(filePath);
    expect(result).toHaveLength(1);
    expect(result[0]!.timestamp).toBeNull();
  });

  it("handles empty file", async () => {
    const filePath = path.join(TEST_DIR, "empty-file.jsonl");
    await writeFile(filePath, "", "utf-8");

    const result = await readTranscript(filePath);
    expect(result).toEqual([]);
  });

  // ==========================================================================
  // 3.1 – extractContent edge cases (Req 4.1, 4.3, 4.4)
  // ==========================================================================

  it("trims leading/trailing whitespace from string content (Req 4.1)", async () => {
    const filePath = path.join(TEST_DIR, "trim.jsonl");
    const lines = [
      JSON.stringify({
        type: "user",
        message: { content: "  padded content  " },
      }),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const result = await readTranscript(filePath);
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toEqual([
      { type: "text", text: "padded content" },
    ]);
  });

  it("returns null for array with only tool_use/tool_result blocks (Req 4.3)", async () => {
    const filePath = path.join(TEST_DIR, "tool-only.jsonl");
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", text: undefined },
            { type: "tool_result", text: undefined },
          ],
        },
      }),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const result = await readTranscript(filePath);
    expect(result).toHaveLength(0);
  });

  it("returns null for array with empty text blocks (Req 4.4)", async () => {
    const filePath = path.join(TEST_DIR, "empty-text.jsonl");
    const lines = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "" },
            { type: "text", text: "   " },
          ],
        },
      }),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const result = await readTranscript(filePath);
    expect(result).toHaveLength(0);
  });

  // ==========================================================================
  // 3.1 – message.role fallback (Req 3.2)
  // ==========================================================================

  it("processes entries using message.role fallback when type is absent (Req 3.2)", async () => {
    const filePath = path.join(TEST_DIR, "role-fallback.jsonl");
    const lines = [
      JSON.stringify({
        message: { role: "user", content: "user via role" },
      }),
      JSON.stringify({
        message: { role: "assistant", content: "assistant via role" },
      }),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const result = await readTranscript(filePath);
    expect(result).toHaveLength(2);
    expect(result[0]!.role).toBe("user");
    expect(result[0]!.content).toEqual([
      { type: "text", text: "user via role" },
    ]);
    expect(result[1]!.role).toBe("assistant");
    expect(result[1]!.content).toEqual([
      { type: "text", text: "assistant via role" },
    ]);
  });
});
