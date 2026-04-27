import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import path from "node:path";
import {
  readConversationMessages,
  appendTranscriptEntry,
  getTranscriptPath,
  parseCommandContent,
  copyTranscriptUpTo,
  findLastAssistantUuid,
  type TranscriptEntry,
} from "./transcript";

const TEST_DIR = path.join("/tmp", "cc-transcript-test-" + Date.now());

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
    const result = await getTranscriptPath("abc-123", TEST_DIR);
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

    await appendTranscriptEntry("conv-1", entry, TEST_DIR);

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

    await appendTranscriptEntry("conv-2", entry1, TEST_DIR);
    await appendTranscriptEntry("conv-2", entry2, TEST_DIR);

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

    await appendTranscriptEntry("conv-3", entry, TEST_DIR);

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

  it("propagates model and effort from user entries to assistant messages", async () => {
    const filePath = path.join(TEST_DIR, "transcripts", "model-effort.jsonl");
    const lines = [
      JSON.stringify({
        timestamp: "t0",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Hello" }],
        model: "opus",
        effort: "high",
      }),
      JSON.stringify({
        timestamp: "t1",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Hi there!" }],
      }),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const result = await readConversationMessages(filePath);
    expect(result).toHaveLength(2);
    expect(result[0]!.model).toBe("opus");
    expect(result[0]!.effort).toBe("high");
    // Assistant inherits model+effort from preceding user entry
    expect(result[1]!.model).toBe("opus");
    expect(result[1]!.effort).toBe("high");
  });

  it("tracks model/effort changes across turns", async () => {
    const filePath = path.join(
      TEST_DIR,
      "transcripts",
      "model-effort-change.jsonl",
    );
    const lines = [
      JSON.stringify({
        timestamp: "t0",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Hello" }],
        model: "opus",
        effort: "high",
      }),
      JSON.stringify({
        timestamp: "t1",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Response 1" }],
      }),
      JSON.stringify({
        timestamp: "t2",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Try with sonnet" }],
        model: "sonnet",
      }),
      JSON.stringify({
        timestamp: "t3",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Response 2" }],
      }),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const result = await readConversationMessages(filePath);
    expect(result).toHaveLength(4);
    // First assistant inherits opus + high
    expect(result[1]!.model).toBe("opus");
    expect(result[1]!.effort).toBe("high");
    // Second user has sonnet, no effort (model doesn't support it)
    expect(result[2]!.model).toBe("sonnet");
    expect(result[2]!.effort).toBeUndefined();
    // Second assistant inherits sonnet, no effort
    expect(result[3]!.model).toBe("sonnet");
    expect(result[3]!.effort).toBeUndefined();
  });

  it("handles legacy transcripts without model/effort fields", async () => {
    const filePath = path.join(TEST_DIR, "transcripts", "legacy.jsonl");
    const lines = [
      JSON.stringify({
        timestamp: "t0",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      }),
      JSON.stringify({
        timestamp: "t1",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Hi!" }],
      }),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const result = await readConversationMessages(filePath);
    expect(result).toHaveLength(2);
    expect(result[0]!.model).toBeUndefined();
    expect(result[0]!.effort).toBeUndefined();
    expect(result[1]!.model).toBeUndefined();
    expect(result[1]!.effort).toBeUndefined();
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

// ==========================================================================
// copyTranscriptUpTo
// ==========================================================================

describe("copyTranscriptUpTo", () => {
  /**
   * Helper: build a JSONL transcript file and return its path.
   * Each entry is a TranscriptEntry line.
   */
  async function writeTranscript(
    name: string,
    entries: TranscriptEntry[],
  ): Promise<string> {
    const filePath = path.join(TEST_DIR, "transcripts", `${name}.jsonl`);
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(filePath, content, "utf-8");
    return filePath;
  }

  /** Read the target transcript and return parsed lines */
  async function readTarget(
    conversationId: string,
  ): Promise<TranscriptEntry[]> {
    const targetPath = path.join(
      TEST_DIR,
      "transcripts",
      `${conversationId}.jsonl`,
    );
    const raw = await readFile(targetPath, "utf-8");
    return raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as TranscriptEntry);
  }

  // ---- The red test: exposes merged vs raw counting mismatch ----

  it("uses merged message indices when assistant has multiple JSONL lines", async () => {
    // Transcript with consecutive assistant lines that get merged:
    //   Merged msg 0: user "Hello"
    //   Merged msg 1: assistant "Part 1" + "Part 2" + "Part 3" (3 JSONL lines)
    //   Merged msg 2: user "Follow-up"
    //   Merged msg 3: assistant "Response 2a" + "Response 2b" (2 JSONL lines)
    const entries: TranscriptEntry[] = [
      {
        timestamp: "t0",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        timestamp: "t1",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Part 1" }],
      },
      {
        timestamp: "t2",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Part 2" }],
      },
      {
        timestamp: "t3",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Part 3" }],
      },
      {
        timestamp: "t4",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Follow-up" }],
      },
      {
        timestamp: "t5",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Response 2a" }],
      },
      {
        timestamp: "t6",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Response 2b" }],
      },
    ];

    const sourcePath = await writeTranscript("fork-merge-source", entries);

    // Verify readConversationMessages sees 4 merged messages
    const messages = await readConversationMessages(sourcePath);
    expect(messages).toHaveLength(4);
    expect(messages[2]!.role).toBe("user");
    expect(messages[3]!.role).toBe("assistant");

    // Fork at merged message index 2 (the "Follow-up" user message)
    // should copy everything BEFORE it (user "Hello" + assistant "Part 1/2/3")
    await copyTranscriptUpTo({
      sourceTranscriptPath: sourcePath,
      targetConversationId: "fork-merge-target",
      upToMessageIndex: 2,
      configDir: TEST_DIR,
    });

    const target = await readTarget("fork-merge-target");

    // Should include 4 lines: user "Hello" + assistant "Part 1" + "Part 2" + "Part 3"
    expect(target).toHaveLength(4);
    expect(target[0]!.content![0]).toEqual({ type: "text", text: "Hello" });
    expect(target[target.length - 1]!.content![0]).toEqual({
      type: "text",
      text: "Part 3",
    });
  });

  it("copies everything before target when target is last message", async () => {
    const entries: TranscriptEntry[] = [
      {
        timestamp: "t0",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        timestamp: "t1",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Part 1" }],
      },
      {
        timestamp: "t2",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Part 2" }],
      },
      {
        timestamp: "t3",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Part 3" }],
      },
      {
        timestamp: "t4",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Follow-up" }],
      },
    ];

    const sourcePath = await writeTranscript("fork-noresp-source", entries);

    // Fork at merged index 2 (the "Follow-up" user message)
    // should copy only messages before it
    await copyTranscriptUpTo({
      sourceTranscriptPath: sourcePath,
      targetConversationId: "fork-noresp-target",
      upToMessageIndex: 2,
      configDir: TEST_DIR,
    });

    const target = await readTarget("fork-noresp-target");

    // Should include 4 lines: user "Hello" + assistant "Part 1/2/3"
    expect(target).toHaveLength(4);
    expect(target[target.length - 1]!.content![0]).toEqual({
      type: "text",
      text: "Part 3",
    });
  });

  it("uses merged message indices for edit-and-fork", async () => {
    const entries: TranscriptEntry[] = [
      {
        timestamp: "t0",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        timestamp: "t1",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Part 1" }],
      },
      {
        timestamp: "t2",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Part 2" }],
      },
      {
        timestamp: "t3",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Follow-up" }],
      },
      {
        timestamp: "t4",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Response" }],
      },
    ];

    const sourcePath = await writeTranscript("fork-edit-source", entries);

    // Edit-and-fork at merged index 2 (the "Follow-up" user message)
    // Should copy everything BEFORE that message, then append edited text
    await copyTranscriptUpTo({
      sourceTranscriptPath: sourcePath,
      targetConversationId: "fork-edit-target",
      upToMessageIndex: 2,
      appendEditedMessage: { text: "Edited follow-up", timestamp: "t-edit" },
      configDir: TEST_DIR,
    });

    const target = await readTarget("fork-edit-target");

    // Should have 3 original lines (user + 2 assistant) + 1 edited message = 4
    expect(target).toHaveLength(4);
    expect(target[target.length - 1]!.content![0]).toEqual({
      type: "text",
      text: "Edited follow-up",
    });
  });

  it("preserves non-visible lines between messages when using merged indices", async () => {
    const entries: TranscriptEntry[] = [
      {
        timestamp: "t0",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        timestamp: "t1",
        type: "system",
        raw: { subtype: "init" },
      } as TranscriptEntry,
      {
        timestamp: "t2",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Part 1" }],
      },
      {
        timestamp: "t3",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Part 2" }],
      },
      {
        timestamp: "t4",
        type: "result",
        raw: { subtype: "success" },
      } as TranscriptEntry,
      {
        timestamp: "t5",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Follow-up" }],
      },
    ];

    const sourcePath = await writeTranscript("fork-nonvisible-source", entries);

    // Fork at merged index 2 (the "Follow-up")
    // should copy everything before it, including non-visible lines
    await copyTranscriptUpTo({
      sourceTranscriptPath: sourcePath,
      targetConversationId: "fork-nonvisible-target",
      upToMessageIndex: 2,
      configDir: TEST_DIR,
    });

    const target = await readTarget("fork-nonvisible-target");

    // 5 lines: user, system, assistant, assistant, result (everything before "Follow-up")
    expect(target).toHaveLength(5);
    expect(target[target.length - 1]!.type).toBe("result");
  });

  // ---- Direct fork should copy only messages BEFORE the target ----

  it("direct fork excludes the target message and everything after it", async () => {
    // Transcript: user0, assistant0, user1, assistant1
    // Fork at message index 2 (user1) → should only include user0 + assistant0
    const entries: TranscriptEntry[] = [
      {
        timestamp: "t0",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        timestamp: "t1",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Hi" }],
      },
      {
        timestamp: "t2",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Question" }],
      },
      {
        timestamp: "t3",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Answer" }],
      },
    ];

    const sourcePath = await writeTranscript("fork-exclude-source", entries);

    await copyTranscriptUpTo({
      sourceTranscriptPath: sourcePath,
      targetConversationId: "fork-exclude-target",
      upToMessageIndex: 2,
      configDir: TEST_DIR,
    });

    const target = await readTarget("fork-exclude-target");
    // Should only have the first 2 lines (user0 + assistant0)
    expect(target).toHaveLength(2);
    expect(target[0]!.content![0]).toEqual({ type: "text", text: "Hello" });
    expect(target[1]!.content![0]).toEqual({ type: "text", text: "Hi" });
  });
});

// ==========================================================================
// findLastAssistantUuid
// ==========================================================================

describe("findLastAssistantUuid", () => {
  async function writeTranscript(
    name: string,
    entries: TranscriptEntry[],
  ): Promise<string> {
    const filePath = path.join(TEST_DIR, "transcripts", `${name}.jsonl`);
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(filePath, content, "utf-8");
    return filePath;
  }

  it("returns the uuid of the last assistant message before the fork point", async () => {
    const entries: TranscriptEntry[] = [
      {
        timestamp: "t0",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        timestamp: "t1",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Hi there" }],
        uuid: "uuid-asst-1",
      },
      {
        timestamp: "t2",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Question" }],
      },
      {
        timestamp: "t3",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Answer" }],
        uuid: "uuid-asst-2",
      },
    ];

    const sourcePath = await writeTranscript("uuid-basic", entries);

    // Fork at message 2 (second user message) → last assistant before it is uuid-asst-1
    const uuid = await findLastAssistantUuid(sourcePath, 2);
    expect(uuid).toBe("uuid-asst-1");
  });

  it("returns the uuid of the last JSONL entry when assistant has multiple lines", async () => {
    const entries: TranscriptEntry[] = [
      {
        timestamp: "t0",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        timestamp: "t1",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Part 1" }],
        uuid: "uuid-part-1",
      },
      {
        timestamp: "t2",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Part 2" }],
        uuid: "uuid-part-2",
      },
      {
        timestamp: "t3",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Part 3" }],
        uuid: "uuid-part-3",
      },
      {
        timestamp: "t4",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Follow-up" }],
      },
    ];

    const sourcePath = await writeTranscript("uuid-merged", entries);

    // Fork at message 2 (Follow-up) → last assistant UUID is uuid-part-3
    const uuid = await findLastAssistantUuid(sourcePath, 2);
    expect(uuid).toBe("uuid-part-3");
  });

  it("returns null when transcript has no uuid fields (backward compat)", async () => {
    const entries: TranscriptEntry[] = [
      {
        timestamp: "t0",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        timestamp: "t1",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Hi" }],
      },
      {
        timestamp: "t2",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Question" }],
      },
    ];

    const sourcePath = await writeTranscript("uuid-legacy", entries);

    const uuid = await findLastAssistantUuid(sourcePath, 2);
    expect(uuid).toBeNull();
  });

  it("returns null when fork point is at the first message (no assistant before it)", async () => {
    const entries: TranscriptEntry[] = [
      {
        timestamp: "t0",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        timestamp: "t1",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Hi" }],
        uuid: "uuid-1",
      },
    ];

    const sourcePath = await writeTranscript("uuid-first", entries);

    // Fork at message 0 → no assistant before it
    const uuid = await findLastAssistantUuid(sourcePath, 0);
    expect(uuid).toBeNull();
  });

  it("skips non-visible entries when counting", async () => {
    const entries: TranscriptEntry[] = [
      {
        timestamp: "t0",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        timestamp: "t1",
        type: "system",
        raw: { subtype: "init" },
      } as TranscriptEntry,
      {
        timestamp: "t2",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Hi" }],
        uuid: "uuid-1",
      },
      {
        timestamp: "t3",
        type: "result",
        raw: { subtype: "success" },
      } as TranscriptEntry,
      {
        timestamp: "t4",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Question" }],
      },
    ];

    const sourcePath = await writeTranscript("uuid-nonvisible", entries);

    // Fork at message 2 (second user) → last assistant is uuid-1
    const uuid = await findLastAssistantUuid(sourcePath, 2);
    expect(uuid).toBe("uuid-1");
  });
});
