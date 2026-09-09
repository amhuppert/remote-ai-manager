import { describe, it, expect } from "vitest";

import type { MessageContentBlock } from "./schemas";
import {
  MAX_RANGE_BOUNDARIES,
  type ReaderDetailLevel,
  checkpointListCommand,
  entryGetCommand,
  imageGetCommand,
  projectRangeBoundaries,
  readSeqRangeCommand,
  historyImageHandles,
  savedCheckpointBoundaries,
  transcriptBoundariesSchema,
  type BoundaryAnchorUnit,
  type CheckpointBoundaryInput,
} from "./history-recovery";

function unit(messageIndex: number, entrySeqs: number[]): BoundaryAnchorUnit {
  return { messageIndex, entrySeqs };
}

function boundary(
  ordinal: number,
  capturedThroughSeq: number,
): CheckpointBoundaryInput {
  return { operationId: `op-${ordinal}`, ordinal, capturedThroughSeq };
}

// Three units spanning seqs 0..5, the shape a two-checkpoint conversation has.
const UNITS: BoundaryAnchorUnit[] = [
  unit(0, [0, 1]),
  unit(1, [2, 3]),
  unit(2, [4, 5]),
];

function project(
  boundaries: CheckpointBoundaryInput[],
  units: BoundaryAnchorUnit[] = UNITS,
) {
  return projectRangeBoundaries({
    conversationId: "conv-1",
    boundaries,
    units,
  });
}

describe("recovery commands", () => {
  it("names an entry, an image, a seq range and the checkpoint index", () => {
    expect(entryGetCommand("conv-1", 42)).toBe(
      "cctl conversation entry get conv-1 42",
    );
    expect(imageGetCommand("conv-1", 42, 3)).toBe(
      "cctl conversation image get conv-1 42 3",
    );
    expect(readSeqRangeCommand("conv-1", 7, 19)).toBe(
      "cctl conversation read conv-1 --seq-range 7:19",
    );
    expect(checkpointListCommand("conv-1", 4)).toBe(
      "cctl conversation checkpoint list conv-1 --before 4",
    );
  });

  it("carries the reader's thinking opt-in into the entry it names", () => {
    // Following a recovery command for a TRUNCATED thinking excerpt must not
    // silently drop the thinking: the export defaults it off.
    expect(entryGetCommand("conv-1", 42, { includeThinking: true })).toBe(
      "cctl conversation entry get conv-1 42 --include-thinking",
    );
    expect(entryGetCommand("conv-1", 42, { includeThinking: false })).toBe(
      "cctl conversation entry get conv-1 42",
    );
  });

  it("never carries a reader-only tool level into an entry export", () => {
    // A complete export always returns full tools, so --include-tools has no
    // meaning there. The renderer passes ONE level object to both command
    // builders, so the entry builder must ignore the extra property at
    // runtime rather than rely on its parameter type to remove it.
    const level: ReaderDetailLevel = {
      includeThinking: true,
      includeTools: "full",
    };
    expect(entryGetCommand("conv-1", 42, level)).toBe(
      "cctl conversation entry get conv-1 42 --include-thinking",
    );
    const quiet: ReaderDetailLevel = {
      includeThinking: false,
      includeTools: "none",
    };
    expect(entryGetCommand("conv-1", 42, quiet)).toBe(
      "cctl conversation entry get conv-1 42",
    );
  });

  it("carries the reader's detail level into the range it names", () => {
    expect(
      readSeqRangeCommand("conv-1", 7, 19, {
        includeThinking: true,
        includeTools: "full",
      }),
    ).toBe(
      "cctl conversation read conv-1 --seq-range 7:19 --include-tools full --include-thinking",
    );
    expect(
      readSeqRangeCommand("conv-1", 7, 19, {
        includeThinking: false,
        includeTools: "none",
      }),
    ).toBe(
      "cctl conversation read conv-1 --seq-range 7:19 --include-tools none",
    );
    // The reader's own default needs no flag to reproduce.
    expect(
      readSeqRangeCommand("conv-1", 7, 19, {
        includeThinking: false,
        includeTools: "summary",
      }),
    ).toBe("cctl conversation read conv-1 --seq-range 7:19");
  });

  it("addresses a conversation by id alone, with no session path", () => {
    for (const command of [
      entryGetCommand("conv-1", 1),
      imageGetCommand("conv-1", 1, 0),
      readSeqRangeCommand("conv-1", 1, 2),
      checkpointListCommand("conv-1", 2),
    ]) {
      expect(command).not.toContain("/sessions/");
      expect(command).not.toContain("__project__");
    }
  });
});

describe("projectRangeBoundaries", () => {
  it("anchors a boundary between the units its divider separates", () => {
    const projected = project([boundary(1, 3)]);
    expect(transcriptBoundariesSchema.parse(projected)).toEqual(projected);
    expect(projected.entries).toEqual([
      {
        operationId: "op-1",
        ordinal: 1,
        capturedThroughSeq: 3,
        afterMessageIndex: 1,
        nextSeq: 4,
      },
    ]);
    expect(projected.totalInRange).toBe(1);
    expect(projected.nextBefore).toBeNull();
    expect(projected.indexCommand).toBeNull();
  });

  it("anchors a divider inside a merged unit at its own coordinates", () => {
    const [entry] = project([boundary(1, 2)]).entries;
    expect(entry).toMatchObject({ afterMessageIndex: 1, nextSeq: 3 });
  });

  it("reports no following coordinate for a boundary at the range end", () => {
    const [entry] = project([boundary(1, 5)]).entries;
    expect(entry).toMatchObject({ afterMessageIndex: 2, nextSeq: null });
  });

  it("keeps a boundary whose divider opens the rendered range", () => {
    const projected = project([boundary(1, 9)], [unit(0, [10, 11])]);
    expect(projected.entries).toEqual([
      {
        operationId: "op-1",
        ordinal: 1,
        capturedThroughSeq: 9,
        afterMessageIndex: null,
        nextSeq: 10,
      },
    ]);
  });

  it("drops boundaries whose divider falls outside the rendered range", () => {
    const projected = project(
      [boundary(1, 3), boundary(2, 20)],
      [unit(0, [10, 11])],
    );
    expect(projected).toEqual({
      entries: [],
      totalInRange: 0,
      nextBefore: null,
      indexCommand: null,
    });
  });

  it("orders entries by ordinal regardless of input order", () => {
    const projected = project([boundary(3, 5), boundary(1, 1), boundary(2, 3)]);
    expect(projected.entries.map((e) => e.ordinal)).toEqual([1, 2, 3]);
  });

  it("caps at eight and hands the rest a checkpoint-index cursor", () => {
    const many = Array.from({ length: 11 }, (_, index) =>
      boundary(index + 1, index),
    );
    const projected = project(
      many,
      Array.from({ length: 11 }, (_, index) => unit(index, [index])),
    );

    expect(projected.entries).toHaveLength(MAX_RANGE_BOUNDARIES);
    // The newest boundaries are kept: they are the ones adjacent to the range.
    expect(projected.entries.map((e) => e.ordinal)).toEqual([
      4, 5, 6, 7, 8, 9, 10, 11,
    ]);
    expect(projected.totalInRange).toBe(11);
    expect(projected.nextBefore).toBe(4);
    expect(projected.indexCommand).toBe(
      "cctl conversation checkpoint list conv-1 --before 4",
    );
  });

  it("returns nothing when the read rendered no units", () => {
    expect(project([boundary(1, 0)], [])).toEqual({
      entries: [],
      totalInRange: 0,
      nextBefore: null,
      indexCommand: null,
    });
  });
});

describe("savedCheckpointBoundaries", () => {
  it("keeps only the operations that froze a payload", () => {
    expect(
      savedCheckpointBoundaries([
        {
          operationId: "op-1",
          ordinal: 1,
          boundary: { capturedThroughSeq: 4 },
          checkpoint: { seedSha256: "abc" },
        },
        {
          operationId: "op-2",
          ordinal: 2,
          boundary: { capturedThroughSeq: 9 },
          checkpoint: null,
        },
      ]),
    ).toEqual([{ operationId: "op-1", ordinal: 1, capturedThroughSeq: 4 }]);
  });
});

describe("historyImageHandles", () => {
  function handles(content: MessageContentBlock[]) {
    return historyImageHandles({
      conversationId: "conv-1",
      seq: 12,
      content,
    });
  }

  it("addresses an inline image at its own block index", () => {
    expect(
      handles([
        { type: "text", text: "look" },
        { type: "image", mediaType: "image/png", base64Data: "AAAA" },
      ]),
    ).toEqual([
      {
        conversationId: "conv-1",
        seq: 12,
        contentBlockIndex: 1,
        mediaType: "image/png",
        storage: "inline",
        command: "cctl conversation image get conv-1 12 1",
      },
    ]);
  });

  it("collapses a marker and its reference into one image-bearing handle", () => {
    const result = handles([
      {
        type: "image_marker",
        index: 1,
        mediaType: "image/jpeg",
        imagePath: "/store/1.jpg",
      },
      {
        type: "image_ref",
        mediaType: "image/jpeg",
        imagePath: "/store/1.jpg",
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      contentBlockIndex: 1,
      storage: "external",
    });
  });

  it("still addresses a marker that has no paired reference", () => {
    const result = handles([
      {
        type: "image_marker",
        index: 1,
        mediaType: "image/png",
        imagePath: "/store/1.png",
      },
      { type: "text", text: "after" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ contentBlockIndex: 0 });
  });

  it("numbers two images in one entry by their own block indexes", () => {
    const result = handles([
      { type: "image", mediaType: "image/png", base64Data: "AAAA" },
      { type: "text", text: "and" },
      { type: "image", mediaType: "image/webp", base64Data: "BBBB" },
    ]);
    expect(result.map((handle) => handle.contentBlockIndex)).toEqual([0, 2]);
  });

  it("names no handle for an entry without images", () => {
    expect(
      handles([
        { type: "text", text: "plain" },
        { type: "tool_use", name: "Read", input: { file_path: "/a" } },
      ]),
    ).toEqual([]);
  });
});
