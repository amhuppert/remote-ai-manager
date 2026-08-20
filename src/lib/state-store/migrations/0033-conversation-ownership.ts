import type { StateMigration } from "./types";

/**
 * Add `conversation_owner` and `turn_generation` to both conversation tables
 * (#81): the durable record of which non-prompt turn holds a conversation, and
 * a counter of admitted turns that a cached conversation actor cannot forge.
 *
 * The synchronous schema floor already declares both columns on every open, so
 * on a floor-initialized database this is a no-op; the migration records the
 * change in the ordered ledger and applies the same shape to any database that
 * predates the floor entry.
 *
 * Purely additive with no back-fill. Null owner and generation 0 are the
 * meaningful legacy values: no conversation written before this feature was
 * ever held by a non-prompt turn, and the generation only has to be monotonic
 * from wherever it starts. No KNOWN_SCHEMA_VERSION bump — an older build
 * sharing `command-center.db` simply ignores two columns it has no reader for,
 * and fencing it out of the whole database would cost it every feature to
 * protect a claim it never makes.
 */
export const conversationOwnership: StateMigration = {
  name: "0033-conversation-ownership",
  up: async ({ context }) => {
    for (const table of ["conversations", "project_conversations"]) {
      const columns = context.db
        .prepare(`PRAGMA table_info(${table})`)
        .all() as Array<{ name: string }>;
      const present = new Set(columns.map((c) => c.name));
      if (!present.has("conversation_owner")) {
        context.db.exec(
          `ALTER TABLE ${table} ADD COLUMN conversation_owner TEXT`,
        );
      }
      if (!present.has("turn_generation")) {
        context.db.exec(
          `ALTER TABLE ${table} ADD COLUMN turn_generation INTEGER NOT NULL DEFAULT 0`,
        );
      }
    }
  },
};
