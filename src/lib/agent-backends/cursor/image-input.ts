import type { ConversationImageRef } from "../conversation";

/**
 * Cursor image input (spec D15): translates the neutral `ConversationImageRef`
 * turn inputs into the SDK's base64 user-message image shape, enforcing named
 * bounds before any worker turn starts — so an oversized or unsupported image
 * is a bounded client error rather than a billable turn that fails inside the
 * provider.
 *
 * Errors carry the offending image's position and the bound it broke. They
 * never carry image bytes or the source path: an error is logged and persisted,
 * and neither belongs in that record.
 */

export const CURSOR_ALLOWED_IMAGE_MEDIA_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

/** Matches the existing composer cap. */
export const CURSOR_MAX_IMAGES_PER_TURN = 5;
export const CURSOR_MAX_IMAGE_DECODED_BYTES = 5 * 1024 * 1024;
export const CURSOR_MAX_TURN_IMAGE_DECODED_BYTES = 20 * 1024 * 1024;

export type CursorImageFailureCode =
  | "too_many_images"
  | "unsupported_media_type"
  | "malformed_image_data"
  | "image_too_large"
  | "turn_images_too_large";

/** The SDK's `SDKImage` base64 arm. */
export interface CursorSdkImage {
  data: string;
  mimeType: string;
}

export type CursorImageTranslationResult =
  | { ok: true; images: readonly CursorSdkImage[]; decodedBytes: number }
  | {
      ok: false;
      code: CursorImageFailureCode;
      message: string;
      /** Null when the violation is a property of the turn, not one image. */
      imageIndex: number | null;
    };

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decoded length computed from the encoded length rather than by decoding: a
 * payload is rejected for being too large without ever materializing it.
 * Returns null when the input is not well-formed base64.
 */
function decodedByteLength(base64Data: string): number | null {
  if (base64Data.length === 0) return null;
  if (base64Data.length % 4 !== 0) return null;
  if (!BASE64_PATTERN.test(base64Data)) return null;

  const padding = base64Data.endsWith("==")
    ? 2
    : base64Data.endsWith("=")
      ? 1
      : 0;
  return (base64Data.length / 4) * 3 - padding;
}

function normalizeMediaType(mediaType: string): string {
  return mediaType.trim().toLowerCase();
}

function failure(
  code: CursorImageFailureCode,
  message: string,
  imageIndex: number | null,
): CursorImageTranslationResult {
  return { ok: false, code, message, imageIndex };
}

export function translateCursorImages(
  imageRefs: readonly ConversationImageRef[],
): CursorImageTranslationResult {
  // Count first: an oversized batch is refused without measuring every payload.
  if (imageRefs.length > CURSOR_MAX_IMAGES_PER_TURN) {
    return failure(
      "too_many_images",
      `A Cursor turn accepts at most ${CURSOR_MAX_IMAGES_PER_TURN} images; this turn has ${imageRefs.length}.`,
      null,
    );
  }

  const images: CursorSdkImage[] = [];
  let decodedBytes = 0;

  for (const imageRef of imageRefs) {
    const mimeType = normalizeMediaType(imageRef.mediaType);
    if (!CURSOR_ALLOWED_IMAGE_MEDIA_TYPES.includes(mimeType)) {
      return failure(
        "unsupported_media_type",
        `Cursor accepts ${CURSOR_ALLOWED_IMAGE_MEDIA_TYPES.join(", ")}; image ${imageRef.index} is ${mimeType.length > 0 ? mimeType : "untyped"}.`,
        imageRef.index,
      );
    }

    const size = decodedByteLength(imageRef.base64Data);
    if (size === null) {
      return failure(
        "malformed_image_data",
        `Image ${imageRef.index} is not valid base64 data.`,
        imageRef.index,
      );
    }
    if (size > CURSOR_MAX_IMAGE_DECODED_BYTES) {
      return failure(
        "image_too_large",
        `Image ${imageRef.index} decodes to ${size} bytes, over the ${CURSOR_MAX_IMAGE_DECODED_BYTES} byte per-image limit.`,
        imageRef.index,
      );
    }

    decodedBytes += size;
    if (decodedBytes > CURSOR_MAX_TURN_IMAGE_DECODED_BYTES) {
      return failure(
        "turn_images_too_large",
        `This turn's images decode to more than the ${CURSOR_MAX_TURN_IMAGE_DECODED_BYTES} byte per-turn limit.`,
        imageRef.index,
      );
    }

    images.push({ data: imageRef.base64Data, mimeType });
  }

  return { ok: true, images, decodedBytes };
}
