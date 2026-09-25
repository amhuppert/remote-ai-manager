/**
 * Delivers spec review feedback to the conversation that AUTHORED the draft
 * as passive, durable notices (#60): a transcript notice the human sees
 * immediately and a pending agent notice the agent reads at its NEXT turn.
 * Never an auto-wake — nothing here prompts, resumes, or otherwise starts a
 * turn.
 *
 * The review service resolves the draft's latest agent author (from the
 * durable event log) and hands it over in the notice; this module owns only
 * the delivery consequences. A delivery failure is logged and swallowed: the
 * review act already committed, and a notification must never fail it
 * retroactively.
 */

import { createLogger } from "@/lib/logging";
import {
  storeSessionNameFromScopeRef,
  type ConversationScopeRef,
} from "@/lib/conversations/conversation-target";
import { findConversationById } from "@/lib/conversations/cross-project-list";
import { appendNotice } from "@/lib/prompt/transcript";
import { getErrorMessage } from "@/lib/shared/errors";
import type { SpecReviewFeedbackNotice } from "@/lib/specs/review-service";
import { mutateConversation } from "@/lib/state-store";
import { appendPendingAgentNotice as appendPendingAgentConversationNotice } from "@/lib/workflows/conversation/pre-turn/notices-drain";

const logger = createLogger("notifications.spec-review-feedback");

/**
 * The slice of a resolved conversation this notifier needs: where it lives and
 * which scope addresses it. `ConversationListItem` satisfies it structurally.
 */
export type SpecReviewFeedbackConversation =
  | {
      projectName: string;
      projectPath: string;
      scope: "session";
      sessionName: string;
    }
  | { projectName: string; projectPath: string; scope: "project" };

export interface SpecReviewFeedbackNotifierDeps {
  /** Null when no conversation of either scope carries the id anymore. */
  findConversationById(
    conversationId: string,
  ): Promise<SpecReviewFeedbackConversation | null>;
  /** Durable human-visible transcript notice row (broadcast over SSE). */
  appendNotice(input: {
    conversationId: string;
    text: string;
    projectName: string;
    storeSessionName: string;
  }): Promise<void>;
  /** Durable agent notice drained into the NEXT runtime's instructions. */
  appendPendingAgentNotice(input: {
    projectPath: string;
    storeSessionName: string;
    conversationId: string;
    text: string;
  }): Promise<void>;
}

export interface SpecReviewFeedbackNotifier {
  reviewFeedback(notice: SpecReviewFeedbackNotice): Promise<void>;
}

/**
 * What the draft's author reads. Each line names the spec, what happened, and — when
 * there is something to act on — the exact next read.
 */
function feedbackText(notice: SpecReviewFeedbackNotice): string {
  const readComments = `cctl spec comments ${notice.specSlug} --open`;
  switch (notice.kind) {
    case "commented":
      return `Review feedback on spec ${notice.specSlug}: a human commented on ${notice.subject ?? "the draft"}. Read it with ${readComments}.`;
    case "signed_off":
      return `Spec ${notice.specSlug}: a human signed off the draft; it is now approved.`;
  }
}

export function createSpecReviewFeedbackNotifier(
  deps: SpecReviewFeedbackNotifierDeps,
): SpecReviewFeedbackNotifier {
  async function deliver(notice: SpecReviewFeedbackNotice): Promise<void> {
    if (notice.proposer === null) return;
    const conversationId = notice.proposer.conversationId;
    const found = await deps.findConversationById(conversationId);
    if (found === null) {
      logger.warn("notifications.spec_review_feedback.conversation_missing", {
        specId: notice.specId,
        revisionId: notice.revisionId,
        kind: notice.kind,
        conversationId,
      });
      return;
    }
    const scopeRef: ConversationScopeRef =
      found.scope === "session"
        ? { scope: "session", sessionName: found.sessionName }
        : { scope: "project" };
    const storeSessionName = storeSessionNameFromScopeRef(scopeRef);
    const text = feedbackText(notice);
    // Independent halves: the agent notice must still land when the
    // transcript append fails, and vice versa.
    const results = await Promise.allSettled([
      deps.appendNotice({
        conversationId,
        text,
        projectName: found.projectName,
        storeSessionName,
      }),
      deps.appendPendingAgentNotice({
        projectPath: found.projectPath,
        storeSessionName,
        conversationId,
        text,
      }),
    ]);
    for (const result of results) {
      if (result.status === "rejected") {
        logger.warn("notifications.spec_review_feedback.append_failed", {
          specId: notice.specId,
          revisionId: notice.revisionId,
          kind: notice.kind,
          conversationId,
          error: getErrorMessage(result.reason),
        });
      }
    }
    logger.info("notifications.spec_review_feedback.delivered", {
      specId: notice.specId,
      revisionId: notice.revisionId,
      kind: notice.kind,
      conversationId,
    });
  }

  return {
    async reviewFeedback(notice) {
      try {
        await deliver(notice);
      } catch (error) {
        // A notification failure must never fail the committed review act.
        logger.warn("notifications.spec_review_feedback.delivery_failed", {
          specId: notice.specId,
          revisionId: notice.revisionId,
          kind: notice.kind,
          error: getErrorMessage(error),
        });
      }
    },
  };
}

/**
 * The one production composition of the feedback notifier, shared by the spec
 * route service factory and the workflow composition so neither restates the
 * conversation-store seams.
 */
export function createProductionSpecReviewFeedbackNotifier(): SpecReviewFeedbackNotifier {
  return createSpecReviewFeedbackNotifier({
    findConversationById(conversationId) {
      return findConversationById(conversationId);
    },
    appendNotice(input) {
      return appendNotice(input);
    },
    appendPendingAgentNotice(input) {
      return appendPendingAgentConversationNotice(
        { mutateConversation },
        {
          projectPath: input.projectPath,
          sessionName: input.storeSessionName,
          conversationId: input.conversationId,
        },
        input.text,
        "spec_review_feedback_notice",
      );
    },
  });
}
