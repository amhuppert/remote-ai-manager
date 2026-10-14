import { z } from "zod";
import { enforceCurrentSchemaCompatibility } from "../schema-compatibility";
import {
  CUTOVER_GATE_ADMISSIONS_DDL,
  CUTOVER_NOTIFICATIONS_DDL,
  CUTOVER_SUBSCRIPTIONS_DDL,
} from "./cutover-schema";
import type { MigrationContext, StateMigration } from "./types";

type Db = MigrationContext["db"];
const columnSchema = z.object({ name: z.string() });
const sqlSchema = z.object({ sql: z.string() });

function hasColumn(db: Db, table: string, column: string): boolean {
  return z
    .array(columnSchema)
    .parse(db.pragma(`table_info(${table})`))
    .some((columnInfo) => columnInfo.name === column);
}

function tableSql(db: Db, table: string): string | null {
  const raw = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(table);
  return raw === undefined ? null : sqlSchema.parse(raw).sql;
}

/** Rebuild a leaf without letting an old table retain the new indexes' names. */
function rebuild(db: Db, table: string, ddl: string): void {
  const statement = new RegExp(
    `CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n  \\);`,
  ).exec(ddl)?.[0];
  if (statement === undefined)
    throw new Error(`Missing frozen cutover DDL for ${table}`);
  db.exec(statement.replace(`IF NOT EXISTS ${table}`, `${table}_cutover`));
  const oldColumns = new Set(
    z
      .array(columnSchema)
      .parse(db.pragma(`table_info(${table})`))
      .map((columnInfo) => columnInfo.name),
  );
  const columns = z
    .array(columnSchema)
    .parse(db.pragma(`table_info(${table}_cutover)`))
    .map((columnInfo) => columnInfo.name)
    .filter((name: string) => oldColumns.has(name));
  const projection = columns.map((name: string) => `"${name}"`).join(",");
  db.exec(`INSERT INTO ${table}_cutover (${projection}) SELECT ${projection} FROM ${table};
    DROP TABLE ${table}; ALTER TABLE ${table}_cutover RENAME TO ${table};`);
  // Other tables in the same frozen DDL already exist; only this leaf's indexes were removed.
  db.exec(ddl);
}

export const retireGraphEngineStorage: StateMigration = {
  name: "0070-retire-graph-engine-storage",
  async up({ context }) {
    const db = context.db;
    db.transaction(() => {
      enforceCurrentSchemaCompatibility(db, db.name, 30);
      for (const table of [
        "conversation_subscriptions",
        "conversation_subscription_deliveries",
      ]) {
        const row = db
          .prepare(
            `SELECT 1 FROM ${table} WHERE source_kind='workflow' LIMIT 1`,
          )
          .get();
        if (row !== undefined)
          throw new Error(
            `0069 must retire workflow rows in ${table} before storage removal`,
          );
      }
      if (
        db
          .prepare(
            "SELECT 1 FROM notifications WHERE source='workflow' OR spec_gate IN ('execution_start','delivery') LIMIT 1",
          )
          .get() !== undefined ||
        db
          .prepare(
            "SELECT 1 FROM spec_gate_admissions WHERE gate IN ('execution_start','delivery') LIMIT 1",
          )
          .get() !== undefined
      ) {
        throw new Error(
          "0069 must retire graph and delivery gate rows before storage removal",
        );
      }
      for (const table of [
        "spec_delivery_plan_candidate_approvals",
        "spec_delivery_plan_comments",
        "spec_delivery_plan_snapshots",
        "spec_delivery_plan_attempts",
        "spec_delivery_discoveries",
        "spec_criterion_dispositions",
        "spec_task_claims",
        "spec_acceptance_reviews",
        "spec_waivers",
        "spec_proof_verdicts",
        "spec_evidence",
        "spec_delivery_verdicts",
        "spec_execution_bindings",
      ])
        db.exec(`DROP TABLE IF EXISTS ${table}`);
      if (hasColumn(db, "spec_gate_admissions", "execution_id"))
        rebuild(db, "spec_gate_admissions", CUTOVER_GATE_ADMISSIONS_DDL);
      db.exec("DROP TABLE IF EXISTS spec_executions");
      db.exec(`DROP TRIGGER IF EXISTS trg_conversation_machine_snapshots_session_cleanup;
        DROP TRIGGER IF EXISTS trg_conversation_machine_snapshots_project_cleanup;`);
      for (const [table, columns] of [
        ["spec_revisions", ["external_delivery_json"]],
        [
          "job_records",
          [
            "execution_id",
            "spec_execution_id",
            "final_publish",
            "candidate_validation",
          ],
        ],
        ["conversations", ["machine_snapshot"]],
        ["project_conversations", ["machine_snapshot"]],
      ] as const) {
        for (const column of columns)
          if (hasColumn(db, table, column))
            db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
      }
      for (const table of [
        "graph_workflow_executions",
        "graph_workflow_archived_executions",
        "graph_workflow_events",
        "graph_workflow_result_deliveries",
        "graph_workflow_pending_artifacts",
        "graph_plan_reviews",
        "graph_workflow_coverage_cutover_backups",
        "conversation_machine_snapshots",
        "core_interactive_conversations",
        "agent_run_records",
      ])
        db.exec(`DROP TABLE IF EXISTS ${table}`);
      for (const table of [
        "conversation_subscriptions",
        "conversation_subscription_deliveries",
      ]) {
        if (tableSql(db, table)?.includes("'workflow'"))
          rebuild(db, table, CUTOVER_SUBSCRIPTIONS_DDL);
      }
      if (hasColumn(db, "notifications", "workflow_execution_id"))
        rebuild(db, "notifications", CUTOVER_NOTIFICATIONS_DDL);
    }).immediate();
  },
};
