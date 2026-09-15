import type { StateMigration } from "./types";
import { z } from "zod";
import { createLogger } from "@/lib/logging";

const logger = createLogger("state-store.graph-workflow-review-origin");
const rowsSchema = z.array(
  z.object({
    project_path: z.string(),
    session_name: z.string(),
    execution_id: z.string(),
    runtime_json: z.string(),
  }),
);
const runtimeSchema = z
  .object({
    contextStates: z.record(
      z.string(),
      z
        .object({
          status: z.string(),
          iterationCount: z.number().optional(),
          completedTaskCount: z.number().optional(),
          reviewOrigin: z.unknown().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const graphWorkflowReviewOrigin: StateMigration = {
  name: "0049-graph-workflow-review-origin",
  up: async ({ context: { db } }) => {
    const hasTable = (name: string): boolean =>
      Boolean(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          )
          .get(name),
      );
    if (!hasTable("graph_workflow_executions")) return;
    const resetContexts = hasTable("graph_workflow_events")
      ? db.prepare(`SELECT DISTINCT context_id FROM graph_workflow_events
          WHERE project_path = ? AND session_name = ? AND execution_id = ? AND pre_reset = 1`)
      : null;
    const converted = db
      .transaction(() => {
        const rows = rowsSchema.parse(
          db
            .prepare(
              `SELECT project_path, session_name, execution_id, runtime_json
        FROM graph_workflow_executions`,
            )
            .all(),
        );
        let contexts = 0;
        for (const row of rows) {
          const runtime = runtimeSchema.parse(JSON.parse(row.runtime_json));
          const resetIds = new Set(
            resetContexts === null
              ? []
              : z
                  .array(z.object({ context_id: z.string().nullable() }))
                  .parse(
                    resetContexts.all(
                      row.project_path,
                      row.session_name,
                      row.execution_id,
                    ),
                  )
                  .map((entry) => entry.context_id),
          );
          let changed = false;
          for (const [id, state] of Object.entries(runtime.contextStates)) {
            if (Object.hasOwn(state, "reviewOrigin")) continue;
            if (
              state.status === "pending" &&
              (state.iterationCount ?? 0) === 0 &&
              (state.completedTaskCount ?? 0) === 0 &&
              !resetIds.has(id)
            )
              continue;
            state.reviewOrigin = null;
            changed = true;
            contexts += 1;
          }
          if (!changed) continue;
          const result = db
            .prepare(
              `UPDATE graph_workflow_executions SET runtime_json = ?
          WHERE project_path = ? AND session_name = ? AND execution_id = ? AND runtime_json = ?`,
            )
            .run(
              JSON.stringify(runtime),
              row.project_path,
              row.session_name,
              row.execution_id,
              row.runtime_json,
            );
          if (result.changes !== 1)
            throw new Error(
              `Execution ${row.execution_id} changed during review-origin cutover`,
            );
        }
        return contexts;
      })
      .immediate();
    logger.info("graph-workflow.review_origin.cutover_completed", {
      unavailableContextCount: converted,
    });
  },
};
