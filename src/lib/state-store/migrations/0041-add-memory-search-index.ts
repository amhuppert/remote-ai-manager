import { MEMORY_SEARCH_SCHEMA_DDL } from "../state-db";
import type { StateMigration } from "./types";

/**
 * Create `memory_notes_fts`, the derived FTS5 index over the Memory Note rows
 * (spec `memory`, D1). The synchronous schema floor already creates it on every
 * open, so on a floor-initialized database this is a no-op; the migration
 * records the change in the ordered ledger and applies the identical DDL
 * (shared constant, no hand-synced copy) to any database that predates the
 * floor entry.
 *
 * The table is derived state and carries no rows of its own here: a database
 * that already holds notes repopulates the index through the repository's
 * rebuild, which is the same write path the incremental updates use.
 *
 * Purely additive, so no KNOWN_SCHEMA_VERSION bump.
 */
export const addMemorySearchIndex: StateMigration = {
  name: "0041-add-memory-search-index",
  up: async ({ context }) => {
    context.db.exec(MEMORY_SEARCH_SCHEMA_DDL);
  },
};
