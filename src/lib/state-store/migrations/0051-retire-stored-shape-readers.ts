import { randomUUID } from "node:crypto";
import { migrateArchivedExecutionAssignments } from "./0051-archived-execution-shape";
import { enforceCurrentSchemaCompatibility } from "../schema-compatibility";
import { KNOWN_SCHEMA_VERSION } from "../state-db";
import type { MigrationContext, StateMigration } from "./types";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function rewriteSnapshot(value: unknown): boolean {
  const context = asRecord(asRecord(value)?.context);
  if (!context) return false;
  let changed = false;
  const activeTurn = asRecord(context.activeTurn);
  if (activeTurn && !("kind" in activeTurn)) {
    activeTurn.kind = "conversation_turn";
    changed = true;
  }
  const debugMode = asRecord(context.debugMode);
  if (
    debugMode?.active === true &&
    !(
      typeof debugMode.debugSessionId === "string" &&
      debugMode.debugSessionId.length > 0
    )
  ) {
    debugMode.debugSessionId = randomUUID();
    context.debugGenerationNeedsPersistence = true;
    changed = true;
  }
  return changed;
}

type HistoricalBackend = "claude" | "codex";

// Frozen at the retired reader's cutover: never consult today's model catalog
// or defaults to reconstruct the settings a historical collaboration ran with.
function historicalAgent(
  backend: HistoricalBackend,
  settings: unknown,
  codexFastMode: unknown,
) {
  const entry = asRecord(settings);
  if (
    !entry ||
    typeof entry.model !== "string" ||
    (entry.effort !== undefined && typeof entry.effort !== "string")
  ) {
    throw new Error(`Invalid historical collaboration settings for ${backend}`);
  }
  const parameters: Record<string, string> = {};
  if (typeof entry.effort === "string") {
    parameters[backend === "claude" ? "effort" : "reasoning"] = entry.effort;
  }
  if (backend === "codex" && typeof codexFastMode === "boolean") {
    parameters.fast = String(codexFastMode);
  }
  return { backend, modelSelection: { modelId: entry.model, parameters } };
}

function rewriteEnvelopes(value: unknown): boolean {
  const envelopes = asRecord(value);
  if (!envelopes) return false;
  let changed = false;
  for (const value of Object.values(envelopes)) {
    const envelope = asRecord(value);
    if (envelope?.workflowType !== "collaboration") continue;
    const snapshot = asRecord(envelope.featureSnapshot);
    if (!snapshot) continue;
    if (!("origin" in snapshot)) {
      snapshot.origin = "user";
      changed = true;
    }
    const settings = asRecord(snapshot.agentModelSettings);
    if (!settings) continue;
    if (snapshot.agents === undefined) {
      const primary = snapshot.primaryAgentBackend;
      if (primary !== "claude" && primary !== "codex") {
        throw new Error(
          "Historical collaboration has no valid primary backend",
        );
      }
      const secondary = primary === "claude" ? "codex" : "claude";
      snapshot.agents = {
        agent_one: historicalAgent(
          primary,
          settings[primary],
          snapshot.codexFastMode,
        ),
        agent_two: historicalAgent(
          secondary,
          settings[secondary],
          snapshot.codexFastMode,
        ),
      };
    }
    delete snapshot.agentModelSettings;
    delete snapshot.codexFastMode;
    changed = true;
  }
  return changed;
}

function rewriteColumn(
  db: MigrationContext["db"],
  table: string,
  column: string,
  rewrite: (value: unknown) => boolean,
): void {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (!exists) return;
  const rows = db
    .prepare(
      `SELECT rowid, ${column} AS body FROM ${table} WHERE ${column} IS NOT NULL`,
    )
    .all() as Array<{ rowid: number; body: string }>;
  const update = db.prepare(
    `UPDATE ${table} SET ${column} = ? WHERE rowid = ?`,
  );
  for (const row of rows) {
    const value: unknown = JSON.parse(row.body);
    if (rewrite(value)) update.run(JSON.stringify(value), row.rowid);
  }
}

/**
 * Retire snapshot read repairs after both hosts' shape audit. These canonical
 * shapes were already accepted by older builds, so no compatibility bump is
 * needed. One immediate transaction preserves unrelated fields and makes a
 * concurrent worker or crash replay keep the first persisted debug generation.
 */
export const retireStoredShapeReaders: StateMigration = {
  name: "0051-retire-stored-shape-readers",
  up: async ({ context: { db } }) => {
    db.transaction(() => {
      enforceCurrentSchemaCompatibility(db, db.name, KNOWN_SCHEMA_VERSION);
      migrateArchivedExecutionAssignments(db);
      rewriteColumn(
        db,
        "conversation_machine_snapshots",
        "snapshot_json",
        rewriteSnapshot,
      );
      rewriteColumn(db, "sessions", "workflow_envelopes", rewriteEnvelopes);
    }).immediate();
  },
};
