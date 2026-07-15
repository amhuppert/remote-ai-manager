/**
 * Pre-turn step: server-side image indexing and persistence.
 *
 * Hides the decision that image identity is the server-assigned cumulative
 * index, not the client attachment id: the transcript is scanned for the
 * cumulative count, inline+strip images are assembled into a coherent block
 * sequence with rewritten `[Image #N]` markers, and each image is persisted
 * to disk by serverIndex BEFORE dispatch so the backend (and downstream
 * readers) can refer to it by path.
 */

import type { ConversationImageRef } from "@/lib/agent-backends/conversation";
import type { ImagePayload } from "@/lib/images/schemas";
import {
  assembleUserContentBlocks,
  type AssembledUserContent,
} from "../assemble-user-blocks";

export interface ImagePersistenceDeps {
  getNextImageIndex(conversationId: string): Promise<number>;
  saveTranscriptImage(
    conversationId: string,
    index: number,
    mediaType: string,
    base64Data: string,
  ): Promise<string>;
}

export interface PersistedTurnImages {
  assembled: AssembledUserContent;
  imageRefs: ConversationImageRef[];
}

/** Assemble user content blocks and persist each image by server index. */
export async function persistTurnImages(
  deps: ImagePersistenceDeps,
  input: {
    conversationId: string;
    promptText: string;
    images: ImagePayload[];
  },
): Promise<PersistedTurnImages> {
  const startIndex =
    input.images.length > 0
      ? await deps.getNextImageIndex(input.conversationId)
      : 1;

  const assembled = assembleUserContentBlocks({
    promptText: input.promptText,
    images: input.images,
    startIndex,
  });

  const imagesByAttachmentId = new Map<string, ImagePayload>(
    input.images.map((img) => [img.attachmentId, img]),
  );

  const imageRefs: ConversationImageRef[] = [];
  for (const assignment of assembled.assignments) {
    const image = imagesByAttachmentId.get(assignment.attachmentId);
    if (!image) continue;
    const persistedPath = await deps.saveTranscriptImage(
      input.conversationId,
      assignment.serverIndex,
      assignment.mediaType,
      image.base64Data,
    );
    imageRefs.push({
      index: assignment.serverIndex,
      mediaType: assignment.mediaType,
      path: persistedPath,
      base64Data: image.base64Data,
    });
  }

  return { assembled, imageRefs };
}
