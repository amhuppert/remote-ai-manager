import type { ConversationCostSettlement } from "@/lib/agent-backends/conversation";
import type { PublishFn } from "@/lib/events/publication";
import { createLogger } from "@/lib/logging";
import type { TranscriptEntry } from "@/lib/prompt/transcript";
import { getErrorMessage } from "@/lib/shared/errors";
import { conversationEventScopeFields } from "./project-conversation-scope";
import type { ConversationState } from "./schemas";

const logger = createLogger("conversation-cost-settlement");

/** The frame a late settlement leaves in the transcript, read by usage projections. */
export const COST_SETTLEMENT_FRAME_TYPE = "cost_settlement";

export interface CostSettlementIdentity {
  projectPath: string;
  projectName: string;
  /** Store-level session name; the project sentinel selects the project scope. */
  storeSessionName: string;
  conversationId: string;
}

export interface CostSettlementDeps {
  mutateConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    label: string,
    mutate: (conversation: ConversationState) => void,
  ): Promise<void>;
  /**
   * Fold the delta into the hosted actor's totals when the conversation is
   * live in memory. `applied: false` means no actor holds it, and the row is
   * written directly instead — never both, which would count the delta twice.
   */
  applyToHostedActor(
    identity: CostSettlementIdentity,
    costUsdDelta: number,
  ): { applied: true; totalCostUsd: number | null } | { applied: false };
  publish: PublishFn;
  /** Idempotent by entry id; a failure here is logged, never fatal. */
  appendTranscriptEntryOnce?(
    conversationId: string,
    entry: TranscriptEntry & { id: string },
  ): Promise<void>;
}

/**
 * The transcript frame for cost that no backend result frame carries. It is
 * lineage-cumulative like every result frame, so transcript readers fold it
 * with the same final-per-lineage rule; the id makes a re-append a no-op.
 */
export function costSettlementFrame(
  conversationId: string,
  settlement: ConversationCostSettlement,
): TranscriptEntry & { id: string } {
  const cumulativeMicros = Math.round(settlement.cumulativeCostUsd * 1e6);
  return {
    id: `cost-settlement:${conversationId}:${settlement.lineageId}:${cumulativeMicros}`,
    timestamp: new Date().toISOString(),
    type: COST_SETTLEMENT_FRAME_TYPE,
    raw: {
      kind: COST_SETTLEMENT_FRAME_TYPE,
      lineageId: settlement.lineageId,
      cumulativeCostUsd: settlement.cumulativeCostUsd,
      costUsdDelta: settlement.costUsdDelta,
    },
  };
}

/**
 * Apply a provider cost settlement that arrived outside a turn result to the
 * conversation's durable total, its live actor when hosted, its transcript,
 * and the SSE bus. The backend runtime owns exactly-once reporting; this seam
 * owns where each reported cent lands.
 */
export async function recordConversationCostSettlement(
  identity: CostSettlementIdentity,
  settlement: ConversationCostSettlement,
  deps: CostSettlementDeps,
): Promise<{ totalCostUsd: number | null }> {
  const hosted = deps.applyToHostedActor(identity, settlement.costUsdDelta);
  let totalCostUsd: number | null = hosted.applied ? hosted.totalCostUsd : null;
  if (!hosted.applied) {
    await deps.mutateConversation(
      identity.projectPath,
      identity.storeSessionName,
      identity.conversationId,
      "conversation.cost-settled",
      (conversation) => {
        conversation.totalCostUsd =
          (conversation.totalCostUsd ?? 0) + settlement.costUsdDelta;
        totalCostUsd = conversation.totalCostUsd;
      },
    );
  }

  if (deps.appendTranscriptEntryOnce !== undefined) {
    try {
      await deps.appendTranscriptEntryOnce(
        identity.conversationId,
        costSettlementFrame(identity.conversationId, settlement),
      );
    } catch (error) {
      logger.warn("conversation.cost_settlement_frame_failed", {
        ...conversationEventScopeFields(
          identity.projectName,
          identity.storeSessionName,
          identity.conversationId,
        ),
        error: getErrorMessage(error),
      });
    }
  }

  const outcome = deps.publish({
    type: "conversation-usage-updated",
    ...conversationEventScopeFields(
      identity.projectName,
      identity.storeSessionName,
      identity.conversationId,
    ),
    totalCostUsd,
  });
  logger.info("conversation.cost_settled", {
    ...conversationEventScopeFields(
      identity.projectName,
      identity.storeSessionName,
      identity.conversationId,
    ),
    costUsdDelta: settlement.costUsdDelta,
    totalCostUsd,
    appliedTo: hosted.applied ? "actor" : "row",
    published: outcome.delivered,
  });
  return { totalCostUsd };
}
