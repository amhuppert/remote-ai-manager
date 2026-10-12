/**
 * Migration rehearsal: runs this build's database startup (the native SDD
 * pre-open step, the schema floor and the pending migrations) against a copy
 * of a stopped data directory, without starting a server, so no turn, process
 * group or repository is touched.
 *
 * The source is never opened with SQLite: `command-center.db` and its
 * write-ahead log are copied byte for byte, with the top-level JSON files
 * (config, schema markers, manifests), and everything runs on the copy.
 *
 * Only migrations from `FIRST_REHEARSABLE_MIGRATION` on are rehearsed, and only
 * once the native SDD cutover (0030) has completed: those touch nothing but
 * the database and the schema markers. Earlier ones read and write trees the
 * copy does not hold, and one rewrites `CommandCenter.json` in the projects
 * the copied rows still name, so a source that has them pending is refused.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "../../src/lib/state-store/migrator";
import { migrations as productionMigrations } from "../../src/lib/state-store/migrations";
import { runNativeSddV2CutoverBeforeStateDbOpen } from "../../src/lib/state-store/migrations/0030-native-sdd-v2-cutover";
import type { StateMigration } from "../../src/lib/state-store/migrations/types";

type Db = InstanceType<typeof Database>;

const DB_FILE = "command-center.db";
const CUTOVER_MANIFEST = "native-sdd-v2-cutover-manifest.json";
export const FIRST_REHEARSABLE_MIGRATION = "0049-graph-workflow-review-origin";

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

export interface RehearsalReport {
  scratchDir: string;
  pendingBefore: string[];
  applied: string[];
  schemaVersionBefore: number | null;
  schemaVersionAfter: number | null;
  before: DatabaseChecks;
  after: DatabaseChecks;
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

function cutoverComplete(dir: string): boolean {
  const manifestPath = path.join(dir, CUTOVER_MANIFEST);
  if (!existsSync(manifestPath)) return false;
  try {
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    return rowObject(manifest)?.phase === "complete";
  } catch {
    return false;
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
  staged.close();
  if (pid !== null) {
    return refuse(
      `a Command Center server (pid ${pid}) holds ${from}; stop it and rerun`,
    );
  }
  const pendingBefore = migrationList
    .map((migration) => migration.name)
    .filter((name) => !ledgered.has(name));
  const unsupported = pendingBefore.filter(
    (name) => name < FIRST_REHEARSABLE_MIGRATION,
  );
  if (unsupported.length > 0) {
    return refuse(
      `pending migrations from before ${FIRST_REHEARSABLE_MIGRATION} touch files outside the database, which a copy cannot rehearse safely: ${unsupported.join(", ")}`,
    );
  }
  if (!cutoverComplete(to)) {
    return refuse(
      `${CUTOVER_MANIFEST} in ${from} does not record a completed native SDD cutover (0030), whose startup step moves workflow files`,
    );
  }

  let db: Db | null = null;
  try {
    await runNativeSddV2CutoverBeforeStateDbOpen(to);
    db = deps.openStateDatabase(scratchPath);
    const applied = await runMigrations({ db, configDir: to }, migrationList);
    return {
      ok: true,
      report: {
        scratchDir: to,
        pendingBefore,
        applied,
        schemaVersionBefore,
        schemaVersionAfter: schemaVersion(db),
        before,
        after: databaseChecks(db),
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
