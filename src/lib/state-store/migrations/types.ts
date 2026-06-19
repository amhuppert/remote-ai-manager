import type { MigrationParams, RunnableMigration } from "umzug";
import type Database from "better-sqlite3";

/**
 * Context handed to every state-store migration. `db` is the open
 * better-sqlite3 connection the migration mutates; `configDir` is the directory
 * holding `command-center.db` — available for migrations that also touch
 * on-disk files — or `null` for in-memory databases that have no config dir.
 */
export interface MigrationContext {
  db: InstanceType<typeof Database>;
  configDir: string | null;
}

/**
 * A single ordered migration. `name` is both the ledger key and the sort key
 * (migrations run in lexicographic `name` order), so prefix names with a
 * zero-padded sequence, e.g. `0002-add-foo`.
 *
 * Migrations MUST be idempotent. The runner records completion in a separate
 * step from running `up`, so a crash in between replays the migration on the
 * next start. The synchronous schema floor in `state-db.ts` also guarantees a
 * fresh database already has current table shapes, so a migration that adds a
 * column/table must guard against it already existing (or be expressed as
 * `IF NOT EXISTS`).
 */
export type StateMigration = RunnableMigration<MigrationContext>;

export type StateMigrationParams = MigrationParams<MigrationContext>;
