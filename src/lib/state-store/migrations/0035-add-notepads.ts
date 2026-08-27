import { NOTEPADS_SCHEMA_DDL } from "../state-db";
import type { StateMigration } from "./types";

/**
 * Create the three notepad tables — `notepads`, `notepad_revisions`, and
 * `notepad_images` (spec design D1). The synchronous schema floor already
 * creates them on every open, so on a floor-initialized database this is a
 * no-op; the migration records the change in the ordered ledger and applies the
 * identical DDL (shared constant, no hand-synced copy) to any database that
 * predates the floor entry.
 *
 * Purely additive — no existing row moves and no existing read path learns a
 * new vocabulary, so an older build sharing `command-center.db` simply ignores
 * tables it has no reader for. No KNOWN_SCHEMA_VERSION bump: fencing older
 * builds out of the whole database would cost them every feature to protect
 * tables none of them touch.
 */
export const addNotepads: StateMigration = {
  name: "0035-add-notepads",
  up: async ({ context }) => {
    context.db.exec(NOTEPADS_SCHEMA_DDL);
  },
};
