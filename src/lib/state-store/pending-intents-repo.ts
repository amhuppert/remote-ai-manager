import type Database from "better-sqlite3";
import { z } from "zod";
import {
  ownerRefSchema,
  pendingIntentSchema,
  type ExecutorKind,
  type OwnerRef,
  type PendingIntent,
} from "@/lib/intents/schemas";

type Db = InstanceType<typeof Database>;

const rowSchema = z.object({
  id: z.string(),
  requester_kind: z.string(),
  requester_id: z.string(),
  executor: z.string(),
  cause: z.string(),
  permit_controller_id: z.string().nullable(),
  permit_generation: z.number().int().nullable(),
  request_json: z.string(),
  recorded_at: z.string(),
});

const COLUMNS = `id, requester_kind, requester_id, executor, cause,
  permit_controller_id, permit_generation, request_json, recorded_at`;

function fromRow(raw: unknown): PendingIntent {
  const row = rowSchema.parse(raw);
  return pendingIntentSchema.parse({
    id: row.id,
    requester: { kind: row.requester_kind, id: row.requester_id },
    executor: row.executor,
    cause: row.cause,
    permit:
      row.permit_controller_id === null || row.permit_generation === null
        ? null
        : {
            controllerId: row.permit_controller_id,
            generation: row.permit_generation,
          },
    request: JSON.parse(row.request_json),
    recordedAt: row.recorded_at,
  });
}

/** Sole writer of `pending_intents`; the intent ledger owns the rules. */
export interface PendingIntentsRepo {
  /** Inserts unless an intent with the same executor and cause exists. */
  insertIfAbsent(intent: PendingIntent): void;
  getByCause(executor: ExecutorKind, cause: string): PendingIntent | null;
  listByRequester(requester: OwnerRef): PendingIntent[];
  listRequesters(): OwnerRef[];
  delete(id: string): void;
}

export function createPendingIntentsRepo(db: Db): PendingIntentsRepo {
  const insertStmt = db.prepare(
    `INSERT OR IGNORE INTO pending_intents (${COLUMNS})
     VALUES (@id, @requesterKind, @requesterId, @executor, @cause,
             @permitControllerId, @permitGeneration, @requestJson, @recordedAt)`,
  );
  const byCauseStmt = db.prepare(
    `SELECT ${COLUMNS} FROM pending_intents WHERE executor = ? AND cause = ?`,
  );
  const byRequesterStmt = db.prepare(
    `SELECT ${COLUMNS} FROM pending_intents
      WHERE requester_kind = ? AND requester_id = ?
      ORDER BY recorded_at, rowid`,
  );
  const requestersStmt = db.prepare(
    `SELECT DISTINCT requester_kind AS kind, requester_id AS id
       FROM pending_intents ORDER BY requester_kind, requester_id`,
  );
  const deleteStmt = db.prepare(`DELETE FROM pending_intents WHERE id = ?`);
  return {
    insertIfAbsent(intent) {
      const parsed = pendingIntentSchema.parse(intent);
      insertStmt.run({
        id: parsed.id,
        requesterKind: parsed.requester.kind,
        requesterId: parsed.requester.id,
        executor: parsed.executor,
        cause: parsed.cause,
        permitControllerId: parsed.permit?.controllerId ?? null,
        permitGeneration: parsed.permit?.generation ?? null,
        requestJson: JSON.stringify(parsed.request ?? null),
        recordedAt: parsed.recordedAt,
      });
    },
    getByCause(executor, cause) {
      const raw: unknown = byCauseStmt.get(executor, cause);
      return raw === undefined ? null : fromRow(raw);
    },
    listByRequester(requester) {
      return byRequesterStmt.all(requester.kind, requester.id).map(fromRow);
    },
    listRequesters() {
      return z.array(ownerRefSchema).parse(requestersStmt.all());
    },
    delete(id) {
      deleteStmt.run(id);
    },
  };
}
