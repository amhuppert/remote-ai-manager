/**
 * Pre-turn step: document-feedback prompt and transcript composition.
 *
 * Hides the decision of how the two send paths carry document feedback:
 *  - Immediate path: the send hook puts the formatted feedback prose in
 *    `promptText` (and `documentFeedback` for the card). The prose is used
 *    as-is, or derived here when no explicit text was supplied.
 *  - Drained queue path (`queuedDelivery` set): the durable queue dropped the
 *    feedback prose at enqueue, so `promptText` is the user's OWN text — a
 *    coalesced batch may pair a normal text message with a feedback message.
 *    Both must reach the agent, so the derived feedback prose is appended to
 *    the user text rather than replacing it.
 *
 * Absent feedback, `effectivePromptText` equals the input prompt text, so
 * non-feedback turns are unchanged.
 */

import { formatDocumentFeedbackPrompt } from "@/lib/document-comments/format-feedback";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
import type { ExecutePromptInput } from "../types";
import { buildUserTranscriptBlocks } from "../build-user-transcript-blocks";
import type { ConversationImageRef } from "@/lib/agent-backends/conversation";

export interface ResolvedTurnPromptText {
  /** The agent-facing prompt text for the turn (feedback prose folded in). */
  effectivePromptText: string;
  /**
   * True when a drained queue batch carries document feedback: the user's own
   * text and the derived feedback prose must BOTH reach the agent and the
   * transcript card records the user text separately.
   */
  isDrainedFeedbackBatch: boolean;
}

/** Compose the agent-facing prompt text for a turn that may carry feedback. */
export function resolveTurnPromptText(input: {
  promptText: string;
  documentFeedback: ExecutePromptInput["documentFeedback"];
  isQueuedDelivery: boolean;
}): ResolvedTurnPromptText {
  const derivedFeedbackText = input.documentFeedback
    ? formatDocumentFeedbackPrompt(input.documentFeedback.items)
    : null;
  const isDrainedFeedbackBatch =
    input.isQueuedDelivery && derivedFeedbackText !== null;
  const hasExplicitPromptText = input.promptText.trim().length > 0;

  if (!derivedFeedbackText) {
    return { effectivePromptText: input.promptText, isDrainedFeedbackBatch };
  }
  if (isDrainedFeedbackBatch) {
    return {
      effectivePromptText: hasExplicitPromptText
        ? `${input.promptText}\n\n${derivedFeedbackText}`
        : derivedFeedbackText,
      isDrainedFeedbackBatch,
    };
  }
  return {
    effectivePromptText: hasExplicitPromptText
      ? input.promptText
      : derivedFeedbackText,
    isDrainedFeedbackBatch,
  };
}

/**
 * Build the user-turn transcript blocks.
 *
 * For a feedback turn the transcript records the structured card. The
 * agent-facing feedback prose is carried separately as the turn's prompt text,
 * so the card-side `rewrittenPromptText` is the user's OWN text only — never
 * the prose. Immediate feedback puts the prose in `promptText`, so the card is
 * recorded alone (empty text). A drained mixed batch carries a distinct user
 * text that is preserved as a text block before the card. Queued feedback
 * content has no inline `[Image #N]` markers, so the raw user text is used
 * directly. Non-feedback turns are unchanged: text+image interleaving, or a
 * single text block, or nothing.
 */
export function composeUserTranscriptBlocks(input: {
  promptText: string;
  effectivePromptText: string;
  rewrittenPromptText: string;
  isDrainedFeedbackBatch: boolean;
  documentFeedback: ExecutePromptInput["documentFeedback"];
  imageRefs: ConversationImageRef[];
}): MessageContentBlock[] {
  const transcriptUserText = input.isDrainedFeedbackBatch
    ? input.promptText
    : "";
  if (input.documentFeedback) {
    return buildUserTranscriptBlocks({
      rewrittenPromptText: transcriptUserText,
      imageRefs: input.imageRefs,
      documentFeedback: input.documentFeedback,
    });
  }
  if (input.imageRefs.length > 0) {
    return buildUserTranscriptBlocks({
      rewrittenPromptText: input.rewrittenPromptText,
      imageRefs: input.imageRefs,
    });
  }
  return input.effectivePromptText
    ? [{ type: "text" as const, text: input.effectivePromptText }]
    : [];
}
