import type Database from "better-sqlite3";
import { z } from "zod";
import { createLogger, type Logger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import { checkRowColumnSize } from "./row-size-telemetry";

type Db = InstanceType<typeof Database>;

/** The logger surface this repo needs: growth-gate warns + row-invalid errors. */
type SnapshotsRepoLogger = Pick<Logger, "warn" | "error">;

const defaultLogger: SnapshotsRepoLogger = createLogger(
  "state-store.conversation-machine-snapshots",
);

/**
 * Which parent table a sidecar snapshot belongs to. `machine_snapshot` lived on
 * two parent rows — `conversations` (session conversations) and
 * `project_conversations` (session-less project conversations) — so an id-only
 * sidecar would have ambiguous ownership. The `owner` discriminator ties each
 * row to its parent repo and lets each parent's delete remove exactly its own
 * sidecar rows.
 */
export type ConversationSnapshotOwner = "session" | "project";

export interface ConversationMachineSnapshotRecord {
  owner: ConversationSnapshotOwner;
  conversationId: string;
  /** The persisted resume-token projection (see `persisted-snapshot-codec`). */
  snapshot: unknown;
  updatedAt: string;
}

/**
 * Focused repository for the `conversation_machine_snapshots` sidecar table.
 * Written only by conversation-snapshot persistence and read only by
 * per-conversation rehydration; the hot `conversations` / `project_conversations`
 * enumerations never touch it. Point operations only (keyed by the composite
 * `(owner, conversation_id)` primary key) — there is no enumeration path, so no
 * versioned-row cache. Follows the `graph_workflow_executions` dedicated-table
 * precedent (PERFORMANCE.md 2026-06-20).
 */
export interface ConversationMachineSnapshotsRepo {
  get(
    owner: ConversationSnapshotOwner,
    conversationId: string,
  ): ConversationMachineSnapshotRecord | null;
  upsert(
    owner: ConversationSnapshotOwner,
    conversationId: string,
    snapshot: unknown,
    updatedAt: string,
  ): void;
  deleteByConversation(
    owner: ConversationSnapshotOwner,
    conversationId: string,
  ): void;
}

const snapshotRowSchema = z.object({
  owner: z.enum(["session", "project"]),
  conversation_id: z.string(),
  snapshot_json: z.string(),
  updated_at: z.string(),
});

/**
 * The parent table each `owner` discriminant points at. The upsert is fenced to
 * the parent's existence (below), so it must name the right table per owner.
 */
const PARENT_TABLE_BY_OWNER: Readonly<
  Record<ConversationSnapshotOwner, "conversations" | "project_conversations">
> = {
  session: "conversations",
  project: "project_conversations",
};

/**
 * Parent-conditional upsert SQL for one owner. The `INSERT … SELECT … WHERE
 * EXISTS(parent)` inserts a row only while the owning conversation still exists,
 * so a debounced snapshot write that fires AFTER the conversation was deleted
 * inserts nothing (and, having inserted nothing, never reaches the `ON CONFLICT`
 * update either). This atomically fences the delayed-write race that would
 * otherwise resurrect an orphan the AFTER DELETE trigger already cleaned up —
 * `parentTable` is a fixed identifier, never caller input.
 */
function parentConditionalUpsertSql(parentTable: string): string {
  return `INSERT INTO conversation_machine_snapshots (
            owner, conversation_id, snapshot_json, updated_at
          )
          SELECT @owner, @conversation_id, @snapshot_json, @updated_at
           WHERE EXISTS (
             SELECT 1 FROM ${parentTable} WHERE id = @conversation_id
           )
          ON CONFLICT(owner, conversation_id) DO UPDATE SET
            snapshot_json = excluded.snapshot_json,
            updated_at    = excluded.updated_at`;
}

export function createConversationMachineSnapshotsRepo(
  db: Db,
  logger: SnapshotsRepoLogger = defaultLogger,
): ConversationMachineSnapshotsRepo {
  const getStmt = db.prepare(
    `SELECT owner, conversation_id, snapshot_json, updated_at
       FROM conversation_machine_snapshots
      WHERE owner = ? AND conversation_id = ?
      LIMIT 1`,
  );
  const upsertStmtByOwner = {
    session: db.prepare(
      parentConditionalUpsertSql(PARENT_TABLE_BY_OWNER.session),
    ),
    project: db.prepare(
      parentConditionalUpsertSql(PARENT_TABLE_BY_OWNER.project),
    ),
  } satisfies Record<ConversationSnapshotOwner, unknown>;
  const deleteStmt = db.prepare(
    `DELETE FROM conversation_machine_snapshots
      WHERE owner = ? AND conversation_id = ?`,
  );

  return {
    get(owner, conversationId) {
      const raw: unknown = getStmt.get(owner, conversationId);
      if (raw === undefined) return null;
      const parsed = snapshotRowSchema.safeParse(raw);
      if (!parsed.success) {
        logger.error("state-store.conversation-machine-snapshots.row_invalid", {
          owner,
          conversationId,
        });
        return null;
      }
      const row = parsed.data;
      let snapshot: unknown;
      try {
        snapshot = JSON.parse(row.snapshot_json);
      } catch (err) {
        // A corrupt blob is not rehydratable; surface it and treat as absent
        // rather than crashing startup rehydration.
        logger.error(
          "state-store.conversation-machine-snapshots.parse_failed",
          { owner, conversationId, error: getErrorMessage(err) },
        );
        return null;
      }
      return {
        owner: row.owner,
        conversationId: row.conversation_id,
        snapshot,
        updatedAt: row.updated_at,
      };
    },
    upsert(owner, conversationId, snapshot, updatedAt) {
      const snapshotJson = JSON.stringify(snapshot);
      // Growth gate: the resume-token projection should stay a few KB, so a
      // snapshot_json crossing the threshold is a projection regression (a large
      // blob leaked back onto the token). Derived here, emitted after the write.
      checkRowColumnSize({
        logger,
        table: "conversation_machine_snapshots",
        column: "snapshot_json",
        id: conversationId,
        value: snapshotJson,
      });
      upsertStmtByOwner[owner].run({
        owner,
        conversation_id: conversationId,
        snapshot_json: snapshotJson,
        updated_at: updatedAt,
      });
    },
    deleteByConversation(owner, conversationId) {
      deleteStmt.run(owner, conversationId);
    },
  };
}
