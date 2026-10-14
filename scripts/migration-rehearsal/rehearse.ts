/**
 * Migration rehearsal: runs this build's database startup (the retired-history
 * guard, the schema floor and the pending migrations) against a copy of a
 * stopped data directory, without starting a server, so no turn, process
 * group or repository is touched.
 *
 * The source is never opened with SQLite: `command-center.db` and its
 * write-ahead log are copied byte for byte, with the top-level JSON files
 * (config, schema markers, manifests), and everything runs on the copy.
 *
 * The guard runs on the copy before the floor, so a directory this build would
 * refuse is reported with the retired migrations it lacks. The report compares
 * the copy's schema before and after, which shows what the floor and the
 * migrations changed.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  classifyMigrationHistory,
  type MigrationHistory,
} from "../../src/lib/state-store/migration-history";
import { runMigrations } from "../../src/lib/state-store/migrator";
import { migrations as productionMigrations } from "../../src/lib/state-store/migrations";
import type { StateMigration } from "../../src/lib/state-store/migrations/types";

type Db = InstanceType<typeof Database>;

const DB_FILE = "command-center.db";

export interface RehearsalDeps {
  /** Opens the scratch database the way the server does: schema floor included. */
  openStateDatabase(dbPath: string): Db;
  isProcessAlive(pid: number): boolean;
  migrations?: readonly StateMigration[];
}

interface DatabaseChecks {
  integrityProblems: string[];
  foreignKeyViolations: number;
}

/** Schema entries, as `<type> <name>`, that startup added, removed or changed. */
export interface SchemaChanges {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface RehearsalReport {
  scratchDir: string;
  history: MigrationHistory;
  pendingBefore: string[];
  applied: string[];
  schemaVersionBefore: number | null;
  schemaVersionAfter: number | null;
  before: DatabaseChecks;
  after: DatabaseChecks;
  schemaChanges: SchemaChanges;
}

export type RehearsalResult =
  | { ok: true; report: RehearsalReport }
  | { ok: false; reason: string };

/**
 * The environment of the process that runs the rehearsal: its data directory
 * is the scratch copy, and no log file override can route its logs elsewhere.
 */
export function rehearsalEnvironment(
  env: NodeJS.ProcessEnv,
  to: string,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, CC_CONFIG_DIR: to };
  delete next["CC_LOG_FILE"];
  return next;
}

/** A path with symlinks resolved, including one that does not exist yet. */
export function canonicalPath(target: string): string {
  const missing: string[] = [];
  let existing = target;
  while (!existsSync(existing)) {
    missing.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  return path.join(realpathSync(existing), ...missing);
}

function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function rowObject(result: unknown): Record<string, unknown> | null {
  return typeof result === "object" && result !== null && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : null;
}

function tableExists(db: Db, table: string): boolean {
  return (
    rowObject(
      db
        .prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(table),
    ) !== null
  );
}

function liveOwnerPid(db: Db, deps: RehearsalDeps): number | null {
  if (!tableExists(db, "graph_workflow_runtime_owner")) return null;
  const pid = rowObject(
    db
      .prepare(
        "SELECT pid FROM graph_workflow_runtime_owner WHERE singleton = 1",
      )
      .get(),
  )?.pid;
  return typeof pid === "number" && deps.isProcessAlive(pid) ? pid : null;
}

function schemaVersion(db: Db): number | null {
  if (!tableExists(db, "schema_migrations")) return null;
  const version = rowObject(
    db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get(),
  )?.v;
  return typeof version === "number" ? version : null;
}

function appliedNames(db: Db): Set<string> {
  if (!tableExists(db, "applied_migrations")) return new Set();
  const rows = db.prepare("SELECT name FROM applied_migrations").all();
  return new Set(
    rows.flatMap((row) => {
      const name = rowObject(row)?.name;
      return typeof name === "string" ? [name] : [];
    }),
  );
}

function databaseChecks(db: Db): DatabaseChecks {
  return {
    integrityProblems: db
      .prepare("PRAGMA integrity_check")
      .all()
      .map((row) => rowObject(row)?.integrity_check)
      .filter((value): value is string => typeof value === "string")
      .filter((value) => value !== "ok"),
    foreignKeyViolations: db.prepare("PRAGMA foreign_key_check").all().length,
  };
}

/** Every schema entry outside SQLite's own, keyed `<type> <name>`. */
function schemaEntries(db: Db): Map<string, string | null> {
  const entries = new Map<string, string | null>();
  const rows = db.prepare("SELECT type, name, sql FROM sqlite_master").all();
  for (const row of rows) {
    const entry = rowObject(row);
    const type = entry?.type;
    const name = entry?.name;
    const sql = entry?.sql;
    if (typeof type !== "string" || typeof name !== "string") continue;
    if (name.startsWith("sqlite_")) continue;
    entries.set(`${type} ${name}`, typeof sql === "string" ? sql : null);
  }
  return entries;
}

function schemaChanges(
  before: Map<string, string | null>,
  after: Map<string, string | null>,
): SchemaChanges {
  const sorted = (keys: Iterable<string>) => [...keys].sort();
  return {
    added: sorted([...after.keys()].filter((key) => !before.has(key))),
    removed: sorted([...before.keys()].filter((key) => !after.has(key))),
    changed: sorted(
      [...after.keys()].filter(
        (key) => before.has(key) && before.get(key) !== after.get(key),
      ),
    ),
  };
}

function historyOrRefusal(
  db: Db,
): { history: MigrationHistory } | { refusal: string } {
  try {
    return { history: classifyMigrationHistory(db) };
  } catch (error) {
    return { refusal: error instanceof Error ? error.message : String(error) };
  }
}

function pathRefusal(options: { from: string; to: string }): string | null {
  if (!path.isAbsolute(options.from) || !path.isAbsolute(options.to)) {
    return "--from and --to must be absolute paths";
  }
  if (!existsSync(path.join(options.from, DB_FILE))) {
    return `no ${DB_FILE} in ${options.from}`;
  }
  const from = canonicalPath(options.from);
  const to = canonicalPath(options.to);
  if (isWithin(to, from) || isWithin(from, to)) {
    return `the scratch directory ${to} must lie outside the data directory ${from}`;
  }
  if (existsSync(to) && readdirSync(to).length > 0) {
    return `the scratch directory ${to} is not empty`;
  }
  return null;
}

/** Copies the stopped database, its log and the top-level JSON files. */
function stage(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const file of [DB_FILE, `${DB_FILE}-wal`]) {
    if (existsSync(path.join(from, file))) {
      copyFileSync(path.join(from, file), path.join(to, file));
    }
  }
  for (const entry of readdirSync(from)) {
    const file = path.join(from, entry);
    if (entry.endsWith(".json") && statSync(file).isFile()) {
      copyFileSync(file, path.join(to, entry));
    }
  }
}

export async function rehearseMigrations(
  options: { from: string; to: string },
  deps: RehearsalDeps,
): Promise<RehearsalResult> {
  const refusal = pathRefusal(options);
  if (refusal !== null) return { ok: false, reason: refusal };
  const from = canonicalPath(options.from);
  const to = canonicalPath(options.to);
  const createdScratch = !existsSync(to);
  const refuse = (reason: string): RehearsalResult => {
    rmSync(to, { recursive: true, force: true });
    if (!createdScratch) mkdirSync(to);
    return { ok: false, reason };
  };

  stage(from, to);
  const scratchPath = path.join(to, DB_FILE);
  const migrationList = deps.migrations ?? productionMigrations;
  const staged = new Database(scratchPath);
  const pid = liveOwnerPid(staged, deps);
  const ledgered = appliedNames(staged);
  const schemaVersionBefore = schemaVersion(staged);
  const before = databaseChecks(staged);
  const schemaBefore = schemaEntries(staged);
  const classified = historyOrRefusal(staged);
  staged.close();
  if (pid !== null) {
    return refuse(
      `a Command Center server (pid ${pid}) holds ${from}; stop it and rerun`,
    );
  }
  if ("refusal" in classified) return refuse(classified.refusal);
  const pendingBefore = migrationList
    .map((migration) => migration.name)
    .filter((name) => !ledgered.has(name));

  let db: Db | null = null;
  try {
    db = deps.openStateDatabase(scratchPath);
    const applied = await runMigrations({ db, configDir: to }, migrationList);
    return {
      ok: true,
      report: {
        scratchDir: to,
        history: classified.history,
        pendingBefore,
        applied,
        schemaVersionBefore,
        schemaVersionAfter: schemaVersion(db),
        before,
        after: databaseChecks(db),
        schemaChanges: schemaChanges(schemaBefore, schemaEntries(db)),
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: `startup failed on the copy in ${to}: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    db?.close();
  }
}
