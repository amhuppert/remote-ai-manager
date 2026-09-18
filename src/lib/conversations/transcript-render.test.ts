import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  NORMALIZER_VERSION,
  renderOptionsSchema,
  renderedTranscriptSchema,
  renderCompactTranscript,
  renderCompleteEntryLines,
  renderedTranscriptToMarkdown,
  groupTranscriptEntries,
  segmentTranscript,
  type RenderOptions,
} from "./transcript-render";
import {
  EMPTY_TRANSCRIPT_BOUNDARIES,
  type CheckpointBoundaryInput,
} from "./history-recovery";
import type { MessageContentBlock } from "./schemas";
import {
  readTranscriptEntriesWithSeq,
  _resetTranscriptEntriesCacheForTesting,
  _resetTranscriptReadCacheForTesting,
  type TranscriptEntryWithSeq,
} from "@/lib/prompt/transcript";

function entry(
  seq: number,
  role: "user" | "assistant" | "notice",
  content: MessageContentBlock[],
  overrides: Partial<
    Pick<TranscriptEntryWithSeq, "entryId" | "timestamp">
  > = {},
): TranscriptEntryWithSeq {
  return {
    seq,
    entryId: overrides.entryId ?? null,
    role,
    timestamp:
      overrides.timestamp !== undefined
        ? overrides.timestamp
        : "2024-01-01T00:00:00Z",
    content,
  };
}

function text(value: string): MessageContentBlock {
  return { type: "text", text: value };
}

function thinking(value: string): MessageContentBlock {
  return { type: "thinking", text: value };
}

function options(
  overrides: z.input<typeof renderOptionsSchema> = {},
): RenderOptions {
  return renderOptionsSchema.parse(overrides);
}

function render(
  entries: TranscriptEntryWithSeq[],
  overrides: z.input<typeof renderOptionsSchema> = {},
  boundaries?: CheckpointBoundaryInput[],
) {
  const last = entries[entries.length - 1];
  return renderCompactTranscript(
    {
      conversationId: "conv-render",
      entries,
      maxSeq: last ? last.seq : -1,
      ...(boundaries === undefined ? {} : { boundaries }),
    },
    options(overrides),
  );
}

describe("NORMALIZER_VERSION", () => {
  it("is version 2", () => {
    expect(NORMALIZER_VERSION).toBe("2");
  });
});

// ==========================================================================
// renderOptionsSchema
// ==========================================================================

describe("renderOptionsSchema", () => {
  it("applies defaults", () => {
    const parsed = renderOptionsSchema.parse({});
    expect(parsed).toMatchObject({
      outline: false,
      includeTools: "summary",
      includeThinking: false,
      includeDebug: true,
      maxBytes: 262_144,
      format: "json",
    });
  });

  it("rejects combining message with seqRange", () => {
    const result = renderOptionsSchema.safeParse({
      message: 1,
      seqRange: [0, 2],
    });
    expect(result.success).toBe(false);
  });

  it("rejects combining messageRange with seqRange", () => {
    const result = renderOptionsSchema.safeParse({
      messageRange: [0, 1],
      seqRange: [0, 2],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid search regex", () => {
    const result = renderOptionsSchema.safeParse({ search: "(" });
    expect(result.success).toBe(false);
  });
});

// ==========================================================================
// Render grouping projection over a real cached transcript. `groupTranscriptEntries`
// projects the entry-level reader onto the shared grouping owner
// (transcript-logical-units); this pins the render product — merged indexes,
// roles, ids, per-part seqs, and command-block content — end to end through a
// real JSONL read. The read/render agreement itself is guaranteed by both
// projecting onto that one owner (its contract test covers the boundary rule),
// so this asserts render's own product, not a cross-copy comparison.
// ==========================================================================

describe("groupTranscriptEntries over a real cached transcript", () => {
  const TEST_DIR = path.join("/tmp", "cc-transcript-render-test-" + Date.now());

  beforeEach(async () => {
    _resetTranscriptEntriesCacheForTesting();
    _resetTranscriptReadCacheForTesting();
    await mkdir(TEST_DIR, { recursive: true });
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("merges same-role runs, breaks on a slash command, and skips system lines", async () => {
    const filePath = path.join(TEST_DIR, "grouping.jsonl");
    const lines = [
      JSON.stringify({
        id: "m-0",
        timestamp: "2024-01-01T00:00:00Z",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "hello" }],
      }),
      JSON.stringify({ type: "system", timestamp: "t", raw: { init: true } }),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:02Z",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "part one" }],
      }),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:03Z",
        type: "assistant",
        role: "assistant",
        content: [{ type: "text", text: "part two" }],
      }),
      // Slash command: breaks the merge chain and forms its own message,
      // then the following plain user entry merges INTO it.
      JSON.stringify({
        timestamp: "2024-01-01T00:00:04Z",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "/commit now" }],
      }),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:05Z",
        type: "user",
        role: "user",
        content: [{ type: "text", text: "follow-up" }],
      }),
      JSON.stringify({
        timestamp: "2024-01-01T00:00:06Z",
        type: "notice",
        role: "notice",
        content: [{ type: "text", text: "heads up" }],
      }),
    ];
    await writeFile(filePath, lines.join("\n") + "\n", "utf-8");

    const { entries } = await readTranscriptEntriesWithSeq(filePath);
    const units = groupTranscriptEntries(entries);

    expect(units.map((u) => u.role)).toEqual([
      "user",
      "assistant",
      "user",
      "notice",
    ]);
    expect(units.map((u) => u.messageIndex)).toEqual([0, 1, 2, 3]);
    expect(units[0]!.messageId).toBe("m-0");
    // Consecutive assistant lines merge; the system line is invisible.
    expect(units[1]!.parts.map((p) => p.seq)).toEqual([2, 3]);
    // The command unit carries the parsed command block plus the merged text.
    expect(units[2]!.parts.map((p) => p.seq)).toEqual([4, 5]);
    expect(units[2]!.parts[0]!.content).toEqual([
      { type: "command", name: "/commit", args: "now" },
    ]);
  });
});

// ==========================================================================
// Per-block rendering
// ==========================================================================

describe("renderCompactTranscript block rendering", () => {
  it("keeps text in full with per-entry seq prefixes", () => {
    const result = render([entry(0, "user", [text("line one\nline two")])]);
    expect(result.units).toHaveLength(1);
    expect(result.units[0]!.lines).toEqual(["[s0] line one", "[s0] line two"]);
    expect(renderedTranscriptSchema.parse(result)).toEqual(result);
  });

  it("omits thinking by default and counts the omission", () => {
    const result = render([
      entry(0, "user", [text("q")]),
      entry(1, "assistant", [
        { type: "thinking", text: "secret reasoning" },
        text("answer"),
      ]),
    ]);
    expect(result.units[1]!.lines).toEqual(["[s1] answer"]);
    expect(result.omissions.thinkingOmitted).toBe(1);
  });

  it("includes a flagged bounded thinking excerpt when includeThinking", () => {
    const result = render(
      [entry(0, "assistant", [{ type: "thinking", text: "a".repeat(600) }])],
      { includeThinking: true },
    );
    const line = result.units[0]!.lines[0]!;
    expect(line.startsWith("[s0] 🧠 thinking: ")).toBe(true);
    expect(line.length).toBeLessThan(600);
    expect(line.endsWith("…")).toBe(true);
    expect(result.omissions.thinkingOmitted).toBe(0);
  });

  it("renders tool_use as a one-line summary with primary arg and gist", () => {
    const result = render([
      entry(0, "assistant", [
        {
          type: "tool_use",
          name: "Read",
          input: { file_path: "/a.ts", limit: 5 },
        },
      ]),
    ]);
    expect(result.units[0]!.lines).toEqual([
      '[s0] ⚙ Read(/a.ts) — {"file_path":"/a.ts","limit":5}',
    ]);
  });

  it("drops tool blocks when includeTools=none", () => {
    const result = render(
      [
        entry(0, "assistant", [
          text("keep me"),
          { type: "tool_use", name: "Bash", input: { command: "ls" } },
          { type: "tool_result", tool_use_id: "t1", content: "out" },
        ]),
      ],
      { includeTools: "none" },
    );
    expect(result.units[0]!.lines).toEqual(["[s0] keep me"]);
  });

  it("includes full input JSON when includeTools=full", () => {
    const result = render(
      [
        entry(0, "assistant", [
          { type: "tool_use", name: "Bash", input: { command: "ls -la" } },
        ]),
      ],
      { includeTools: "full" },
    );
    expect(result.units[0]!.lines).toEqual([
      '[s0] ⚙ Bash(ls -la) — {"command":"ls -la"}',
      '[s0]   input: {"command":"ls -la"}',
    ]);
  });

  it("renders tool_result status, metrics, and head/tail excerpt with elided bytes", () => {
    const content = "H".repeat(500) + "T".repeat(500);
    const result = render([
      entry(0, "assistant", [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content,
          metrics: { lineCount: 12, byteCount: 1000 },
        },
      ]),
    ]);
    const lines = result.units[0]!.lines;
    expect(lines[0]).toBe("[s0] → ok (lines=12 bytes=1000)");
    expect(lines).toContain("[s0] … [400 bytes elided] …");
    expect(result.omissions.toolResultBytesElided).toBe(400);
  });

  it("renders failed tool_result as error", () => {
    const result = render([
      entry(0, "assistant", [
        {
          type: "tool_result",
          tool_use_id: "t1",
          content: "boom",
          isError: true,
        },
      ]),
    ]);
    expect(result.units[0]!.lines).toEqual(["[s0] → error", "[s0] boom"]);
  });

  it("renders command blocks as one-liners", () => {
    const result = render([
      entry(0, "user", [{ type: "command", name: "/commit", args: "now" }]),
      entry(1, "user", [{ type: "command", name: "/status", args: null }]),
    ]);
    expect(result.units[0]!.lines).toEqual([
      "[s0] /commit now",
      "[s1] /status",
    ]);
  });

  it("renders every image variant as a placeholder", () => {
    const result = render([
      entry(0, "user", [
        { type: "image", mediaType: "image/png", base64Data: "AAAA" },
        { type: "image_ref", mediaType: "image/jpeg", imagePath: "/x.jpg" },
        {
          type: "image_marker",
          index: 1,
          mediaType: "image/webp",
          imagePath: "/y.webp",
        },
      ]),
    ]);
    expect(result.units[0]!.lines).toEqual([
      "[s0] [image image/png]",
      "[s0] [image image/jpeg]",
      "[s0] [image image/webp]",
    ]);
  });

  it("collapses debug_structured to one concise line and honors includeDebug=false", () => {
    const blocks: MessageContentBlock[] = [
      {
        type: "debug_structured",
        phase: "hypothesizing",
        payload: { hypotheses: ["cache stale"] },
      },
    ];
    const included = render([entry(0, "assistant", blocks)]);
    expect(included.units[0]!.lines).toEqual([
      '[s0] 🐞 debug[hypothesizing]: {"hypotheses":["cache stale"]}',
    ]);

    const excluded = render([entry(0, "assistant", blocks)], {
      includeDebug: false,
    });
    expect(excluded.units[0]!.lines).toEqual([]);
  });

  it("renders document_feedback one line per item", () => {
    const result = render([
      entry(0, "user", [
        {
          type: "document_feedback",
          items: [
            {
              docPath: "docs/a.md",
              path: "intro",
              headingLabel: "Intro",
              line: 3,
              quote: "quoted",
              note: "fix wording",
            },
            {
              docPath: "docs/b.md",
              path: "usage",
              headingLabel: "Usage",
              line: 9,
              quote: "q2",
              note: "add example",
            },
          ],
        },
      ]),
    ]);
    expect(result.units[0]!.lines).toEqual([
      "[s0] 📝 docs/a.md:3 Intro — fix wording",
      "[s0] 📝 docs/b.md:9 Usage — add example",
    ]);
  });

  it("renders notepad_feedback as the named notepad and its dispatched comments", () => {
    const result = render([
      entry(0, "user", [
        {
          type: "notepad_feedback",
          notepadId: "np-1",
          notepadName: "Release plan",
          notepadRefXml: '<notepad-ref notepad-id="np-1" />',
          items: [
            {
              commentId: "c-1",
              location: "§ Rollout · L12",
              quote: "ship on Friday",
              body: "deploys are frozen on Friday",
            },
          ],
        },
      ]),
    ]);
    expect(result.units[0]!.lines).toEqual([
      "[s0] 📝 notepad Release plan (np-1) — 1 comment",
      "[s0]    § Rollout · L12 — deploys are frozen on Friday",
    ]);
  });
});

// ==========================================================================
// Units, refs, and top-level fields
// ==========================================================================

describe("renderCompactTranscript units and refs", () => {
  const conversation = [
    entry(0, "user", [text("question")], { entryId: "m-0" }),
    entry(1, "assistant", [text("first")]),
    entry(2, "assistant", [text("second")]),
    entry(4, "user", [text("next question")]),
  ];

  it("carries whole-unit spans, per-entry seqs, and merged-message indexes", () => {
    const result = render(conversation);
    expect(result.conversationId).toBe("conv-render");
    expect(result.totalMessages).toBe(3);
    expect(result.maxSeq).toBe(4);
    expect(result.truncated).toBe(false);
    expect(result.units.map((u) => u.ref)).toEqual([
      { messageIndex: 0, messageId: "m-0", seqStart: 0, seqEnd: 0 },
      { messageIndex: 1, messageId: null, seqStart: 1, seqEnd: 2 },
      { messageIndex: 2, messageId: null, seqStart: 4, seqEnd: 4 },
    ]);
    expect(result.units[1]!.entrySeqs).toEqual([1, 2]);
    expect(result.units[1]!.lines).toEqual(["[s1] first", "[s2] second"]);
  });

  it("uses an empty string for units whose first entry has no timestamp", () => {
    const result = render([entry(0, "user", [text("x")], { timestamp: null })]);
    expect(result.units[0]!.timestamp).toBe("");
  });

  it("validates against renderedTranscriptSchema", () => {
    const result = render(conversation);
    expect(renderedTranscriptSchema.parse(result)).toEqual(result);
  });
});

// ==========================================================================
// Windowing
// ==========================================================================

describe("renderCompactTranscript windowing", () => {
  const conversation = [
    entry(0, "user", [text("q1")]),
    entry(1, "assistant", [text("a1 part one")]),
    entry(2, "assistant", [text("a1 part two")]),
    entry(3, "user", [text("q2")]),
    entry(4, "assistant", [text("a2")]),
  ];

  it("selects a single logical message with message", () => {
    const result = render(conversation, { message: 1 });
    expect(result.units.map((u) => u.ref.messageIndex)).toEqual([1]);
    expect(result.omissions.unitsOutsideWindow).toBe(3);
    expect(result.totalMessages).toBe(4);
  });

  it("selects an inclusive messageRange", () => {
    const result = render(conversation, { messageRange: [1, 2] });
    expect(result.units.map((u) => u.ref.messageIndex)).toEqual([1, 2]);
    expect(result.omissions.unitsOutsideWindow).toBe(2);
  });

  it("slices a merged unit when the seqRange boundary falls inside it", () => {
    const result = render(conversation, { seqRange: [2, 3] });
    expect(result.units).toHaveLength(2);

    const sliced = result.units[0]!;
    // Whole-unit span retained for navigation, entrySeqs/lines sliced.
    expect(sliced.ref).toEqual({
      messageIndex: 1,
      messageId: null,
      seqStart: 1,
      seqEnd: 2,
    });
    expect(sliced.entrySeqs).toEqual([2]);
    expect(sliced.lines).toEqual(["[s2] a1 part two"]);

    expect(result.units[1]!.ref.messageIndex).toBe(2);
    expect(result.omissions.unitsOutsideWindow).toBe(2);
  });

  it("excludes units whose entries all fall outside the seqRange", () => {
    const result = render(conversation, { seqRange: [0, 0] });
    expect(result.units.map((u) => u.ref.messageIndex)).toEqual([0]);
    expect(result.omissions.unitsOutsideWindow).toBe(3);
  });
});

// ==========================================================================
// Search
// ==========================================================================

describe("renderCompactTranscript search", () => {
  it("returns only units whose text blocks match the regex", () => {
    const result = render(
      [
        entry(0, "user", [text("alpha")]),
        entry(1, "assistant", [text("the beta answer")]),
        entry(2, "user", [text("gamma")]),
      ],
      { search: "beta|gamma" },
    );
    expect(result.units.map((u) => u.ref.messageIndex)).toEqual([1, 2]);
    expect(result.omissions.unitsOutsideWindow).toBe(1);
  });

  it("does not match non-text blocks", () => {
    const result = render(
      [
        entry(0, "assistant", [
          { type: "tool_use", name: "Bash", input: { command: "beta" } },
        ]),
      ],
      { search: "beta" },
    );
    expect(result.units).toHaveLength(0);
    expect(result.omissions.unitsOutsideWindow).toBe(1);
  });
});

// ==========================================================================
// maxBytes truncation
// ==========================================================================

describe("renderCompactTranscript maxBytes", () => {
  it("stops adding units at the byte boundary and sets truncated", () => {
    const result = render(
      [
        entry(0, "user", [text("short")]),
        entry(1, "assistant", [text("x".repeat(200))]),
      ],
      { maxBytes: 30 },
    );
    expect(result.units.map((u) => u.ref.messageIndex)).toEqual([0]);
    expect(result.truncated).toBe(true);
  });

  it("partially emits the boundary unit when some of its lines fit", () => {
    const result = render(
      [
        entry(0, "user", [text("short")]),
        entry(1, "assistant", [text(`line one\n${"x".repeat(300)}`)]),
      ],
      { maxBytes: 40 },
    );
    expect(result.truncated).toBe(true);
    expect(result.units.map((u) => u.ref.messageIndex)).toEqual([0, 1]);
    expect(result.units[1]?.lines).toEqual([
      "[s1] line one",
      "… [unit truncated: 306 bytes elided]",
    ]);
    expect(result.units[1]?.entrySeqs).toEqual([1]);
  });

  it("emits a bounded partial slice of a single oversize unit instead of nothing", () => {
    const bigText = Array.from(
      { length: 50 },
      (_, i) => `log line ${i} ${"y".repeat(20)}`,
    ).join("\n");
    const result = render([entry(0, "user", [text(bigText)])], {
      maxBytes: 120,
    });
    expect(result.truncated).toBe(true);
    expect(result.units).toHaveLength(1);
    const unit = result.units[0];
    expect(unit).toBeDefined();
    if (!unit) return;
    expect(unit.lines.length).toBeGreaterThan(1);
    expect(unit.lines[unit.lines.length - 1]).toMatch(
      /^… \[unit truncated: \d+ bytes elided\]$/,
    );
    expect(unit.lines[0]).toContain("log line 0");
    expect(unit.entrySeqs).toEqual([0]);
  });

  it("emits only an elision marker when no line of the sole unit fits", () => {
    const result = render([entry(0, "user", [text("x".repeat(100))])], {
      maxBytes: 10,
    });
    expect(result.truncated).toBe(true);
    expect(result.units).toHaveLength(1);
    expect(result.units[0]?.lines).toEqual([
      "… [unit truncated: 106 bytes elided]",
    ]);
    expect(result.units[0]?.entrySeqs).toEqual([]);
  });

  it("does not truncate when everything fits", () => {
    const result = render([entry(0, "user", [text("hi")])]);
    expect(result.truncated).toBe(false);
  });
});

// ==========================================================================
// Outline mode
// ==========================================================================

describe("renderCompactTranscript outline", () => {
  it("reduces text to a bounded first-line headline and drops tool noise", () => {
    const longFirstLine = "H".repeat(150);
    const result = render(
      [
        entry(0, "user", [text("what is this?\nmore detail")]),
        entry(1, "assistant", [
          { type: "thinking", text: "hmm" },
          text(`${longFirstLine}\nbody`),
          { type: "tool_use", name: "Read", input: { file_path: "/a" } },
          { type: "tool_result", tool_use_id: "t", content: "stuff" },
        ]),
      ],
      { outline: true },
    );
    expect(result.units[0]!.lines).toEqual(["[s0] what is this?"]);
    expect(result.units[1]!.lines).toHaveLength(1);
    const headline = result.units[1]!.lines[0]!;
    expect(headline.startsWith("[s1] HHH")).toBe(true);
    expect(headline.endsWith("…")).toBe(true);
    expect(headline.length).toBeLessThan(150);
  });
});

// ==========================================================================
// Markdown formatting
// ==========================================================================

describe("renderedTranscriptToMarkdown", () => {
  it("renders unit headers with message index, seq span, and role", () => {
    const result = render([
      entry(0, "user", [text("question")]),
      entry(1, "assistant", [text("first")]),
      entry(2, "assistant", [text("second")]),
    ]);
    const markdown = renderedTranscriptToMarkdown(result);
    expect(markdown).toContain("#0 [seq 0] user\n[s0] question");
    expect(markdown).toContain(
      "#1 [seq 1–2] assistant\n[s1] first\n[s2] second",
    );
  });

  it("marks truncated documents", () => {
    const result = render(
      [
        entry(0, "user", [text("short")]),
        entry(1, "assistant", [text("y".repeat(500))]),
      ],
      { maxBytes: 30 },
    );
    const markdown = renderedTranscriptToMarkdown(result);
    expect(markdown).toContain("truncated");
  });
});

// ==========================================================================
// Empty input
// ==========================================================================

describe("renderCompactTranscript empty input", () => {
  it("renders an empty transcript", () => {
    const result = renderCompactTranscript(
      { conversationId: "conv-empty", entries: [], maxSeq: -1 },
      options(),
    );
    expect(result).toEqual({
      conversationId: "conv-empty",
      totalMessages: 0,
      maxSeq: -1,
      units: [],
      truncated: false,
      omissions: {
        thinkingOmitted: 0,
        toolResultBytesElided: 0,
        unitsOutsideWindow: 0,
      },
      boundaries: EMPTY_TRANSCRIPT_BOUNDARIES,
      truncation: {
        omittedAfter: null,
        partialEntry: null,
        excerptedEntries: [],
        excerptedEntriesOmitted: 0,
        excerptedEntriesNext: null,
      },
    });
  });
});

// ==========================================================================
// Stored tool_result entries: folding, windows, rendering (design §4)
// ==========================================================================

describe("tool_result entry folding and rendering", () => {
  function toolResultEntry(
    seq: number,
    block: Partial<Extract<MessageContentBlock, { type: "tool_result" }>> = {},
  ): TranscriptEntryWithSeq {
    return {
      kind: "tool_result",
      seq,
      entryId: null,
      timestamp: "2024-01-01T00:00:00Z",
      content: [{ type: "tool_result", tool_use_id: "t1", ...block }],
    };
  }

  function toolUse(name: string): MessageContentBlock {
    return { type: "tool_use", id: "t1", name, input: { command: "ls" } };
  }

  it("folds tool_result entries into the open unit without starting or counting a unit", () => {
    const result = render([
      entry(0, "user", [text("run it")]),
      entry(1, "assistant", [toolUse("Bash")]),
      toolResultEntry(2, {
        content: "file-a\nfile-b",
        metrics: { lineCount: 2 },
      }),
      entry(3, "assistant", [text("done")]),
    ]);

    // messageIndex parity: 2 logical messages, not 3.
    expect(result.totalMessages).toBe(2);
    expect(result.units).toHaveLength(2);
    const assistant = result.units[1]!;
    expect(assistant.ref.messageIndex).toBe(1);
    expect(assistant.entrySeqs).toEqual([1, 2, 3]);
    expect(assistant.ref.seqStart).toBe(1);
    expect(assistant.ref.seqEnd).toBe(3);
    expect(assistant.lines).toEqual([
      '[s1] ⚙ Bash(ls) — {"command":"ls"}',
      "[s2] → ok (lines=2)",
      "[s2] file-a",
      "[s2] file-b",
      "[s3] done",
    ]);
  });

  it("renders a folded tool_result with status, metrics, bounded head/tail, and counted elided bytes", () => {
    const long = "x".repeat(1_000);
    const result = render([
      entry(0, "assistant", [toolUse("Bash")]),
      toolResultEntry(1, { content: long, isError: true }),
    ]);

    const lines = result.units[0]!.lines;
    expect(lines).toContain("[s1] → error");
    expect(
      lines.some((line) => /\[s1\] … \[\d+ bytes elided\] …/.test(line)),
    ).toBe(true);
    expect(result.omissions.toolResultBytesElided).toBe(400);
  });

  it("drops folded tool_result lines when includeTools is none, and in outline mode", () => {
    const entries = [
      entry(0, "user", [text("go")]),
      entry(1, "assistant", [toolUse("Bash")]),
      toolResultEntry(2, { content: "output" }),
    ];

    const none = render(entries, { includeTools: "none" });
    expect(none.units[1]!.lines).toEqual([]);
    // The folded entry still belongs to the unit's span even when unrendered.
    expect(none.units[1]!.entrySeqs).toEqual([1, 2]);

    const outline = render(entries, { outline: true });
    expect(
      outline.units
        .flatMap((unit) => unit.lines)
        .some((l) => l.includes("output")),
    ).toBe(false);
  });

  it("slices a seqRange window directly onto a tool_result line", () => {
    const result = render(
      [
        entry(0, "user", [text("go")]),
        entry(1, "assistant", [toolUse("Bash")]),
        toolResultEntry(2, { content: "the output", metrics: { exitCode: 0 } }),
        entry(3, "assistant", [text("done")]),
      ],
      { seqRange: [2, 2] },
    );

    expect(result.units).toHaveLength(1);
    expect(result.units[0]!.lines).toEqual([
      "[s2] → ok (exit=0)",
      "[s2] the output",
    ]);
    // The unit keeps its merged identity even when sliced mid-unit.
    expect(result.units[0]!.ref.messageIndex).toBe(1);
    expect(result.omissions.unitsOutsideWindow).toBe(1);
  });

  it("drops a tool_result with no open unit instead of starting one", () => {
    const result = render([
      toolResultEntry(0, { content: "orphan" }),
      entry(1, "user", [text("hello")]),
    ]);

    expect(result.units).toHaveLength(1);
    expect(result.units[0]!.role).toBe("user");
    expect(result.units[0]!.ref.messageIndex).toBe(0);
  });

  it("folds an interleaved tool_result into the open assistant unit on a real transcript", async () => {
    const TEST_DIR = path.join(
      "/tmp",
      "cc-transcript-render-toolresult-" + Date.now(),
    );
    await mkdir(TEST_DIR, { recursive: true });
    try {
      const filePath = path.join(TEST_DIR, "tool-results.jsonl");
      const lines = [
        JSON.stringify({
          timestamp: "2024-01-01T00:00:00Z",
          type: "user",
          role: "user",
          content: [{ type: "text", text: "run the audit" }],
        }),
        JSON.stringify({
          timestamp: "2024-01-01T00:00:01Z",
          type: "assistant",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tu-1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        }),
        JSON.stringify({
          timestamp: "2024-01-01T00:00:02Z",
          type: "tool_result",
          raw: {
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  tool_use_id: "tu-1",
                  type: "tool_result",
                  content: "file-a\nfile-b",
                  is_error: false,
                },
              ],
            },
            parent_tool_use_id: null,
            session_id: "s",
            uuid: "u",
          },
        }),
        JSON.stringify({
          timestamp: "2024-01-01T00:00:03Z",
          type: "assistant",
          role: "assistant",
          content: [{ type: "text", text: "two files" }],
        }),
        JSON.stringify({
          timestamp: "2024-01-01T00:00:04Z",
          type: "user",
          role: "user",
          content: [{ type: "text", text: "thanks" }],
        }),
      ];
      await writeFile(filePath, lines.join("\n") + "\n", "utf-8");

      const { entries, maxSeq } = await readTranscriptEntriesWithSeq(filePath);
      const units = groupTranscriptEntries(entries);

      // The tool_result is invisible, so it neither starts nor counts a unit:
      // user (0), assistant+tool_result+assistant (1), user (2).
      expect(units.map((u) => u.role)).toEqual(["user", "assistant", "user"]);
      expect(units.map((u) => u.messageIndex)).toEqual([0, 1, 2]);
      // The tool_result folded into the assistant unit with its exact seq.
      expect(units[1]!.parts.map((p) => p.seq)).toEqual([1, 2, 3]);
      // maxSeq tracks the last VISIBLE entry, not the trailing tool_result.
      expect(maxSeq).toBe(4);
    } finally {
      await rm(TEST_DIR, { recursive: true, force: true });
    }
  });
});

// ==========================================================================
// segmentTranscript — budget-bounded, unit-boundary segmentation (fold input)
// ==========================================================================

describe("segmentTranscript", () => {
  function segment(
    entries: TranscriptEntryWithSeq[],
    windowBudgetBytes: number,
    overrides: z.input<typeof renderOptionsSchema> = {},
  ) {
    const last = entries[entries.length - 1];
    return segmentTranscript(
      { conversationId: "conv-seg", entries, maxSeq: last ? last.seq : -1 },
      options(overrides),
      windowBudgetBytes,
    );
  }

  // Four alternating-role text units (same role would merge into one unit).
  function alternatingUnits(textLength: number): TranscriptEntryWithSeq[] {
    const body = "a".repeat(textLength);
    return [
      entry(0, "user", [text(body)]),
      entry(1, "assistant", [text(body)]),
      entry(2, "user", [text(body)]),
      entry(3, "assistant", [text(body)]),
    ];
  }

  it("returns one segment covering everything when the whole transcript fits", () => {
    const segments = segment(alternatingUnits(1000), 1_000_000);
    expect(segments).toEqual([{ seqStart: 0, seqEnd: 3 }]);
  });

  it("packs consecutive units into contiguous segments under the budget", () => {
    // Each unit ≈ 1006 bytes; a 2500-byte budget fits two per segment.
    const segments = segment(alternatingUnits(1000), 2500);
    expect(segments).toEqual([
      { seqStart: 0, seqEnd: 1 },
      { seqStart: 2, seqEnd: 3 },
    ]);
  });

  it("cuts only on unit boundaries — one unit per segment when none pair up", () => {
    const segments = segment(alternatingUnits(1000), 1500);
    expect(segments).toEqual([
      { seqStart: 0, seqEnd: 0 },
      { seqStart: 1, seqEnd: 1 },
      { seqStart: 2, seqEnd: 2 },
      { seqStart: 3, seqEnd: 3 },
    ]);
  });

  it("isolates a lone over-budget unit into its own segment", () => {
    const entries = [
      entry(0, "user", [text("hi")]),
      entry(1, "assistant", [text("a".repeat(5000))]),
      entry(2, "user", [text("bye")]),
    ];
    expect(segment(entries, 2500)).toEqual([
      { seqStart: 0, seqEnd: 0 },
      { seqStart: 1, seqEnd: 1 },
      { seqStart: 2, seqEnd: 2 },
    ]);
  });

  it("segments only the seqRange window (delta input)", () => {
    expect(
      segment(alternatingUnits(1000), 1_000_000, { seqRange: [2, 3] }),
    ).toEqual([{ seqStart: 2, seqEnd: 3 }]);
    expect(segment(alternatingUnits(1000), 1500, { seqRange: [2, 3] })).toEqual(
      [
        { seqStart: 2, seqEnd: 2 },
        { seqStart: 3, seqEnd: 3 },
      ],
    );
  });

  it("extends the final segment over a trailing tool_result folded into its unit", () => {
    const entries: TranscriptEntryWithSeq[] = [
      entry(0, "user", [text("question")]),
      entry(1, "assistant", [text("answer")]),
      {
        kind: "tool_result",
        seq: 2,
        entryId: null,
        timestamp: "2024-01-01T00:00:00Z",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "output" },
        ],
      },
    ];
    expect(segment(entries, 1_000_000)).toEqual([{ seqStart: 0, seqEnd: 2 }]);
  });

  it("returns no segments for an empty window", () => {
    expect(segment([], 1000)).toEqual([]);
    expect(
      segment(alternatingUnits(1000), 1000, { seqRange: [99, 100] }),
    ).toEqual([]);
  });
});

// ==========================================================================
// Checkpoint boundary projection (metadata only — never a frame)
// ==========================================================================

describe("renderCompactTranscript checkpoint boundaries", () => {
  const conversation = [
    entry(0, "user", [text("a")]),
    entry(1, "assistant", [text("b")]),
    entry(2, "user", [text("c")]),
  ];

  it("projects a saved boundary without adding a message or a line", () => {
    const plain = render(conversation);
    const withBoundary = render(conversation, {}, [
      { operationId: "op-1", ordinal: 1, capturedThroughSeq: 1 },
    ]);

    expect(withBoundary.totalMessages).toBe(plain.totalMessages);
    expect(withBoundary.units).toEqual(plain.units);
    expect(withBoundary.boundaries.entries).toEqual([
      {
        operationId: "op-1",
        ordinal: 1,
        capturedThroughSeq: 1,
        afterMessageIndex: 1,
        nextSeq: 2,
      },
    ]);
  });

  it("keeps three repeated checkpoints in ordinal order", () => {
    const rendered = render(
      [
        ...conversation,
        entry(3, "assistant", [text("d")]),
        entry(4, "user", [text("e")]),
      ],
      {},
      [
        { operationId: "op-1", ordinal: 1, capturedThroughSeq: 0 },
        { operationId: "op-2", ordinal: 2, capturedThroughSeq: 2 },
        { operationId: "op-3", ordinal: 3, capturedThroughSeq: 3 },
      ],
    );
    expect(rendered.totalMessages).toBe(5);
    expect(
      rendered.boundaries.entries.map((b) => [b.ordinal, b.nextSeq]),
    ).toEqual([
      [1, 1],
      [2, 3],
      [3, 4],
    ]);
  });

  it("omits boundaries outside the selected seq window", () => {
    const rendered = render(conversation, { seqRange: [2, 2] }, [
      { operationId: "op-1", ordinal: 1, capturedThroughSeq: 0 },
      { operationId: "op-2", ordinal: 2, capturedThroughSeq: 2 },
    ]);
    expect(rendered.boundaries.entries.map((b) => b.ordinal)).toEqual([2]);
    expect(rendered.boundaries.totalInRange).toBe(1);
  });

  it("reports no boundaries when the caller supplies none", () => {
    expect(render(conversation).boundaries).toEqual(
      EMPTY_TRANSCRIPT_BOUNDARIES,
    );
  });
});

// ==========================================================================
// Truncation metadata: omitted later entries vs a partially displayed one
// ==========================================================================

describe("renderCompactTranscript truncation metadata", () => {
  it("reports nothing lost when the whole window fits", () => {
    expect(render([entry(0, "user", [text("hi")])]).truncation).toEqual({
      omittedAfter: null,
      partialEntry: null,
      excerptedEntries: [],
      excerptedEntriesOmitted: 0,
      excerptedEntriesNext: null,
    });
  });

  it("names the next omitted raw sequence and a range-read command", () => {
    const result = render(
      [
        entry(0, "user", [text("short")]),
        entry(1, "assistant", [text("x".repeat(200))]),
      ],
      { maxBytes: 30 },
    );
    expect(result.truncation.omittedAfter).toEqual({
      nextSeq: 1,
      lastSeq: 1,
      unitCount: 1,
      command: "cctl conversation read conv-render --seq-range 1:1",
    });
    expect(result.truncation.partialEntry).toBeNull();
  });

  it("names the partially displayed entry and its complete-entry command", () => {
    const result = render(
      [
        entry(0, "user", [text("short")]),
        entry(1, "assistant", [text(`line one\n${"x".repeat(300)}`)]),
      ],
      { maxBytes: 40 },
    );
    expect(result.truncation.partialEntry).toEqual({
      seq: 1,
      messageIndex: 1,
      elidedBytes: 306,
      command: "cctl conversation entry get conv-render 1",
    });
    // Nothing follows the cut entry, so there is no omitted range to read.
    expect(result.truncation.omittedAfter).toBeNull();
  });

  it("distinguishes the cut entry from the entries never reached", () => {
    const result = render(
      [
        entry(0, "user", [text("short")]),
        entry(1, "assistant", [text(`line one\n${"x".repeat(300)}`)]),
        entry(2, "user", [text("u2")]),
        entry(3, "assistant", [text("a3")]),
      ],
      { maxBytes: 40 },
    );
    expect(result.truncation.partialEntry?.seq).toBe(1);
    expect(result.truncation.omittedAfter).toEqual({
      nextSeq: 2,
      lastSeq: 3,
      unitCount: 2,
      command: "cctl conversation read conv-render --seq-range 2:3",
    });
  });

  it("names each excerpted tool result with its own recovery command", () => {
    const result = render([
      entry(0, "user", [text("go")]),
      entry(1, "assistant", [
        { type: "tool_result", tool_use_id: "t", content: "z".repeat(1000) },
      ]),
    ]);
    expect(result.truncation.excerptedEntries).toEqual([
      {
        seq: 1,
        messageIndex: 1,
        elidedBytes: 400,
        command: "cctl conversation entry get conv-render 1",
      },
    ]);
    expect(result.truncation.excerptedEntriesOmitted).toBe(0);
    // An excerpt is not a truncated read: the window itself was complete.
    expect(result.truncation.omittedAfter).toBeNull();
  });

  it("caps the excerpted-entry index and counts the rest", () => {
    const entries = [entry(0, "user", [text("go")])];
    for (let seq = 1; seq <= 10; seq += 1) {
      entries.push(
        entry(seq, "assistant", [
          {
            type: "tool_result",
            tool_use_id: `t${seq}`,
            content: "z".repeat(1000),
          },
        ]),
      );
    }
    const result = render(entries);
    expect(result.truncation.excerptedEntries).toHaveLength(8);
    expect(result.truncation.excerptedEntriesOmitted).toBe(2);
  });

  it("returns full tool content instead of an excerpt at includeTools=full", () => {
    const result = render(
      [
        entry(0, "user", [text("go")]),
        entry(1, "assistant", [
          { type: "tool_result", tool_use_id: "t", content: "z".repeat(1000) },
        ]),
      ],
      { includeTools: "full" },
    );
    expect(result.truncation.excerptedEntries).toEqual([]);
  });

  it("names the seq range holding the excerpted entries past the cap", () => {
    const entries = [entry(0, "user", [text("go")])];
    for (let seq = 1; seq <= 10; seq += 1) {
      entries.push(
        entry(seq, "assistant", [
          {
            type: "tool_result",
            tool_use_id: `t${seq}`,
            content: "z".repeat(1000),
          },
        ]),
      );
    }
    const result = render(entries);
    expect(result.truncation.excerptedEntriesOmitted).toBe(2);
    // The cap drops coordinates, so the reader hands back the window that
    // still holds them rather than losing them silently.
    expect(result.truncation.excerptedEntriesNext).toEqual({
      nextSeq: 9,
      lastSeq: 10,
      command: "cctl conversation read conv-render --seq-range 9:10",
    });
  });
});

// ==========================================================================
// Every shortened kind, not just tool results, is recoverable
// ==========================================================================

describe("renderCompactTranscript excerpt accounting across block kinds", () => {
  const longNote = "n".repeat(600);

  it("names an entry whose requested thinking was shortened, keeping the opt-in", () => {
    const result = render(
      [entry(0, "assistant", [thinking("t".repeat(900))])],
      {
        includeThinking: true,
      },
    );
    expect(result.truncation.excerptedEntries).toEqual([
      {
        seq: 0,
        messageIndex: 0,
        // 900 recorded characters against the 500 the excerpt kept.
        elidedBytes: 400,
        command: "cctl conversation entry get conv-render 0 --include-thinking",
      },
    ]);
  });

  it.each([
    [
      "thinking",
      [thinking("t".repeat(501))],
      { includeThinking: true },
      "cctl conversation entry get conv-render 0 --include-thinking",
    ],
    [
      "an outline headline",
      [text("z".repeat(121))],
      { outline: true },
      "cctl conversation entry get conv-render 0",
    ],
    [
      "a feedback note",
      [
        {
          type: "document_feedback" as const,
          items: [
            {
              docPath: "docs/a.md",
              path: "docs/a.md",
              line: 3,
              headingLabel: "H",
              quote: "q",
              note: "n".repeat(201),
            },
          ],
        },
      ],
      {},
      "cctl conversation entry get conv-render 0",
    ],
  ])(
    "reports %s shortened by a single character, ellipsis notwithstanding",
    (_kind, content, overrides, command) => {
      // The replacement ellipsis is three UTF-8 bytes, so a one-character
      // loss must not be measured against the marker's size.
      const result = render(
        [entry(0, "assistant", content as MessageContentBlock[])],
        overrides,
      );
      expect(result.truncation.excerptedEntries).toEqual([
        { seq: 0, messageIndex: 0, elidedBytes: 1, command },
      ]);
    },
  );

  it("keeps the reader's tool level out of an entry-export command", () => {
    const excerpted = render(
      [entry(0, "assistant", [thinking("t".repeat(900))])],
      { includeThinking: true, includeTools: "none" },
    );
    expect(excerpted.truncation.excerptedEntries[0]?.command).toBe(
      "cctl conversation entry get conv-render 0 --include-thinking",
    );

    const entries = [
      entry(0, "user", [text("go")]),
      entry(1, "assistant", [text("aaa\nbbb")]),
    ];
    const full = render(entries, { includeTools: "full" });
    const firstUnitBytes = (full.units[0]?.lines ?? []).reduce(
      (sum, line) => sum + Buffer.byteLength(line, "utf-8") + 1,
      0,
    );
    const cut = render(entries, {
      includeTools: "full",
      maxBytes: firstUnitBytes + Buffer.byteLength("[s1] aaa", "utf-8") + 1,
    });
    expect(cut.truncation.partialEntry?.command).toBe(
      "cctl conversation entry get conv-render 1",
    );
  });

  it.each([
    [
      "tool input gist",
      [
        {
          type: "tool_use" as const,
          id: "u1",
          name: "Bash",
          input: { command: "echo ".repeat(90) },
        },
      ],
      {},
    ],
    [
      "debug payload",
      [
        {
          type: "debug_structured" as const,
          phase: "hypothesizing",
          payload: { note: longNote },
        },
      ],
      {},
    ],
    [
      "document feedback note",
      [
        {
          type: "document_feedback" as const,
          items: [
            {
              docPath: "docs/a.md",
              path: "docs/a.md",
              line: 3,
              headingLabel: "H",
              quote: "q",
              note: longNote,
            },
          ],
        },
      ],
      {},
    ],
    [
      "notepad feedback body",
      [
        {
          type: "notepad_feedback" as const,
          notepadId: "np-1",
          notepadName: "Notes",
          notepadRefXml: '<notepad-ref id="np-1" />',
          items: [
            { commentId: "c1", location: "L3", quote: "q", body: longNote },
          ],
        },
      ],
      {},
    ],
    [
      "outline headline",
      [text(`first line\n${"y".repeat(500)}`)],
      { outline: true },
    ],
  ])("names an entry shortened by a %s", (_kind, content, overrides) => {
    const result = render(
      [entry(0, "assistant", content as MessageContentBlock[])],
      overrides,
    );
    expect(result.truncation.excerptedEntries).toHaveLength(1);
    const [reported] = result.truncation.excerptedEntries;
    expect(reported?.seq).toBe(0);
    expect(reported?.elidedBytes).toBeGreaterThan(0);
    expect(reported?.command).toBe("cctl conversation entry get conv-render 0");
  });

  it("reports no excerpt when nothing was shortened", () => {
    const result = render([entry(0, "assistant", [text("short enough")])]);
    expect(result.truncation.excerptedEntries).toEqual([]);
  });
});

// ==========================================================================
// Byte-budget cuts attribute loss to the entry that actually lost it
// ==========================================================================

describe("renderCompactTranscript byte-budget attribution", () => {
  /** Rendered cost of the lines one entry contributed, as the render counts it. */
  function entryBytes(
    rendered: ReturnType<typeof render>,
    seq: number,
  ): number {
    return rendered.units
      .flatMap((unit) => unit.lines)
      .filter((line) => line.startsWith(`[s${seq}] `))
      .reduce((sum, line) => sum + Buffer.byteLength(line, "utf-8") + 1, 0);
  }

  it("reports no partial entry when the cut falls between two entries", () => {
    const entries = [
      entry(0, "user", [text("go")]),
      entry(1, "assistant", [text("aaa")]),
      entry(2, "assistant", [text("bbb")]),
    ];
    const full = render(entries);
    const result = render(entries, {
      maxBytes: entryBytes(full, 0) + entryBytes(full, 1),
    });
    // Entry 1 is displayed complete: it is not partial, it is the last one read.
    expect(result.truncation.partialEntry).toBeNull();
    expect(result.truncation.omittedAfter).toEqual({
      nextSeq: 2,
      lastSeq: 2,
      unitCount: 0,
      command: "cctl conversation read conv-render --seq-range 2:2",
    });
  });

  it("attributes only its own lost lines to the partially displayed entry", () => {
    const entries = [
      entry(0, "user", [text("go")]),
      entry(1, "assistant", [text("aaa\nbbb")]),
      entry(2, "assistant", [text("ccc")]),
    ];
    const full = render(entries);
    const firstLineBytes = Buffer.byteLength("[s1] aaa", "utf-8") + 1;
    const result = render(entries, {
      maxBytes: entryBytes(full, 0) + firstLineBytes,
    });
    expect(result.truncation.partialEntry).toEqual({
      seq: 1,
      messageIndex: 1,
      // Entry 2's bytes belong to the omitted range, not to this entry.
      elidedBytes: entryBytes(full, 1) - firstLineBytes,
      command: "cctl conversation entry get conv-render 1",
    });
    expect(result.truncation.omittedAfter?.nextSeq).toBe(2);
  });

  it("keeps the excerpt command of an entry inside the truncated unit", () => {
    const entries = [
      entry(0, "user", [text("go")]),
      entry(1, "assistant", [
        { type: "tool_result", tool_use_id: "t", content: "z".repeat(1000) },
      ]),
      entry(2, "assistant", [text("x".repeat(400))]),
    ];
    const full = render(entries);
    const result = render(entries, {
      maxBytes: entryBytes(full, 0) + entryBytes(full, 1),
    });
    expect(result.truncated).toBe(true);
    // The budget stopped before entry 2, but entry 1 was still SUMMARIZED —
    // that loss needs its own command, which the cut must not discard.
    expect(result.truncation.excerptedEntries).toEqual([
      {
        seq: 1,
        messageIndex: 1,
        elidedBytes: 400,
        command: "cctl conversation entry get conv-render 1",
      },
    ]);
  });
});

// ==========================================================================
// Complete-entry export: a manageable entry must not be lost to a line count
// ==========================================================================

describe("renderCompleteEntryLines", () => {
  /** Past every engine's spread-argument limit, far under any byte bound. */
  const ENORMOUS_LINE_COUNT = 1_200_000;

  it("exports an entry with more lines than a spread call can carry", () => {
    const content = "abc\n".repeat(ENORMOUS_LINE_COUNT);
    const { lines } = renderCompleteEntryLines(
      [{ type: "tool_result", tool_use_id: "t", content }],
      { includeThinking: false },
    );
    // Header, every content line, and the empty line the trailing newline
    // leaves behind — the whole entry, not a RangeError.
    expect(lines).toHaveLength(ENORMOUS_LINE_COUNT + 2);
    expect(lines[0]).toBe("→ ok");
    expect(lines[1]).toBe("abc");
    expect(lines[ENORMOUS_LINE_COUNT]).toBe("abc");
  });

  it("exports enormous requested thinking and text the same way", () => {
    const { lines } = renderCompleteEntryLines(
      [
        { type: "thinking", text: "t\n".repeat(ENORMOUS_LINE_COUNT) },
        { type: "text", text: "x\n".repeat(ENORMOUS_LINE_COUNT) },
      ],
      { includeThinking: true },
    );
    // "🧠 thinking:" + thinking lines + trailing empty, then the text lines.
    expect(lines).toHaveLength(2 * (ENORMOUS_LINE_COUNT + 1) + 1);
    expect(lines[0]).toBe("🧠 thinking:");
  });
});

describe("capture audit origin", () => {
  it("labels mixed capture/tool parts without changing original message coordinates", () => {
    const origin = {
      source: "checkpoint_capture",
      checkpointCapture: {
        operationId: "op",
        captureId: "op:capture",
        part: "activity",
      },
    } as const;
    const entries: TranscriptEntryWithSeq[] = [
      entry(0, "user", [text("actual task")]),
      entry(1, "assistant", [text("ordinary")]),
      {
        ...entry(2, "assistant", [text("capture\nline\u2028separator")]),
        origin,
      },
      {
        kind: "tool_result",
        seq: 3,
        entryId: null,
        timestamp: null,
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool",
            content: "tool capture result",
          },
        ],
        origin,
      },
      entry(4, "user", [text("next task")]),
    ];
    const result = render(entries, { includeTools: "full" });
    expect(result.totalMessages).toBe(3);
    expect(result.units[1]).toMatchObject({
      ref: { messageIndex: 1, seqStart: 1, seqEnd: 3 },
      sourceParts: [{ seq: 1 }, { seq: 2, origin }, { seq: 3, origin }],
    });
    expect(result.units[1]?.lines.join("\n")).toContain(
      "checkpoint capture activity",
    );
    expect(result.units[2]?.ref).toMatchObject({
      messageIndex: 2,
      seqStart: 4,
    });
    expect(renderedTranscriptSchema.parse(result).units[1]).toMatchObject({
      sourceParts: [{ seq: 1 }, { seq: 2, origin }, { seq: 3, origin }],
    });
  });
});
