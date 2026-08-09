import {
  addColumnToleratingRace,
  VALIDATION_RUNS_SCHEMA_DDL,
} from "../state-db";
import type { StateMigration } from "./types";

const SCOPE_COLUMNS = [
  {
    name: "requested_scope",
    type: "TEXT CHECK (requested_scope IN ('changed', 'full'))",
  },
  {
    name: "effective_scope",
    type: "TEXT CHECK (effective_scope IN ('changed', 'full'))",
  },
] as const;

/**
 * Add durable requested/effective scope. Explicit legacy paths prove changed
 * execution; a pathless legacy row carries no evidence about wrapper behavior
 * and remains null rather than receiving a fabricated scope.
 */
export const validationRunScopes: StateMigration = {
  name: "0016-validation-run-scopes",
  up: async ({ context }) => {
    const { db } = context;
    db.exec(VALIDATION_RUNS_SCHEMA_DDL);
    const present = new Set(
      (db.pragma("table_info(validation_runs)") as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    for (const column of SCOPE_COLUMNS) {
      if (present.has(column.name)) continue;
      addColumnToleratingRace(db, "validation_runs", column.name, column.type);
    }
    db.prepare(
      `UPDATE validation_runs
          SET requested_scope = 'changed', effective_scope = 'changed'
        WHERE scoped = 1
          AND requested_scope IS NULL
          AND effective_scope IS NULL`,
    ).run();
  },
};
