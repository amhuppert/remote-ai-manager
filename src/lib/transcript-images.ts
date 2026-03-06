import { writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getConfigDirPath } from "./config";
import type { MessageContentBlock } from "@/types";

// ============================================================
// Path Helpers
// ============================================================

/** Directory for externalized transcript images */
function getImagesDir(conversationId: string, configDir?: string): string {
  return path.join(
    configDir ?? getConfigDirPath(),
    "transcripts",
    "images",
    conversationId,
  );
}

/** Ensure the per-conversation images directory exists */
async function ensureImagesDir(
  conversationId: string,
  configDir?: string,
): Promise<string> {
  const dir = getImagesDir(conversationId, configDir);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

/** Map MIME type to file extension */
function mediaTypeToExtension(mediaType: string): string {
  switch (mediaType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "bin";
  }
}

// ============================================================
// Write Operations
// ============================================================

/**
 * Save a base64-encoded image to disk as a binary file.
 * Returns the absolute path to the saved file.
 */
export async function saveTranscriptImage(
  conversationId: string,
  index: number,
  mediaType: string,
  base64Data: string,
  configDir?: string,
): Promise<string> {
  const dir = await ensureImagesDir(conversationId, configDir);
  const hash = createHash("sha256")
    .update(base64Data)
    .digest("hex")
    .slice(0, 8);
  const ext = mediaTypeToExtension(mediaType);
  const filename = `${index}-${hash}.${ext}`;
  const filePath = path.join(dir, filename);

  const buffer = Buffer.from(base64Data, "base64");
  await writeFile(filePath, buffer);

  return filePath;
}

// ============================================================
// Read Operations
// ============================================================

/**
 * Read an image file from disk and return base64-encoded data.
 * Returns null if the file does not exist.
 */
export async function readTranscriptImage(
  imagePath: string,
): Promise<string | null> {
  if (!existsSync(imagePath)) return null;
  const buffer = await readFile(imagePath);
  return buffer.toString("base64");
}

// ============================================================
// Content Block Conversion
// ============================================================

/**
 * Replace inline `image` blocks with `image_ref` blocks backed by files on disk.
 * Non-image blocks pass through unchanged.
 */
export async function externalizeImageBlocks(
  conversationId: string,
  blocks: MessageContentBlock[],
  configDir?: string,
): Promise<MessageContentBlock[]> {
  const result: MessageContentBlock[] = [];
  let imageIndex = 0;

  for (const block of blocks) {
    if (block.type === "image") {
      const filePath = await saveTranscriptImage(
        conversationId,
        imageIndex++,
        block.mediaType,
        block.base64Data,
        configDir,
      );
      result.push({
        type: "image_ref" as const,
        mediaType: block.mediaType,
        imagePath: filePath,
      });
    } else {
      result.push(block);
    }
  }

  return result;
}

/**
 * Resolve `image_ref` blocks back to inline `image` blocks by reading files from disk.
 * Falls back to a placeholder text block if the file is missing.
 * Blocks of other types pass through unchanged.
 */
export async function resolveImageRefs(
  blocks: MessageContentBlock[],
): Promise<MessageContentBlock[]> {
  const result: MessageContentBlock[] = [];

  for (const block of blocks) {
    if (block.type === "image_ref") {
      const base64Data = await readTranscriptImage(block.imagePath);
      if (base64Data) {
        result.push({
          type: "image" as const,
          mediaType: block.mediaType,
          base64Data,
        });
      } else {
        result.push({
          type: "text" as const,
          text: "[Image unavailable]",
        });
      }
    } else {
      result.push(block);
    }
  }

  return result;
}
