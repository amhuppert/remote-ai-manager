import { MEMORY_TELEMETRY_SCHEMA_DDL } from "../state-db";
import type { StateMigration } from "./types";

/**
 * Create `memory_delivery_watermarks`, `memory_index_delivery_state`, and
 * `memory_observation_counters`: the evaluation instruments R15 defines over
 * Memory Notes and the two tables the once-then-delta index delivery reads
 * before composing. The synchronous schema floor already creates all three on
 * every open, so on a floor-initialized database this is a no-op; the migration records the change in the ordered ledger and
 * applies the identical DDL (shared constant, no hand-synced copy) to any
 * database that predates the floor entry.
 *
 * Nothing they hold is ever read back into ranking or freshness: the watermark
 * and state rows decide only what a delta carries, so a database that never
 * gained them re-delivers full blocks and loses evaluation history, never
 * selection behavior.
 *
 * Purely additive, exactly like `0040-add-memory-notes` and
 * `0041-add-memory-search-index`, so no KNOWN_SCHEMA_VERSION bump.
 */
export const addMemoryTelemetry: StateMigration = {
  name: "0042-add-memory-telemetry",
  up: async ({ context }) => {
    context.db.exec(MEMORY_TELEMETRY_SCHEMA_DDL);
  },
};
