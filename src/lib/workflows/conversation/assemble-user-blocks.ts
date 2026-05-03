import type { ImagePayload, MessageContentBlock } from "@/types";

export interface AssembleUserContentBlocksArgs {
  promptText: string;
  images: readonly ImagePayload[];
  startIndex: number;
}

export interface AssembledImageAssignment {
  attachmentId: string;
  serverIndex: number;
  mediaType: ImagePayload["mediaType"];
}

export interface AssembledUserContent {
  rewrittenPromptText: string;
  blocks: MessageContentBlock[];
  assignments: AssembledImageAssignment[];
}

/**
 * Pure assembly of a turn's user content from a typed prompt and image
 * attachments. Reassigns each image's index to a contiguous server-side
 * sequence starting at `startIndex` (inline images first, in client-order
 * by `inlineMarkerIndex` ascending; then strip-only images in array order),
 * rewrites `[Image #N]` markers in the prompt to use the server indices,
 * and emits an interleaved block sequence: text segments + image blocks
 * at marker positions, followed by strip-only image blocks at the end.
 *
 * Orphan markers (no matching attachment) are left as literal text. An
 * empty prompt with no images produces zero blocks.
 */
export function assembleUserContentBlocks(
  args: AssembleUserContentBlocksArgs,
): AssembledUserContent {
  const { promptText, images, startIndex } = args;

  const inlineImages = images
    .filter((img) => img.inlineMarkerIndex !== undefined)
    .slice()
    .sort((a, b) => {
      const aIdx = a.inlineMarkerIndex as number;
      const bIdx = b.inlineMarkerIndex as number;
      return aIdx - bIdx;
    });
  const stripImages = images.filter(
    (img) => img.inlineMarkerIndex === undefined,
  );

  const assignments: AssembledImageAssignment[] = [];
  const clientToServer = new Map<number, number>();
  const serverIndexToImage = new Map<number, ImagePayload>();

  let nextServerIndex = startIndex;
  for (const img of inlineImages) {
    const serverIndex = nextServerIndex++;
    const clientIndex = img.inlineMarkerIndex as number;
    clientToServer.set(clientIndex, serverIndex);
    serverIndexToImage.set(serverIndex, img);
    assignments.push({
      attachmentId: img.attachmentId,
      serverIndex,
      mediaType: img.mediaType,
    });
  }
  for (const img of stripImages) {
    const serverIndex = nextServerIndex++;
    assignments.push({
      attachmentId: img.attachmentId,
      serverIndex,
      mediaType: img.mediaType,
    });
  }

  const rewrittenPromptText = promptText.replace(
    /\[Image #(\d+)\]/g,
    (match, captured: string) => {
      const clientIdx = Number.parseInt(captured, 10);
      const serverIdx = clientToServer.get(clientIdx);
      if (serverIdx === undefined) return match;
      return `[Image #${serverIdx}]`;
    },
  );

  const blocks: MessageContentBlock[] = [];
  let cursor = 0;

  for (const match of rewrittenPromptText.matchAll(/\[Image #(\d+)\]/g)) {
    const captured = match[1];
    const matchIndex = match.index;
    if (captured === undefined || matchIndex === undefined) continue;
    const serverIdx = Number.parseInt(captured, 10);
    const image = serverIndexToImage.get(serverIdx);
    if (!image) continue;

    if (matchIndex > cursor) {
      blocks.push({
        type: "text",
        text: rewrittenPromptText.slice(cursor, matchIndex),
      });
    }
    blocks.push({
      type: "image",
      mediaType: image.mediaType,
      base64Data: image.base64Data,
    });
    cursor = matchIndex + match[0].length;
  }

  if (cursor < rewrittenPromptText.length) {
    blocks.push({
      type: "text",
      text: rewrittenPromptText.slice(cursor),
    });
  }

  for (const img of stripImages) {
    blocks.push({
      type: "image",
      mediaType: img.mediaType,
      base64Data: img.base64Data,
    });
  }

  return { rewrittenPromptText, blocks, assignments };
}
