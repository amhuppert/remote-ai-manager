import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { StateMigration } from "./types";

const logger = createLogger("state-store/migrations");

const MIGRATION_NAME = "0024-collab-lane-flow-agent-ids";

/**
 * NUL is the lane storage-key separator (`laneStorageKey` in
 * `workflows/primitives/lane-vocabulary.ts`). Spelled via `fromCharCode` so
 * this source file carries no raw NUL byte.
 */
const LANE_KEY_SEPARATOR = String.fromCharCode(0);

/**
 * Only collaboration lanes ever used a bare backend name as their lane id, so
 * this exact-match predicate is the collaboration filter: graph-workflow lane
 * ids are structured strings that never equal a backend name.
 */
const LEGACY_COLLAB_LANE_IDS = new Set(["claude", "codex"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseRecordColumn(
  raw: string | null,
  column: string,
  rowid: number,
): Record<string, unknown> {
  if (!raw) return {};
  try {
    return asRecord(JSON.parse(raw)) ?? {};
  } catch (err) {
    logger.warn("migration.collab_lane_flow_agent_ids.unparseable_column", {
      column,
      rowid,
      error: getErrorMessage(err),
    });
    return {};
  }
}

/**
 * Agent One's backend for a collaboration envelope, from either snapshot
 * shape: the user-origin snapshot carries `primaryAgentBackend`; the
 * workflow-origin snapshot carries Agent Two's backend inside
 * `resolvedConfig.secondAgent.value.backend` and Agent One is its opposite
 * (the pairing rule at the time these envelopes were written). Null when the
 * envelope does not describe a collaboration pairing.
 */
function agentOneBackendFor(envelope: unknown): string | null {
  const snapshot = asRecord(asRecord(envelope)?.["featureSnapshot"]);
  if (!snapshot) return null;
  const primary = snapshot["primaryAgentBackend"];
  if (primary === "claude" || primary === "codex") return primary;
  const secondBackend = asRecord(
    asRecord(asRecord(snapshot["resolvedConfig"])?.["secondAgent"])?.["value"],
  )?.["backend"];
  if (secondBackend === "claude") return "codex";
  if (secondBackend === "codex") return "claude";
  return null;
}

/**
 * Re-keys persisted collaboration lane rows from backend-named lane ids
 * (`claude` / `codex`) to flow-agent lane ids (`agent_one` / `agent_two`),
 * mapping each lane through its owning envelope: the lane whose backend is
 * Agent One's becomes `agent_one`, the other `agent_two`. A legacy lane with
 * no owning collaboration envelope in the same session row is dead and is
 * dropped.
 *
 * Idempotent by predicate: only bare backend-named lane ids match, and the
 * rewrite produces flow-agent ids that never match again. A replay that finds
 * the target key already present keeps the existing target and drops the
 * legacy duplicate, so partial writes converge.
 *
 * No `KNOWN_SCHEMA_VERSION` bump: an older build reading flow-agent lane ids
 * parses them fine (`laneId` is a free string) — it merely fails to find its
 * backend-named lane and seeds a fresh one, a per-workflow continuity loss,
 * not a set-read failure.
 */
export const collabLaneFlowAgentIds: StateMigration = {
  name: MIGRATION_NAME,
  async up({ context }) {
    const { db } = context;
    const rows = db
      .prepare(
        "SELECT rowid AS rowid, workflow_lanes, workflow_envelopes FROM sessions WHERE workflow_lanes IS NOT NULL AND workflow_lanes != ''",
      )
      .all() as Array<{
      rowid: number;
      workflow_lanes: string | null;
      workflow_envelopes: string | null;
    }>;

    const update = db.prepare(
      "UPDATE sessions SET workflow_lanes = ? WHERE rowid = ?",
    );

    let rekeyed = 0;
    let dropped = 0;
    for (const row of rows) {
      const lanes = parseRecordColumn(
        row.workflow_lanes,
        "workflow_lanes",
        row.rowid,
      );
      const envelopes = parseRecordColumn(
        row.workflow_envelopes,
        "workflow_envelopes",
        row.rowid,
      );

      let changed = false;
      for (const key of Object.keys(lanes)) {
        const sep = key.indexOf(LANE_KEY_SEPARATOR);
        if (sep <= 0) continue;
        const workflowId = key.slice(0, sep);
        const laneId = key.slice(sep + 1);
        if (!LEGACY_COLLAB_LANE_IDS.has(laneId)) continue;

        const agentOneBackend = agentOneBackendFor(envelopes[workflowId]);
        if (agentOneBackend === null) {
          delete lanes[key];
          dropped += 1;
          changed = true;
          continue;
        }

        const flowAgent =
          laneId === agentOneBackend ? "agent_one" : "agent_two";
        const newKey = `${workflowId}${LANE_KEY_SEPARATOR}${flowAgent}`;
        if (lanes[newKey] === undefined) {
          const lane = asRecord(lanes[key]);
          lanes[newKey] =
            lane !== null ? { ...lane, laneId: flowAgent } : lanes[key];
          rekeyed += 1;
        } else {
          dropped += 1;
        }
        delete lanes[key];
        changed = true;
      }

      if (changed) {
        update.run(JSON.stringify(lanes), row.rowid);
      }
    }

    logger.info("migration.collab_lane_flow_agent_ids", {
      sessionRows: rows.length,
      rekeyed,
      dropped,
    });
  },
};
