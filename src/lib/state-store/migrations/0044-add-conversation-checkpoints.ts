import { publishSchemaCompatibilityBarrier } from "../schema-compatibility";
import { CONVERSATION_CHECKPOINTS_SCHEMA_DDL } from "../state-db";
import type { MigrationContext, StateMigration } from "./types";

export const CONVERSATION_CHECKPOINTS_SCHEMA_VERSION = 15;
const MIGRATION_DESCRIPTION = "durable conversation checkpoint operations";

/**
 * Create `conversation_checkpoint_operations` and `conversation_checkpoints`,
 * their indexes, the payload immutability trigger, and the two owning-parent
 * cleanup triggers. The synchronous schema floor already creates all of it on
 * every open, so on a floor-initialized database this re-applies the identical
 * `IF NOT EXISTS` DDL as a no-op and exists to reach a database that predates
 * the floor entry. It shares the floor's constant, so there is no second
 * hand-synced copy to drift.
 *
 * **Preserving, not destructive.** Nothing is dropped, rewritten, or reset: the
 * conversation, profile, queue, artifact, and transcript rows a running install
 * holds are untouched, and a replay after an interruption between `up` and the
 * ledger write is another no-op over the same statements.
 *
 * Unlike the other additive table migrations, this one advances
 * `KNOWN_SCHEMA_VERSION` and publishes its compatibility barrier. The tables
 * are additive but the invariant they carry is not: a build without checkpoint
 * awareness reads a conversation mid-retirement as an ordinary idle one, admits
 * a turn, and mints a provider reference the frozen seed can never be delivered
 * into — silently losing the retired context the operation exists to preserve.
 *
 * The barrier is published BEFORE the SQLite work, deliberately: a failed
 * transaction that leaves the barrier behind blocks an older reader that has
 * nothing to gain from the window, which is strictly safer than letting one
 * race a retrying cutover.
 */
export const addConversationCheckpoints: StateMigration = {
  name: "0044-add-conversation-checkpoints",
  up: async ({ context }) => {
    if (context.configDir !== null) {
      await publishSchemaCompatibilityBarrier(
        context.configDir,
        CONVERSATION_CHECKPOINTS_SCHEMA_VERSION,
      );
    }
    migrate(context);
  },
};

function migrate(context: MigrationContext): void {
  context.db
    .transaction(() => {
      context.db.exec(CONVERSATION_CHECKPOINTS_SCHEMA_DDL);
      context.db
        .prepare(
          `INSERT OR IGNORE INTO schema_migrations (version, description)
           VALUES (?, ?)`,
        )
        .run(CONVERSATION_CHECKPOINTS_SCHEMA_VERSION, MIGRATION_DESCRIPTION);
    })
    .immediate();
}
