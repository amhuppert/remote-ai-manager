import {
  addColumnToleratingRace,
  VALIDATION_RUNS_SCHEMA_DDL,
} from "../state-db";
import type { StateMigration } from "./types";

/**
 * Add nullable session attribution to retained validation timing rows. The
 * synchronous schema floor carries the same column for fresh databases; this
 * migration covers databases created before that floor and is replay-safe.
 */
export const validationRunSessionName: StateMigration = {
  name: "0014-validation-run-session-name",
  up: async ({ context }) => {
    context.db.exec(VALIDATION_RUNS_SCHEMA_DDL);
    const columns = context.db.pragma("table_info(validation_runs)") as Array<{
      name: string;
    }>;
    if (columns.some((column) => column.name === "session_name")) return;
    addColumnToleratingRace(
      context.db,
      "validation_runs",
      "session_name",
      "TEXT",
    );
  },
};
