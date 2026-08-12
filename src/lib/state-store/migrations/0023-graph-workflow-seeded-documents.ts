import {
  enforceCurrentSchemaCompatibility,
  publishSchemaCompatibilityBarrier,
} from "../schema-compatibility";
import { KNOWN_SCHEMA_VERSION } from "../state-db";
import type { StateMigration } from "./types";

const MIGRATION_SCHEMA_VERSION = 7;
const MIGRATION_SCHEMA_DESCRIPTION =
  "graph-workflow shared documents carry the engine-seeded kind";

/**
 * BREAKING migration, and nothing but the fence: the seeded shared-document
 * kind widens a vocabulary, it does not move any stored bytes, so there is no
 * row to rewrite and no backfill to make idempotent.
 *
 * What the fence buys: a `sharedDocuments` entry with `kind:"seeded"` is
 * written into `graph_workflow_executions.runtime_json` whenever a launching
 * tier seeds a document, and `graph-workflow-executions-repo` throws a
 * PersistenceError on a kind its enum does not admit — from `listActive()`,
 * which decodes every row, so one seeded execution makes an older build lose
 * the workflow state of every session rather than of the seeded run. That is
 * the 0017 situation exactly (a widened persisted vocabulary whose repository
 * throws rather than quarantines), and it takes the same answer: refuse the
 * older reader at open time. The documented rollout requirement to quiesce
 * older open workers applies.
 *
 * The stamp is unconditional, fresh floor-created databases included: a fresh
 * database already admits the wide vocabulary, so leaving it unstamped would
 * let an older build open the one database most likely to receive a seeded run.
 */
export const graphWorkflowSeededDocuments: StateMigration = {
  name: "0023-graph-workflow-seeded-documents",
  up: async ({ context }) => {
    const { db } = context;
    // Fail-closed external barrier before SQLite can expose seeded-kind bytes:
    // an older build reopening mid-cutover is refused by the config-directory
    // marker before the in-database stamp is visible to it. A rolled-back
    // transaction leaves it published, which is the safe direction.
    if (context.configDir !== null) {
      await publishSchemaCompatibilityBarrier(
        context.configDir,
        MIGRATION_SCHEMA_VERSION,
      );
    }
    db.transaction(() => {
      // Recheck under the write lock, witnessing the BUILD's known version
      // (0006 precedent) so a same-build replay after any future cutover still
      // converges while a genuinely newer build's advance refuses.
      enforceCurrentSchemaCompatibility(db, db.name, KNOWN_SCHEMA_VERSION);
      db.prepare(
        `INSERT OR IGNORE INTO schema_migrations (version, description)
         VALUES (?, ?)`,
      ).run(MIGRATION_SCHEMA_VERSION, MIGRATION_SCHEMA_DESCRIPTION);
    }).immediate();
  },
};
