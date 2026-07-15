import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { MessageContentBlock } from "@/lib/conversations/message-content-schemas";
import {
  getTranscriptPath,
  readLastAssistantContent,
} from "@/lib/prompt/transcript";

const logger = createLogger("workflow-rotation-handoff");

/**
 * Ceiling on the handoff note injected into a rotation seed. The context-limit
 * stop instruction asks for a note, not a report; the cap keeps a runaway
 * final message from bloating the fresh conversation's opening prompt.
 */
export const HANDOFF_NOTE_MAX_CHARS = 6_000;

const TRUNCATION_MARKER = "\n\n[handoff truncated]";

/**
 * Distill a conversation's final assistant content into the handoff note a
 * rotation seed carries: the text blocks only (no thinking or tool chatter),
 * joined in order, trimmed, and capped at `maxChars`. Head-truncation keeps
 * the note's structure — agents lead with completions and lessons.
 */
export function extractHandoffNote(
  blocks: MessageContentBlock[] | null,
  maxChars: number = HANDOFF_NOTE_MAX_CHARS,
): string | null {
  if (!blocks || blocks.length === 0) {
    return null;
  }
  const text = blocks
    .filter(
      (block): block is Extract<MessageContentBlock, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n\n")
    .trim();
  if (text.length === 0) {
    return null;
  }
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars) + TRUNCATION_MARKER;
}

/**
 * Production loader for `WorkflowContinuityServiceDeps.loadRotationHandoff`:
 * tail-reads the retiring conversation's transcript for its final assistant
 * message. Returns null (never throws) on any miss so rotation proceeds
 * without a handoff rather than failing.
 */
export async function loadRotationHandoffNote(
  conversationId: string,
): Promise<string | null> {
  try {
    const transcriptPath = await getTranscriptPath(conversationId);
    const blocks = await readLastAssistantContent(transcriptPath);
    const note = extractHandoffNote(blocks);
    logger.debug("rotation_handoff.extracted", {
      conversationId,
      found: note !== null,
      noteLength: note?.length ?? 0,
    });
    return note;
  } catch (error) {
    logger.warn("rotation_handoff.read_failed", {
      conversationId,
      error: getErrorMessage(error),
    });
    return null;
  }
}
