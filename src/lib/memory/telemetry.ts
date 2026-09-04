import { createLogger } from "@/lib/logging";
import type {
  MemoryObservationQuery,
  MemoryTelemetryRepo,
} from "@/lib/state-store/memory-telemetry-repo";

import type {
  MemoryDeliveryWatermark,
  MemoryIndexDeliveryKind,
  MemoryIndexDeliveryState,
  MemoryObservationCounter,
} from "./schemas";

const logger = createLogger("memory.telemetry");

/**
 * One note as it was put in front of a conversation: the immutable id and the
 * revision whose text was actually delivered. Deliberately the narrow shape
 * rather than a `MemoryIndexEntry` or a context-pack entry, so the delivering
 * seam decides what it delivered and this module never learns to read a note.
 */
export interface MemoryDeliveredNote {
  readonly memoryId: string;
  readonly revision: number;
  /**
   * Whether the delivered text carried this note's status line. Stated by the
   * delivering seam rather than re-read here, for the same reason the revision
   * is: only the seam knows what its own text held.
   */
  readonly statusDelivered: boolean;
}

/**
 * A turn's ambient `<memory-index>` block. `kind` and `composedAt` are required
 * here and absent from the expanded variant because only the ambient channel
 * has a delivery history to advance: a recall pack is a one-off answer to a
 * question, not a place in the once-then-delta sequence.
 *
 * `composedAt` is the instant the block was COMPOSED, not the instant this
 * write runs. The seam settles the record after the backend accepts the turn,
 * so a note captured in between belongs to the next delta; dating the state at
 * settlement would silently swallow it.
 */
export interface RecordMemoryIndexDeliveryInput {
  readonly conversationId: string;
  readonly channel: "index";
  readonly kind: MemoryIndexDeliveryKind;
  readonly composedAt: string;
  readonly notes: readonly MemoryDeliveredNote[];
}

/** A recall pack the agent asked for and read. */
export interface RecordMemoryExpandedDeliveryInput {
  readonly conversationId: string;
  readonly channel: "expanded";
  readonly notes: readonly MemoryDeliveredNote[];
}

export type RecordMemoryDeliveryInput =
  | RecordMemoryIndexDeliveryInput
  | RecordMemoryExpandedDeliveryInput;

/**
 * Everything the next composition needs to compute a delta, read in one call
 * before it composes: where the conversation stands in the delivery sequence,
 * and what each note last carried. `state` is null for a conversation that has
 * never been delivered a block or whose context was lost — both are the state
 * that is due the full block.
 *
 * The watermarks are the INDEX channel only. A recall pack the agent expanded
 * is not part of the block a compaction dropped, and letting it suppress a
 * delta entry would hide a hook the ambient block never carried.
 */
export interface MemoryIndexDeliveryRead {
  readonly state: MemoryIndexDeliveryState | null;
  readonly watermarks: readonly MemoryDeliveryWatermark[];
}

/**
 * Where a validator round spent itself re-deriving something a linked note
 * already held (R15). Every field is optional because the observation is
 * gathered by hand or by an evaluation harness rather than produced by a code
 * path that always knows all four: an unattributed round still counts.
 *
 * Identities only — never the fact that was re-derived, and never note text.
 */
export interface RecordValidatorRederivationInput {
  readonly memoryId?: string | null;
  readonly conversationId?: string | null;
  readonly executionId?: string | null;
  readonly contextId?: string | null;
}

export interface MemoryTelemetryDeps {
  repo: MemoryTelemetryRepo;
  now(): string;
}

/**
 * The observation surface for Memory Notes (spec R15): delivery watermarks per
 * conversation, and the counters that let the evidence-gated defaults —
 * validator access, promotion notification, index budget, embeddings — be
 * revisited from evidence after delivery.
 *
 * Everything here is write-and-read-back only. No selection path takes this
 * service as a dependency, and the counters live in their own repository, so
 * the `inv-no-popularity-or-telemetry-rank` invariant is a property of the
 * wiring rather than a rule someone has to remember
 * (`telemetry-outside-ranking.test.ts` is its backstop).
 */
export interface MemoryTelemetryService {
  /**
   * Record what a turn injected or a recall expanded, and count the retrieval
   * on each note that was actually shown. Called from the delivery seams
   * themselves, never from composition: composing a block for a preview shows
   * it to nobody, and a watermark that counted previews would answer a
   * different question than the one R15 asks.
   */
  recordDelivery(input: RecordMemoryDeliveryInput): Promise<void>;
  /**
   * The read the ambient composition takes BEFORE it composes: the delivery
   * state and the index-channel watermarks together, so what a delta carries
   * is decided against one consistent view.
   */
  readIndexDelivery(conversationId: string): Promise<MemoryIndexDeliveryRead>;
  /**
   * A context loss: the conversation no longer holds the block, so its index
   * history goes and its next turn is due the full block again. Leaves the
   * expanded-channel watermarks and every counter standing — the agent was
   * still shown what it was shown.
   */
  resetIndexDelivery(conversationId: string): Promise<void>;
  /** Every note revision this conversation has been shown, per channel. */
  listDeliveryWatermarks(
    conversationId: string,
  ): Promise<MemoryDeliveryWatermark[]>;
  /**
   * The durable session notes a completed incarnation offered for promotion
   * (R10, D8). Counted per note and per offer, so the "was the passive
   * affordance missed" question is a comparison against {@link recordPromoted}
   * on the SAME note rather than against a global total.
   */
  recordPromotionCandidates(memoryIds: readonly string[]): Promise<void>;
  /**
   * A promotion that actually happened, named by the SESSION note it retired —
   * the same subject the candidate counter names, which is what makes the two
   * comparable.
   */
  recordPromoted(memoryId: string): Promise<void>;
  /**
   * A validator round spent re-deriving a fact a linked note already held.
   * Emits the greppable `memory.telemetry.validator_rederivation` event as well
   * as counting, because the evaluation reads the log timeline for WHERE the
   * round was spent and the counter for how often.
   */
  recordValidatorRederivation(
    input: RecordValidatorRederivationInput,
  ): Promise<void>;
  /** The observation counters, highest count first. */
  listObservations(
    query?: MemoryObservationQuery,
  ): Promise<MemoryObservationCounter[]>;
}

export function createMemoryTelemetryService(
  deps: MemoryTelemetryDeps,
): MemoryTelemetryService {
  async function observe(
    kind: MemoryObservationCounter["kind"],
    memoryIds: readonly (string | null)[],
  ): Promise<void> {
    if (memoryIds.length === 0) return;
    await deps.repo.observe({
      kind,
      memoryIds: [...memoryIds],
      observedAt: deps.now(),
    });
  }

  return {
    async recordDelivery(input) {
      const { conversationId, channel, notes } = input;
      let recorded: MemoryDeliveryWatermark[] = [];
      // An empty delivery is the ordinary shape of a quiet turn: no watermark
      // to write, and it costs the write queue nothing here. The state row
      // below still advances, because the turn did receive a block.
      if (notes.length > 0) {
        recorded = await deps.repo.recordDeliveries({
          conversationId,
          channel,
          notes: notes.map(({ memoryId, revision, statusDelivered }) => ({
            memoryId,
            revision,
            statusDelivered,
          })),
          deliveredAt: deps.now(),
        });
        // Counted from what PERSISTED rather than from what was asked: a note
        // deleted between composition and this write was shown to nobody by
        // the time the row would have said so.
        await observe(
          channel === "index" ? "retrieval_index" : "retrieval_expanded",
          recorded.map((watermark) => watermark.memoryId),
        );
      }
      // After the watermarks, never before: the state row is what the next
      // composition trusts to say the conversation was told, and advancing it
      // over a failed watermark write would drop those notes from every
      // future delta.
      if (input.channel === "index") {
        await deps.repo.markIndexDelivery({
          conversationId,
          kind: input.kind,
          at: input.composedAt,
        });
      }
      logger.info("memory.telemetry.delivery_recorded", {
        conversationId,
        channel,
        kind: input.channel === "index" ? input.kind : null,
        delivered: notes.length,
        recorded: recorded.length,
      });
    },

    async readIndexDelivery(conversationId) {
      const [state, watermarks] = await Promise.all([
        deps.repo.getIndexDeliveryState(conversationId),
        deps.repo.listDeliveryWatermarks(conversationId),
      ]);
      return {
        state,
        watermarks: watermarks.filter(
          (watermark) => watermark.channel === "index",
        ),
      };
    },

    async resetIndexDelivery(conversationId) {
      await deps.repo.resetIndexDelivery(conversationId);
      logger.info("memory.telemetry.index_delivery_reset", { conversationId });
    },

    async listDeliveryWatermarks(conversationId) {
      return deps.repo.listDeliveryWatermarks(conversationId);
    },

    async recordPromotionCandidates(memoryIds) {
      if (memoryIds.length === 0) return;
      await observe("promotion_candidate", memoryIds);
      logger.info("memory.telemetry.promotion_candidates_observed", {
        candidates: memoryIds.length,
      });
    },

    async recordPromoted(memoryId) {
      await observe("promoted", [memoryId]);
      logger.info("memory.telemetry.promoted_observed", { memoryId });
    },

    async recordValidatorRederivation(input) {
      await observe("validator_rederivation", [input.memoryId ?? null]);
      logger.info("memory.telemetry.validator_rederivation", {
        memoryId: input.memoryId ?? null,
        conversationId: input.conversationId ?? null,
        executionId: input.executionId ?? null,
        contextId: input.contextId ?? null,
      });
    },

    async listObservations(query) {
      return deps.repo.listObservations(query);
    },
  };
}
