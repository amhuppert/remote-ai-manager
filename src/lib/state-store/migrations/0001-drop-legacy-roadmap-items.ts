import type { StateMigration } from "./types";

/**
 * Drop the long-removed `roadmap_items` table and its index. These DROPs
 * previously lived in the every-open schema floor (`state-db.ts` `SCHEMA_DDL`);
 * a one-time cleanup belongs in the migration ledger, not in code that re-runs
 * on every connection. Idempotent via `IF EXISTS`, so it is a no-op on fresh
 * databases that never had the table.
 */
export const dropLegacyRoadmapItems: StateMigration = {
  name: "0001-drop-legacy-roadmap-items",
  up: async ({ context }) => {
    context.db.exec(`
      DROP INDEX IF EXISTS idx_roadmap_items_project;
      DROP TABLE IF EXISTS roadmap_items;
    `);
  },
};
