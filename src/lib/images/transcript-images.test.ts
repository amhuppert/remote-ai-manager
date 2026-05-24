import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, readFile, writeFile, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
import {
  saveTranscriptImage,
  readTranscriptImage,
  externalizeImageBlocks,
  resolveImageRefs,
  getNextImageIndex,
  mediaTypeToExt,
} from "./transcript-images";

const TEST_DIR = path.join("/tmp", "cc-transcript-images-test-" + Date.now());

// A small 1x1 red PNG encoded as base64
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";

beforeEach(async () => {
  await mkdir(path.join(TEST_DIR, "transcripts"), { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

// ==========================================================================
// mediaTypeToExt
// ==========================================================================

describe("mediaTypeToExt", () => {
  it("maps known image MIME types to extensions", () => {
    expect(mediaTypeToExt("image/jpeg")).toBe("jpg");
    expect(mediaTypeToExt("image/png")).toBe("png");
    expect(mediaTypeToExt("image/gif")).toBe("gif");
    expect(mediaTypeToExt("image/webp")).toBe("webp");
  });

  it("throws on unknown MIME types", () => {
    expect(() => mediaTypeToExt("image/tiff")).toThrow();
    expect(() => mediaTypeToExt("application/octet-stream")).toThrow();
  });
});

// ==========================================================================
// saveTranscriptImage
// ==========================================================================

describe("saveTranscriptImage", () => {
  it("saves binary file with predictable {N}.{ext} name", async () => {
    const filePath = await saveTranscriptImage(
      "conv-1",
      1,
      "image/png",
      TINY_PNG_BASE64,
      TEST_DIR,
    );

    expect(existsSync(filePath)).toBe(true);
    expect(filePath).toContain("conv-1");
    expect(filePath).toMatch(/[/\\]1\.png$/);

    const buffer = await readFile(filePath);
    expect(buffer.toString("base64")).toBe(TINY_PNG_BASE64);
  });

  it("creates per-conversation images directory", async () => {
    await saveTranscriptImage(
      "conv-new",
      1,
      "image/png",
      TINY_PNG_BASE64,
      TEST_DIR,
    );

    const dir = path.join(TEST_DIR, "transcripts", "images", "conv-new");
    expect(existsSync(dir)).toBe(true);
  });

  it("writes correct extension per media type", async () => {
    const jpg = await saveTranscriptImage(
      "conv-ext",
      1,
      "image/jpeg",
      TINY_PNG_BASE64,
      TEST_DIR,
    );
    const gif = await saveTranscriptImage(
      "conv-ext",
      2,
      "image/gif",
      TINY_PNG_BASE64,
      TEST_DIR,
    );
    const webp = await saveTranscriptImage(
      "conv-ext",
      3,
      "image/webp",
      TINY_PNG_BASE64,
      TEST_DIR,
    );

    expect(jpg).toMatch(/[/\\]1\.jpg$/);
    expect(gif).toMatch(/[/\\]2\.gif$/);
    expect(webp).toMatch(/[/\\]3\.webp$/);
  });
});

// ==========================================================================
// readTranscriptImage
// ==========================================================================

describe("readTranscriptImage", () => {
  it("reads saved image back as base64", async () => {
    const filePath = await saveTranscriptImage(
      "conv-read",
      1,
      "image/png",
      TINY_PNG_BASE64,
      TEST_DIR,
    );

    const result = await readTranscriptImage(filePath);
    expect(result).toBe(TINY_PNG_BASE64);
  });

  it("returns null for non-existent file", async () => {
    const result = await readTranscriptImage("/tmp/does-not-exist.png");
    expect(result).toBeNull();
  });

  it("reads legacy {N}-{hash}.{ext} files (lazy compat)", async () => {
    const dir = path.join(TEST_DIR, "transcripts", "images", "conv-legacy");
    await mkdir(dir, { recursive: true });
    const legacyPath = path.join(dir, "0-abcd1234.png");
    await writeFile(legacyPath, Buffer.from(TINY_PNG_BASE64, "base64"));

    const result = await readTranscriptImage(legacyPath);
    expect(result).toBe(TINY_PNG_BASE64);
  });
});

// ==========================================================================
// externalizeImageBlocks
// ==========================================================================

describe("externalizeImageBlocks", () => {
  it("converts each image block to a marker + ref pair with sequential indices", async () => {
    const blocks: MessageContentBlock[] = [
      { type: "text", text: "Look at this:" },
      { type: "image", mediaType: "image/png", base64Data: TINY_PNG_BASE64 },
    ];

    const result = await externalizeImageBlocks(
      "conv-ext",
      blocks,
      1,
      TEST_DIR,
    );

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ type: "text", text: "Look at this:" });
    expect(result[1]!.type).toBe("image_marker");
    expect(result[2]!.type).toBe("image_ref");

    if (result[1]!.type === "image_marker" && result[2]!.type === "image_ref") {
      expect(result[1]!.index).toBe(1);
      expect(result[1]!.mediaType).toBe("image/png");
      expect(result[1]!.imagePath).toMatch(/[/\\]1\.png$/);
      expect(result[2]!.mediaType).toBe("image/png");
      expect(result[2]!.imagePath).toBe(result[1]!.imagePath);
      expect(existsSync(result[2]!.imagePath)).toBe(true);
    }
  });

  it("respects startIndex (cumulative numbering)", async () => {
    const blocks: MessageContentBlock[] = [
      { type: "image", mediaType: "image/png", base64Data: TINY_PNG_BASE64 },
      { type: "image", mediaType: "image/jpeg", base64Data: TINY_PNG_BASE64 },
    ];

    const result = await externalizeImageBlocks(
      "conv-cum",
      blocks,
      5,
      TEST_DIR,
    );

    expect(result).toHaveLength(4);
    if (
      result[0]!.type === "image_marker" &&
      result[1]!.type === "image_ref" &&
      result[2]!.type === "image_marker" &&
      result[3]!.type === "image_ref"
    ) {
      expect(result[0]!.index).toBe(5);
      expect(result[0]!.imagePath).toMatch(/[/\\]5\.png$/);
      expect(result[1]!.imagePath).toBe(result[0]!.imagePath);
      expect(result[2]!.index).toBe(6);
      expect(result[2]!.imagePath).toMatch(/[/\\]6\.jpg$/);
      expect(result[3]!.imagePath).toBe(result[2]!.imagePath);
    }
  });

  it("passes through non-image blocks unchanged", async () => {
    const blocks: MessageContentBlock[] = [
      { type: "text", text: "Hello" },
      { type: "tool_use", name: "Read", input: { file_path: "/tmp/x" } },
    ];

    const result = await externalizeImageBlocks(
      "conv-pass",
      blocks,
      1,
      TEST_DIR,
    );
    expect(result).toEqual(blocks);
  });

  it("preserves pre-existing image_marker blocks alongside images", async () => {
    const blocks: MessageContentBlock[] = [
      { type: "text", text: "first " },
      { type: "image", mediaType: "image/png", base64Data: TINY_PNG_BASE64 },
      { type: "text", text: " second" },
    ];

    const result = await externalizeImageBlocks(
      "conv-mix",
      blocks,
      3,
      TEST_DIR,
    );

    expect(result).toHaveLength(4);
    expect(result[0]).toEqual({ type: "text", text: "first " });
    expect(result[1]!.type).toBe("image_marker");
    expect(result[2]!.type).toBe("image_ref");
    expect(result[3]).toEqual({ type: "text", text: " second" });
  });
});

// ==========================================================================
// resolveImageRefs
// ==========================================================================

describe("resolveImageRefs", () => {
  it("resolves image_ref blocks back to image blocks", async () => {
    const filePath = await saveTranscriptImage(
      "conv-resolve",
      1,
      "image/png",
      TINY_PNG_BASE64,
      TEST_DIR,
    );

    const blocks: MessageContentBlock[] = [
      { type: "image_ref", mediaType: "image/png", imagePath: filePath },
    ];

    const result = await resolveImageRefs(blocks);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "image",
      mediaType: "image/png",
      base64Data: TINY_PNG_BASE64,
    });
  });

  it("resolves legacy {N}-{hash}.{ext} image_ref paths", async () => {
    const dir = path.join(TEST_DIR, "transcripts", "images", "conv-legacy");
    await mkdir(dir, { recursive: true });
    const legacyPath = path.join(dir, "2-deadbeef.png");
    await writeFile(legacyPath, Buffer.from(TINY_PNG_BASE64, "base64"));

    const blocks: MessageContentBlock[] = [
      { type: "image_ref", mediaType: "image/png", imagePath: legacyPath },
    ];

    const result = await resolveImageRefs(blocks);
    expect(result[0]).toEqual({
      type: "image",
      mediaType: "image/png",
      base64Data: TINY_PNG_BASE64,
    });
  });

  it("degrades gracefully for missing files", async () => {
    const blocks: MessageContentBlock[] = [
      {
        type: "image_ref",
        mediaType: "image/png",
        imagePath: "/tmp/missing-image.png",
      },
    ];

    const result = await resolveImageRefs(blocks);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "text",
      text: "[Image unavailable]",
    });
  });

  it("passes through non-image_ref blocks unchanged (including image_marker)", async () => {
    const blocks: MessageContentBlock[] = [
      { type: "text", text: "Hello" },
      {
        type: "image_marker",
        index: 1,
        mediaType: "image/png",
        imagePath: "/tmp/whatever.png",
      },
    ];

    const result = await resolveImageRefs(blocks);
    expect(result).toEqual(blocks);
  });
});

// ==========================================================================
// getNextImageIndex
// ==========================================================================

describe("getNextImageIndex", () => {
  async function writeTranscriptLine(
    conversationId: string,
    entry: Record<string, unknown>,
  ): Promise<void> {
    const dir = path.join(TEST_DIR, "transcripts");
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${conversationId}.jsonl`);
    const line = JSON.stringify(entry) + "\n";
    const existing = existsSync(filePath)
      ? await readFile(filePath, "utf-8")
      : "";
    await writeFile(filePath, existing + line, "utf-8");
  }

  it("returns 1 for an empty conversation", async () => {
    const next = await getNextImageIndex("conv-empty", TEST_DIR);
    expect(next).toBe(1);
  });

  it("returns 1 when transcript has no image blocks", async () => {
    await writeTranscriptLine("conv-text", {
      timestamp: "2026-01-01T00:00:00Z",
      type: "user",
      role: "user",
      content: [{ type: "text", text: "hello" }],
    });

    const next = await getNextImageIndex("conv-text", TEST_DIR);
    expect(next).toBe(1);
  });

  it("counts image_ref blocks across messages", async () => {
    await writeTranscriptLine("conv-refs", {
      timestamp: "2026-01-01T00:00:00Z",
      type: "user",
      role: "user",
      content: [
        { type: "text", text: "look" },
        {
          type: "image_marker",
          index: 1,
          mediaType: "image/png",
          imagePath: "/x/1.png",
        },
        { type: "image_ref", mediaType: "image/png", imagePath: "/x/1.png" },
      ],
    });
    await writeTranscriptLine("conv-refs", {
      timestamp: "2026-01-01T00:01:00Z",
      type: "user",
      role: "user",
      content: [
        {
          type: "image_marker",
          index: 2,
          mediaType: "image/png",
          imagePath: "/x/2.png",
        },
        { type: "image_ref", mediaType: "image/png", imagePath: "/x/2.png" },
      ],
    });

    const next = await getNextImageIndex("conv-refs", TEST_DIR);
    expect(next).toBe(3);
  });

  it("counts inline image blocks (legacy transcripts without externalization)", async () => {
    await writeTranscriptLine("conv-inline", {
      timestamp: "2026-01-01T00:00:00Z",
      type: "user",
      role: "user",
      content: [
        { type: "image", mediaType: "image/png", base64Data: "abc" },
        { type: "image", mediaType: "image/png", base64Data: "def" },
      ],
    });

    const next = await getNextImageIndex("conv-inline", TEST_DIR);
    expect(next).toBe(3);
  });
});

// ==========================================================================
// Round-trip
// ==========================================================================

describe("round-trip: externalize then resolve", () => {
  it("preserves image content; image_marker is added (not in original)", async () => {
    const original: MessageContentBlock[] = [
      { type: "text", text: "Check this image:" },
      { type: "image", mediaType: "image/png", base64Data: TINY_PNG_BASE64 },
    ];

    const externalized = await externalizeImageBlocks(
      "conv-rt",
      original,
      1,
      TEST_DIR,
    );
    const resolved = await resolveImageRefs(externalized);

    expect(resolved).toHaveLength(3);
    expect(resolved[0]).toEqual({ type: "text", text: "Check this image:" });
    expect(resolved[1]!.type).toBe("image_marker");
    expect(resolved[2]).toEqual({
      type: "image",
      mediaType: "image/png",
      base64Data: TINY_PNG_BASE64,
    });
  });
});

// Suppress unused-import warning
void copyFile;
