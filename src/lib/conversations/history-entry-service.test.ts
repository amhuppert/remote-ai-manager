import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createHistoryEntryService,
  historyEntrySchema,
  historyEntryText,
  historyEntryTextStream,
  type HistoryEntry,
} from "./history-entry-service";
import {
  readTranscriptEntriesWithSeq,
  _resetTranscriptEntriesCacheForTesting,
  _resetTranscriptReadCacheForTesting,
} from "@/lib/prompt/transcript";

const TEST_DIR = path.join(
  "/tmp",
  `cc-history-entry-${process.pid}-${Date.now()}`,
);

const HUGE_TOOL_RESULT = Array.from(
  { length: 4000 },
  (_, index) => `result line ${index} ${"y".repeat(60)}`,
).join("\n");

const IMAGE_PATH = "/tmp/cc-history-entry-image/1.png";

const service = createHistoryEntryService({
  readTranscriptEntries: readTranscriptEntriesWithSeq,
});

let transcriptPath = "";

async function writeArchive(): Promise<void> {
  transcriptPath = path.join(TEST_DIR, "entries.jsonl");
  const lines = [
    JSON.stringify({
      id: "m-0",
      timestamp: "2024-01-01T00:00:00Z",
      type: "user",
      role: "user",
      content: [{ type: "text", text: "please read the log" }],
    }),
    JSON.stringify({
      timestamp: "2024-01-01T00:00:01Z",
      type: "assistant",
      role: "assistant",
      content: [
        { type: "thinking", text: "first line of reasoning\nsecond line" },
        {
          type: "tool_use",
          id: "t-1",
          name: "Bash",
          input: { command: "z".repeat(500), timeout: 900 },
        },
      ],
    }),
    JSON.stringify({
      timestamp: "2024-01-01T00:00:02Z",
      type: "tool_result",
      raw: {
        type: "tool_result",
        tool_use_id: "t-1",
        content: HUGE_TOOL_RESULT,
      },
    }),
    JSON.stringify({ type: "system", timestamp: "t", raw: { init: true } }),
    JSON.stringify({
      timestamp: "2024-01-01T00:00:04Z",
      type: "user",
      role: "user",
      content: [
        { type: "text", text: "and this screenshot" },
        {
          type: "image_marker",
          index: 1,
          mediaType: "image/png",
          imagePath: IMAGE_PATH,
        },
        { type: "image_ref", mediaType: "image/png", imagePath: IMAGE_PATH },
      ],
    }),
  ];
  await writeFile(transcriptPath, lines.join("\n") + "\n", "utf-8");
}

async function getEntry(seq: number, includeThinking = false) {
  _resetTranscriptEntriesCacheForTesting();
  return service.getEntry({
    conversationId: "conv-entry",
    transcriptPath,
    seq,
    includeThinking,
  });
}

async function expectEntry(seq: number, includeThinking = false) {
  const result = await getEntry(seq, includeThinking);
  if (!result.ok) {
    throw new Error(`expected entry ${seq}, got ${result.code}`);
  }
  return result.entry;
}

describe("history entry export", () => {
  beforeEach(async () => {
    _resetTranscriptEntriesCacheForTesting();
    _resetTranscriptReadCacheForTesting();
    await mkdir(TEST_DIR, { recursive: true });
    await writeArchive();
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("returns the entry at its original raw coordinate", async () => {
    const entry = await expectEntry(0);
    expect(historyEntrySchema.parse(entry)).toEqual(entry);
    expect(entry).toMatchObject({
      conversationId: "conv-entry",
      seq: 0,
      kind: "message",
      role: "user",
      entryId: "m-0",
      messageIndex: 0,
      includeThinking: false,
    });
    expect(entry.lines).toEqual(["please read the log"]);
  });

  it("keeps an oversized tool result complete, with no excerpt marker", async () => {
    const entry = await expectEntry(2);
    const text = historyEntryText(entry);
    expect(entry.kind).toBe("tool_result");
    expect(entry.role).toBeNull();
    expect(text).toContain(HUGE_TOOL_RESULT);
    expect(text).not.toContain("bytes elided");
    expect(text).not.toContain("…");
    expect(entry.bytes).toBe(Buffer.byteLength(text, "utf-8"));
    expect(entry.sha256).toBe(
      createHash("sha256").update(text, "utf-8").digest("hex"),
    );
    // The bounded reader would have excerpted this; the export must not.
    expect(entry.bytes).toBeGreaterThan(HUGE_TOOL_RESULT.length);
  });

  it("keeps full tool input instead of the reader's gist", async () => {
    const entry = await expectEntry(1);
    const text = historyEntryText(entry);
    expect(text).toContain("z".repeat(500));
    expect(text).toContain('"timeout":900');
  });

  it("omits thinking unless it is explicitly requested", async () => {
    const without = await expectEntry(1);
    expect(historyEntryText(without)).not.toContain("first line of reasoning");
    expect(without.thinkingOmitted).toBe(1);

    const withThinking = await expectEntry(1, true);
    expect(withThinking.includeThinking).toBe(true);
    expect(withThinking.thinkingOmitted).toBe(0);
    expect(withThinking.lines).toContain("first line of reasoning");
    expect(withThinking.lines).toContain("second line");
  });

  it("names one image handle for a paired marker and reference", async () => {
    const entry = await expectEntry(4);
    expect(entry.images).toEqual([
      {
        conversationId: "conv-entry",
        seq: 4,
        // The image-bearing block, not the display marker at index 1.
        contentBlockIndex: 2,
        mediaType: "image/png",
        storage: "external",
        command: "cctl conversation image get conv-entry 4 2",
      },
    ]);
  });

  it("identifies a sequence the adapter does not project as an entry", async () => {
    const result = await getEntry(3);
    expect(result).toMatchObject({
      ok: false,
      code: "entry_unsupported",
      seq: 3,
    });
  });

  it("identifies a sequence past the archive", async () => {
    const result = await getEntry(99);
    expect(result).toMatchObject({
      ok: false,
      code: "entry_not_found",
      seq: 99,
    });
  });

  it("refuses a negative sequence", async () => {
    const result = await getEntry(-1);
    expect(result).toMatchObject({ ok: false, code: "entry_not_found" });
  });

  it("reports a missing transcript rather than throwing", async () => {
    _resetTranscriptEntriesCacheForTesting();
    const result = await service.getEntry({
      conversationId: "conv-entry",
      transcriptPath: null,
      seq: 0,
    });
    expect(result).toMatchObject({ ok: false, code: "entry_not_found" });
  });
});

describe("historyEntryTextStream", () => {
  async function collect(entry: HistoryEntry): Promise<string> {
    const decoder = new TextDecoder();
    const reader = historyEntryTextStream(entry).getReader();
    let out = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      out += decoder.decode(chunk.value, { stream: true });
    }
    return out + decoder.decode();
  }

  it("streams exactly the bytes the entry measured", async () => {
    const entry: HistoryEntry = {
      conversationId: "conv-entry",
      seq: 7,
      kind: "message",
      role: "assistant",
      entryId: null,
      timestamp: null,
      messageIndex: 2,
      includeThinking: false,
      thinkingOmitted: 0,
      lines: ["alpha", "beta", "gamma"],
      bytes: Buffer.byteLength("alpha\nbeta\ngamma", "utf-8"),
      sha256: createHash("sha256")
        .update("alpha\nbeta\ngamma", "utf-8")
        .digest("hex"),
      images: [],
    };
    const streamed = await collect(entry);
    expect(streamed).toBe(historyEntryText(entry));
    expect(Buffer.byteLength(streamed, "utf-8")).toBe(entry.bytes);
  });
});

// ==========================================================================
// A manageable entry with an unmanageable number of lines
// ==========================================================================

describe("history entry export of an enormous entry", () => {
  /** Past every engine's spread-argument limit, far under any byte bound. */
  const ENORMOUS_LINE_COUNT = 1_200_000;
  const HUGE_DIR = path.join(TEST_DIR, "enormous");
  let hugePath = "";

  beforeEach(async () => {
    _resetTranscriptEntriesCacheForTesting();
    _resetTranscriptReadCacheForTesting();
    await mkdir(HUGE_DIR, { recursive: true });
    hugePath = path.join(HUGE_DIR, "enormous.jsonl");
    await writeFile(
      hugePath,
      JSON.stringify({
        timestamp: "2024-01-01T00:00:00Z",
        type: "tool_result",
        raw: {
          type: "tool_result",
          tool_use_id: "t-huge",
          content: "abc\n".repeat(ENORMOUS_LINE_COUNT),
        },
      }) + "\n",
      "utf-8",
    );
  });

  afterEach(async () => {
    await rm(HUGE_DIR, { recursive: true, force: true });
  });

  it("returns every line of an entry no spread call could carry", async () => {
    _resetTranscriptEntriesCacheForTesting();
    const result = await service.getEntry({
      conversationId: "conv-entry",
      transcriptPath: hugePath,
      seq: 0,
    });
    if (!result.ok) throw new Error(`expected the entry, got ${result.code}`);
    expect(result.entry.lines).toHaveLength(ENORMOUS_LINE_COUNT + 2);
    expect(result.entry.bytes).toBe(
      Buffer.byteLength(historyEntryText(result.entry), "utf-8"),
    );
  });
});
