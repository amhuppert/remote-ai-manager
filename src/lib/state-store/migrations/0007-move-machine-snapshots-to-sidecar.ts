import type { Snapshot } from "xstate";
import { createLogger } from "@/lib/logging";
import { toPersistedConversationSnapshot } from "@/lib/workflows/conversation/persisted-snapshot-codec";
import type { StateMigration } from "./types";

const logger = createLogger(
  "state-store/migrations/0007-move-machine-snapshots-to-sidecar",
);

interface SnapshotSourceRow {
  id: string;
  machine_snapshot: string | null;
}

/**
 * One parent table's snapshot column and the sidecar `owner` discriminator it
 * migrates under. `machine_snapshot` lived on both `conversations` (session
 * conversations) and `project_conversations` (project conversations); each moves
 * into the shared sidecar tagged with its owner.
 */
interface ParentSource {
  table: "conversations" | "project_conversations";
  owner: "session" | "project";
}

const PARENT_SOURCES: readonly ParentSource[] = [
  { table: "conversations", owner: "session" },
  { table: "project_conversations", owner: "project" },
];

/**
 * Project a raw persisted snapshot blob into the resume-token form the sidecar
 * stores. Returns null for a blob that is not a JSON object — an unparseable /
 * non-object snapshot has no resumable shape, so no sidecar row is created for
 * it (the caller still clears the source column so the migration converges).
 */
function projectRawSnapshot(rawJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const projected = toPersistedConversationSnapshot(
    parsed as Snapshot<unknown>,
  );
  return JSON.stringify(projected);
}

/**
 * One-time move of the conversation machine snapshot off the hot parent rows and
 * into the dedicated `conversation_machine_snapshots` sidecar, applying the
 * resume-token projection (drops `lastResult.contentBlocks` and the `children`
 * subtree) as it copies. The source column is NULLed after a successful copy so
 * older builds — which read the column as "no snapshot" — stay forward
 * compatible. A whole new table (rather than an additive column) sidesteps the
 * additive-column `next build` race documented in PERFORMANCE lore.
 *
 * Idempotent: `WHERE machine_snapshot IS NOT NULL` is the replay guard — after a
 * successful pass the column is NULL, so a replay processes nothing. The
 * sidecar `ON CONFLICT … DO UPDATE` makes a partial-then-replay converge. An
 * unparseable / non-object blob creates no sidecar row but is still cleared
 * (logged first), so the migration converges instead of re-scanning that row on
 * every startup and leaving a snapshot payload on the parent forever.
 */
export const moveMachineSnapshotsToSidecar: StateMigration = {
  name: "0007-move-machine-snapshots-to-sidecar",
  up: async ({ context }) => {
    const { db } = context;

    const insertSidecar = db.prepare(
      `INSERT INTO conversation_machine_snapshots (
         owner, conversation_id, snapshot_json, updated_at
       ) VALUES (@owner, @conversation_id, @snapshot_json, @updated_at)
       ON CONFLICT(owner, conversation_id) DO UPDATE SET
         snapshot_json = excluded.snapshot_json,
         updated_at    = excluded.updated_at`,
    );

    const now = new Date().toISOString();
    let snapshotsMoved = 0;
    let blobsCleared = 0;

    for (const { table, owner } of PARENT_SOURCES) {
      const selectRows = db.prepare(
        `SELECT id, machine_snapshot FROM ${table}
          WHERE machine_snapshot IS NOT NULL`,
      );
      const clearSource = db.prepare(
        `UPDATE ${table} SET machine_snapshot = NULL WHERE id = ?`,
      );

      const run = db.transaction(() => {
        const rows = selectRows.all() as SnapshotSourceRow[];
        for (const row of rows) {
          if (row.machine_snapshot === null) continue;
          const projected = projectRawSnapshot(row.machine_snapshot);
          if (projected === null) {
            // Unusable blob: no resumable shape, so no sidecar row — but still
            // clear the column so the migration converges. Log it first because
            // clearing discards data (that data was already unresumable).
            logger.warn(
              "state-store.migrations.machine_snapshot_unparseable_cleared",
              { table, owner, id: row.id },
            );
            clearSource.run(row.id);
            blobsCleared += 1;
            continue;
          }
          insertSidecar.run({
            owner,
            conversation_id: row.id,
            snapshot_json: projected,
            updated_at: now,
          });
          clearSource.run(row.id);
          snapshotsMoved += 1;
        }
      });
      run();
    }

    logger.info("state-store.migrations.move_machine_snapshots_to_sidecar", {
      snapshotsMoved,
      blobsCleared,
    });
  },
};
