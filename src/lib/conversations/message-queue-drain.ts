/**
 * Conversation message-queue drain engine.
 *
 * Owns next-turn delivery out of a conversation's persisted message queue:
 * claiming the head batch, converting queued content into a `SUBMIT_PROMPT`,
 * routing queued `/commit`/`/merge` rows through the command service, and
 * settling rows (`delivered`/`pending`/`failed`) around actor acceptance.
 * The conversation actor manager triggers drains on idle entry and on
 * explicit nudges; this module is the single policy for what a drain does.
 */

import { createLogger } from "@/lib/logging";
import type {
  ConversationContext,
  ConversationEvent,
} from "@/lib/workflows/conversation/types";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
import type { DocumentFeedbackPayload } from "@/lib/conversations/message-content-schemas";
import type { ImagePayload } from "@/lib/images/schemas";
import { messageQueueService } from "@/lib/conversations/message-queue-service";
import type { ClaimedQueuedBatch } from "@/lib/conversations/message-queue-service";
import type { ParsedConversationCommand } from "@/lib/conversation-commands/schemas";
import type { RunCommandOutcome } from "@/lib/conversation-commands/service";
import type { ConversationCommandDispatchInput } from "@/lib/conversation-commands/dispatch";
import { dispatchConversationCommand } from "@/lib/conversation-commands/dispatch";
import { ticketCommandFallbackMessage } from "@/lib/conversation-commands/ticket-confirmation";
import { isProjectSentinel } from "@/lib/conversations/project-conversation-scope";
import { getErrorMessage } from "@/lib/shared/errors";

// The `conversation-manager` module key is a stable log-query key: queue.*
// drain events group with the manager's actor lifecycle events, so one module
// filter covers a conversation's turn-delivery forensics.
const logger = createLogger("conversation-manager");

// ============================================================
// Conversation Queue Dependency Injection
// ============================================================

/**
 * Queue operations the drain action and startup recovery depend on. Method
 * syntax (bivariant) so production `messageQueueService` methods assign cleanly.
 * Tests inject fakes via {@link setConversationQueueDeps} instead of mocking the
 * internal queue-service module.
 */
export interface ConversationQueueDeps {
  claimNextTurnBatch(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
  }): Promise<ClaimedQueuedBatch | null>;
  markPending(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    ids: string[];
    deliveryAttemptId: string;
    error: string;
  }): Promise<void>;
  markDelivered(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    ids: string[];
    deliveryAttemptId: string;
  }): Promise<void>;
  markFailed(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    ids: string[];
    deliveryAttemptId: string;
    error: string;
  }): Promise<void>;
  recoverAbandonedDeliveries(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
  }): Promise<number>;
  /**
   * Run a queued `/commit` or `/merge` through the conversation command
   * service with direct-path semantics: persist the user's command message to
   * the transcript, then await the service run (req 8.3). Mirrors the prompt
   * route's `dispatchConversationCommand` dep.
   */
  runConversationCommand(
    input: ConversationCommandDispatchInput,
  ): Promise<RunCommandOutcome>;
}

const defaultConversationQueueDeps: ConversationQueueDeps = {
  claimNextTurnBatch: (input) => messageQueueService.claimNextTurnBatch(input),
  markPending: (input) => messageQueueService.markPending(input),
  markDelivered: (input) => messageQueueService.markDelivered(input),
  markFailed: (input) => messageQueueService.markFailed(input),
  recoverAbandonedDeliveries: (input) =>
    messageQueueService.recoverAbandonedDeliveries(input),
  runConversationCommand: (input) => dispatchConversationCommand(input),
};

let _conversationQueueDeps: ConversationQueueDeps | null = null;

export function setConversationQueueDeps(deps: ConversationQueueDeps): void {
  _conversationQueueDeps = deps;
}

export function _resetConversationQueueDepsForTesting(): void {
  _conversationQueueDeps = null;
}

export function getConversationQueueDeps(): ConversationQueueDeps {
  return _conversationQueueDeps ?? defaultConversationQueueDeps;
}

// ============================================================
// Drain helpers
// ============================================================

/**
 * Convert a claimed next-turn batch's coalesced content into the `promptText`
 * and `images` a `SUBMIT_PROMPT` carries. `text` blocks are newline-joined;
 * `image` blocks become strip images appended after text. `attachmentId` is a
 * synthetic within-turn correlation key (queued images carry no original id),
 * and no `inlineMarkerIndex` is set because queued images deliver as appended
 * strip images, not inline markers. A `document_feedback` block is surfaced as
 * `documentFeedback` (items merged across coalesced blocks) so the drained
 * `SUBMIT_PROMPT` re-emits it rather than dropping it; the actor re-derives the
 * agent-facing prose from those items. Other block types are dropped.
 * Pure: the input is not mutated.
 */
export function queuedBatchToSubmitPrompt(
  content: readonly MessageContentBlock[],
): {
  promptText: string;
  images: ImagePayload[];
  documentFeedback?: DocumentFeedbackPayload;
} {
  const promptText = content
    .filter(
      (block): block is { type: "text"; text: string } => block.type === "text",
    )
    .map((block) => block.text)
    .join("\n");

  const images: ImagePayload[] = [];
  for (const block of content) {
    if (block.type !== "image") continue;
    const mediaType = imagePayloadMediaTypeOrNull(block.mediaType);
    if (!mediaType) continue;
    images.push({
      attachmentId: `queued-${images.length}`,
      mediaType,
      base64Data: block.base64Data,
    });
  }

  const feedbackItems = content.flatMap((block) =>
    block.type === "document_feedback" ? block.items : [],
  );

  return {
    promptText,
    images,
    ...(feedbackItems.length > 0
      ? { documentFeedback: { items: feedbackItems } }
      : {}),
  };
}

const IMAGE_PAYLOAD_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
] as const;

type ImagePayloadMediaType = (typeof IMAGE_PAYLOAD_MEDIA_TYPES)[number];

/**
 * Queue `image` blocks store `mediaType` as a free `string`, but `ImagePayload`
 * requires the narrowed `ImageMediaType` enum. Narrow against the known set so
 * the drain never forwards an unsupported media type. Returns null when the
 * stored value is not a recognized image payload media type.
 */
function imagePayloadMediaTypeOrNull(
  mediaType: string,
): ImagePayloadMediaType | null {
  return (IMAGE_PAYLOAD_MEDIA_TYPES as readonly string[]).includes(mediaType)
    ? (mediaType as ImagePayloadMediaType)
    : null;
}

/** Minimal actor-self surface the standalone drain needs: dispatch one event
 *  and test acceptance. Method syntax keeps the production actor ref assignable
 *  and lets tests pass a small fake. */
export interface DrainSelf {
  getSnapshot(): { can(event: ConversationEvent): boolean };
  send(event: ConversationEvent): void;
}

/**
 * Run a claimed single-command batch through the command service with the same
 * `RunCommandInput` mapping as the direct prompt path (project-sentinel
 * sessions map to `sessionName: null` + `noticeSessionName`). The queue row is
 * marked `delivered` only after the run resolves. A service throw is a system
 * error — rejections and fallbacks resolve as outcomes — so the row is settled
 * terminally (`failed`, error recorded) rather than returned to `pending`,
 * which would retry a deterministic failure on every idle entry. Never throws.
 */
async function runQueuedCommand(
  batch: ClaimedQueuedBatch,
  command: ParsedConversationCommand,
  context: Pick<
    ConversationContext,
    "projectPath" | "sessionName" | "conversationId" | "projectName"
  >,
  deps: ConversationQueueDeps,
): Promise<void> {
  const { projectPath, projectName, sessionName, conversationId } = context;
  const { promptText } = queuedBatchToSubmitPrompt(batch.content);
  const hasSessionWorktree = !isProjectSentinel(sessionName);

  logger.info("queue.drain_command_dispatched", {
    conversationId,
    sessionName,
    command: command.command,
    hintLength: command.hint.length,
    messageIds: batch.messageIds,
    deliveryAttemptId: batch.deliveryAttemptId,
  });

  try {
    const outcome = await deps.runConversationCommand({
      projectPath,
      projectName,
      sessionName: hasSessionWorktree ? sessionName : null,
      ...(hasSessionWorktree ? {} : { noticeSessionName: sessionName }),
      conversationId,
      parsed: command,
      rawText: promptText,
    });
    const ticketFallback = ticketCommandFallbackMessage(outcome);
    if (ticketFallback !== null) {
      await deps.markFailed({
        projectPath,
        sessionName,
        conversationId,
        ids: batch.messageIds,
        deliveryAttemptId: batch.deliveryAttemptId,
        error: ticketFallback,
      });
      logger.warn("queue.drain_command_ticket_fallback", {
        conversationId,
        sessionName,
        command: command.command,
        status: outcome.status,
        messageIds: batch.messageIds,
        deliveryAttemptId: batch.deliveryAttemptId,
      });
      return;
    }
    await deps.markDelivered({
      projectPath,
      sessionName,
      conversationId,
      ids: batch.messageIds,
      deliveryAttemptId: batch.deliveryAttemptId,
    });
    logger.info("queue.drain_command_complete", {
      conversationId,
      sessionName,
      command: command.command,
      status: outcome.status,
      messageIds: batch.messageIds,
      deliveryAttemptId: batch.deliveryAttemptId,
    });
  } catch (err) {
    const error = getErrorMessage(err);
    logger.error("queue.drain_command_failed", {
      conversationId,
      sessionName,
      command: command.command,
      messageIds: batch.messageIds,
      deliveryAttemptId: batch.deliveryAttemptId,
      error,
    });
    try {
      await deps.markFailed({
        projectPath,
        sessionName,
        conversationId,
        ids: batch.messageIds,
        deliveryAttemptId: batch.deliveryAttemptId,
        error,
      });
    } catch (markErr) {
      logger.error("queue.drain_command_failed", {
        conversationId,
        sessionName,
        phase: "mark_failed",
        error: getErrorMessage(markErr),
      });
    }
  }
}

/**
 * Claim the next-turn batch and dispatch exactly one `SUBMIT_PROMPT` carrying
 * the queued-delivery metadata through the actor. No-op when the queue is
 * empty. A batch claimed as a single command row is routed to the command
 * service instead of `SUBMIT_PROMPT` (req 8.3); remaining entries drain on
 * later idle entries, preserving order. If the actor can no longer accept
 * `SUBMIT_PROMPT`, the claimed rows are returned to `pending` so a later
 * settle re-drains them. Fire-and-forget: any unexpected error is contained
 * and the rows are returned to `pending`.
 */
export async function drainConversationQueue(
  self: DrainSelf,
  context: Pick<
    ConversationContext,
    | "projectPath"
    | "sessionName"
    | "conversationId"
    | "projectName"
    | "transient"
  >,
  deps: ConversationQueueDeps,
): Promise<void> {
  const { projectPath, sessionName, conversationId } = context;
  // Transient lanes have no message-queue rows; claiming against the absent
  // conversation record would throw and log `queue.drain_failed`.
  if (context.transient === true) {
    logger.debug("queue.drain_skipped_transient", {
      conversationId,
      sessionName,
    });
    return;
  }
  let batch: ClaimedQueuedBatch | null = null;
  try {
    batch = await deps.claimNextTurnBatch({
      projectPath,
      sessionName,
      conversationId,
    });
    if (!batch) return;

    if (batch.command) {
      await runQueuedCommand(batch, batch.command, context, deps);
      return;
    }

    const { promptText, images, documentFeedback } = queuedBatchToSubmitPrompt(
      batch.content,
    );

    const event: ConversationEvent = {
      type: "SUBMIT_PROMPT",
      promptText,
      ...(images.length ? { images } : {}),
      ...(documentFeedback ? { documentFeedback } : {}),
      streamId: `drain-${batch.deliveryAttemptId}`,
      queuedDelivery: {
        messageIds: batch.messageIds,
        deliveryAttemptId: batch.deliveryAttemptId,
      },
    };

    if (self.getSnapshot().can(event)) {
      self.send(event);
      logger.info("queue.drain_dispatched", {
        conversationId,
        sessionName,
        messageIds: batch.messageIds,
        deliveryAttemptId: batch.deliveryAttemptId,
      });
      return;
    }

    await deps.markPending({
      projectPath,
      sessionName,
      conversationId,
      ids: batch.messageIds,
      deliveryAttemptId: batch.deliveryAttemptId,
      error: "actor not accepting prompt",
    });
    logger.warn("queue.drain_returned_pending", {
      conversationId,
      sessionName,
      messageIds: batch.messageIds,
      deliveryAttemptId: batch.deliveryAttemptId,
    });
  } catch (err) {
    logger.error("queue.drain_failed", {
      conversationId,
      sessionName,
      error: getErrorMessage(err),
    });
    if (batch) {
      try {
        await deps.markPending({
          projectPath,
          sessionName,
          conversationId,
          ids: batch.messageIds,
          deliveryAttemptId: batch.deliveryAttemptId,
          error: getErrorMessage(err),
        });
      } catch (markErr) {
        logger.error("queue.drain_failed", {
          conversationId,
          sessionName,
          phase: "mark_pending",
          error: getErrorMessage(markErr),
        });
      }
    }
  }
}
