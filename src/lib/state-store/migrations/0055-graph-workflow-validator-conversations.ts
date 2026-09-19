import {
  enforceCurrentSchemaCompatibility,
  publishSchemaCompatibilityBarrier,
} from "../schema-compatibility";
import { KNOWN_SCHEMA_VERSION } from "../state-db";
import type { StateMigration } from "./types";

export const GRAPH_WORKFLOW_VALIDATOR_CONVERSATIONS_SCHEMA_VERSION = 22;

/**
 * Validator assignments no longer carry a `strategy`, and graph lanes no
 * longer persist a backend session ref: every lane is one durable CC
 * conversation. Older builds require both, and listActive() eagerly decodes
 * every execution, so one new lane or definition would break the entire result
 * set on an older build. Fence those builds without rewriting or discarding
 * any saved execution or workflow.
 */
export const graphWorkflowValidatorConversations: StateMigration = {
  name: "0055-graph-workflow-validator-conversations",
  up: async ({ context }) => {
    const { db } = context;
    if (context.configDir !== null) {
      await publishSchemaCompatibilityBarrier(
        context.configDir,
        GRAPH_WORKFLOW_VALIDATOR_CONVERSATIONS_SCHEMA_VERSION,
      );
    }
    db.transaction(() => {
      enforceCurrentSchemaCompatibility(db, db.name, KNOWN_SCHEMA_VERSION);
      db.prepare(
        "INSERT OR IGNORE INTO schema_migrations (version, description) VALUES (?, ?)",
      ).run(
        GRAPH_WORKFLOW_VALIDATOR_CONVERSATIONS_SCHEMA_VERSION,
        "graph workflow validators run on one durable conversation per assignment",
      );
    }).immediate();
  },
};
