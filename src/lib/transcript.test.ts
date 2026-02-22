import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  readTranscript,
  expandTilde,
  readConversationMessages,
  parseCommandContent,
} from "./transcript";

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

// ==========================================================================
// expandTilde
// ==========================================================================

describe("expandTilde", () => {
  it("expands ~/path to homedir/path", () => {
    const result = expandTilde("~/foo/bar");
    expect(result).toBe(os.homedir() + "/foo/bar");
  });

  it("leaves absolute paths unchanged", () => {
    expect(expandTilde("/absolute/path")).toBe("/absolute/path");
  });

  it("leaves relative paths unchanged", () => {
    expect(expandTilde("relative/path")).toBe("relative/path");
  });
});

// ==========================================================================
// readConversationMessages
// ==========================================================================

describe("readConversationMessages", () => {
  it("returns empty array for null path", async () => {
    const result = await readConversationMessages(null);
    expect(result).toEqual([]);
  });

  it("expands tilde and reads transcript", async () => {
    // Write a transcript file in the test dir
    const filePath = path.join(TEST_DIR, "conv.jsonl");
    const lines = [
      JSON.stringify({
        type: "user",
        message: { content: "Hello" },
        timestamp: "2024-01-01T00:00:00Z",
      }),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    // readConversationMessages with absolute path should work
    const result = await readConversationMessages(filePath);
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toEqual([{ type: "text", text: "Hello" }]);
  });

  it("returns empty array for non-existent transcript", async () => {
    const result = await readConversationMessages("/tmp/nonexistent-xyz.jsonl");
    expect(result).toEqual([]);
  });
});

// ==========================================================================
// parseCommandContent
// ==========================================================================

describe("parseCommandContent", () => {
  it("parses command with name and args", () => {
    const content =
      "<command-message>kiro:spec-init</command-message>\n<command-name>/kiro:spec-init</command-name>\n<command-args>notifications</command-args>";
    const result = parseCommandContent(content);
    expect(result).toEqual({
      type: "command",
      name: "/kiro:spec-init",
      args: "notifications",
    });
  });

  it("parses command without args tag", () => {
    const content =
      "<command-message>commit</command-message>\n<command-name>/commit</command-name>";
    const result = parseCommandContent(content);
    expect(result).toEqual({
      type: "command",
      name: "/commit",
      args: null,
    });
  });

  it("returns null for non-command content", () => {
    expect(parseCommandContent("Hello Claude")).toBeNull();
    expect(parseCommandContent("some text without tags")).toBeNull();
  });

  it("handles command-name without leading slash", () => {
    const content = "<command-name>commit</command-name>";
    const result = parseCommandContent(content);
    expect(result).toEqual({
      type: "command",
      name: "/commit",
      args: null,
    });
  });

  it("handles empty args", () => {
    const content =
      "<command-name>/test</command-name>\n<command-args>  </command-args>";
    const result = parseCommandContent(content);
    expect(result).toEqual({
      type: "command",
      name: "/test",
      args: null,
    });
  });
});

// ==========================================================================
// readTranscript – slash command handling
// ==========================================================================

describe("readTranscript – slash commands", () => {
  it("converts command invocation to a command content block", async () => {
    const filePath = path.join(TEST_DIR, "command.jsonl");
    const lines = [
      JSON.stringify({
        type: "user",
        uuid: "cmd-1",
        message: {
          content:
            "<command-message>commit</command-message>\n<command-name>/commit</command-name>\n<command-args>fix bug</command-args>",
        },
        timestamp: "2024-01-01T00:00:00Z",
      }),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const result = await readTranscript(filePath);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      role: "user",
      content: [{ type: "command", name: "/commit", args: "fix bug" }],
      timestamp: "2024-01-01T00:00:00Z",
    });
  });

  it("skips expanded command content (child message with matching parentUuid)", async () => {
    const filePath = path.join(TEST_DIR, "expanded.jsonl");
    const lines = [
      // Command invocation
      JSON.stringify({
        type: "user",
        uuid: "cmd-1",
        message: {
          content:
            "<command-message>kiro:spec-init</command-message>\n<command-name>/kiro:spec-init</command-name>\n<command-args>notifications</command-args>",
        },
        timestamp: "2024-01-01T00:00:00Z",
      }),
      // Expanded content (should be skipped)
      JSON.stringify({
        type: "user",
        uuid: "expanded-1",
        parentUuid: "cmd-1",
        message: {
          content: [
            {
              type: "text",
              text: "# Spec Initialization\n\nThis is a very long expanded prompt...",
            },
          ],
        },
        timestamp: "2024-01-01T00:00:01Z",
      }),
      // Claude's response
      JSON.stringify({
        type: "assistant",
        uuid: "resp-1",
        parentUuid: "expanded-1",
        message: {
          content: [{ type: "text", text: "I'll initialize the spec." }],
        },
        timestamp: "2024-01-01T00:00:02Z",
      }),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const result = await readTranscript(filePath);
    expect(result).toHaveLength(2);
    // Command invocation shown as compact block
    expect(result[0]).toEqual({
      role: "user",
      content: [
        {
          type: "command",
          name: "/kiro:spec-init",
          args: "notifications",
        },
      ],
      timestamp: "2024-01-01T00:00:00Z",
    });
    // Claude's response preserved
    expect(result[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "I'll initialize the spec." }],
      timestamp: "2024-01-01T00:00:02Z",
    });
  });

  it("does not skip user messages without matching parentUuid", async () => {
    const filePath = path.join(TEST_DIR, "no-skip.jsonl");
    const lines = [
      JSON.stringify({
        type: "user",
        uuid: "cmd-1",
        message: {
          content:
            "<command-name>/commit</command-name>\n<command-args>fix</command-args>",
        },
      }),
      // A regular user message (different parentUuid)
      JSON.stringify({
        type: "user",
        uuid: "msg-2",
        parentUuid: "other-uuid",
        message: { content: "A follow-up question" },
      }),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const result = await readTranscript(filePath);
    expect(result).toHaveLength(2);
    expect(result[0]!.content[0]!.type).toBe("command");
    expect(result[1]!.content).toEqual([
      { type: "text", text: "A follow-up question" },
    ]);
  });
});
