/**
 * Pre-turn step: review-feedback prompt and transcript composition.
 *
 * Owns ONE decision for both review loops — document comments and notepad
 * comment dispatches — because both answer it identically and a turn can carry
 * either or both. The two payloads stay separately named end to end rather than
 * collapsing into a discriminated feedback-source union (D18): each keeps its
 * own identity, and only the durable-vs-delivered rule is shared.
 *
 * Hides the decision of how the two send paths carry feedback:
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
import { formatNotepadFeedbackPrompt } from "@/lib/notepads/format-feedback";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
import type { ConversationTurnSpec } from "../turn-spec";
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

/**
 * Derive the agent-facing prose for whichever review payloads the turn carries.
 * Null when it carries none. Several notepad dispatches can coalesce into one
 * drained batch, so each keeps its own fragment rather than being merged.
 */
function deriveFeedbackText(input: {
  documentFeedback: ConversationTurnSpec["documentFeedback"];
  notepadFeedback: ConversationTurnSpec["notepadFeedback"];
}): string | null {
  const fragments = [
    ...(input.documentFeedback
      ? [formatDocumentFeedbackPrompt(input.documentFeedback.items)]
      : []),
    ...(input.notepadFeedback ?? []).map(formatNotepadFeedbackPrompt),
  ];
  return fragments.length > 0 ? fragments.join("\n\n") : null;
}

/** Compose the agent-facing prompt text for a turn that may carry feedback. */
export function resolveTurnPromptText(input: {
  promptText: string;
  documentFeedback?: ConversationTurnSpec["documentFeedback"];
  notepadFeedback?: ConversationTurnSpec["notepadFeedback"];
  isQueuedDelivery: boolean;
}): ResolvedTurnPromptText {
  const derivedFeedbackText = deriveFeedbackText({
    documentFeedback: input.documentFeedback,
    notepadFeedback: input.notepadFeedback,
  });
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
  documentFeedback?: ConversationTurnSpec["documentFeedback"];
  notepadFeedback?: ConversationTurnSpec["notepadFeedback"];
  imageRefs: ConversationImageRef[];
}): MessageContentBlock[] {
  const transcriptUserText = input.isDrainedFeedbackBatch
    ? input.promptText
    : "";
  const hasNotepadFeedback = (input.notepadFeedback?.length ?? 0) > 0;
  if (input.documentFeedback || hasNotepadFeedback) {
    return buildUserTranscriptBlocks({
      rewrittenPromptText: transcriptUserText,
      imageRefs: input.imageRefs,
      ...(input.documentFeedback
        ? { documentFeedback: input.documentFeedback }
        : {}),
      ...(hasNotepadFeedback
        ? { notepadFeedback: input.notepadFeedback ?? [] }
        : {}),
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
