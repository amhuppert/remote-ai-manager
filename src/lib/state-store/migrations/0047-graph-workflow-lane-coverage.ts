import type { StateMigration } from "./types";
import {
  enforceCurrentSchemaCompatibility,
  publishSchemaCompatibilityBarrier,
} from "../schema-compatibility";
import { KNOWN_SCHEMA_VERSION } from "../state-db";

import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";

const MIGRATION_SCHEMA_VERSION = 17;
const logger = createLogger("state-store.graph-workflow-coverage-cutover");
const rowSchema = z.object({
  project_path: z.string(),
  session_name: z.string(),
  execution_id: z.string(),
  runtime_json: z.string(),
  definition_json: z.string(),
});
const coverageStateSchema = graphWorkflowExecutionSchema
  .pick({
    contextStates: true,
    executionLanes: true,
    joins: true,
  })
  .passthrough();

const coverageDefinitionSchema = graphWorkflowExecutionSchema.pick({
  workingDefinition: true,
});

export const graphWorkflowLaneCoverage: StateMigration = {
  name: "0047-graph-workflow-lane-coverage",
  up: async ({ context: { db, configDir } }) => {
    if (
      !db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'graph_workflow_executions'",
        )
        .get()
    )
      return;
    if (configDir !== null)
      await publishSchemaCompatibilityBarrier(
        configDir,
        MIGRATION_SCHEMA_VERSION,
      );
    db.exec(`CREATE TABLE IF NOT EXISTS graph_workflow_coverage_cutover_backups (
      execution_id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      session_name TEXT NOT NULL,
      runtime_json TEXT NOT NULL
    )`);
    const converted = db
      .transaction(() => {
        enforceCurrentSchemaCompatibility(db, db.name, KNOWN_SCHEMA_VERSION);
        const rows = z.array(rowSchema).parse(
          db
            .prepare(
              `
        SELECT project_path, session_name, execution_id, runtime_json, definition_json
        FROM graph_workflow_executions
        WHERE status NOT IN ('completed', 'aborted')
        AND execution_id NOT IN (SELECT execution_id FROM graph_workflow_coverage_cutover_backups)
      `,
            )
            .all(),
        );
        for (const row of rows) {
          const runtime = coverageStateSchema.parse(
            JSON.parse(row.runtime_json),
          );
          const { workingDefinition } = coverageDefinitionSchema.parse(
            JSON.parse(row.definition_json),
          );
          for (const lane of Object.values(runtime.executionLanes)) {
            lane.includedContextIds = Object.values(runtime.contextStates)
              .filter((state) => {
                if (
                  state.status !== "completed" ||
                  state.laneId !== lane.laneId
                )
                  return false;
                if (
                  workingDefinition.executionContexts.find(
                    (context) => context.id === state.contextId,
                  )?.placement.mode === "readOnly"
                )
                  return true;
                const intent = state.landingIntent;
                if (intent)
                  return (
                    intent.mode === "lane_commit" &&
                    intent.state === "landed" &&
                    intent.laneId === lane.laneId
                  );
                return lane.commitSnapshots.some(
                  (snapshot) => snapshot.contextId === state.contextId,
                );
              })
              .map((state) => state.contextId);
          }
          for (const join of Object.values(runtime.joins)) {
            if (join.status === "succeeded") continue;
            join.sourceLaneContextIds = Object.fromEntries(
              join.sourceLaneIds.map((laneId) => [
                laneId,
                [...(runtime.executionLanes[laneId]?.includedContextIds ?? [])],
              ]),
            );
            join.mergedSourceLaneIds = [];
            join.validationDebtSourceLaneIds = [];
            join.validationEvidence = [];
            if (join.status === "running") join.status = "pending";
          }
          db.prepare(
            `INSERT INTO graph_workflow_coverage_cutover_backups
          (execution_id, project_path, session_name, runtime_json) VALUES (?, ?, ?, ?)`,
          ).run(
            row.execution_id,
            row.project_path,
            row.session_name,
            row.runtime_json,
          );
          const write = db
            .prepare(
              `UPDATE graph_workflow_executions SET runtime_json = ?
          WHERE project_path = ? AND session_name = ? AND execution_id = ? AND runtime_json = ? AND definition_json = ?`,
            )
            .run(
              JSON.stringify(runtime),
              row.project_path,
              row.session_name,
              row.execution_id,
              row.runtime_json,
              row.definition_json,
            );
          if (write.changes !== 1)
            throw new Error(
              `Execution ${row.execution_id} changed during lane coverage cutover`,
            );
        }
        db.prepare(
          "INSERT OR IGNORE INTO schema_migrations (version, description) VALUES (?, ?)",
        ).run(
          MIGRATION_SCHEMA_VERSION,
          "Graph workflow coverage and sole runtime ownership",
        );
        return rows.map((row) => row.execution_id);
      })
      .immediate();
    logger.info("graph-workflow.coverage_cutover.completed", {
      executionIds: converted,
      count: converted.length,
    });
  },
};
