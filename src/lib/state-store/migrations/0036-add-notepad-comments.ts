import { NOTEPAD_COMMENTS_SCHEMA_DDL } from "../state-db";
import type { StateMigration } from "./types";

/**
 * Create the two notepad review-comment tables — `notepad_comments` and
 * `notepad_comment_replies` (spec design D15). The synchronous schema floor
 * already creates them on every open, so on a floor-initialized database this
 * is a no-op; the migration records the change in the ordered ledger and
 * applies the identical DDL (shared constant, no hand-synced copy) to any
 * database that predates the floor entry.
 *
 * Purely additive, exactly like `0035-add-notepads`: no existing row moves and
 * no existing read path learns a new vocabulary, so an older build sharing
 * `command-center.db` simply ignores tables it has no reader for. No
 * KNOWN_SCHEMA_VERSION bump.
 */
export const addNotepadComments: StateMigration = {
  name: "0036-add-notepad-comments",
  up: async ({ context }) => {
    context.db.exec(NOTEPAD_COMMENTS_SCHEMA_DDL);
  },
};
