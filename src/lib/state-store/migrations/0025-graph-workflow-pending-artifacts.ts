import { GRAPH_WORKFLOW_PENDING_ARTIFACTS_SCHEMA_DDL } from "../state-db";
import type { StateMigration } from "./types";

/**
 * The launch-artifact reconstruction table (D7 R3.4), in one additive
 * migration.
 *
 * Purely additive — an older build simply never reads the table, and the runs it
 * starts materialize inside their own launch as before — so deliberately no
 * KNOWN_SCHEMA_VERSION bump. The synchronous floor already creates it on every
 * open; this entry records the change in the ordered ledger and applies the
 * identical DDL (shared constant, no hand-synced copy) to any database that
 * predates the floor entry.
 *
 * Idempotent by construction: the DDL guards with IF NOT EXISTS and there is no
 * row to backfill — a pending record only ever describes a launch that has not
 * finished materializing, and every pre-migration launch already did.
 */
export const graphWorkflowPendingArtifacts: StateMigration = {
  name: "0025-graph-workflow-pending-artifacts",
  up: async ({ context }) => {
    context.db.exec(GRAPH_WORKFLOW_PENDING_ARTIFACTS_SCHEMA_DDL);
  },
};
