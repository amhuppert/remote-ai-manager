import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { graphWorkflowSharedDocumentEntrySchema } from "@/lib/workflow-graph/definition-schemas";
import { createSharedDocumentStore } from "@/lib/workflow-graph/shared-document-store";
import { createGraphWorkflowPendingArtifactsRepo } from "../graph-workflow-pending-artifacts-repo";
import type { StateMigration } from "./types";

const logger = createLogger("state-store.graph-workflow-document-content");
const documentRuntime = z
  .object({
    sharedDocuments: z.array(graphWorkflowSharedDocumentEntrySchema).optional(),
  })
  .passthrough();

/**
 * Convert recoverable publication bytes once, before graph admission opens.
 * Capturing objects is outside SQLite; installing their references compares
 * the complete runtime snapshot so a concurrent writer cannot lose its work.
 */
export const graphWorkflowDocumentContent: StateMigration = {
  name: "0048-graph-workflow-document-content",
  up: async ({ context: { db, configDir } }) => {
    const rows = db
      .prepare(
        `
      SELECT project_path, session_name, execution_id, runtime_json
      FROM graph_workflow_executions
    `,
      )
      .all() as Array<{
      project_path: string;
      session_name: string;
      execution_id: string;
      runtime_json: string;
    }>;
    const store =
      configDir === null
        ? null
        : createSharedDocumentStore({ resolveConfigDir: () => configDir });
    const pendingArtifacts = createGraphWorkflowPendingArtifactsRepo(db);
    const install = db.prepare(`
      UPDATE graph_workflow_executions SET runtime_json = ?
      WHERE project_path = ? AND session_name = ? AND execution_id = ? AND runtime_json = ?
    `);

    for (const row of rows) {
      const runtime = documentRuntime.parse(JSON.parse(row.runtime_json));
      const candidates =
        runtime.sharedDocuments?.filter(
          (entry) =>
            entry.kind !== "charter" && entry.contentHash === undefined,
        ) ?? [];
      if (candidates.length === 0) continue;
      const pending = pendingArtifacts.find(
        row.project_path,
        row.session_name,
        row.execution_id,
      );
      let captured = 0;
      let unavailable = 0;
      for (const entry of candidates) {
        const seed =
          entry.kind === "seeded"
            ? pending?.documents.find(
                (document) => document.relativePath === entry.relativePath,
              )
            : undefined;
        const reference =
          store === null
            ? null
            : seed
              ? await store.captureContent({
                  executionId: row.execution_id,
                  contents: seed.contents,
                })
              : await store.migrateLegacyDocument({
                  executionId: row.execution_id,
                  relativePath: entry.relativePath,
                });
        entry.contentHash = reference?.contentHash ?? null;
        if (reference === null) unavailable += 1;
        else captured += 1;
      }
      const written = install.run(
        JSON.stringify(runtime),
        row.project_path,
        row.session_name,
        row.execution_id,
        row.runtime_json,
      );
      if (written.changes !== 1) {
        logger.warn("graph-workflow.documents.cutover_superseded", {
          executionId: row.execution_id,
        });
        throw new Error(
          `Document cutover superseded for execution ${row.execution_id}; retry before admitting graph work`,
        );
      }
      logger.info("graph-workflow.documents.cutover_completed", {
        executionId: row.execution_id,
        captured,
        unavailable,
      });
    }
  },
};
