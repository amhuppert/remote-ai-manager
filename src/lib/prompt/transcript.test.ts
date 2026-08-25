import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  appendFile,
  writeFile,
  mkdir,
  rm,
  readFile,
  stat,
  open,
} from "node:fs/promises";
import path from "node:path";
import {
  readConversationMessages,
  readConversationMessagesWithSeq,
  readTranscriptEntriesWithSeq,
  readLastAssistantContent,
  _resetLastAssistantCacheForTesting,
  _resetLastSeqCacheForTesting,
  _resetTranscriptReadCacheForTesting,
  _resetTranscriptEntriesCacheForTesting,
  _resetTranscriptMaxSeqCacheForTesting,
  createTranscriptMaxSeqReader,
  getTranscriptMaxSeq,
  type TranscriptMaxSeqIO,
  appendTranscriptEntry,
  appendTranscriptEntryOnce,
  safeAppendTranscriptEntry,
  safeAppendTranscriptEntryOnce,
  appendNotice,
  getTranscriptPath,
  parseCommandContent,
  copyTranscriptUpTo,
  findForkAnchorUuid,
  setTranscriptDeps,
  _resetTranscriptDepsForTesting,
  type TranscriptEntry,
} from "./transcript";
import {
  messageAppendedEventSchema,
  type MessageContentBlock,
} from "@/lib/conversations/schemas";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import type { SSEEvent } from "@/lib/api/sse-events";
const TEST_DIR = path.join("/tmp", "cc-transcript-test-" + Date.now());

beforeEach(async () => {
  await mkdir(path.join(TEST_DIR, "transcripts"), { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
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

  it("appends a stable entry id only once across concurrent retries", async () => {
    const entry = {
      id: "collab-start:conv-once:0",
      timestamp: "2024-01-01T00:00:00Z",
      type: "user",
      role: "user" as const,
      content: [{ type: "text" as const, text: "/collab design X" }],
    };

    await Promise.all([
      appendTranscriptEntryOnce("conv-once", entry, TEST_DIR),
      appendTranscriptEntryOnce("conv-once", entry, TEST_DIR),
    ]);

    const filePath = path.join(TEST_DIR, "transcripts", "conv-once.jsonl");
    const lines = (await readFile(filePath, "utf-8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).id).toBe(entry.id);
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
// readLastAssistantContent
// ==========================================================================

describe("readLastAssistantContent", () => {
  beforeEach(() => {
    _resetLastAssistantCacheForTesting();
  });

  it("returns null for a non-existent file", async () => {
    expect(
      await readLastAssistantContent("/tmp/nonexistent-tail-xyz.jsonl"),
    ).toBeNull();
  });

  it("returns the content blocks of the most recent assistant entry", async () => {
    const filePath = path.join(TEST_DIR, "transcripts", "tail-simple.jsonl");
    const lines = [
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "go" }],
      }),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:01Z",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Working on it." }],
      }),
    ];
    await writeFile(filePath, lines.join("\n") + "\n", "utf-8");

    const result = await readLastAssistantContent(filePath);
    expect(result).toEqual([{ type: "text", text: "Working on it." }]);
  });

  it("ignores entries after the latest assistant when computing the tail (no later assistant)", async () => {
    const filePath = path.join(TEST_DIR, "transcripts", "tail-trailing.jsonl");
    const lines = [
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "first" }],
      }),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:01Z",
        type: "assistant",
        role: "assistant",
        content: [
          { type: "tool_use", name: "Edit", input: { file_path: "x.ts" } },
        ],
      }),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:02Z",
        type: "tool_result",
        raw: { tool_use_id: "abc" },
      }),
    ];
    await writeFile(filePath, lines.join("\n") + "\n", "utf-8");

    const result = await readLastAssistantContent(filePath);
    expect(result).toEqual([
      { type: "tool_use", name: "Edit", input: { file_path: "x.ts" } },
    ]);
  });

  it("merges consecutive assistant entries in chronological order", async () => {
    const filePath = path.join(TEST_DIR, "transcripts", "tail-merge.jsonl");
    const lines = [
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "go" }],
      }),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:01Z",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "Thinking..." }],
      }),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:02Z",
        type: "assistant",
        role: "assistant",
        content: [
          { type: "tool_use", name: "Edit", input: { file_path: "src/y.ts" } },
        ],
      }),
    ];
    await writeFile(filePath, lines.join("\n") + "\n", "utf-8");

    const result = await readLastAssistantContent(filePath);
    expect(result).toEqual([
      { type: "text", text: "Thinking..." },
      { type: "tool_use", name: "Edit", input: { file_path: "src/y.ts" } },
    ]);
  });

  it("stops merging at the prior user entry", async () => {
    const filePath = path.join(TEST_DIR, "transcripts", "tail-boundary.jsonl");
    const lines = [
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "earlier reply" }],
      }),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:01Z",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "ask again" }],
      }),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:02Z",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "later reply" }],
      }),
    ];
    await writeFile(filePath, lines.join("\n") + "\n", "utf-8");

    const result = await readLastAssistantContent(filePath);
    expect(result).toEqual([{ type: "text", text: "later reply" }]);
  });

  it("finds the most recent assistant entry in a large file (exercises tail-read window)", async () => {
    const filePath = path.join(TEST_DIR, "transcripts", "tail-large.jsonl");
    // Write many large user entries so the file exceeds the 256KB tail window.
    const padding = "x".repeat(2048);
    const userLines: string[] = [];
    for (let i = 0; i < 200; i++) {
      userLines.push(
        JSON.stringify({
          timestamp: "2024-01-01T00:00:00Z",
          type: "user",
          role: "user",
          content: [{ type: "text", text: `${padding}-${i}` }],
        }),
      );
    }
    const finalAssistant = JSON.stringify({
      timestamp: "2024-01-01T00:00:01Z",
      type: "assistant",
      role: "assistant",
      content: [{ type: "text", text: "final answer" }],
    });
    await writeFile(
      filePath,
      [...userLines, finalAssistant].join("\n") + "\n",
      "utf-8",
    );

    const result = await readLastAssistantContent(filePath);
    expect(result).toEqual([{ type: "text", text: "final answer" }]);
  });

  it("returns null when no assistant entry exists within the tail window of a large file", async () => {
    const filePath = path.join(TEST_DIR, "transcripts", "tail-no-asst.jsonl");
    const padding = "y".repeat(2048);
    const lines: string[] = [
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "very old reply" }],
      }),
    ];
    for (let i = 0; i < 200; i++) {
      lines.push(
        JSON.stringify({
          timestamp: "2024-01-01T00:00:00Z",
          type: "user",
          role: "user",
          content: [{ type: "text", text: `${padding}-${i}` }],
        }),
      );
    }
    await writeFile(filePath, lines.join("\n") + "\n", "utf-8");

    expect(await readLastAssistantContent(filePath)).toBeNull();
  });

  it("returns fresh content after an append (cache invalidated by size change)", async () => {
    const filePath = path.join(
      TEST_DIR,
      "transcripts",
      "tail-invalidate.jsonl",
    );
    await writeFile(
      filePath,
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "before" }],
      }) + "\n",
      "utf-8",
    );

    const before = await readLastAssistantContent(filePath);
    expect(before).toEqual([{ type: "text", text: "before" }]);

    await appendTranscriptEntry(
      "tail-invalidate",
      {
        timestamp: "2024-01-01T00:00:01Z",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "next prompt" }],
      },
      TEST_DIR,
    );
    await appendTranscriptEntry(
      "tail-invalidate",
      {
        timestamp: "2024-01-01T00:00:02Z",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "after" }],
      },
      TEST_DIR,
    );

    // appendTranscriptEntry writes to <TEST_DIR>/transcripts/<id>.jsonl, which
    // is the same filePath we wrote above.
    const after = await readLastAssistantContent(filePath);
    expect(after).toEqual([{ type: "text", text: "after" }]);
  });
});

// ==========================================================================
// readConversationMessages
// ==========================================================================

describe("readConversationMessages", () => {
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

  it("propagates turn settings from user entries to assistant messages", async () => {
    const filePath = path.join(TEST_DIR, "transcripts", "model-effort.jsonl");
    const lines = [
      JSON.stringify({
        timestamp: "t0",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Hello" }],
        model: "opus",
        effort: "high",
        codexFastMode: true,
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
    expect(result[0]!.codexFastMode).toBe(true);
    // Assistant inherits turn settings from the preceding user entry.
    expect(result[1]!.model).toBe("opus");
    expect(result[1]!.effort).toBe("high");
    expect(result[1]!.codexFastMode).toBe(true);
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
// readConversationMessagesWithSeq
// ==========================================================================

describe("readConversationMessagesWithSeq", () => {
  it("returns [] for non-existent file", async () => {
    expect(
      await readConversationMessagesWithSeq("/tmp/missing-xyz.jsonl"),
    ).toEqual([]);
  });

  it("stamps seq with the 0-based JSONL line index of each entry", async () => {
    const filePath = path.join(TEST_DIR, "transcripts", "seq-basic.jsonl");
    const lines = [
      JSON.stringify({
        type: "user",
        role: "user",
        content: [{ type: "text", text: "a" }],
      }),
      JSON.stringify({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "b" }],
      }),
      JSON.stringify({
        type: "user",
        role: "user",
        content: [{ type: "text", text: "c" }],
      }),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const result = await readConversationMessagesWithSeq(filePath);
    expect(result.map((m) => m.seq)).toEqual([0, 1, 2]);
  });

  it("coalesces persisted Cursor deltas without crossing tool boundaries", async () => {
    const filePath = path.join(
      TEST_DIR,
      "transcripts",
      "cursor-content-deltas.jsonl",
    );
    const cursorEntry = (eventIndex: number, content: MessageContentBlock[]) =>
      JSON.stringify({
        id: `cursor:conv-1:run-1:${eventIndex}`,
        type: "assistant",
        role: "assistant",
        content,
      });
    const lines = [
      JSON.stringify({
        type: "user",
        role: "user",
        content: [{ type: "text", text: "test" }],
      }),
      cursorEntry(0, [{ type: "thinking", text: "The user sent " }]),
      cursorEntry(1, [{ type: "thinking", text: "a test." }]),
      cursorEntry(2, [{ type: "text", text: "Checking " }]),
      cursorEntry(3, [{ type: "text", text: "the workspace." }]),
      cursorEntry(4, [
        {
          type: "tool_use",
          id: "call-1",
          name: "shell",
          input: { command: "pwd" },
        },
      ]),
      cursorEntry(5, [{ type: "text", text: "Ready " }]),
      cursorEntry(6, [{ type: "text", text: "for work." }]),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const result = await readConversationMessagesWithSeq(filePath);

    expect(result[1]?.content).toEqual([
      { type: "thinking", text: "The user sent a test." },
      { type: "text", text: "Checking the workspace." },
      {
        type: "tool_use",
        id: "call-1",
        name: "shell",
        input: { command: "pwd" },
      },
      { type: "text", text: "Ready for work." },
    ]);
  });

  it("uses the last contributing line index for merged consecutive entries", async () => {
    const filePath = path.join(TEST_DIR, "transcripts", "seq-merged.jsonl");
    const lines = [
      JSON.stringify({
        type: "user",
        role: "user",
        content: [{ type: "text", text: "ask" }],
      }),
      JSON.stringify({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "first" }],
      }),
      JSON.stringify({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "second" }],
      }),
      JSON.stringify({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "third" }],
      }),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const result = await readConversationMessagesWithSeq(filePath);
    expect(result).toHaveLength(2);
    expect(result[0]!.seq).toBe(0);
    // Merged assistant turn ends at line 3
    expect(result[1]!.seq).toBe(3);
  });

  it("uses the latest turn settings for merged consecutive user entries", async () => {
    const filePath = path.join(
      TEST_DIR,
      "transcripts",
      "seq-merged-user-settings.jsonl",
    );
    const lines = [
      JSON.stringify({
        type: "user",
        role: "user",
        content: [{ type: "text", text: "failed attempt" }],
        model: "opus",
        effort: "high",
        codexFastMode: true,
      }),
      JSON.stringify({
        type: "user",
        role: "user",
        content: [{ type: "text", text: "successful retry" }],
        model: "gpt-5.6-luna",
        effort: "medium",
        codexFastMode: false,
      }),
      JSON.stringify({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      }),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const result = await readConversationMessagesWithSeq(filePath);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "failed attempt" },
        { type: "text", text: "successful retry" },
      ],
      model: "gpt-5.6-luna",
      effort: "medium",
      codexFastMode: false,
      seq: 1,
    });
    expect(result[1]).toMatchObject({
      role: "assistant",
      model: "gpt-5.6-luna",
      effort: "medium",
      codexFastMode: false,
      seq: 2,
    });
  });

  it("clears effort when the latest merged user entry omits it", async () => {
    const filePath = path.join(
      TEST_DIR,
      "transcripts",
      "seq-merged-user-cleared-effort.jsonl",
    );
    const lines = [
      JSON.stringify({
        type: "user",
        role: "user",
        content: [{ type: "text", text: "first attempt" }],
        model: "opus",
        effort: "high",
        codexFastMode: true,
      }),
      JSON.stringify({
        type: "user",
        role: "user",
        content: [{ type: "text", text: "retry without effort" }],
        model: "gpt-5.6-luna",
        codexFastMode: false,
      }),
      JSON.stringify({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      }),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const result = await readConversationMessagesWithSeq(filePath);

    expect(result[0]).toMatchObject({
      model: "gpt-5.6-luna",
      codexFastMode: false,
      seq: 1,
    });
    expect(result[0]!.effort).toBeUndefined();
    expect(result[1]).toMatchObject({
      model: "gpt-5.6-luna",
      codexFastMode: false,
      seq: 2,
    });
    expect(result[1]!.effort).toBeUndefined();
  });

  it("does not carry optional settings into a separate metadata-free user turn", async () => {
    const filePath = path.join(
      TEST_DIR,
      "transcripts",
      "seq-metadata-free-user-turn.jsonl",
    );
    const lines = [
      JSON.stringify({
        type: "user",
        role: "user",
        content: [{ type: "text", text: "configured turn" }],
        model: "gpt-5.6-luna",
        effort: "medium",
        codexFastMode: true,
      }),
      JSON.stringify({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "first response" }],
      }),
      JSON.stringify({
        type: "user",
        role: "user",
        content: [{ type: "text", text: "metadata-free turn" }],
      }),
      JSON.stringify({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "second response" }],
      }),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const result = await readConversationMessagesWithSeq(filePath);

    expect(result).toHaveLength(4);
    expect(result[2]!.model).toBeUndefined();
    expect(result[2]!.effort).toBeUndefined();
    expect(result[2]!.codexFastMode).toBeUndefined();
    expect(result[3]!.model).toBe("gpt-5.6-luna");
    expect(result[3]!.effort).toBeUndefined();
    expect(result[3]!.codexFastMode).toBeUndefined();
  });

  it("does not advance seq for non-visible lines between visible entries", async () => {
    const filePath = path.join(TEST_DIR, "transcripts", "seq-skip.jsonl");
    const lines = [
      JSON.stringify({
        type: "user",
        role: "user",
        content: [{ type: "text", text: "a" }],
      }),
      JSON.stringify({ type: "system", raw: { subtype: "init" } }),
      JSON.stringify({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "b" }],
      }),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const result = await readConversationMessagesWithSeq(filePath);
    expect(result.map((m) => m.seq)).toEqual([0, 2]);
  });
});

// ==========================================================================
// readConversationMessagesWithSeq — parsed-row cache
// ==========================================================================

describe("readConversationMessagesWithSeq caching", () => {
  beforeEach(() => {
    _resetTranscriptReadCacheForTesting();
  });

  it("returns the same array reference when the file is unchanged", async () => {
    const filePath = path.join(TEST_DIR, "transcripts", "cache-stable.jsonl");
    const lines = [
      JSON.stringify({
        type: "user",
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }),
      JSON.stringify({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
      }),
    ];
    await writeFile(filePath, lines.join("\n"), "utf-8");

    const first = await readConversationMessagesWithSeq(filePath);
    const second = await readConversationMessagesWithSeq(filePath);
    expect(second).toBe(first);
  });

  it("returns a fresh array after the file is appended to", async () => {
    const filePath = path.join(
      TEST_DIR,
      "transcripts",
      "cache-invalidate.jsonl",
    );
    await writeFile(
      filePath,
      JSON.stringify({
        type: "user",
        role: "user",
        content: [{ type: "text", text: "first" }],
      }) + "\n",
      "utf-8",
    );

    const first = await readConversationMessagesWithSeq(filePath);
    expect(first).toHaveLength(1);

    // Wait a few ms so mtime changes detectably across filesystems.
    await new Promise((r) => setTimeout(r, 20));

    await writeFile(
      filePath,
      [
        JSON.stringify({
          type: "user",
          role: "user",
          content: [{ type: "text", text: "first" }],
        }),
        JSON.stringify({
          type: "assistant",
          role: "assistant",
          content: [{ type: "text", text: "second" }],
        }),
      ].join("\n"),
      "utf-8",
    );

    const second = await readConversationMessagesWithSeq(filePath);
    expect(second).not.toBe(first);
    expect(second).toHaveLength(2);
    expect(second[1]!.content[0]).toEqual({ type: "text", text: "second" });
  });

  it("isolates caches per transcript path", async () => {
    const pathA = path.join(TEST_DIR, "transcripts", "cache-a.jsonl");
    const pathB = path.join(TEST_DIR, "transcripts", "cache-b.jsonl");
    await writeFile(
      pathA,
      JSON.stringify({
        type: "user",
        role: "user",
        content: [{ type: "text", text: "a" }],
      }) + "\n",
      "utf-8",
    );
    await writeFile(
      pathB,
      JSON.stringify({
        type: "user",
        role: "user",
        content: [{ type: "text", text: "b" }],
      }) + "\n",
      "utf-8",
    );

    const a = await readConversationMessagesWithSeq(pathA);
    const b = await readConversationMessagesWithSeq(pathB);
    expect(a).not.toBe(b);
    expect(a[0]!.content[0]).toEqual({ type: "text", text: "a" });
    expect(b[0]!.content[0]).toEqual({ type: "text", text: "b" });
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

  it("returns null for non-command content", () => {
    expect(parseCommandContent("Hello Claude")).toBeNull();
    expect(parseCommandContent("some text without tags")).toBeNull();
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

  // ---- Copy projection: slash-command unit boundary ----
  // A slash-command user entry starts its own logical unit even when the
  // PRECEDING visible entry is the same role. Because the copy path derives its
  // merged index from the shared grouping owner (transcript-logical-units), a
  // fork index means the same thing as the merged-message index the UI shows.
  it("breaks the merged index on a slash command so the copy matches the UI index", async () => {
    const entries: TranscriptEntry[] = [
      // Merged msg 0: plain user text.
      {
        timestamp: "t0",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Hi there" }],
      },
      // Merged msg 1: slash command — its own unit even though the previous
      // entry was also role=user.
      {
        timestamp: "t1",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "/commit now" }],
      },
      // Merged msg 2: assistant turn.
      {
        timestamp: "t2",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
      },
    ];
    const sourcePath = await writeTranscript("slash-boundary-copy", entries);

    // Exclusive copy up to merged index 2 (the assistant turn) includes both
    // user units (plain + command) and stops before the assistant.
    await copyTranscriptUpTo({
      sourceTranscriptPath: sourcePath,
      targetConversationId: "slash-boundary-target",
      upToMessageIndex: 2,
      mode: "exclusive",
      configDir: TEST_DIR,
    });

    const copied = await readTarget("slash-boundary-target");
    expect(
      copied.map((e) => (e.content?.[0] as { text?: string })?.text),
    ).toEqual(["Hi there", "/commit now"]);

    // And exclusive copy up to merged index 1 (the command) includes only the
    // plain user unit — the command is a distinct index, not merged with it.
    await copyTranscriptUpTo({
      sourceTranscriptPath: sourcePath,
      targetConversationId: "slash-boundary-target-1",
      upToMessageIndex: 1,
      mode: "exclusive",
      configDir: TEST_DIR,
    });
    const copiedTo1 = await readTarget("slash-boundary-target-1");
    expect(
      copiedTo1.map((e) => (e.content?.[0] as { text?: string })?.text),
    ).toEqual(["Hi there"]);
  });

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
      mode: "exclusive",
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
      mode: "exclusive",
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
      mode: "exclusive",
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
// findForkAnchorUuid — exclusive mode
// ==========================================================================

describe("findForkAnchorUuid (exclusive)", () => {
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

    const uuid = await findForkAnchorUuid(sourcePath, {
      atMessageIndex: 2,
      mode: "exclusive",
    });
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

    const uuid = await findForkAnchorUuid(sourcePath, {
      atMessageIndex: 2,
      mode: "exclusive",
    });
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

    const uuid = await findForkAnchorUuid(sourcePath, {
      atMessageIndex: 2,
      mode: "exclusive",
    });
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

    const uuid = await findForkAnchorUuid(sourcePath, {
      atMessageIndex: 0,
      mode: "exclusive",
    });
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

    const uuid = await findForkAnchorUuid(sourcePath, {
      atMessageIndex: 2,
      mode: "exclusive",
    });
    expect(uuid).toBe("uuid-1");
  });
});

// ==========================================================================
// findForkAnchorUuid — inclusive mode
// ==========================================================================

describe("findForkAnchorUuid (inclusive)", () => {
  async function writeTranscript(
    name: string,
    entries: TranscriptEntry[],
  ): Promise<string> {
    const filePath = path.join(TEST_DIR, "transcripts", `${name}.jsonl`);
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(filePath, content, "utf-8");
    return filePath;
  }

  it("returns the target assistant's own uuid when anchoring inclusively at an assistant message", async () => {
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
    ];

    const sourcePath = await writeTranscript("inc-asst", entries);

    const uuid = await findForkAnchorUuid(sourcePath, {
      atMessageIndex: 1,
      mode: "inclusive",
    });
    expect(uuid).toBe("uuid-asst-1");
  });

  it("returns the last JSONL uuid in the target merged assistant message", async () => {
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
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Follow-up" }],
      },
    ];

    const sourcePath = await writeTranscript("inc-merged", entries);

    const uuid = await findForkAnchorUuid(sourcePath, {
      atMessageIndex: 1,
      mode: "inclusive",
    });
    expect(uuid).toBe("uuid-part-2");
  });

  it("returns null when the inclusive target is a user message", async () => {
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
        uuid: "uuid-asst-1",
      },
      {
        timestamp: "t2",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Question" }],
      },
    ];

    const sourcePath = await writeTranscript("inc-user-target", entries);

    const uuid = await findForkAnchorUuid(sourcePath, {
      atMessageIndex: 2,
      mode: "inclusive",
    });
    expect(uuid).toBeNull();
  });
});

// ==========================================================================
// copyTranscriptUpTo — inclusive mode
// ==========================================================================

describe("copyTranscriptUpTo (inclusive)", () => {
  async function writeTranscript(
    name: string,
    entries: TranscriptEntry[],
  ): Promise<string> {
    const filePath = path.join(TEST_DIR, "transcripts", `${name}.jsonl`);
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(filePath, content, "utf-8");
    return filePath;
  }

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

  it("includes the target assistant message at the cutoff", async () => {
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
        type: "user",
        role: "user",
        content: [{ type: "text", text: "Follow-up" }],
      },
    ];

    const sourcePath = await writeTranscript("inc-copy-source", entries);

    await copyTranscriptUpTo({
      sourceTranscriptPath: sourcePath,
      targetConversationId: "inc-copy-target",
      upToMessageIndex: 1,
      mode: "inclusive",
      configDir: TEST_DIR,
    });

    const target = await readTarget("inc-copy-target");
    // user "Hello" + assistant "Part 1" + assistant "Part 2"
    expect(target).toHaveLength(3);
    expect(target[target.length - 1]!.content![0]).toEqual({
      type: "text",
      text: "Part 2",
    });
  });

  it("copies the full transcript when target is the last merged message", async () => {
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
        uuid: "uuid-asst",
      },
    ];

    const sourcePath = await writeTranscript("inc-full", entries);

    await copyTranscriptUpTo({
      sourceTranscriptPath: sourcePath,
      targetConversationId: "inc-full-target",
      upToMessageIndex: 1,
      mode: "inclusive",
      configDir: TEST_DIR,
    });

    const target = await readTarget("inc-full-target");
    expect(target).toHaveLength(2);
  });
});

// ==========================================================================
// appendTranscriptEntry — message-appended broadcast
// ==========================================================================

describe("appendTranscriptEntry — message-appended broadcast", () => {
  let captured: SSEEvent[] = [];

  beforeEach(() => {
    captured = [];
    setTranscriptDeps({
      broadcast: (event: SSEEvent) => {
        captured.push(event);
        return { delivered: true };
      },
    });
  });

  afterEach(() => {
    _resetTranscriptDepsForTesting();
  });

  const meta = { projectName: "demo", storeSessionName: "main" };

  function makeEntry(
    role: "user" | "assistant",
    text: string,
  ): TranscriptEntry {
    return {
      timestamp: "2024-01-01T00:00:00Z",
      type: role,
      role,
      content: [{ type: "text", text }],
    };
  }

  it("broadcasts message-appended with monotonic seq (0,1,2) for three entries", async () => {
    await appendTranscriptEntry(
      "conv-bcast",
      makeEntry("user", "hello"),
      TEST_DIR,
      meta,
    );
    await appendTranscriptEntry(
      "conv-bcast",
      makeEntry("assistant", "hi there"),
      TEST_DIR,
      meta,
    );
    await appendTranscriptEntry(
      "conv-bcast",
      makeEntry("user", "next"),
      TEST_DIR,
      meta,
    );

    expect(captured).toHaveLength(3);
    expect(captured.map((e) => (e as { seq: number }).seq)).toEqual([0, 1, 2]);
    for (const event of captured) {
      const parsed = messageAppendedEventSchema.safeParse(event);
      expect(parsed.success).toBe(true);
    }
  });

  it("does not broadcast when meta is omitted", async () => {
    await appendTranscriptEntry(
      "conv-no-meta",
      makeEntry("user", "silent"),
      TEST_DIR,
    );
    expect(captured).toHaveLength(0);
  });

  it("broadcasts the scope=project message-appended variant for the project sentinel", async () => {
    await appendTranscriptEntry(
      "conv-proj",
      makeEntry("assistant", "on main"),
      TEST_DIR,
      { projectName: "demo", storeSessionName: "__project__" },
    );
    expect(captured).toHaveLength(1);
    const event = captured[0] as {
      scope: string;
      projectName: string;
      conversationId: string;
      sessionName?: string;
    };
    expect(event.scope).toBe("project");
    expect(event.projectName).toBe("demo");
    expect(event.conversationId).toBe("conv-proj");
    expect("sessionName" in event).toBe(false);
    // The discriminated union accepts the project variant.
    expect(messageAppendedEventSchema.safeParse(event).success).toBe(true);
  });

  it("does not broadcast for system/result entries even when meta is provided", async () => {
    await appendTranscriptEntry(
      "conv-sys",
      {
        timestamp: "2024-01-01T00:00:00Z",
        type: "system",
        raw: { subtype: "init" },
      },
      TEST_DIR,
      meta,
    );
    await appendTranscriptEntry(
      "conv-sys",
      {
        timestamp: "2024-01-01T00:00:01Z",
        type: "result",
        raw: { subtype: "success" },
      },
      TEST_DIR,
      meta,
    );
    expect(captured).toHaveLength(0);
  });

  it("does not broadcast when content is empty", async () => {
    await appendTranscriptEntry(
      "conv-empty",
      {
        timestamp: "2024-01-01T00:00:00Z",
        type: "assistant",
        role: "assistant",
        content: [],
      },
      TEST_DIR,
      meta,
    );
    expect(captured).toHaveLength(0);
  });

  it("includes agent settings in the broadcast message when set on the entry", async () => {
    await appendTranscriptEntry(
      "conv-model",
      {
        timestamp: "2024-01-01T00:00:00Z",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "hi" }],
        model: "opus",
        effort: "high",
        codexFastMode: true,
      },
      TEST_DIR,
      meta,
    );
    expect(captured).toHaveLength(1);
    const event = captured[0] as {
      message: {
        model?: string;
        effort?: string;
        codexFastMode?: boolean;
      };
    };
    expect(event.message.model).toBe("opus");
    expect(event.message.effort).toBe("high");
    expect(event.message.codexFastMode).toBe(true);
  });

  it("indexes visible Markdown refs before broadcasting", async () => {
    const order: string[] = [];
    setTranscriptDeps({
      indexMarkdownDocuments: vi.fn().mockImplementation(async () => {
        order.push("index");
      }),
      broadcast: () => {
        order.push("broadcast");
        return { delivered: true };
      },
    });

    await appendTranscriptEntry(
      "conv-index",
      {
        timestamp: "2026-07-11T10:00:00.000Z",
        type: "assistant",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "Read",
            input: { file_path: "docs/plan.md" },
          },
        ],
      },
      TEST_DIR,
      meta,
    );

    expect(order).toEqual(["index", "broadcast"]);
  });

  it("broadcasts even when Markdown indexing fails", async () => {
    const broadcast = vi.fn();
    setTranscriptDeps({
      indexMarkdownDocuments: vi.fn().mockRejectedValue(new Error("db busy")),
      broadcast,
    });

    await expect(
      appendTranscriptEntry(
        "conv-index-failure",
        makeEntry("assistant", "still visible"),
        TEST_DIR,
        meta,
      ),
    ).resolves.toBeUndefined();
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  // R1.3: `TranscriptBroadcastMeta` carries the SESSION-KEYED STORE name, which
  // is the project sentinel for a project conversation. The SSE payload already
  // derived the public scope variant, but the index-failure warning re-emitted
  // the raw store name as `sessionName` — a leak on an ordinary project turn
  // whose document indexing happened to fail.
  describe("conversation scope in the index-failure diagnostic (R1.3)", () => {
    async function appendWithFailingIndex(
      storeSessionName: string,
    ): Promise<ReturnType<typeof createCapturingLogger>> {
      const log = createCapturingLogger();
      setTranscriptDeps({
        indexMarkdownDocuments: vi.fn().mockRejectedValue(new Error("db busy")),
        broadcast: () => ({ delivered: true }),
        log,
      });

      await appendTranscriptEntry(
        `conv-index-scope-${storeSessionName}`,
        makeEntry("assistant", "still visible"),
        TEST_DIR,
        { projectName: "demo", storeSessionName },
      );
      return log;
    }

    it("emits scope:project with no session identity for a project conversation", async () => {
      const log = await appendWithFailingIndex(
        PROJECT_CONVERSATION_SESSION_SENTINEL,
      );

      const failure = log.entries.find(
        (e) => e.message === "documents-index.index_failed",
      );
      expect(failure).toBeDefined();
      expect(failure?.fields).toMatchObject({
        scope: "project",
        projectName: "demo",
      });
      expect(failure?.fields).not.toHaveProperty("sessionName");
      expect(log.allFieldValues()).not.toContain(
        PROJECT_CONVERSATION_SESSION_SENTINEL,
      );
    });

    it("still reports the real session name for a session conversation", async () => {
      const log = await appendWithFailingIndex("main");

      expect(
        log.entries.find((e) => e.message === "documents-index.index_failed")
          ?.fields,
      ).toMatchObject({ scope: "session", sessionName: "main" });
    });
  });

  describe("seq cache", () => {
    beforeEach(() => {
      _resetLastSeqCacheForTesting();
    });

    it("broadcasts seq derived from cache, not from re-reading the file (cache survives external truncation)", async () => {
      const conversationId = "conv-cache-survives";
      const filePath = await getTranscriptPath(conversationId, TEST_DIR);

      // Prime the cache: first append creates the file at seq=0.
      await appendTranscriptEntry(
        conversationId,
        makeEntry("user", "first"),
        TEST_DIR,
        meta,
      );
      expect((captured[0] as { seq: number }).seq).toBe(0);

      // Simulate an external process truncating the file. A correctly-cached
      // implementation must NOT re-read the now-empty file when computing the
      // next seq — it must increment from the cached value.
      await writeFile(filePath, "", "utf-8");

      await appendTranscriptEntry(
        conversationId,
        makeEntry("assistant", "second"),
        TEST_DIR,
        meta,
      );
      expect((captured[1] as { seq: number }).seq).toBe(1);
    });

    it("computes seq from existing file content on cold cache (lazy init counts pre-existing newlines)", async () => {
      const conversationId = "conv-cold-init";
      const filePath = await getTranscriptPath(conversationId, TEST_DIR);

      // Seed the file with 4 pre-existing JSONL lines.
      const preExisting = [
        '{"timestamp":"2024-01-01T00:00:00Z","type":"user","role":"user","content":[{"type":"text","text":"a"}]}',
        '{"timestamp":"2024-01-01T00:00:01Z","type":"assistant","role":"assistant","content":[{"type":"text","text":"b"}]}',
        '{"timestamp":"2024-01-01T00:00:02Z","type":"user","role":"user","content":[{"type":"text","text":"c"}]}',
        '{"timestamp":"2024-01-01T00:00:03Z","type":"assistant","role":"assistant","content":[{"type":"text","text":"d"}]}',
      ];
      await writeFile(filePath, preExisting.join("\n") + "\n", "utf-8");

      await appendTranscriptEntry(
        conversationId,
        makeEntry("user", "e"),
        TEST_DIR,
        meta,
      );
      expect((captured[0] as { seq: number }).seq).toBe(4);

      await appendTranscriptEntry(
        conversationId,
        makeEntry("assistant", "f"),
        TEST_DIR,
        meta,
      );
      expect((captured[1] as { seq: number }).seq).toBe(5);
    });
  });
});

// ==========================================================================
// System notices
// ==========================================================================

describe("system notices", () => {
  let captured: SSEEvent[] = [];

  beforeEach(() => {
    captured = [];
    _resetLastSeqCacheForTesting();
    _resetTranscriptReadCacheForTesting();
    setTranscriptDeps({
      broadcast: (event: SSEEvent) => {
        captured.push(event);
        return { delivered: true };
      },
    });
  });

  afterEach(() => {
    _resetTranscriptDepsForTesting();
  });

  const meta = { projectName: "demo", storeSessionName: "main" };

  it("appendNotice round-trips through the visible-message read path and the SSE broadcast gate", async () => {
    const conversationId = "conv-notice-roundtrip";
    await appendTranscriptEntry(
      conversationId,
      {
        timestamp: "2024-01-01T00:00:00Z",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "please commit" }],
      },
      TEST_DIR,
      meta,
    );
    await appendNotice({
      conversationId,
      text: "No changes to commit.",
      projectName: meta.projectName,
      storeSessionName: meta.storeSessionName,
      configDir: TEST_DIR,
    });

    // Read path: the notice must surface as a visible conversation message.
    const transcriptPath = await getTranscriptPath(conversationId, TEST_DIR);
    const messages = await readConversationMessagesWithSeq(transcriptPath);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: "notice",
      content: [{ type: "text", text: "No changes to commit." }],
      seq: 1,
    });

    // Broadcast path: the notice must pass the appendTranscriptEntry gate.
    expect(captured).toHaveLength(2);
    const noticeEvent = messageAppendedEventSchema.parse(captured[1]);
    expect(noticeEvent.message.role).toBe("notice");
    expect(noticeEvent.message.content).toEqual([
      { type: "text", text: "No changes to commit." },
    ]);
    expect(noticeEvent.seq).toBe(1);
  });

  // R1.3: a project conversation reaches `appendNotice` through the slash-command
  // service (a refused `/collab`, a rejected command), and its caller holds the
  // store session key — the sentinel.
  it("emits scope:project with no session identity when a project conversation is noticed", async () => {
    const log = createCapturingLogger();
    setTranscriptDeps({ broadcast: () => ({ delivered: true }), log });

    await appendNotice({
      conversationId: "conv-notice-scope",
      text: "That command is session-only.",
      projectName: "demo",
      storeSessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
      configDir: TEST_DIR,
    });

    const appended = log.entries.find((e) => e.message === "notice_appended");
    expect(appended).toBeDefined();
    expect(appended?.fields).toMatchObject({ scope: "project" });
    expect(appended?.fields).not.toHaveProperty("sessionName");
    expect(log.allFieldValues()).not.toContain(
      PROJECT_CONVERSATION_SESSION_SENTINEL,
    );
  });

  it("keeps model/effort inheritance across an interleaved notice and gives notices no model/effort", async () => {
    const transcriptPath = path.join(
      TEST_DIR,
      "transcripts",
      "conv-notice-model.jsonl",
    );
    const lines = [
      JSON.stringify({
        type: "user",
        role: "user",
        content: [{ type: "text", text: "hi" }],
        timestamp: "2024-01-01T00:00:00Z",
        model: "opus",
        effort: "high",
      }),
      JSON.stringify({
        type: "notice",
        role: "notice",
        content: [{ type: "text", text: "Commit job started." }],
        timestamp: "2024-01-01T00:00:01Z",
      }),
      JSON.stringify({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        timestamp: "2024-01-01T00:00:02Z",
      }),
    ];
    await writeFile(transcriptPath, lines.join("\n") + "\n", "utf-8");

    const messages = await readConversationMessages(transcriptPath);
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "notice",
      "assistant",
    ]);
    expect(messages[1]?.model).toBeUndefined();
    expect(messages[1]?.effort).toBeUndefined();
    expect(messages[2]?.model).toBe("opus");
    expect(messages[2]?.effort).toBe("high");
  });

  it("copyTranscriptUpTo counts notices as visible merged messages", async () => {
    const sourcePath = path.join(
      TEST_DIR,
      "transcripts",
      "conv-notice-copy-src.jsonl",
    );
    const lines = [
      JSON.stringify({
        type: "user",
        role: "user",
        content: [{ type: "text", text: "one" }],
        timestamp: "2024-01-01T00:00:00Z",
      }),
      JSON.stringify({
        type: "notice",
        role: "notice",
        content: [{ type: "text", text: "a notice" }],
        timestamp: "2024-01-01T00:00:01Z",
      }),
      JSON.stringify({
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "two" }],
        timestamp: "2024-01-01T00:00:02Z",
      }),
    ];
    await writeFile(sourcePath, lines.join("\n") + "\n", "utf-8");

    await copyTranscriptUpTo({
      sourceTranscriptPath: sourcePath,
      targetConversationId: "conv-notice-copy-target",
      upToMessageIndex: 2,
      mode: "exclusive",
      configDir: TEST_DIR,
    });

    const targetPath = await getTranscriptPath(
      "conv-notice-copy-target",
      TEST_DIR,
    );
    const raw = await readFile(targetPath, "utf-8");
    const copied = raw
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as TranscriptEntry);
    expect(copied.map((e) => e.role)).toEqual(["user", "notice"]);
  });
});

// ==========================================================================
// readTranscriptEntriesWithSeq
// ==========================================================================

describe("readTranscriptEntriesWithSeq", () => {
  beforeEach(() => {
    _resetTranscriptEntriesCacheForTesting();
  });

  async function writeTranscript(
    name: string,
    lines: string[],
  ): Promise<string> {
    const filePath = path.join(TEST_DIR, "transcripts", name);
    await writeFile(filePath, lines.join("\n") + "\n", "utf-8");
    return filePath;
  }

  it("returns empty result for non-existent file", async () => {
    expect(
      await readTranscriptEntriesWithSeq("/tmp/missing-entries-xyz.jsonl"),
    ).toEqual({ entries: [], maxSeq: -1 });
  });

  it("returns one record per visible entry without same-role merging", async () => {
    const filePath = await writeTranscript("entries-no-merge.jsonl", [
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "ask" }],
      }),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:01Z",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "first" }],
      }),
      JSON.stringify({
        id: "msg-2",
        timestamp: "2024-01-01T00:00:02Z",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "second" }],
      }),
    ]);

    const result = await readTranscriptEntriesWithSeq(filePath);
    expect(result.maxSeq).toBe(2);
    expect(result.entries).toEqual([
      {
        seq: 0,
        entryId: null,
        role: "user",
        timestamp: "2024-01-01T00:00:00Z",
        content: [{ type: "text", text: "ask" }],
      },
      {
        seq: 1,
        entryId: null,
        role: "assistant",
        timestamp: "2024-01-01T00:00:01Z",
        content: [{ type: "text", text: "first" }],
      },
      {
        seq: 2,
        entryId: "msg-2",
        role: "assistant",
        timestamp: "2024-01-01T00:00:02Z",
        content: [{ type: "text", text: "second" }],
      },
    ]);
  });

  it("keeps raw line indexes across non-visible and malformed lines; maxSeq is the last visible seq", async () => {
    const filePath = await writeTranscript("entries-gaps.jsonl", [
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "a" }],
      }),
      "{not json",
      JSON.stringify({ type: "system", timestamp: "t", raw: { x: 1 } }),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:03Z",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "b" }],
      }),
      JSON.stringify({ type: "result", timestamp: "t", raw: { done: true } }),
    ]);

    const result = await readTranscriptEntriesWithSeq(filePath);
    expect(result.entries.map((e) => e.seq)).toEqual([0, 3]);
    // Trailing non-visible line does not extend maxSeq.
    expect(result.maxSeq).toBe(3);
  });

  it("normalizes missing timestamp to null and does not carry model/effort", async () => {
    const filePath = await writeTranscript("entries-nulls.jsonl", [
      JSON.stringify({
        type: "user",
        role: "user",
        model: "opus",
        effort: "high",
        content: [{ type: "text", text: "hello" }],
      }),
    ]);

    const result = await readTranscriptEntriesWithSeq(filePath);
    expect(result.entries).toEqual([
      {
        seq: 0,
        entryId: null,
        role: "user",
        timestamp: null,
        content: [{ type: "text", text: "hello" }],
      },
    ]);
  });

  it("passes image_ref blocks through unresolved", async () => {
    const filePath = await writeTranscript("entries-image-ref.jsonl", [
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "user",
        role: "user",
        content: [
          {
            type: "image_ref",
            mediaType: "image/png",
            imagePath: "/nowhere/img.png",
          },
        ],
      }),
    ]);

    const result = await readTranscriptEntriesWithSeq(filePath);
    expect(result.entries[0]!.content).toEqual([
      {
        type: "image_ref",
        mediaType: "image/png",
        imagePath: "/nowhere/img.png",
      },
    ]);
  });

  it("returns the same result reference while the file is unchanged", async () => {
    const filePath = await writeTranscript("entries-cache-stable.jsonl", [
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }),
    ]);

    const first = await readTranscriptEntriesWithSeq(filePath);
    const second = await readTranscriptEntriesWithSeq(filePath);
    expect(second).toBe(first);
  });

  it("returns a fresh result after the file changes", async () => {
    const filePath = await writeTranscript("entries-cache-invalidate.jsonl", [
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "first" }],
      }),
    ]);

    const first = await readTranscriptEntriesWithSeq(filePath);
    expect(first.entries).toHaveLength(1);

    // Wait a few ms so mtime changes detectably across filesystems.
    await new Promise((r) => setTimeout(r, 20));

    await writeFile(
      filePath,
      [
        JSON.stringify({
          timestamp: "2024-01-01T00:00:00Z",
          type: "user",
          role: "user",
          content: [{ type: "text", text: "first" }],
        }),
        JSON.stringify({
          timestamp: "2024-01-01T00:00:01Z",
          type: "assistant",
          role: "assistant",
          content: [{ type: "text", text: "second" }],
        }),
      ].join("\n") + "\n",
      "utf-8",
    );

    const second = await readTranscriptEntriesWithSeq(filePath);
    expect(second).not.toBe(first);
    expect(second.entries).toHaveLength(2);
    expect(second.maxSeq).toBe(1);
  });

  it("does not disturb the merged-message reader or its cache", async () => {
    const filePath = await writeTranscript("entries-vs-merged.jsonl", [
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "ask" }],
      }),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:01Z",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "first" }],
      }),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:02Z",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "second" }],
      }),
    ]);

    const entries = await readTranscriptEntriesWithSeq(filePath);
    const merged = await readConversationMessagesWithSeq(filePath);

    expect(entries.entries).toHaveLength(3);
    expect(merged).toHaveLength(2);
    expect(merged[1]!.seq).toBe(2);
    expect(merged[1]!.content).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
  });
});

// ==========================================================================
// readTranscriptEntriesWithSeq — stored tool_result lines
// ==========================================================================

describe("readTranscriptEntriesWithSeq tool_result entries", () => {
  beforeEach(() => {
    _resetTranscriptEntriesCacheForTesting();
  });

  async function writeTranscript(
    name: string,
    lines: string[],
  ): Promise<string> {
    const filePath = path.join(TEST_DIR, "transcripts", name);
    await writeFile(filePath, lines.join("\n") + "\n", "utf-8");
    return filePath;
  }

  /** The exact JSONL shape processMessage persists for SDK tool results. */
  function storedToolResultLine(
    toolUseId: string,
    content: unknown,
    isError?: boolean,
  ): string {
    return JSON.stringify({
      timestamp: "2024-01-01T00:00:02Z",
      type: "tool_result",
      raw: {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              tool_use_id: toolUseId,
              type: "tool_result",
              content,
              ...(isError !== undefined ? { is_error: isError } : {}),
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: "sess-1",
        uuid: "uuid-1",
      },
    });
  }

  it("surfaces stored tool_result lines as kind-discriminated entries with real seqs and parsed blocks", async () => {
    const filePath = await writeTranscript("tool-results-basic.jsonl", [
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "read the file" }],
      }),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:01Z",
        type: "assistant",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Read",
            input: { file_path: "a.ts" },
          },
        ],
      }),
      storedToolResultLine("t1", "     1\tconst a = 1;\n     2\tconst b = 2;"),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:03Z",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      }),
    ]);

    const result = await readTranscriptEntriesWithSeq(filePath);
    expect(result.entries).toHaveLength(4);
    expect(result.entries[2]).toEqual({
      kind: "tool_result",
      seq: 2,
      entryId: null,
      timestamp: "2024-01-01T00:00:02Z",
      content: [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: "     1\tconst a = 1;\n     2\tconst b = 2;",
          // Tool name recovered from the paired tool_use → Read metrics.
          metrics: { lineCount: 2 },
        },
      ],
    });
    // Message entries keep their existing shape (no kind stamp).
    expect(result.entries[1]).not.toHaveProperty("kind");
  });

  it("maps is_error and array-form content (text blocks joined, tool_reference ignored)", async () => {
    const filePath = await writeTranscript("tool-results-error.jsonl", [
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "assistant",
        role: "assistant",
        content: [{ type: "tool_use", id: "t9", name: "Bash", input: {} }],
      }),
      storedToolResultLine(
        "t9",
        [
          { type: "text", text: "command failed" },
          { type: "tool_reference", id: "ref-1" },
          { type: "text", text: "exit status 1" },
        ],
        true,
      ),
    ]);

    const result = await readTranscriptEntriesWithSeq(filePath);
    const toolEntry = result.entries[1];
    if (toolEntry?.kind !== "tool_result")
      throw new Error("expected tool_result entry");
    expect(toolEntry.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "t9",
        content: "command failed\nexit status 1",
        isError: true,
      },
    ]);
  });

  it("does not advance maxSeq for a trailing tool_result line (staleness unchanged)", async () => {
    const filePath = await writeTranscript("tool-results-trailing.jsonl", [
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "go" }],
      }),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:01Z",
        type: "assistant",
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
      }),
      storedToolResultLine("t1", "output"),
    ]);

    const result = await readTranscriptEntriesWithSeq(filePath);
    expect(result.entries).toHaveLength(3);
    expect(result.entries[2]?.seq).toBe(2);
    expect(result.maxSeq).toBe(1);
  });

  it("parses the legacy bare-block raw shape defensively", async () => {
    const filePath = await writeTranscript("tool-results-legacy.jsonl", [
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "tool_result",
        raw: { tool_use_id: "abc" },
      }),
    ]);

    const result = await readTranscriptEntriesWithSeq(filePath);
    const toolEntry = result.entries[0];
    if (toolEntry?.kind !== "tool_result")
      throw new Error("expected tool_result entry");
    expect(toolEntry.content).toEqual([
      { type: "tool_result", tool_use_id: "abc" },
    ]);
  });

  it("renders a generic block for unrecognizable raw payloads instead of throwing", async () => {
    const filePath = await writeTranscript("tool-results-unknown.jsonl", [
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "tool_result",
        raw: "not an object",
      }),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:01Z",
        type: "tool_result",
      }),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:02Z",
        type: "tool_result",
        raw: { message: { content: [{ type: "unrelated" }] } },
      }),
    ]);

    const result = await readTranscriptEntriesWithSeq(filePath);
    expect(result.entries).toHaveLength(3);
    for (const toolEntry of result.entries) {
      if (toolEntry.kind !== "tool_result")
        throw new Error("expected tool_result entry");
      expect(toolEntry.content).toEqual([
        {
          type: "tool_result",
          tool_use_id: "",
          content: "[unrecognized tool_result payload]",
        },
      ]);
    }
    expect(result.maxSeq).toBe(-1);
  });

  it("leaves the merged-message reader blind to tool_result lines (unchanged)", async () => {
    const filePath = await writeTranscript("tool-results-merged-reader.jsonl", [
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "assistant",
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
      }),
      storedToolResultLine("t1", "output"),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:02Z",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "done" }],
      }),
    ]);

    const merged = await readConversationMessagesWithSeq(filePath);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.seq).toBe(2);
    expect(merged[0]?.content).toHaveLength(2);
  });
});

// ==========================================================================
// getTranscriptMaxSeq
// ==========================================================================

describe("getTranscriptMaxSeq", () => {
  beforeEach(() => {
    _resetTranscriptMaxSeqCacheForTesting();
    _resetTranscriptEntriesCacheForTesting();
  });

  async function writeTranscript(
    name: string,
    lines: string[],
  ): Promise<string> {
    const filePath = path.join(TEST_DIR, "transcripts", name);
    await writeFile(filePath, lines.join("\n") + "\n", "utf-8");
    return filePath;
  }

  function visibleLine(text: string, role: "user" | "assistant"): string {
    return JSON.stringify({
      timestamp: "2024-01-01T00:00:00Z",
      type: role,
      role,
      content: [{ type: "text", text }],
    });
  }

  function toolResultLine(toolUseId: string): string {
    return JSON.stringify({
      timestamp: "2024-01-01T00:00:02Z",
      type: "tool_result",
      raw: {
        type: "user",
        message: {
          role: "user",
          content: [
            { tool_use_id: toolUseId, type: "tool_result", content: "output" },
          ],
        },
      },
    });
  }

  /** The number every case must reproduce: the full-parse reader's own maxSeq. */
  async function parityMaxSeq(filePath: string): Promise<number> {
    return (await readTranscriptEntriesWithSeq(filePath)).maxSeq;
  }

  it("reports the ABSOLUTE seq of the last visible entry when a tool_result trails it and the earlier lines exceed the tail window", async () => {
    const padding = "z".repeat(4096);
    const lines: string[] = [];
    for (let i = 0; i < 120; i++) {
      lines.push(visibleLine(`${padding}-${i}`, "user"));
    }
    lines.push(visibleLine("final answer", "assistant"));
    lines.push(toolResultLine("t1"));
    const filePath = await writeTranscript("max-seq-absolute.jsonl", lines);

    expect(await parityMaxSeq(filePath)).toBe(120);
    expect(await getTranscriptMaxSeq(filePath)).toBe(120);
  });

  it("returns -1 for a null path and for a missing file", async () => {
    expect(await getTranscriptMaxSeq(null)).toBe(-1);
    expect(await getTranscriptMaxSeq("/tmp/missing-max-seq-xyz.jsonl")).toBe(
      await parityMaxSeq("/tmp/missing-max-seq-xyz.jsonl"),
    );
  });

  it("returns -1 for an empty file", async () => {
    const filePath = path.join(TEST_DIR, "transcripts", "max-seq-empty.jsonl");
    await writeFile(filePath, "", "utf-8");

    expect(await parityMaxSeq(filePath)).toBe(-1);
    expect(await getTranscriptMaxSeq(filePath)).toBe(-1);
  });

  it("returns -1 when every line is a tool_result", async () => {
    const filePath = await writeTranscript("max-seq-only-tools.jsonl", [
      toolResultLine("t1"),
      toolResultLine("t2"),
    ]);

    expect(await parityMaxSeq(filePath)).toBe(-1);
    expect(await getTranscriptMaxSeq(filePath)).toBe(-1);
  });

  it("counts blank lines toward the seq index", async () => {
    const filePath = await writeTranscript("max-seq-blank-lines.jsonl", [
      visibleLine("ask", "user"),
      "",
      "   ",
      visibleLine("answer", "assistant"),
      "",
    ]);

    expect(await parityMaxSeq(filePath)).toBe(3);
    expect(await getTranscriptMaxSeq(filePath)).toBe(3);
  });

  it("skips a malformed trailing line the way the full parse does", async () => {
    const filePath = path.join(
      TEST_DIR,
      "transcripts",
      "max-seq-partial-tail.jsonl",
    );
    await writeFile(
      filePath,
      [visibleLine("ask", "user"), visibleLine("answer", "assistant")].join(
        "\n",
      ) + '\n{"timestamp":"2024-01-01T00:00:0',
      "utf-8",
    );

    expect(await parityMaxSeq(filePath)).toBe(1);
    expect(await getTranscriptMaxSeq(filePath)).toBe(1);
  });

  it("reads the last visible entry when the file has no trailing newline", async () => {
    const filePath = path.join(
      TEST_DIR,
      "transcripts",
      "max-seq-no-trailing-newline.jsonl",
    );
    await writeFile(
      filePath,
      [visibleLine("ask", "user"), visibleLine("answer", "assistant")].join(
        "\n",
      ),
      "utf-8",
    );

    expect(await parityMaxSeq(filePath)).toBe(1);
    expect(await getTranscriptMaxSeq(filePath)).toBe(1);
  });

  it("falls back to the full parse when the last visible line alone overflows the tail window", async () => {
    const filePath = await writeTranscript("max-seq-huge-line.jsonl", [
      visibleLine("ask", "user"),
      visibleLine("x".repeat(300 * 1024), "assistant"),
    ]);

    expect(await parityMaxSeq(filePath)).toBe(1);
    expect(await getTranscriptMaxSeq(filePath)).toBe(1);
  });

  it("advances after an append without rereading the whole file", async () => {
    const filePath = await writeTranscript("max-seq-append.jsonl", [
      visibleLine("ask", "user"),
      visibleLine("answer", "assistant"),
    ]);
    expect(await getTranscriptMaxSeq(filePath)).toBe(1);

    await appendFile(filePath, toolResultLine("t1") + "\n", "utf-8");
    _resetTranscriptEntriesCacheForTesting();
    expect(await parityMaxSeq(filePath)).toBe(1);
    expect(await getTranscriptMaxSeq(filePath)).toBe(1);

    await appendFile(
      filePath,
      visibleLine("more", "assistant") + "\n",
      "utf-8",
    );
    _resetTranscriptEntriesCacheForTesting();
    expect(await parityMaxSeq(filePath)).toBe(3);
    expect(await getTranscriptMaxSeq(filePath)).toBe(3);
  });

  it("reads far fewer bytes than the file holds when a warm transcript grows by one entry", async () => {
    const lines: string[] = [];
    const padding = "q".repeat(4096);
    for (let i = 0; i < 300; i++) {
      lines.push(
        visibleLine(`${padding}-${i}`, i % 2 === 0 ? "user" : "assistant"),
      );
    }
    const filePath = await writeTranscript("max-seq-bounded.jsonl", lines);
    const fileSize = (await stat(filePath)).size;
    expect(fileSize).toBeGreaterThan(1024 * 1024);

    let bytesRead = 0;
    let fullParses = 0;
    const io: TranscriptMaxSeqIO = {
      stat: async (target) => {
        const stats = await stat(target);
        return { mtimeMs: stats.mtimeMs, size: stats.size };
      },
      openRange: async (target) => {
        const handle = await open(target, "r");
        return {
          read: async (buffer, offset, length, position) => {
            const result = await handle.read(buffer, offset, length, position);
            bytesRead += result.bytesRead;
            return { bytesRead: result.bytesRead };
          },
          close: () => handle.close(),
        };
      },
      readFullMaxSeq: async (target) => {
        fullParses += 1;
        return (await readTranscriptEntriesWithSeq(target)).maxSeq;
      },
    };

    const reader = createTranscriptMaxSeqReader(io);
    expect(await reader.read(filePath)).toBe(299);

    bytesRead = 0;
    await appendFile(
      filePath,
      visibleLine("appended", "assistant") + "\n",
      "utf-8",
    );
    _resetTranscriptEntriesCacheForTesting();

    expect(await reader.read(filePath)).toBe(await parityMaxSeq(filePath));
    expect(await reader.read(filePath)).toBe(300);
    expect(fullParses).toBe(0);
    expect(bytesRead).toBeLessThan(fileSize);
    expect(bytesRead).toBeLessThan(4096 * 2);
  });

  it("rescans instead of trusting the cache when the file is rewritten shorter", async () => {
    const filePath = await writeTranscript("max-seq-shrink.jsonl", [
      visibleLine("ask", "user"),
      visibleLine("answer", "assistant"),
      visibleLine("more", "assistant"),
    ]);
    expect(await getTranscriptMaxSeq(filePath)).toBe(2);

    await writeFile(filePath, visibleLine("only", "user") + "\n", "utf-8");
    _resetTranscriptEntriesCacheForTesting();
    expect(await parityMaxSeq(filePath)).toBe(0);
    expect(await getTranscriptMaxSeq(filePath)).toBe(0);
  });
});

// ==========================================================================
// safeAppendTranscriptEntryOnce
// ==========================================================================

describe("safeAppendTranscriptEntryOnce", () => {
  let captured: SSEEvent[] = [];

  beforeEach(() => {
    captured = [];
    setTranscriptDeps({
      broadcast: (event: SSEEvent) => {
        captured.push(event);
        return { delivered: true };
      },
    });
  });

  afterEach(() => {
    _resetTranscriptDepsForTesting();
  });

  const meta = { projectName: "demo", storeSessionName: "main" };

  async function readLines(conversationId: string): Promise<string[]> {
    const raw = await readFile(
      path.join(TEST_DIR, "transcripts", `${conversationId}.jsonl`),
      "utf-8",
    );
    return raw.trim().split("\n");
  }

  function identifiedEntry(id: string, text: string) {
    return {
      id,
      timestamp: "2024-01-01T00:00:00Z",
      type: "assistant",
      role: "assistant" as const,
      content: [{ type: "text" as const, text }],
    };
  }

  it("persists and broadcasts a re-delivered entry exactly once", async () => {
    const entry = identifiedEntry("conv-ident:run-1:7", "streamed once");

    await safeAppendTranscriptEntryOnce(
      "conv-ident",
      entry,
      undefined,
      TEST_DIR,
      meta,
    );
    await safeAppendTranscriptEntryOnce(
      "conv-ident",
      entry,
      undefined,
      TEST_DIR,
      meta,
    );

    expect(await readLines("conv-ident")).toHaveLength(1);
    expect(captured).toHaveLength(1);
  });

  it("appends a second entry that carries a different id", async () => {
    await safeAppendTranscriptEntryOnce(
      "conv-seq",
      identifiedEntry("conv-seq:run-1:0", "first"),
      undefined,
      TEST_DIR,
      meta,
    );
    await safeAppendTranscriptEntryOnce(
      "conv-seq",
      identifiedEntry("conv-seq:run-1:1", "second"),
      undefined,
      TEST_DIR,
      meta,
    );

    expect(await readLines("conv-seq")).toHaveLength(2);
    expect(captured).toHaveLength(2);
  });

  it("leaves the ordinary append duplicate-tolerant for entries with no identity", async () => {
    const entry: TranscriptEntry = {
      timestamp: "2024-01-01T00:00:00Z",
      type: "assistant",
      role: "assistant",
      content: [{ type: "text", text: "no identity" }],
    };

    await safeAppendTranscriptEntry(
      "conv-anon",
      entry,
      undefined,
      TEST_DIR,
      meta,
    );
    await safeAppendTranscriptEntry(
      "conv-anon",
      entry,
      undefined,
      TEST_DIR,
      meta,
    );

    expect(await readLines("conv-anon")).toHaveLength(2);
    expect(captured).toHaveLength(2);
  });

  it("logs and resolves instead of throwing when the append fails", async () => {
    const logger = createCapturingLogger();
    // A regular file where the config directory must be, so the transcripts
    // directory cannot be created: the append fails and the turn must not.
    const blockedConfigDir = path.join(TEST_DIR, "blocked-config");
    await writeFile(blockedConfigDir, "not a directory", "utf-8");

    await expect(
      safeAppendTranscriptEntryOnce(
        "conv-fail",
        identifiedEntry("conv-fail:run-1:0", "boom"),
        logger,
        blockedConfigDir,
        meta,
      ),
    ).resolves.toBeUndefined();

    expect(
      logger.entries.some((e) => e.message === "transcript_write_failed"),
    ).toBe(true);
  });
});
