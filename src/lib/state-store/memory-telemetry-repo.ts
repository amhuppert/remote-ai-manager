import type Database from "better-sqlite3";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import {
  memoryDeliveryChannelSchema,
  memoryDeliveryWatermarkSchema,
  memoryIndexDeliveryKindSchema,
  memoryIndexDeliveryStateSchema,
  memoryObservationCounterSchema,
  memoryObservationKindSchema,
  type MemoryDeliveryWatermark,
  type MemoryIndexDeliveryState,
  type MemoryObservationCounter,
} from "@/lib/memory/schemas";
import { PersistenceError } from "../shared/errors";
import { parseTrusted, registerTrustedSchema } from "../shared/parse-trusted";
import type { WriteQueue } from "./write-queue";

type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.memory-telemetry");

// ============================================================
// Repo-level write inputs
// ============================================================

/**
 * One conversation's delivery of a set of notes over one channel. Recording is
 * an upsert on `(conversationId, memoryId, channel)`: the row states where the
 * conversation stands, not how it got there, so a re-delivery of the same
 * revision overwrites rather than appending.
 */
export const recordMemoryDeliveriesInputSchema = z.object({
  conversationId: z.string().min(1),
  channel: memoryDeliveryChannelSchema,
  notes: z
    .array(
      z.object({
        memoryId: z.string().min(1),
        revision: z.number().int().positive(),
        /** Whether the delivered text carried this note's status line. */
        statusDelivered: z.boolean(),
      }),
    )
    .min(1),
  deliveredAt: z.string().min(1),
});
export type RecordMemoryDeliveriesInput = z.infer<
  typeof recordMemoryDeliveriesInputSchema
>;

/**
 * One conversation's index delivery, stated by the seam that delivered it.
 * `at` is the COMPOSITION instant of the block, not the moment of this write:
 * a note captured while the turn was in flight belongs to the next delta, and
 * stamping the settlement clock here would swallow it.
 */
export const markMemoryIndexDeliveryInputSchema = z.object({
  conversationId: z.string().min(1),
  kind: memoryIndexDeliveryKindSchema,
  at: z.string().min(1),
});
export type MarkMemoryIndexDeliveryInput = z.infer<
  typeof markMemoryIndexDeliveryInputSchema
>;

/**
 * One observation per `(kind, memoryId)`, each raising that counter by one.
 * The caller states the whole batch a single act produced — a turn's index
 * block, a session end's candidate set — so one transaction records it.
 */
export const observeMemoryCountersInputSchema = z.object({
  kind: memoryObservationKindSchema,
  /**
   * The records observed. `null` is the unattributed observation, which
   * collapses onto one row per kind. Duplicates within one batch count once:
   * a single act observing the same note twice observed it once.
   */
  memoryIds: z.array(z.string().min(1).nullable()).min(1),
  observedAt: z.string().min(1),
});
export type ObserveMemoryCountersInput = z.infer<
  typeof observeMemoryCountersInputSchema
>;

export const memoryObservationQuerySchema = z.object({
  kind: memoryObservationKindSchema.optional(),
  memoryId: z.string().min(1).optional(),
});
export type MemoryObservationQuery = z.infer<
  typeof memoryObservationQuerySchema
>;

/**
 * The observation store for Memory Notes (spec R15): what a conversation has
 * been shown, and how often each record was retrieved, promoted, or
 * re-derived.
 *
 * Deliberately a SEPARATE repository from {@link MemoryRepo} rather than more
 * methods on it. The composer and the recall ranker are handed a `MemoryRepo`
 * and nothing else, so keeping every counter behind this interface means there
 * is no route from a ranking comparison to a retrieval count — the
 * `inv-no-popularity-or-telemetry-rank` invariant holds structurally instead of
 * by review.
 */
export interface MemoryTelemetryRepo {
  /**
   * Upsert what this conversation has now been shown, returning the rows that
   * persisted. A note that vanished between delivery and this write is skipped
   * rather than raising a foreign-key constraint: a delivery can race a delete,
   * and losing one observation is never worth failing a turn over.
   */
  recordDeliveries(
    input: RecordMemoryDeliveriesInput,
  ): Promise<MemoryDeliveryWatermark[]>;
  /** Every note this conversation has been shown, oldest recording first. */
  listDeliveryWatermarks(
    conversationId: string,
  ): Promise<MemoryDeliveryWatermark[]>;
  /**
   * Where this conversation stands with the ambient index. Null when it has
   * never been delivered a block, or when a context loss reset it — the two
   * states a conversation due the full block can be in.
   */
  getIndexDeliveryState(
    conversationId: string,
  ): Promise<MemoryIndexDeliveryState | null>;
  /**
   * Record that this conversation received a block composed at `at`. A full
   * block moves both instants; a delta moves only the delivery instant, so the
   * full one keeps naming the block the conversation still holds.
   */
  markIndexDelivery(
    input: MarkMemoryIndexDeliveryInput,
  ): Promise<MemoryIndexDeliveryState>;
  /**
   * The context-loss act: forget that this conversation was ever delivered an
   * index. Deletes its delivery state and its INDEX-channel watermarks only —
   * an expanded recall pack the agent asked for is not part of the block a
   * compaction dropped, and another conversation's rows are never touched.
   */
  resetIndexDelivery(conversationId: string): Promise<void>;
  /**
   * Raise each named counter by one, returning the rows as they now stand. A
   * counter naming a note that no longer exists is skipped, for the same reason
   * a watermark is.
   */
  observe(
    input: ObserveMemoryCountersInput,
  ): Promise<MemoryObservationCounter[]>;
  /** The counters matching the query, highest count first. */
  listObservations(
    query?: MemoryObservationQuery,
  ): Promise<MemoryObservationCounter[]>;
}

// ============================================================
// Row schemas and mappers
// ============================================================

const memoryDeliveryWatermarksTableRowSchema = registerTrustedSchema(
  z.object({
    conversation_id: z.string(),
    memory_id: z.string(),
    channel: z.string(),
    revision: z.number().int(),
    status_delivered: z.number().int(),
    updated_at: z.string(),
  }),
  "memoryDeliveryWatermarksTableRowSchema",
);

const memoryIndexDeliveryStateTableRowSchema = registerTrustedSchema(
  z.object({
    conversation_id: z.string(),
    last_full_at: z.string(),
    last_delivery_at: z.string(),
    updated_at: z.string(),
  }),
  "memoryIndexDeliveryStateTableRowSchema",
);

const memoryObservationCountersTableRowSchema = registerTrustedSchema(
  z.object({
    id: z.string(),
    kind: z.string(),
    memory_id: z.string().nullable(),
    count: z.number().int(),
    first_observed_at: z.string(),
    last_observed_at: z.string(),
  }),
  "memoryObservationCountersTableRowSchema",
);

function logAndThrowValidationFailure(
  entity: string,
  identifier: string,
  issues: z.core.$ZodIssue[],
): never {
  logger.error("state-store.memory-telemetry.schema_validation_failure", {
    entity,
    identifier,
    issues: issues.map((issue) => ({
      code: issue.code,
      path: issue.path.map(String).join("."),
      message: issue.message,
    })),
  });
  throw new PersistenceError({
    kind: "validation",
    entity,
    identifier,
    issues,
  });
}

function rowToWatermark(rawRow: unknown): MemoryDeliveryWatermark {
  const row = parseTrusted(
    memoryDeliveryWatermarksTableRowSchema,
    rawRow,
    (issues) =>
      logAndThrowValidationFailure(
        "memory_delivery_watermark",
        "<row>",
        issues,
      ),
  );
  return parseTrusted(
    memoryDeliveryWatermarkSchema,
    {
      conversationId: row.conversation_id,
      memoryId: row.memory_id,
      channel: row.channel,
      revision: row.revision,
      statusDelivered: row.status_delivered !== 0,
      updatedAt: row.updated_at,
    },
    (issues) =>
      logAndThrowValidationFailure(
        "memory_delivery_watermark",
        `${row.conversation_id}/${row.memory_id}/${row.channel}`,
        issues,
      ),
  );
}

function rowToIndexDeliveryState(rawRow: unknown): MemoryIndexDeliveryState {
  const row = parseTrusted(
    memoryIndexDeliveryStateTableRowSchema,
    rawRow,
    (issues) =>
      logAndThrowValidationFailure(
        "memory_index_delivery_state",
        "<row>",
        issues,
      ),
  );
  return parseTrusted(
    memoryIndexDeliveryStateSchema,
    {
      conversationId: row.conversation_id,
      lastFullAt: row.last_full_at,
      lastDeliveryAt: row.last_delivery_at,
      updatedAt: row.updated_at,
    },
    (issues) =>
      logAndThrowValidationFailure(
        "memory_index_delivery_state",
        row.conversation_id,
        issues,
      ),
  );
}

function rowToCounter(rawRow: unknown): MemoryObservationCounter {
  const row = parseTrusted(
    memoryObservationCountersTableRowSchema,
    rawRow,
    (issues) =>
      logAndThrowValidationFailure(
        "memory_observation_counter",
        "<row>",
        issues,
      ),
  );
  return parseTrusted(
    memoryObservationCounterSchema,
    {
      id: row.id,
      kind: row.kind,
      memoryId: row.memory_id,
      count: row.count,
      firstObservedAt: row.first_observed_at,
      lastObservedAt: row.last_observed_at,
    },
    (issues) =>
      logAndThrowValidationFailure(
        "memory_observation_counter",
        row.id,
        issues,
      ),
  );
}

/**
 * A counter's identity, derived rather than minted: one row per kind and
 * subject, with the unattributed subject collapsing onto the empty key. A
 * generated id would need a unique index to enforce the same thing, and SQLite
 * treats the NULL `memory_id` in such an index as distinct — every
 * unattributed observation would then insert a new row instead of counting.
 */
function observationCounterId(kind: string, memoryId: string | null): string {
  return `${kind}:${memoryId ?? ""}`;
}

function timed<T>(
  op: string,
  identifier: Record<string, unknown>,
  fn: () => T,
): T {
  const start = performance.now();
  try {
    return fn();
  } finally {
    const durationMs = +(performance.now() - start).toFixed(3);
    logger.info(`state-store.memory-telemetry.${op}.timing`, {
      ...identifier,
      durationMs,
    });
  }
}

export function createMemoryTelemetryRepo(
  db: Db,
  writeQueue: WriteQueue,
): MemoryTelemetryRepo {
  const noteExistsStmt = db
    .prepare(`SELECT 1 FROM memory_notes WHERE id = ? LIMIT 1`)
    .pluck();

  const upsertWatermarkStmt = db.prepare(
    `INSERT INTO memory_delivery_watermarks
       (conversation_id, memory_id, channel, revision, status_delivered,
        updated_at)
     VALUES (@conversation_id, @memory_id, @channel, @revision,
             @status_delivered, @updated_at)
     ON CONFLICT (conversation_id, memory_id, channel) DO UPDATE SET
       revision = excluded.revision,
       status_delivered = excluded.status_delivered,
       updated_at = excluded.updated_at`,
  );
  const findWatermarkStmt = db.prepare(
    `SELECT * FROM memory_delivery_watermarks
      WHERE conversation_id = ? AND memory_id = ? AND channel = ? LIMIT 1`,
  );
  const listWatermarksStmt = db.prepare(
    `SELECT * FROM memory_delivery_watermarks WHERE conversation_id = ?
      ORDER BY updated_at ASC, memory_id ASC, channel ASC`,
  );

  // The full instant moves only for a full block: `CASE` rather than two
  // statements so one row write states the whole transition. A delta arriving
  // with no row at all cannot be a delta against anything, so the insert seeds
  // both instants and the caller is warned rather than silently trusted.
  const markIndexDeliveryStmt = db.prepare(
    `INSERT INTO memory_index_delivery_state
       (conversation_id, last_full_at, last_delivery_at, updated_at)
     VALUES (@conversation_id, @at, @at, @at)
     ON CONFLICT (conversation_id) DO UPDATE SET
       last_full_at = CASE WHEN @is_full = 1 THEN @at ELSE last_full_at END,
       last_delivery_at = @at,
       updated_at = @at`,
  );
  const findIndexDeliveryStateStmt = db.prepare(
    `SELECT * FROM memory_index_delivery_state WHERE conversation_id = ? LIMIT 1`,
  );
  const deleteIndexDeliveryStateStmt = db.prepare(
    `DELETE FROM memory_index_delivery_state WHERE conversation_id = ?`,
  );
  const deleteIndexWatermarksStmt = db.prepare(
    `DELETE FROM memory_delivery_watermarks
      WHERE conversation_id = ? AND channel = 'index'`,
  );

  // `count + 1` on conflict is what makes a counter an aggregate rather than a
  // ledger: the row is the whole history of its observation.
  const upsertCounterStmt = db.prepare(
    `INSERT INTO memory_observation_counters
       (id, kind, memory_id, count, first_observed_at, last_observed_at)
     VALUES (@id, @kind, @memory_id, 1, @observed_at, @observed_at)
     ON CONFLICT (id) DO UPDATE SET
       count = count + 1,
       last_observed_at = excluded.last_observed_at`,
  );
  const findCounterStmt = db.prepare(
    `SELECT * FROM memory_observation_counters WHERE id = ? LIMIT 1`,
  );

  const recordDeliveriesTx = db.transaction(
    (input: RecordMemoryDeliveriesInput): MemoryDeliveryWatermark[] => {
      const recorded: MemoryDeliveryWatermark[] = [];
      for (const note of input.notes) {
        // Checked inside the transaction rather than by the caller: a note
        // deleted between composition and this write would otherwise surface as
        // a raised foreign-key constraint instead of a skipped observation.
        if (noteExistsStmt.get(note.memoryId) === undefined) continue;
        upsertWatermarkStmt.run({
          conversation_id: input.conversationId,
          memory_id: note.memoryId,
          channel: input.channel,
          revision: note.revision,
          status_delivered: note.statusDelivered ? 1 : 0,
          updated_at: input.deliveredAt,
        });
        const rawRow: unknown = findWatermarkStmt.get(
          input.conversationId,
          note.memoryId,
          input.channel,
        );
        if (rawRow === undefined) {
          throw new PersistenceError({
            kind: "not_found",
            entity: "memory_delivery_watermark",
            identifier: `${input.conversationId}/${note.memoryId}/${input.channel}`,
          });
        }
        recorded.push(rowToWatermark(rawRow));
      }
      return recorded;
    },
  );

  const markIndexDeliveryTx = db.transaction(
    (input: MarkMemoryIndexDeliveryInput): MemoryIndexDeliveryState => {
      const existing = findIndexDeliveryStateStmt.get(input.conversationId);
      if (existing === undefined && input.kind === "delta") {
        logger.warn("state-store.memory-telemetry.delta_without_state", {
          conversationId: input.conversationId,
        });
      }
      markIndexDeliveryStmt.run({
        conversation_id: input.conversationId,
        at: input.at,
        is_full: input.kind === "full" ? 1 : 0,
      });
      const rawRow: unknown = findIndexDeliveryStateStmt.get(
        input.conversationId,
      );
      if (rawRow === undefined) {
        throw new PersistenceError({
          kind: "not_found",
          entity: "memory_index_delivery_state",
          identifier: input.conversationId,
        });
      }
      return rowToIndexDeliveryState(rawRow);
    },
  );

  const resetIndexDeliveryTx = db.transaction((conversationId: string) => {
    deleteIndexWatermarksStmt.run(conversationId);
    deleteIndexDeliveryStateStmt.run(conversationId);
  });

  const observeTx = db.transaction(
    (input: ObserveMemoryCountersInput): MemoryObservationCounter[] => {
      const recorded: MemoryObservationCounter[] = [];
      // Distinct subjects only: one act observing the same note twice is one
      // observation of it, and re-running the upsert would silently double the
      // count for a caller that passed a duplicate.
      for (const memoryId of new Set(input.memoryIds)) {
        if (memoryId !== null && noteExistsStmt.get(memoryId) === undefined) {
          continue;
        }
        const id = observationCounterId(input.kind, memoryId);
        upsertCounterStmt.run({
          id,
          kind: input.kind,
          memory_id: memoryId,
          observed_at: input.observedAt,
        });
        const rawRow: unknown = findCounterStmt.get(id);
        if (rawRow === undefined) {
          throw new PersistenceError({
            kind: "not_found",
            entity: "memory_observation_counter",
            identifier: id,
          });
        }
        recorded.push(rowToCounter(rawRow));
      }
      return recorded;
    },
  );

  return {
    async recordDeliveries(input) {
      const validated = recordMemoryDeliveriesInputSchema.parse(input);
      return writeQueue.withWriteQueueSync(
        "memoryTelemetry.recordDeliveries",
        () =>
          timed(
            "recordDeliveries",
            {
              conversationId: validated.conversationId,
              channel: validated.channel,
              notes: validated.notes.length,
            },
            () => recordDeliveriesTx.immediate(validated),
          ),
      );
    },

    async listDeliveryWatermarks(conversationId) {
      return timed("listDeliveryWatermarks", { conversationId }, () =>
        (listWatermarksStmt.all(conversationId) as unknown[]).map(
          rowToWatermark,
        ),
      );
    },

    async getIndexDeliveryState(conversationId) {
      return timed("getIndexDeliveryState", { conversationId }, () => {
        const rawRow: unknown = findIndexDeliveryStateStmt.get(conversationId);
        return rawRow === undefined ? null : rowToIndexDeliveryState(rawRow);
      });
    },

    async markIndexDelivery(input) {
      const validated = markMemoryIndexDeliveryInputSchema.parse(input);
      return writeQueue.withWriteQueueSync(
        "memoryTelemetry.markIndexDelivery",
        () =>
          timed(
            "markIndexDelivery",
            {
              conversationId: validated.conversationId,
              kind: validated.kind,
            },
            () => markIndexDeliveryTx.immediate(validated),
          ),
      );
    },

    async resetIndexDelivery(conversationId) {
      await writeQueue.withWriteQueueSync(
        "memoryTelemetry.resetIndexDelivery",
        () =>
          timed("resetIndexDelivery", { conversationId }, () =>
            resetIndexDeliveryTx.immediate(conversationId),
          ),
      );
    },

    async observe(input) {
      const validated = observeMemoryCountersInputSchema.parse(input);
      return writeQueue.withWriteQueueSync("memoryTelemetry.observe", () =>
        timed(
          "observe",
          { kind: validated.kind, subjects: validated.memoryIds.length },
          () => observeTx.immediate(validated),
        ),
      );
    },

    async listObservations(query = {}) {
      const validated = memoryObservationQuerySchema.parse(query);
      const clauses: string[] = [];
      const params: string[] = [];
      if (validated.kind !== undefined) {
        clauses.push("kind = ?");
        params.push(validated.kind);
      }
      if (validated.memoryId !== undefined) {
        clauses.push("memory_id = ?");
        params.push(validated.memoryId);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
      const statement = db.prepare(
        `SELECT * FROM memory_observation_counters ${where}
          ORDER BY count DESC, kind ASC, IFNULL(memory_id, '') ASC`,
      );
      return timed("listObservations", { ...validated }, () =>
        (statement.all(...params) as unknown[]).map(rowToCounter),
      );
    },
  };
}
