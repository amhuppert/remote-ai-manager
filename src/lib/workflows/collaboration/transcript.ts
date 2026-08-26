import type { ConversationImageRef } from "@/lib/agent-backends/conversation";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type { TranscriptEntry } from "@/lib/prompt/transcript";

export function buildCollaborationUserTranscriptEntry(input: {
  timestamp: string;
  brief: string;
  imageRefs: readonly ConversationImageRef[];
  modelSelection?: BackendModelSelection;
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
    ...(input.modelSelection !== undefined
      ? {
          modelSelection: {
            modelId: input.modelSelection.modelId,
            parameters: { ...input.modelSelection.parameters },
          },
        }
      : {}),
  };
}
