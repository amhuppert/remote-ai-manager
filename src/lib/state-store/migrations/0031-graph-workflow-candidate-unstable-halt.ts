import {
  enforceCurrentSchemaCompatibility,
  publishSchemaCompatibilityBarrier,
} from "../schema-compatibility";
import { KNOWN_SCHEMA_VERSION } from "../state-db";
import type { StateMigration } from "./types";

const MIGRATION_SCHEMA_VERSION = 10;
const MIGRATION_SCHEMA_DESCRIPTION =
  "graph-workflow halt vocabulary carries candidate_unstable";

/**
 * BREAKING migration, and nothing but the fence: the `candidate_unstable`
 * halt reason (with its `lastIncident` and `summary` payload fields, and the
 * matching `planRepairRounds[].haltType` value) widens persisted vocabularies
 * in `graph_workflow_executions.runtime_json` without moving any stored bytes,
 * so there is no row to rewrite and no backfill to make idempotent.
 *
 * What the fence buys: `graph-workflow-executions-repo` throws a
 * PersistenceError on a halt type its enum does not admit — from
 * `listActive()`, which decodes every row — so one execution halted
 * `candidate_unstable` would make an older build lose the workflow state of
 * every session rather than of the halted run. That is the 0023 situation
 * exactly (a widened persisted vocabulary whose repository throws rather than
 * quarantines), and it takes the same answer: refuse the older reader at open
 * time. The documented rollout requirement to quiesce older open workers
 * applies.
 *
 * The stamp is unconditional, fresh floor-created databases included: a fresh
 * database already admits the wide vocabulary, so leaving it unstamped would
 * let an older build open the one database most likely to receive the new
 * halt.
 */
export const graphWorkflowCandidateUnstableHalt: StateMigration = {
  name: "0031-graph-workflow-candidate-unstable-halt",
  up: async ({ context }) => {
    const { db } = context;
    // Fail-closed external barrier before SQLite can expose the widened
    // vocabulary: an older build reopening mid-cutover is refused by the
    // config-directory marker before the in-database stamp is visible to it. A
    // rolled-back transaction leaves it published, which is the safe direction.
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
