import { VALIDATION_RUNS_SCHEMA_DDL } from "../state-db";
import type { StateMigration } from "./types";

/**
 * Create the `validation_runs` ledger table (design: validation-concurrency
 * §4/§12). The synchronous schema floor already creates the table on every
 * open, so on any floor-initialized database this is a no-op; the migration
 * records the change in the ordered ledger and applies the identical DDL
 * (shared constant, no hand-synced copy) to any database that predates the
 * floor entry. Purely additive — older builds ignore the table, so no
 * KNOWN_SCHEMA_VERSION bump.
 */
export const addValidationRuns: StateMigration = {
  name: "0011-add-validation-runs",
  up: async ({ context }) => {
    context.db.exec(VALIDATION_RUNS_SCHEMA_DDL);
  },
};
