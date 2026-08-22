import { mkdtempSync } from "node:fs";
import path from "node:path";

/** Prefix every worker-owned config directory carries, for recognisability. */
export const WORKER_CONFIG_DIR_PREFIX = "cc-vitest-";

/**
 * The Command Center config directory one Vitest worker owns exclusively.
 *
 * Each worker opens `command-center.db` at module scope, and better-sqlite3 is
 * synchronous, so two workers pointed at one directory contend for the same
 * file: the `journal_mode = WAL` pragma taken during open needs a brief
 * exclusive lock and throws `database is locked` once the busy timeout expires.
 *
 * An inherited `CC_CONFIG_DIR` is therefore treated as the PARENT to nest
 * under, never as the directory to use directly. That distinction matters
 * because registered validation always exports one: `scripts/validate/common.sh`
 * scopes the run to a single scratch dir to keep it off the operator's live
 * state. Honouring it as a parent keeps that isolation while still giving every
 * worker its own database.
 */
export function createWorkerConfigDir(
  inheritedConfigDir: string | undefined,
  fallbackRoot: string,
  makeTempDir: (prefix: string) => string = mkdtempSync,
): string {
  const parent = inheritedConfigDir ?? fallbackRoot;
  return makeTempDir(path.join(parent, WORKER_CONFIG_DIR_PREFIX));
}
