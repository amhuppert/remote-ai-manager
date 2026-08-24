import { readdirSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { createLogger } from "@/lib/logging";
import {
  atomicWriteJson,
  atomicWriteJsonSync,
} from "@/lib/shared/atomic-write-json";

const logger = createLogger("state-store/schema-compatibility");

const BARRIER_PREFIX = "command-center.schema-version-";
const BARRIER_SUFFIX = ".json";
const BARRIER_PATTERN = /^command-center\.schema-version-(\d+)\.json$/;

/**
 * A compatibility barrier is append-only and version-specific. Publishing a
 * newer version never overwrites an older marker, so concurrent migrations
 * cannot race a higher on-disk requirement back down to a lower one.
 */
export function schemaCompatibilityBarrierPath(
  configDir: string,
  version: number,
): string {
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new Error(`Invalid schema compatibility version: ${version}`);
  }
  return path.join(configDir, `${BARRIER_PREFIX}${version}${BARRIER_SUFFIX}`);
}

/** Highest append-only compatibility barrier present in `configDir`. */
export function readSchemaCompatibilityBarrierVersion(
  configDir: string,
): number {
  let names: string[];
  try {
    names = readdirSync(configDir);
  } catch (err) {
    if (isNodeErrorCode(err, "ENOENT")) return 0;
    throw err;
  }

  let recordedVersion = 0;
  for (const name of names) {
    const match = BARRIER_PATTERN.exec(name);
    if (!match) continue;
    const version = Number(match[1]);
    if (!Number.isSafeInteger(version) || version <= recordedVersion) continue;
    recordedVersion = version;
  }
  return recordedVersion;
}

export class SchemaVersionConflictError extends Error {
  constructor(
    public readonly recordedVersion: number,
    public readonly knownVersion: number,
  ) {
    super(
      `Refusing to open command-center.db: recorded schema version ${recordedVersion} is greater than known build version ${knownVersion}`,
    );
    this.name = "SchemaVersionConflictError";
  }
}

/**
 * Refuse an incompatible file-backed database before constructing SQLite.
 * Reading directory entries cannot create, checkpoint, or remove WAL/SHM
 * sidecars, unlike opening even a nominally read-only SQLite connection.
 */
export function enforceSchemaCompatibilityBarrier(
  dbPath: string,
  knownVersion: number,
): void {
  if (dbPath === ":memory:") return;
  const recordedVersion = readSchemaCompatibilityBarrierVersion(
    path.dirname(dbPath),
  );
  if (recordedVersion <= knownVersion) return;

  logger.error("state-store.fatal", {
    reason: "schema_version_conflict",
    source: "compatibility_barrier",
    dbPath,
    recordedVersion,
    knownVersion,
  });
  throw new SchemaVersionConflictError(recordedVersion, knownVersion);
}

/**
 * Defense-in-depth gate for a connection that was opened before another build
 * advanced the database. Callers that mutate schema or incompatible bytes run
 * this check after acquiring their SQLite write lock.
 */
export function enforceSqliteSchemaCompatibility(
  db: InstanceType<typeof Database>,
  dbPath: string,
  knownVersion: number,
): void {
  const table = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get();
  if (table === undefined) return;

  const row = db
    .prepare("SELECT MAX(version) AS maxVersion FROM schema_migrations")
    .get() as { maxVersion: number | null };
  const recordedVersion = row.maxVersion ?? 0;
  if (recordedVersion <= knownVersion) return;

  logger.error("state-store.fatal", {
    reason: "schema_version_conflict",
    source: "sqlite_ledger",
    dbPath,
    recordedVersion,
    knownVersion,
  });
  throw new SchemaVersionConflictError(recordedVersion, knownVersion);
}

/**
 * Recheck both compatibility witnesses after acquiring a SQLite write lock.
 * The external barrier can advance while a connection is already open; the
 * ledger can advance while it waits for the lock. Compatibility-sensitive
 * mutations use this combined gate as their first operation.
 */
export function enforceCurrentSchemaCompatibility(
  db: InstanceType<typeof Database>,
  dbPath: string,
  knownVersion: number,
): void {
  enforceSchemaCompatibilityBarrier(dbPath, knownVersion);
  enforceSqliteSchemaCompatibility(db, dbPath, knownVersion);
}

/**
 * Durably publish the fail-closed barrier before committing a breaking SQLite
 * migration. A failed database transaction intentionally leaves the barrier:
 * blocking an older reader is safer than allowing it to race a retrying
 * cutover. Replays are idempotent because each version owns one marker path.
 */
export async function publishSchemaCompatibilityBarrier(
  configDir: string,
  version: number,
): Promise<void> {
  const markerPath = schemaCompatibilityBarrierPath(configDir, version);
  await atomicWriteJson(markerPath, { version });
  logPublishedBarrier(version, markerPath);
}

export function publishSchemaCompatibilityBarrierSync(
  configDir: string,
  version: number,
): void {
  const markerPath = schemaCompatibilityBarrierPath(configDir, version);
  atomicWriteJsonSync(markerPath, { version });
  logPublishedBarrier(version, markerPath);
}

function logPublishedBarrier(version: number, markerPath: string): void {
  logger.info("state-store.schema_compatibility_barrier_published", {
    version,
    markerPath,
  });
}

function isNodeErrorCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === code
  );
}
