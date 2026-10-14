import type { StateMigration } from "./types";
import { graphEngineCutover } from "./0069-graph-engine-cutover";
import { retireGraphEngineStorage } from "./0070-retire-graph-engine-storage";

/**
 * Ordered registry of state-store migrations newer than the history retired at
 * overhaul-deploy-1.5 (`../migration-history.ts`). Append new migrations here
 * in sequence; each must be idempotent and named with a zero-padded numeric
 * prefix so lexicographic ordering matches intended run order. See
 * `migrator.ts` for the runner and `README.md` in this directory for the
 * authoring recipe.
 */
export const migrations: readonly StateMigration[] = [
  graphEngineCutover,
  retireGraphEngineStorage,
];

export type { StateMigration } from "./types";
