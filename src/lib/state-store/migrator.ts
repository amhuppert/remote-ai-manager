import { Umzug, type UmzugStorage } from "umzug";
import { createLogger } from "@/lib/logging";
import { migrations as defaultMigrations } from "./migrations";
import type {
  MigrationContext,
  StateMigration,
  StateMigrationParams,
} from "./migrations/types";

const logger = createLogger("state-store/migrator");

/**
 * Umzug storage backed by the `applied_migrations` table (created by the
 * synchronous schema floor in `state-db.ts`). Tracks applied migrations by name
 * — branch-friendly: differently-named migrations authored on two branches
 * never collide, and a merge simply runs both once. The INSERT is `OR IGNORE`
 * so a concurrent double-apply (multiple Next.js workers opening the same
 * file-backed DB) cannot violate the primary key.
 */
class AppliedMigrationsStorage implements UmzugStorage<MigrationContext> {
  async logMigration({ name, context }: StateMigrationParams): Promise<void> {
    context.db
      .prepare("INSERT OR IGNORE INTO applied_migrations (name) VALUES (?)")
      .run(name);
  }

  async unlogMigration({ name, context }: StateMigrationParams): Promise<void> {
    context.db
      .prepare("DELETE FROM applied_migrations WHERE name = ?")
      .run(name);
  }

  async executed({
    context,
  }: Pick<StateMigrationParams, "context">): Promise<string[]> {
    const rows = context.db
      .prepare("SELECT name FROM applied_migrations ORDER BY name")
      .all() as { name: string }[];
    return rows.map((row) => row.name);
  }
}

/**
 * Build an Umzug migrator bound to a database. `migrationList` defaults to the
 * production registry; tests inject their own list to exercise the runner
 * without depending on the real migrations.
 */
export function createMigrator(
  context: MigrationContext,
  migrationList: readonly StateMigration[] = defaultMigrations,
): Umzug<MigrationContext> {
  return new Umzug<MigrationContext>({
    context,
    migrations: [...migrationList],
    storage: new AppliedMigrationsStorage(),
    // Umzug's own console logger is silenced; structured logging happens in
    // `runMigrations` and the startup registrar.
    logger: undefined,
  });
}

/**
 * Apply all pending migrations against `context.db`, returning the names
 * applied this run (empty when the database is already current).
 *
 * Runs at server startup (instrumentation) before any request touches a repo.
 * The synchronous schema floor in `state-db.ts` has already guaranteed current
 * table shapes, so a fresh database records every migration as a fast no-op and
 * is stamped; only an older on-disk database does real work here.
 */
export async function runMigrations(
  context: MigrationContext,
  migrationList: readonly StateMigration[] = defaultMigrations,
): Promise<string[]> {
  const migrator = createMigrator(context, migrationList);
  const pending = await migrator.pending();
  const applied = await migrator.up();
  const names = applied.map((migration) => migration.name);
  logger.info("state-store.migrations_run", {
    pendingCount: pending.length,
    appliedCount: names.length,
    applied: names,
  });
  return names;
}
