/**
 * Checkpoint SSE reactions, registered against the shared `/api/events`
 * EventSource by the client assembly point (`NotificationListener`).
 *
 * Two kinds of frame matter here. The checkpoint's own event carries the
 * public receipt as its whole body, so a durable phase change is folded
 * straight into the caches. Ordinary conversation frames carry no checkpoint
 * state at all, but they move the predicates ELIGIBILITY is computed from — a
 * turn starting or ending, a question parking the conversation — so they
 * invalidate that one query for the conversation they name and nothing else.
 * Without the second kind a mounted menu keeps showing a refusal reason the
 * server stopped giving minutes ago.
 *
 * The dependency points this way on purpose: the checkpoint domain reacts to
 * conversation events, and the conversation domain knows nothing of
 * checkpoints.
 */

import type { QueryClient } from "@tanstack/react-query";

import { addSseListener } from "@/lib/api/sse";
import {
  askQuestionEventSchema,
  conversationBackgroundActivityEventSchema,
  conversationStatusEventSchema,
  messageQueueUpdatedEventSchema,
} from "@/lib/conversations/schemas";

import {
  CONVERSATION_CHECKPOINT_UPDATED_EVENT,
  conversationCheckpointUpdatedEventSchema,
} from "./events";
import { checkpointKeys, type CheckpointTarget } from "./query-keys";
import { applyConversationCheckpointUpdatedEvent } from "./sse-cache";

export interface ConversationCheckpointSseReactionDeps {
  queryClient: QueryClient;
}

/** The conversation an ordinary lifecycle frame names, at its own scope. */
interface ScopedConversationFrame {
  scope: "session" | "project";
  projectName: string;
  sessionName?: string;
  conversationId: string;
}

function frameTarget(frame: ScopedConversationFrame): CheckpointTarget | null {
  if (frame.scope === "project") {
    return {
      scope: "project",
      projectName: frame.projectName,
      conversationId: frame.conversationId,
    };
  }
  return frame.sessionName === undefined
    ? null
    : {
        scope: "session",
        projectName: frame.projectName,
        sessionName: frame.sessionName,
        conversationId: frame.conversationId,
      };
}

function invalidateEligibility(
  queryClient: QueryClient,
  frame: ScopedConversationFrame,
): void {
  const target = frameTarget(frame);
  if (target === null) return;
  void queryClient.invalidateQueries({
    queryKey: checkpointKeys.eligibility(target),
  });
}

export function registerConversationCheckpointSseReactions(
  es: EventSource,
  deps: ConversationCheckpointSseReactionDeps,
): void {
  addSseListener(
    es,
    CONVERSATION_CHECKPOINT_UPDATED_EVENT,
    conversationCheckpointUpdatedEventSchema,
    (data) => {
      applyConversationCheckpointUpdatedEvent(deps.queryClient, data);
    },
  );

  addSseListener(
    es,
    "conversation-status",
    conversationStatusEventSchema,
    (data) => {
      invalidateEligibility(deps.queryClient, data);
    },
  );

  addSseListener(es, "ask-question", askQuestionEventSchema, (data) => {
    invalidateEligibility(deps.queryClient, data);
  });

  addSseListener(
    es,
    "message-queue-updated",
    messageQueueUpdatedEventSchema,
    (data) => {
      invalidateEligibility(deps.queryClient, data);
    },
  );

  // Background activity is a PROGRESS feed, so only its end is read here.
  // Re-reading eligibility on every tick would be waste, and a stale
  // "eligible" costs nothing: the server still refuses, and that typed refusal
  // is what the surfaces show. The harmful direction is the other one — work
  // that finished leaving the action disabled with a reason that has expired.
  addSseListener(
    es,
    "conversation-background-activity",
    conversationBackgroundActivityEventSchema,
    (data) => {
      if (data.activity !== null) return;
      invalidateEligibility(deps.queryClient, data);
    },
  );
}
