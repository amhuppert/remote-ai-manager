/**
 * Repeated compaction must leave the ORIGINAL archive untouched.
 *
 * Three successive checkpoints are simulated over one real JSONL transcript
 * with a real externalized image file: the transcript bytes, the image bytes,
 * the raw seq coordinates, and `totalMessages` are hashed before the first
 * boundary is projected and compared after the third. Boundaries are metadata,
 * so every one of those must be byte-identical.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  renderCompactTranscript,
  renderOptionsSchema,
  type RenderedTranscript,
} from "./transcript-render";
import type { CheckpointBoundaryInput } from "./history-recovery";
import {
  readTranscriptEntriesWithSeq,
  _resetTranscriptEntriesCacheForTesting,
  _resetTranscriptReadCacheForTesting,
} from "@/lib/prompt/transcript";

const TEST_DIR = path.join(
  "/tmp",
  `cc-history-archive-${process.pid}-${Date.now()}`,
);

/** A real 1x1 PNG, so the image assertion hashes actual image bytes. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function writeArchive(imagePath: string): Promise<string> {
  const filePath = path.join(TEST_DIR, "archive.jsonl");
  const lines = [
    JSON.stringify({
      id: "m-0",
      timestamp: "2024-01-01T00:00:00Z",
      type: "user",
      role: "user",
      content: [{ type: "text", text: "look at this" }],
    }),
    JSON.stringify({
      timestamp: "2024-01-01T00:00:01Z",
      type: "user",
      role: "user",
      content: [
        { type: "image_marker", index: 1, mediaType: "image/png", imagePath },
        { type: "image_ref", mediaType: "image/png", imagePath },
      ],
    }),
    JSON.stringify({
      timestamp: "2024-01-01T00:00:02Z",
      type: "assistant",
      role: "assistant",
      content: [
        { type: "tool_use", name: "Read", input: { file_path: "/a.txt" } },
      ],
    }),
    JSON.stringify({
      timestamp: "2024-01-01T00:00:03Z",
      type: "tool_result",
      raw: {
        type: "tool_result",
        tool_use_id: "t-1",
        content: "q".repeat(2000),
      },
    }),
    JSON.stringify({
      timestamp: "2024-01-01T00:00:04Z",
      type: "user",
      role: "user",
      content: [{ type: "text", text: "and now?" }],
    }),
    JSON.stringify({
      timestamp: "2024-01-01T00:00:05Z",
      type: "assistant",
      role: "assistant",
      content: [{ type: "text", text: "done" }],
    }),
  ];
  await writeFile(filePath, lines.join("\n") + "\n", "utf-8");
  return filePath;
}

/** Boundaries after 1, 2 and 3 checkpoints of the same conversation. */
const CHECKPOINTS: CheckpointBoundaryInput[] = [
  { operationId: "op-1", ordinal: 1, capturedThroughSeq: 1 },
  { operationId: "op-2", ordinal: 2, capturedThroughSeq: 3 },
  { operationId: "op-3", ordinal: 3, capturedThroughSeq: 4 },
];

describe("repeated checkpoints over one archive", () => {
  let transcriptPath = "";
  let imagePath = "";

  beforeEach(async () => {
    _resetTranscriptEntriesCacheForTesting();
    _resetTranscriptReadCacheForTesting();
    await mkdir(TEST_DIR, { recursive: true });
    imagePath = path.join(TEST_DIR, "1.png");
    await writeFile(imagePath, Buffer.from(PNG_BASE64, "base64"));
    transcriptPath = await writeArchive(imagePath);
  });

  afterEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it("preserves JSONL bytes, image bytes, raw seqs and totalMessages", async () => {
    const archiveHashBefore = sha256(await readFile(transcriptPath));
    const imageHashBefore = sha256(await readFile(imagePath));
    const options = renderOptionsSchema.parse({ includeTools: "full" });

    const results: RenderedTranscript[] = [];
    for (let checkpointCount = 1; checkpointCount <= 3; checkpointCount += 1) {
      _resetTranscriptEntriesCacheForTesting();
      const { entries, maxSeq } =
        await readTranscriptEntriesWithSeq(transcriptPath);
      results.push(
        renderCompactTranscript(
          {
            conversationId: "conv-archive",
            entries,
            maxSeq,
            boundaries: CHECKPOINTS.slice(0, checkpointCount),
          },
          options,
        ),
      );
    }
    expect(results).toHaveLength(3);

    const [first, second, third] = results;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(third).toBeDefined();
    if (!first || !second || !third) return;

    // Derived boundaries add no message and move no coordinate.
    expect([first.totalMessages, second.totalMessages, third.totalMessages]) //
      .toEqual([4, 4, 4]);
    expect([first.maxSeq, second.maxSeq, third.maxSeq]).toEqual([5, 5, 5]);
    const seqs = (rendered: RenderedTranscript) =>
      rendered.units.map((unit) => unit.entrySeqs);
    expect(seqs(second)).toEqual(seqs(first));
    expect(seqs(third)).toEqual(seqs(first));
    // Both user entries merge into one logical message; the stored
    // tool_result line folds into the assistant unit keeping its own seq.
    expect(seqs(first)).toEqual([[0, 1], [2, 3], [4], [5]]);
    expect(third.units.map((unit) => unit.ref)).toEqual(
      first.units.map((unit) => unit.ref),
    );

    // Each checkpoint appears exactly once, anchored at its own coordinate.
    expect(third.boundaries.entries).toEqual([
      {
        operationId: "op-1",
        ordinal: 1,
        capturedThroughSeq: 1,
        afterMessageIndex: 0,
        nextSeq: 2,
      },
      {
        operationId: "op-2",
        ordinal: 2,
        capturedThroughSeq: 3,
        afterMessageIndex: 1,
        nextSeq: 4,
      },
      {
        operationId: "op-3",
        ordinal: 3,
        capturedThroughSeq: 4,
        afterMessageIndex: 2,
        nextSeq: 5,
      },
    ]);
    expect(third.boundaries.totalInRange).toBe(3);
    expect(third.boundaries.nextBefore).toBeNull();

    // The archive and its stored image are byte-identical afterwards.
    expect(sha256(await readFile(transcriptPath))).toBe(archiveHashBefore);
    expect(sha256(await readFile(imagePath))).toBe(imageHashBefore);
  });

  it("renders identical lines for every checkpoint of the same archive", async () => {
    const options = renderOptionsSchema.parse({ includeTools: "summary" });
    const renderWith = async (count: number) => {
      _resetTranscriptEntriesCacheForTesting();
      const { entries, maxSeq } =
        await readTranscriptEntriesWithSeq(transcriptPath);
      return renderCompactTranscript(
        {
          conversationId: "conv-archive",
          entries,
          maxSeq,
          boundaries: CHECKPOINTS.slice(0, count),
        },
        options,
      );
    };

    const lines = (await renderWith(1)).units.map((unit) => unit.lines);
    expect((await renderWith(2)).units.map((unit) => unit.lines)).toEqual(
      lines,
    );
    expect((await renderWith(3)).units.map((unit) => unit.lines)).toEqual(
      lines,
    );
    // The image's own coordinate survives: the archive still cites [s1].
    expect(lines[0]).toContain("[s1] [image image/png]");
  });
});
