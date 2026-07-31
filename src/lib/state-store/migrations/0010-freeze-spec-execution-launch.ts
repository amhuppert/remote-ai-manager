import type { StateMigration } from "./types";

function hasColumn(
  columns: readonly { name: string }[],
  column: string,
): boolean {
  return columns.some((candidate) => candidate.name === column);
}

export const freezeSpecExecutionLaunch: StateMigration = {
  name: "0010-freeze-spec-execution-launch",
  up: async ({ context }) => {
    const { db } = context;
    const migrate = db.transaction(() => {
      const columns = db.pragma("table_info(spec_executions)") as Array<{
        name: string;
      }>;
      if (!hasColumn(columns, "execution_start_dial")) {
        db.exec(
          "ALTER TABLE spec_executions ADD COLUMN execution_start_dial TEXT CHECK (execution_start_dial IN ('gate', 'notify', 'off'))",
        );
      }
      if (!hasColumn(columns, "workflow_definition_revision")) {
        db.exec(
          "ALTER TABLE spec_executions ADD COLUMN workflow_definition_revision INTEGER CHECK (workflow_definition_revision > 0)",
        );
      }
      // The definition store is mutable and the spec policy is live state, so
      // neither can reconstruct the launch contract of an existing execution.
      // Legacy rows stay null instead of receiving fabricated provenance.
    });
    migrate.immediate();
  },
};
