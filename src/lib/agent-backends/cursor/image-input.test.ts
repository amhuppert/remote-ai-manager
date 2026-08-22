import { describe, expect, it } from "vitest";

import type { ConversationImageRef } from "../conversation";
import {
  CURSOR_ALLOWED_IMAGE_MEDIA_TYPES,
  CURSOR_MAX_IMAGE_DECODED_BYTES,
  CURSOR_MAX_IMAGES_PER_TURN,
  CURSOR_MAX_TURN_IMAGE_DECODED_BYTES,
  translateCursorImages,
} from "./image-input";

/** Base64 for `decodedBytes` bytes of recognizable, non-secret filler. */
function base64OfSize(decodedBytes: number): string {
  return Buffer.alloc(decodedBytes, 0x41).toString("base64");
}

function imageRef(
  overrides: Partial<ConversationImageRef> = {},
): ConversationImageRef {
  return {
    index: 0,
    mediaType: "image/png",
    path: "/tmp/shot.png",
    base64Data: base64OfSize(16),
    ...overrides,
  };
}

describe("cursor image translation", () => {
  it("translates neutral refs to the SDK base64 image shape in order", () => {
    const result = translateCursorImages([
      imageRef({ index: 0, mediaType: "image/png", base64Data: "AAAA" }),
      imageRef({ index: 1, mediaType: "image/jpeg", base64Data: "BBBB" }),
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images).toStrictEqual([
      { data: "AAAA", mimeType: "image/png" },
      { data: "BBBB", mimeType: "image/jpeg" },
    ]);
  });

  it("accepts a turn with no images", () => {
    const result = translateCursorImages([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.images).toStrictEqual([]);
    expect(result.decodedBytes).toBe(0);
  });

  it("accepts every allowed media type, case-insensitively and normalized", () => {
    for (const mediaType of CURSOR_ALLOWED_IMAGE_MEDIA_TYPES) {
      for (const written of [
        mediaType,
        mediaType.toUpperCase(),
        ` ${mediaType} `,
      ]) {
        const result = translateCursorImages([
          imageRef({ mediaType: written }),
        ]);
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        expect(result.images[0]?.mimeType).toBe(mediaType);
      }
    }
  });

  it("reports the decoded size without decoding into the result", () => {
    const result = translateCursorImages([
      imageRef({ index: 0, base64Data: base64OfSize(1024) }),
      imageRef({ index: 1, base64Data: base64OfSize(2048) }),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decodedBytes).toBe(3072);
  });
});

describe("cursor image bounds", () => {
  it("rejects more than the per-turn image count", () => {
    const refs = Array.from(
      { length: CURSOR_MAX_IMAGES_PER_TURN + 1 },
      (_unused, index) => imageRef({ index }),
    );

    const result = translateCursorImages(refs);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("too_many_images");
    expect(result.message).toContain(String(CURSOR_MAX_IMAGES_PER_TURN));
  });

  it("accepts exactly the per-turn image count", () => {
    const refs = Array.from(
      { length: CURSOR_MAX_IMAGES_PER_TURN },
      (_unused, index) => imageRef({ index }),
    );
    expect(translateCursorImages(refs).ok).toBe(true);
  });

  it("rejects an unsupported media type, naming it", () => {
    for (const mediaType of [
      "image/bmp",
      "image/svg+xml",
      "application/pdf",
      "text/plain",
      "",
    ]) {
      const result = translateCursorImages([imageRef({ index: 2, mediaType })]);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe("unsupported_media_type");
      expect(result.imageIndex).toBe(2);
    }
  });

  it("rejects a single image over the per-image decoded bound", () => {
    const result = translateCursorImages([
      imageRef({
        index: 3,
        base64Data: base64OfSize(CURSOR_MAX_IMAGE_DECODED_BYTES + 1),
      }),
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("image_too_large");
    expect(result.imageIndex).toBe(3);
  });

  it("accepts a single image at exactly the per-image bound", () => {
    const result = translateCursorImages([
      imageRef({ base64Data: base64OfSize(CURSOR_MAX_IMAGE_DECODED_BYTES) }),
    ]);
    expect(result.ok).toBe(true);
  });

  it("rejects a turn over the aggregate decoded bound", () => {
    // Each image is individually legal; only the total exceeds the bound.
    const perImage = CURSOR_MAX_IMAGE_DECODED_BYTES;
    const count =
      Math.floor(CURSOR_MAX_TURN_IMAGE_DECODED_BYTES / perImage) + 1;
    expect(count).toBeLessThanOrEqual(CURSOR_MAX_IMAGES_PER_TURN);

    const result = translateCursorImages(
      Array.from({ length: count }, (_unused, index) =>
        imageRef({ index, base64Data: base64OfSize(perImage) }),
      ),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("turn_images_too_large");
    expect(result.message).toContain(
      String(CURSOR_MAX_TURN_IMAGE_DECODED_BYTES),
    );
  });

  it("rejects malformed base64 data", () => {
    for (const base64Data of ["", "not base64!!", "QUJD===", "QUJDR"]) {
      const result = translateCursorImages([
        imageRef({ index: 1, base64Data }),
      ]);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe("malformed_image_data");
      expect(result.imageIndex).toBe(1);
    }
  });

  it("never echoes image bytes or the source path into an error", () => {
    const marker = "U0VDUkVUSU1BR0VCWVRFUw";
    const result = translateCursorImages([
      imageRef({
        index: 0,
        mediaType: "image/bmp",
        path: "/home/alex/private/secret-screenshot.bmp",
        base64Data: `${marker}${base64OfSize(64)}`,
      }),
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain("secret-screenshot");
    expect(serialized).not.toContain("/home/alex");
  });

  it("reports the bound violated by the first offending image only", () => {
    const result = translateCursorImages([
      imageRef({ index: 0 }),
      imageRef({ index: 1, mediaType: "image/tiff" }),
      imageRef({ index: 2, base64Data: "!!!" }),
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("unsupported_media_type");
    expect(result.imageIndex).toBe(1);
  });

  it("checks the count bound before decoding sizes", () => {
    // An oversized batch must be refused cheaply rather than after measuring
    // every payload in it.
    const refs = Array.from(
      { length: CURSOR_MAX_IMAGES_PER_TURN + 1 },
      (_unused, index) =>
        imageRef({
          index,
          base64Data: base64OfSize(CURSOR_MAX_IMAGE_DECODED_BYTES + 1),
        }),
    );

    const result = translateCursorImages(refs);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("too_many_images");
    expect(result.imageIndex).toBeNull();
  });
});
