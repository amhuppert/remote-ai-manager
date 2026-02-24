import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { MessageContentBlock } from "@/types";

const TEST_DIR = path.join("/tmp", "csm-transcript-images-test-" + Date.now());

vi.mock("./config", () => ({
  getConfigDirPath: () => TEST_DIR,
}));

import {
  saveTranscriptImage,
  readTranscriptImage,
  externalizeImageBlocks,
  resolveImageRefs,
} from "./transcript-images";

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
// saveTranscriptImage
// ==========================================================================

describe("saveTranscriptImage", () => {
  it("saves binary file and returns absolute path", async () => {
    const filePath = await saveTranscriptImage(
      "conv-1",
      0,
      "image/png",
      TINY_PNG_BASE64,
    );

    expect(existsSync(filePath)).toBe(true);
    expect(filePath).toContain("conv-1");
    expect(filePath).toMatch(/0-[a-f0-9]{8}\.png$/);

    // Verify the binary content round-trips correctly
    const buffer = await readFile(filePath);
    expect(buffer.toString("base64")).toBe(TINY_PNG_BASE64);
  });

  it("creates per-conversation images directory", async () => {
    await saveTranscriptImage("conv-new", 0, "image/png", TINY_PNG_BASE64);

    const dir = path.join(TEST_DIR, "transcripts", "images", "conv-new");
    expect(existsSync(dir)).toBe(true);
  });

  it("maps media types to correct extensions", async () => {
    const jpg = await saveTranscriptImage(
      "conv-ext",
      0,
      "image/jpeg",
      TINY_PNG_BASE64,
    );
    const gif = await saveTranscriptImage(
      "conv-ext",
      1,
      "image/gif",
      TINY_PNG_BASE64,
    );
    const webp = await saveTranscriptImage(
      "conv-ext",
      2,
      "image/webp",
      TINY_PNG_BASE64,
    );

    expect(jpg).toMatch(/\.jpg$/);
    expect(gif).toMatch(/\.gif$/);
    expect(webp).toMatch(/\.webp$/);
  });
});

// ==========================================================================
// readTranscriptImage
// ==========================================================================

describe("readTranscriptImage", () => {
  it("reads saved image back as base64", async () => {
    const filePath = await saveTranscriptImage(
      "conv-read",
      0,
      "image/png",
      TINY_PNG_BASE64,
    );

    const result = await readTranscriptImage(filePath);
    expect(result).toBe(TINY_PNG_BASE64);
  });

  it("returns null for non-existent file", async () => {
    const result = await readTranscriptImage("/tmp/does-not-exist.png");
    expect(result).toBeNull();
  });
});

// ==========================================================================
// externalizeImageBlocks
// ==========================================================================

describe("externalizeImageBlocks", () => {
  it("converts image blocks to image_ref blocks", async () => {
    const blocks: MessageContentBlock[] = [
      { type: "text", text: "Look at this:" },
      { type: "image", mediaType: "image/png", base64Data: TINY_PNG_BASE64 },
    ];

    const result = await externalizeImageBlocks("conv-ext", blocks);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: "text", text: "Look at this:" });
    expect(result[1]!.type).toBe("image_ref");
    if (result[1]!.type === "image_ref") {
      expect(result[1]!.mediaType).toBe("image/png");
      expect(result[1]!.imagePath).toMatch(/\.png$/);
      expect(existsSync(result[1]!.imagePath)).toBe(true);
    }
  });

  it("passes through non-image blocks unchanged", async () => {
    const blocks: MessageContentBlock[] = [
      { type: "text", text: "Hello" },
      { type: "tool_use", name: "Read", input: { file_path: "/tmp/x" } },
    ];

    const result = await externalizeImageBlocks("conv-pass", blocks);
    expect(result).toEqual(blocks);
  });

  it("handles multiple images with sequential indices", async () => {
    const blocks: MessageContentBlock[] = [
      { type: "image", mediaType: "image/png", base64Data: TINY_PNG_BASE64 },
      { type: "image", mediaType: "image/jpeg", base64Data: TINY_PNG_BASE64 },
    ];

    const result = await externalizeImageBlocks("conv-multi", blocks);

    expect(result).toHaveLength(2);
    expect(result[0]!.type).toBe("image_ref");
    expect(result[1]!.type).toBe("image_ref");
    if (result[0]!.type === "image_ref" && result[1]!.type === "image_ref") {
      expect(result[0]!.imagePath).toMatch(/^.*0-[a-f0-9]{8}\.png$/);
      expect(result[1]!.imagePath).toMatch(/^.*1-[a-f0-9]{8}\.jpg$/);
    }
  });
});

// ==========================================================================
// resolveImageRefs
// ==========================================================================

describe("resolveImageRefs", () => {
  it("resolves image_ref blocks back to image blocks", async () => {
    const filePath = await saveTranscriptImage(
      "conv-resolve",
      0,
      "image/png",
      TINY_PNG_BASE64,
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

  it("passes through non-image_ref blocks unchanged", async () => {
    const blocks: MessageContentBlock[] = [
      { type: "text", text: "Hello" },
      { type: "image", mediaType: "image/png", base64Data: TINY_PNG_BASE64 },
    ];

    const result = await resolveImageRefs(blocks);
    expect(result).toEqual(blocks);
  });
});

// ==========================================================================
// Round-trip
// ==========================================================================

describe("round-trip: externalize then resolve", () => {
  it("produces original content blocks", async () => {
    const original: MessageContentBlock[] = [
      { type: "text", text: "Check this image:" },
      { type: "image", mediaType: "image/png", base64Data: TINY_PNG_BASE64 },
    ];

    const externalized = await externalizeImageBlocks("conv-rt", original);
    const resolved = await resolveImageRefs(externalized);

    expect(resolved).toEqual(original);
  });
});
