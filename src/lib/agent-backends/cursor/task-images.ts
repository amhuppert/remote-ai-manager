import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ConversationImageRef } from "../conversation";
import {
  CURSOR_MAX_IMAGES_PER_TURN,
  CURSOR_MAX_IMAGE_DECODED_BYTES,
} from "./image-input";

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export async function loadCursorTaskImages(
  paths: readonly string[],
  signal: AbortSignal,
): Promise<ConversationImageRef[]> {
  if (paths.length > CURSOR_MAX_IMAGES_PER_TURN)
    throw new Error(
      `Cursor accepts at most ${CURSOR_MAX_IMAGES_PER_TURN} task images`,
    );
  return Promise.all(
    paths.map(async (file, index) => {
      const mediaType = MEDIA_TYPES[path.extname(file).toLowerCase()];
      if (!mediaType)
        throw new Error(
          `Cursor task image ${index + 1} has an unsupported format`,
        );
      const info = await stat(file);
      if (!info.isFile() || info.size > CURSOR_MAX_IMAGE_DECODED_BYTES)
        throw new Error(
          `Cursor task image ${index + 1} exceeds the image file bound`,
        );
      const data = await readFile(file, { signal });
      return {
        index: index + 1,
        path: file,
        mediaType,
        base64Data: data.toString("base64"),
      };
    }),
  );
}
