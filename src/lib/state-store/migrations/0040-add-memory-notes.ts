import { MEMORY_SCHEMA_DDL } from "../state-db";
import type { StateMigration } from "./types";

/**
 * Create the canonical Memory Note tables — `memory_notes`,
 * `memory_note_aliases`, `memory_note_revisions`, and `memory_links` (spec
 * `memory`, D1). The synchronous schema floor already creates them on every
 * open, so on a floor-initialized database this is a no-op; the migration
 * records the change in the ordered ledger and applies the identical DDL
 * (shared constant, no hand-synced copy) to any database that predates the
 * floor entry.
 *
 * Purely additive, exactly like the notepad migrations before it: no existing
 * row moves and no existing read path learns a new vocabulary, so an older
 * build sharing `command-center.db` simply ignores tables it has no reader
 * for. No KNOWN_SCHEMA_VERSION bump.
 */
export const addMemoryNotes: StateMigration = {
  name: "0040-add-memory-notes",
  up: async ({ context }) => {
    context.db.exec(MEMORY_SCHEMA_DDL);
  },
};
