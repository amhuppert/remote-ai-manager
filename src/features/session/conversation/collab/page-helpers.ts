import { isCollabTriggerMessage } from "@/features/session/conversation/conversation-rows";
import type { CollaborationArtifact } from "@/lib/workflows/collaboration/types";
import type { TranscriptMessage } from "@/lib/conversations/schemas";

export const COLLAB_RUNNING_TOOLTIP =
  "collaboration in progress \u00b7 stop the run to continue";

export interface CollabEnvelopeLike {
  status: "running" | "paused" | "completed" | "failed";
  featureSnapshot: unknown;
}

export function findActiveCollab<T extends CollabEnvelopeLike>(
  envelopes: readonly T[] | undefined,
  conversationId: string,
): T | undefined {
  if (!envelopes) return undefined;
  return envelopes.find((envelope) => {
    if (envelope.status !== "running" && envelope.status !== "paused") {
      return false;
    }
    const snapshot = envelope.featureSnapshot;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      return false;
    }
    return (
      (snapshot as Record<string, unknown>)["conversationId"] === conversationId
    );
  });
}

export function findCollabEnvelopeForConversation<T extends CollabEnvelopeLike>(
  envelopes: readonly T[] | undefined,
  conversationId: string,
): T | undefined {
  if (!envelopes) return undefined;
  const matching = envelopes.filter((envelope) => {
    const snapshot = envelope.featureSnapshot;
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      return false;
    }
    return (
      (snapshot as Record<string, unknown>)["conversationId"] === conversationId
    );
  });
  if (matching.length === 0) return undefined;
  const active = matching.find(
    (envelope) => envelope.status === "running" || envelope.status === "paused",
  );
  return active ?? matching.at(-1);
}

function transcriptText(message: TranscriptMessage): string | null {
  return (
    message.content.find(
      (block): block is { type: "text"; text: string } => block.type === "text",
    )?.text ?? null
  );
}

export function latestFinalAnswerText(
  artifacts: readonly CollaborationArtifact[],
): string | null {
  void artifacts;
  return null;
}

export function findCollabFinalDuplicateIndex(
  messages: readonly TranscriptMessage[],
  finalAnswerText: string | null,
): number | null {
  if (!finalAnswerText) return null;
  const normalizedFinal = finalAnswerText.trim();
  if (normalizedFinal.length === 0) return null;

  let latestCollabUserIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "user") continue;
    if (isCollabTriggerMessage(message)) {
      latestCollabUserIndex = i;
      break;
    }
  }
  if (latestCollabUserIndex === -1) return null;

  const duplicateIndex = messages.findIndex((message, index) => {
    if (index <= latestCollabUserIndex || message.role !== "assistant") {
      return false;
    }
    return transcriptText(message)?.trim() === normalizedFinal;
  });
  return duplicateIndex === -1 ? null : duplicateIndex;
}
