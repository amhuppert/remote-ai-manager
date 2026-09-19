import {
  enforceCurrentSchemaCompatibility,
  publishSchemaCompatibilityBarrier,
} from "../schema-compatibility";
import { KNOWN_SCHEMA_VERSION } from "../state-db";
import type { StateMigration } from "./types";

export const GRAPH_WORKFLOW_CONTINUOUS_CONVERSATIONS_SCHEMA_VERSION = 21;

/**
 * Older graph readers require lane fields that continuous conversations no
 * longer persist. listActive() eagerly decodes every execution, so one new
 * lane would break the entire result set on an older build. Fence those builds
 * without rewriting or discarding any saved execution or workflow.
 */
export const graphWorkflowContinuousConversations: StateMigration = {
  name: "0054-graph-workflow-continuous-conversations",
  up: async ({ context }) => {
    const { db } = context;
    if (context.configDir !== null) {
      await publishSchemaCompatibilityBarrier(
        context.configDir,
        GRAPH_WORKFLOW_CONTINUOUS_CONVERSATIONS_SCHEMA_VERSION,
      );
    }
    db.transaction(() => {
      enforceCurrentSchemaCompatibility(db, db.name, KNOWN_SCHEMA_VERSION);
      db.prepare(
        "INSERT OR IGNORE INTO schema_migrations (version, description) VALUES (?, ?)",
      ).run(
        GRAPH_WORKFLOW_CONTINUOUS_CONVERSATIONS_SCHEMA_VERSION,
        "graph workflow assignments preserve one continuous conversation",
      );
    }).immediate();
  },
};
