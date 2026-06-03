import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import path from "node:path";
import {
  readConversationMessages,
  readConversationMessagesWithSeq,
  readLastAssistantContent,
  _resetLastAssistantCacheForTesting,
  _resetLastSeqCacheForTesting,
  _resetTranscriptReadCacheForTesting,
  appendTranscriptEntry,
  getTranscriptPath,
  parseCommandContent,
  copyTranscriptUpTo,
  findForkAnchorUuid,
  setTranscriptDeps,
  _resetTranscriptDepsForTesting,
  type TranscriptEntry,
} from "./transcript";
import { messageAppendedEventSchema } from "@/lib/conversations/schemas";
import type { SSEEvent } from "@/lib/api/sse-events";
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
// readLastAssistantContent
// ==========================================================================

describe("readLastAssistantContent", () => {
  beforeEach(() => {
    _resetLastAssistantCacheForTesting();
  });

  it("returns null for null path", async () => {
    expect(await readLastAssistantContent(null)).toBeNull();
  });

  it("returns null for a non-existent file", async () => {
    expect(
      await readLastAssistantContent("/tmp/nonexistent-tail-xyz.jsonl"),
    ).toBeNull();
  });

  it("returns null for an empty file", async () => {
    const filePath = path.join(TEST_DIR, "transcripts", "empty-tail.jsonl");
    await writeFile(filePath, "", "utf-8");
    expect(await readLastAssistantContent(filePath)).toBeNull();
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
// readConversationMessagesWithSeq
// ==========================================================================

describe("readConversationMessagesWithSeq", () => {
  it("returns [] for null path", async () => {
    expect(await readConversationMessagesWithSeq(null)).toEqual([]);
  });

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
      mode: "exclusive",
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
      },
    });
  });

  afterEach(() => {
    _resetTranscriptDepsForTesting();
  });

  const meta = { projectName: "demo", sessionName: "main" };

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
      { projectName: "demo", sessionName: "__project__" },
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

  it("includes model and effort in the broadcast message when set on the entry", async () => {
    await appendTranscriptEntry(
      "conv-model",
      {
        timestamp: "2024-01-01T00:00:00Z",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "hi" }],
        model: "opus",
        effort: "high",
      },
      TEST_DIR,
      meta,
    );
    expect(captured).toHaveLength(1);
    const event = captured[0] as {
      message: { model?: string; effort?: string };
    };
    expect(event.message.model).toBe("opus");
    expect(event.message.effort).toBe("high");
  });

  it("uses the active broadcast dep set via setTranscriptDeps", async () => {
    const spy = vi.fn();
    setTranscriptDeps({ broadcast: spy });

    await appendTranscriptEntry(
      "conv-spy",
      makeEntry("user", "hello"),
      TEST_DIR,
      meta,
    );

    expect(spy).toHaveBeenCalledTimes(1);
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

    it("computes seq=0 on cold cache when the file does not yet exist", async () => {
      const conversationId = "conv-cold-no-file";

      await appendTranscriptEntry(
        conversationId,
        makeEntry("user", "first"),
        TEST_DIR,
        meta,
      );
      expect((captured[0] as { seq: number }).seq).toBe(0);
    });
  });
});
