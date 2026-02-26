import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import path from "node:path";
import {
  readConversationMessages,
  appendTranscriptEntry,
  getTranscriptPath,
  parseCommandContent,
  type TranscriptEntry,
} from "./transcript";

const TEST_DIR = path.join("/tmp", "csm-transcript-test-" + Date.now());

// Mock getConfigDirPath to use our test directory
vi.mock("./config", () => ({
  getConfigDirPath: () => TEST_DIR,
}));

beforeEach(async () => {
  await mkdir(path.join(TEST_DIR, "transcripts"), { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

// ==========================================================================
// getTranscriptPath
// ==========================================================================

describe("getTranscriptPath", () => {
  it("returns path inside transcripts directory", async () => {
    const result = await getTranscriptPath("abc-123");
    expect(result).toBe(path.join(TEST_DIR, "transcripts", "abc-123.jsonl"));
  });
});

// ==========================================================================
// appendTranscriptEntry
// ==========================================================================

describe("appendTranscriptEntry", () => {
  it("creates file and appends entry as JSONL", async () => {
    const entry: TranscriptEntry = {
      timestamp: "2024-01-01T00:00:00Z",
      type: "assistant",
      role: "assistant",
      content: [{ type: "text", text: "Hello!" }],
    };

    await appendTranscriptEntry("conv-1", entry);

    const filePath = path.join(TEST_DIR, "transcripts", "conv-1.jsonl");
    const raw = await readFile(filePath, "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual(entry);
  });

  it("appends multiple entries", async () => {
    const entry1: TranscriptEntry = {
      timestamp: "2024-01-01T00:00:00Z",
      type: "user",
      role: "user",
      content: [{ type: "text", text: "Hello" }],
    };
    const entry2: TranscriptEntry = {
      timestamp: "2024-01-01T00:00:01Z",
      type: "assistant",
      role: "assistant",
      content: [{ type: "text", text: "Hi there!" }],
    };

    await appendTranscriptEntry("conv-2", entry1);
    await appendTranscriptEntry("conv-2", entry2);

    const filePath = path.join(TEST_DIR, "transcripts", "conv-2.jsonl");
    const raw = await readFile(filePath, "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).role).toBe("user");
    expect(JSON.parse(lines[1]!).role).toBe("assistant");
  });

  it("stores non-display entries (system, result) without role", async () => {
    const entry: TranscriptEntry = {
      timestamp: "2024-01-01T00:00:00Z",
      type: "system",
      raw: { subtype: "init", session_id: "sess-1" },
    };

    await appendTranscriptEntry("conv-3", entry);

    const filePath = path.join(TEST_DIR, "transcripts", "conv-3.jsonl");
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw.trim());
    expect(parsed.type).toBe("system");
    expect(parsed.role).toBeUndefined();
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

  it("returns empty array for non-existent file", async () => {
    const result = await readConversationMessages("/tmp/nonexistent-xyz.jsonl");
    expect(result).toEqual([]);
  });

  it("parses user and assistant messages", async () => {
    const filePath = path.join(TEST_DIR, "transcripts", "read-test.jsonl");
    const lines = [
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Hello Claude" }],
      }),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:01Z",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Hello! How can I help?" }],
      }),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const result = await readConversationMessages(filePath);
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

  it("skips non-display entries (system, result, status)", async () => {
    const filePath = path.join(TEST_DIR, "transcripts", "mixed.jsonl");
    const lines = [
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "system",
        raw: { subtype: "init" },
      }),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:01Z",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      }),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:02Z",
        type: "result",
        raw: { subtype: "success" },
      }),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:03Z",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Response" }],
      }),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const result = await readConversationMessages(filePath);
    expect(result).toHaveLength(2);
    expect(result[0]!.role).toBe("user");
    expect(result[1]!.role).toBe("assistant");
  });

  it("skips entries with empty content", async () => {
    const filePath = path.join(TEST_DIR, "transcripts", "empty-content.jsonl");
    const lines = [
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "assistant",
        role: "assistant",
        content: [],
      }),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:01Z",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Real content" }],
      }),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const result = await readConversationMessages(filePath);
    expect(result).toHaveLength(1);
    expect(result[0]!.content[0]).toEqual({
      type: "text",
      text: "Real content",
    });
  });

  it("skips malformed JSON lines", async () => {
    const filePath = path.join(TEST_DIR, "transcripts", "malformed.jsonl");
    const lines = [
      "not valid json",
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "valid" }],
      }),
      "{ broken",
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const result = await readConversationMessages(filePath);
    expect(result).toHaveLength(1);
  });

  it("handles empty file", async () => {
    const filePath = path.join(TEST_DIR, "transcripts", "empty.jsonl");
    await writeFile(filePath, "", "utf-8");

    const result = await readConversationMessages(filePath);
    expect(result).toEqual([]);
  });

  it("preserves tool_use content blocks", async () => {
    const filePath = path.join(TEST_DIR, "transcripts", "tools.jsonl");
    const lines = [
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "assistant",
        role: "assistant",
        content: [
          { type: "text", text: "Let me read that file." },
          {
            type: "tool_use",
            name: "Read",
            input: { file_path: "src/index.ts" },
          },
        ],
      }),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const result = await readConversationMessages(filePath);
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toHaveLength(2);
    expect(result[0]!.content[0]!.type).toBe("text");
    expect(result[0]!.content[1]!.type).toBe("tool_use");
  });

  it("merges consecutive assistant messages into a single message", async () => {
    const filePath = path.join(TEST_DIR, "transcripts", "merge-asst.jsonl");
    const lines = [
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      }),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:01Z",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "First response" }],
      }),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:02Z",
        type: "assistant",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "Write",
            input: { file_path: "/tmp/test.ts" },
          },
        ],
      }),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:03Z",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Done writing." }],
      }),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const result = await readConversationMessages(filePath);
    expect(result).toHaveLength(2);
    expect(result[0]!.role).toBe("user");
    expect(result[1]!.role).toBe("assistant");
    expect(result[1]!.content).toHaveLength(3);
    expect(result[1]!.content[0]).toEqual({
      type: "text",
      text: "First response",
    });
    expect(result[1]!.content[1]).toEqual({
      type: "tool_use",
      name: "Write",
      input: { file_path: "/tmp/test.ts" },
    });
    expect(result[1]!.content[2]).toEqual({
      type: "text",
      text: "Done writing.",
    });
    // Timestamp should be from the first message in the group
    expect(result[1]!.timestamp).toBe("2024-01-01T00:00:01Z");
  });

  it("detects slash command invocations in user messages", async () => {
    const filePath = path.join(TEST_DIR, "transcripts", "command.jsonl");
    const lines = [
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "user",
        role: "user",
        content: [
          {
            type: "text",
            text: "<command-name>/commit</command-name>\n<command-args>fix bug</command-args>",
          },
        ],
      }),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const result = await readConversationMessages(filePath);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      role: "user",
      content: [{ type: "command", name: "/commit", args: "fix bug" }],
      timestamp: "2024-01-01T00:00:00Z",
    });
  });

  it("detects plain text slash commands in user messages", async () => {
    const filePath = path.join(TEST_DIR, "transcripts", "plain-command.jsonl");
    const lines = [
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "user",
        role: "user",
        content: [
          {
            type: "text",
            text: "/kiro:spec-requirements voice-transcription-integration",
          },
        ],
      }),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const result = await readConversationMessages(filePath);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      role: "user",
      content: [
        {
          type: "command",
          name: "/kiro:spec-requirements",
          args: "voice-transcription-integration",
        },
      ],
      timestamp: "2024-01-01T00:00:00Z",
    });
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

  // Plain text slash commands
  it("parses plain slash command with args", () => {
    const result = parseCommandContent(
      "/kiro:spec-requirements voice-transcription-integration",
    );
    expect(result).toEqual({
      type: "command",
      name: "/kiro:spec-requirements",
      args: "voice-transcription-integration",
    });
  });

  it("parses plain slash command without args", () => {
    const result = parseCommandContent("/commit");
    expect(result).toEqual({
      type: "command",
      name: "/commit",
      args: null,
    });
  });

  it("parses plain namespaced slash command without args", () => {
    const result = parseCommandContent("/kiro:spec-status");
    expect(result).toEqual({
      type: "command",
      name: "/kiro:spec-status",
      args: null,
    });
  });

  it("parses plain slash command with multi-word args", () => {
    const result = parseCommandContent("/kiro:spec-init notifications feature");
    expect(result).toEqual({
      type: "command",
      name: "/kiro:spec-init",
      args: "notifications feature",
    });
  });

  it("does not parse regular text as a slash command", () => {
    expect(parseCommandContent("Hello Claude, please help")).toBeNull();
    expect(
      parseCommandContent("I need help with /path/to/file in my project"),
    ).toBeNull();
  });

  it("handles plain slash command with leading/trailing whitespace", () => {
    const result = parseCommandContent("  /commit fix bug  ");
    expect(result).toEqual({
      type: "command",
      name: "/commit",
      args: "fix bug",
    });
  });
});
