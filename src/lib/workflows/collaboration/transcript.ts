import type { ConversationImageRef } from "@/lib/agent-backends/conversation";
import type { TranscriptEntry } from "@/lib/prompt/transcript";

export function buildCollaborationUserTranscriptEntry(input: {
  timestamp: string;
  brief: string;
  imageRefs: readonly ConversationImageRef[];
  modelId?: string;
  effort?: string;
  id?: string;
}): TranscriptEntry {
  return {
    ...(input.id !== undefined ? { id: input.id } : {}),
    timestamp: input.timestamp,
    type: "user",
    role: "user",
    content: [
      { type: "text", text: `/collab ${input.brief}` },
      ...input.imageRefs.map((image) => ({
        type: "image_ref" as const,
        mediaType: image.mediaType,
        imagePath: image.path,
      })),
    ],
    ...(input.modelId !== undefined ? { model: input.modelId } : {}),
    ...(input.effort !== undefined ? { effort: input.effort } : {}),
  };
}
