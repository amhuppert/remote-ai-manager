import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { readTranscript } from "../transcript";

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
      content: "Hello Claude",
      timestamp: "2024-01-01T00:00:00Z",
    });
    expect(result[1]).toEqual({
      role: "assistant",
      content: "Hello! How can I help?",
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
    expect(result[0]!.content).toBe("First paragraph\nSecond paragraph");
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
    expect(result[0]!.content).toBe("valid");
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
    expect(result[0]!.content).toBe("real content");
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
});
