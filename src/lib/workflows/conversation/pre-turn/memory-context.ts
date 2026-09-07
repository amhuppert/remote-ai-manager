import type {
  MemoryIndexContextRequest,
  PreparedMemoryIndexDelivery,
} from "@/lib/memory/index-live-context";
import { getErrorMessage } from "@/lib/shared/errors";
import type { ConversationActorDependencies } from "../actor-dependencies";
import type { PreparedTurnContribution } from "../turn-context";

type MemoryContextDependencies = {
  context: Pick<
    ConversationActorDependencies["context"],
    "getMemoryIndexBlock"
  >;
  effects: Pick<
    ConversationActorDependencies["effects"],
    "recordMemoryIndexDeliveries"
  >;
  log: ConversationActorDependencies["log"];
};

export async function prepareMemoryContext(
  deps: MemoryContextDependencies,
  request: MemoryIndexContextRequest,
): Promise<PreparedTurnContribution> {
  let delivery: PreparedMemoryIndexDelivery | null = null;
  // The conversation's current <memory-index> block, for session and project
  // conversations alike (spec `memory` R5/R6): rebuilt from live rows every
  // turn, so a note another conversation captured a moment ago is here now.
  // A read failure degrades to a turn without memory rather than failing it.
  try {
    delivery = await deps.context.getMemoryIndexBlock(request);
  } catch (error) {
    deps.log.warn("prompt.memory_index_block_failed", {
      conversationId: request.conversationId,
      error: getErrorMessage(error),
    });
  }
  let acceptance: Promise<void> | undefined;
  return {
    block: delivery?.block ?? null,
    onInputAccepted() {
      acceptance ??= (async () => {
        // The notes this turn's <memory-index> block carried are delivered
        // only now (R15): capability setup, runtime readiness, MCP apply and
        // dispatch can reject a prepared turn before the agent sees it.
        // An independent advisory write precedes required workflow settlement,
        // so a neighbouring failure cannot strand an already-read watermark.
        if (delivery === null) return;
        // The receipt describes composition time: a revision captured while the
        // turn is in flight belongs to the next delivery, even if acceptance is late.
        const fields = {
          conversationId: request.conversationId,
          mode: delivery.mode,
          entryCount: delivery.entries.length,
          omittedCount: delivery.rendered?.omitted ?? 0,
          bytes: Buffer.byteLength(delivery.block ?? "", "utf8"),
        };
        try {
          await deps.effects.recordMemoryIndexDeliveries({
            conversationId: request.conversationId,
            kind: delivery.mode,
            composedAt: delivery.composedAt,
            notes: delivery.entries.map(
              ({ memoryId, revision, statusDelivered }) => ({
                memoryId,
                revision,
                statusDelivered,
              }),
            ),
          });
          deps.log.info("prompt.memory_delivery_settled", fields);
        } catch (error) {
          deps.log.warn("prompt.memory_delivery_record_failed", {
            ...fields,
            error: getErrorMessage(error),
          });
        }
      })();
      return acceptance;
    },
  };
}
