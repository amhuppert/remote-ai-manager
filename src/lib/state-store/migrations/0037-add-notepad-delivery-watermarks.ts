import { NOTEPAD_DELIVERY_WATERMARKS_SCHEMA_DDL } from "../state-db";
import type { StateMigration } from "./types";

/**
 * Create `notepad_delivery_watermarks`, the per-conversation record of what a
 * notepad last presented to an agent (spec design D17). The synchronous schema
 * floor already creates it on every open, so on a floor-initialized database
 * this is a no-op; the migration records the change in the ordered ledger and
 * applies the identical DDL (shared constant, no hand-synced copy) to any
 * database that predates the floor entry.
 *
 * Purely additive, exactly like `0035-add-notepads` and
 * `0036-add-notepad-comments`: no existing row moves and no existing read path
 * learns a new vocabulary, so an older build sharing `command-center.db` simply
 * ignores a table it has no reader for. No KNOWN_SCHEMA_VERSION bump.
 */
export const addNotepadDeliveryWatermarks: StateMigration = {
  name: "0037-add-notepad-delivery-watermarks",
  up: async ({ context }) => {
    context.db.exec(NOTEPAD_DELIVERY_WATERMARKS_SCHEMA_DDL);
  },
};
