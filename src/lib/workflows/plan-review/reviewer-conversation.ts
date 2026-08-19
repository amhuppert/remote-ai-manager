import { conversationReadCommands } from "@/lib/conversations/conversation-ref";
import { findConversationById } from "@/lib/conversations/cross-project-list";
import { createContextArtifactsRepo } from "@/lib/context-artifacts/repo";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import { getStateDb } from "@/lib/state-store/store";

import type { PlanReviewReader } from "./status-schemas";

// ============================================================
// "Go read the reviewer's conversation" (#69 change 5)
//
// A recorded verdict names the conversation that reached it, and the findings
// artifact is a summary of a much longer deliberation. A planner revising a
// changes-requested plan in a fresh session needs the way IN to that
// deliberation, not just the id — so the status answer carries the commands
// that open it, ready to run.
//
// Every path here degrades. An unresolvable id still gets its read command,
// because `cctl conversation read` resolves the owning project and session
// itself and may well succeed against a conversation this lookup could not
// see; and a lookup that throws is a lookup, not a verdict.
// ============================================================

const logger = createLogger("workflows.plan-review");

/**
 * What the status answer needs to know about the reviewer's conversation. Two
 * booleans, because that is genuinely all the command vocabulary branches on —
 * asking for the whole conversation projection here would buy nothing and cost
 * a cross-project walk.
 */
export interface ReviewerConversationFacts {
  /** Did the conversation resolve at all? Drives the degraded note. */
  found: boolean;
  /** Does a COMPLETED conversation compaction exist for it? */
  hasCompaction: boolean;
}

export interface ReviewerConversationResolver {
  resolve(conversationId: string): Promise<ReviewerConversationFacts>;
}

const UNRESOLVED_NOTE =
  "reviewer conversation could not be resolved from this server's state — the read command still resolves the id itself and may work";

/**
 * Compose the reader block for one reviewer id. Never throws: a resolver that
 * fails is logged and treated as "not found", which yields the bare id plus the
 * note — the same answer a deleted conversation gets.
 */
export async function buildPlanReviewReader(
  conversationId: string,
  resolver: ReviewerConversationResolver,
): Promise<PlanReviewReader> {
  let facts: ReviewerConversationFacts = { found: false, hasCompaction: false };
  let failed = false;
  try {
    facts = await resolver.resolve(conversationId);
  } catch (err) {
    failed = true;
    logger.warn("workflows.plan-review.reviewer_lookup_failed", {
      conversationId,
      error: getErrorMessage(err),
    });
  }

  // `conversationReadCommands` branches only on none vs not-none, so any
  // non-none value selects the same pair; "fresh" is the presence signal here,
  // not a staleness claim — this surface never reads the transcript position
  // that would justify one.
  const commands = conversationReadCommands(
    conversationId,
    facts.hasCompaction ? "fresh" : "none",
  ).map(([name, command]) => ({ name, command }));

  return {
    conversationId,
    resolved: facts.found,
    note: facts.found && !failed ? null : UNRESOLVED_NOTE,
    commands,
  };
}

/**
 * The production resolver: the conversations domain's by-id surface (focused
 * state-store accessors, no whole-state scan) for existence, and the
 * context-artifacts repository for the completed compaction row. The enriched
 * cross-project list also derives compaction status, but only by walking every
 * project — far too much work to decide two advisory command lines.
 */
export const defaultReviewerConversationResolver: ReviewerConversationResolver =
  {
    async resolve(conversationId) {
      const conversation = await findConversationById(conversationId);
      if (!conversation) return { found: false, hasCompaction: false };
      const hasCompaction = createContextArtifactsRepo(getStateDb())
        .findByConversation(conversationId)
        .some(
          (row) =>
            row.kind === "conversation_compaction" && row.status === "complete",
        );
      return { found: true, hasCompaction };
    },
  };
