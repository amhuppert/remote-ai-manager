import type { StateMigration } from "./types";
import { dropLegacyRoadmapItems } from "./0001-drop-legacy-roadmap-items";

/**
 * Ordered registry of state-store migrations. Append new migrations here in
 * sequence; each must be idempotent and named with a zero-padded numeric prefix
 * so lexicographic ordering matches intended run order. See `migrator.ts` for
 * the runner and `README.md` in this directory for the authoring recipe.
 */
export const migrations: readonly StateMigration[] = [dropLegacyRoadmapItems];

export type { MigrationContext, StateMigration } from "./types";
