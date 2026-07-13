import { writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { getConfigDirPath } from "../config/loader";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
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

/**
 * Map a known image MIME type to its file extension.
 * Throws on unknown types — callers should validate input via `imageMediaTypeSchema`.
 */
export function mediaTypeToExt(mediaType: string): string {
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
      throw new Error(`Unsupported image media type: ${mediaType}`);
  }
}

// ============================================================
// Write Operations
// ============================================================

/**
 * Save a base64-encoded image to disk as a binary file using a predictable
 * `{N}.{ext}` filename. Returns the absolute path to the saved file.
 */
export async function saveTranscriptImage(
  conversationId: string,
  index: number,
  mediaType: string,
  base64Data: string,
  configDir?: string,
): Promise<string> {
  const dir = await ensureImagesDir(conversationId, configDir);
  const ext = mediaTypeToExt(mediaType);
  const filename = `${index}.${ext}`;
  const filePath = path.join(dir, filename);

  const buffer = Buffer.from(base64Data, "base64");
  await writeFile(filePath, buffer);

  return filePath;
}

export async function saveWorkflowTranscriptImage(
  conversationId: string,
  workflowId: string,
  index: number,
  mediaType: string,
  base64Data: string,
  configDir?: string,
): Promise<string> {
  const dir = await ensureImagesDir(conversationId, configDir);
  const ext = mediaTypeToExt(mediaType);
  const workflowKey = createHash("sha256").update(workflowId).digest("hex");
  const filePath = path.join(dir, `${index}-${workflowKey}.${ext}`);
  await writeFile(filePath, Buffer.from(base64Data, "base64"));
  return filePath;
}

// ============================================================
// Read Operations
// ============================================================

/**
 * Read an image file from disk and return base64-encoded data.
 * Returns null if the file does not exist.
 *
 * Reads any path that exists — including legacy `{N}-{hash}.{ext}` files
 * written before the predictable-naming migration.
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
 * Replace inline `image` blocks with paired `image_marker` + `image_ref`
 * blocks backed by files on disk. Indices are assigned sequentially starting
 * at `startIndex` to support cumulative numbering across a conversation.
 * Non-image blocks pass through unchanged.
 */
export async function externalizeImageBlocks(
  conversationId: string,
  blocks: MessageContentBlock[],
  startIndex: number = 1,
  configDir?: string,
): Promise<MessageContentBlock[]> {
  const result: MessageContentBlock[] = [];
  let nextIndex = startIndex;

  for (const block of blocks) {
    if (block.type === "image") {
      const index = nextIndex++;
      const filePath = await saveTranscriptImage(
        conversationId,
        index,
        block.mediaType,
        block.base64Data,
        configDir,
      );
      result.push({
        type: "image_marker" as const,
        index,
        mediaType: block.mediaType,
        imagePath: filePath,
      });
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
 * Resolve `image_ref` blocks back to inline `image` blocks by reading files
 * from disk. Falls back to a placeholder text block if the file is missing.
 * Blocks of other types (including `image_marker`) pass through unchanged.
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

// ============================================================
// Cumulative Index Calculation
// ============================================================

/**
 * Scan a conversation's JSONL transcript and return the next 1-based image
 * index. Counts every image-bearing content block (`image`, `image_ref`)
 * across all entries — `image_marker` blocks are paired with `image_ref`
 * and would double-count, so they are ignored here.
 *
 * Returns 1 when the transcript file does not exist or contains no images.
 */
export async function getNextImageIndex(
  conversationId: string,
  configDir?: string,
): Promise<number> {
  const filePath = path.join(
    configDir ?? getConfigDirPath(),
    "transcripts",
    `${conversationId}.jsonl`,
  );

  if (!existsSync(filePath)) return 1;

  const raw = await readFile(filePath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);

  let count = 0;
  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const content = (entry as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== "object" || block === null) continue;
      const type = (block as { type?: unknown }).type;
      if (type === "image" || type === "image_ref") {
        count++;
      }
    }
  }

  return count + 1;
}
