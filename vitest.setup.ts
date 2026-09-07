/**
 * Shared Vitest setup for Node and jsdom unit tests.
 *
 * Logging is suppressed via CC_LOG_SILENT=1 env var (set in vitest.config.ts).
 * No vi.mock() calls needed — the real logging module is used but silenced.
 *
 * CC_CONFIG_DIR is set to a per-fork temp directory so SQLite-backed tests
 * never touch the user's real ~/.config/cc/command-center.db. This is required
 * because src/lib/config.ts captures CONFIG_DIR at module load — it MUST be
 * set before any test file imports config.ts (transitively via state-db).
 *
 * The per-test reset goes through the state-store-owned lightweight entry
 * rather than `state-db.ts` itself: importing that module pulls the schema
 * floor, `better-sqlite3`, the config loader, and logging into every test
 * file, including the majority that never open a database.
 */
import { rmSync } from "node:fs";
import os from "node:os";
import { afterAll, beforeEach } from "vitest";
import { createWorkerConfigDir } from "@/lib/shared/testing/worker-config-dir";
import { resetInstalledStateDbForTesting } from "@/lib/state-store/reset-installed-state-db";

// Always worker-owned, never adopted. An inherited CC_CONFIG_DIR becomes the
// parent to nest under: registered validation exports one scratch dir for the
// whole run (scripts/validate/common.sh), so adopting it handed every fork the
// same command-center.db and the `journal_mode = WAL` pragma taken at open
// raced across workers into `SqliteError: database is locked`.
const VITEST_CONFIG_DIR = createWorkerConfigDir(
  process.env["CC_CONFIG_DIR"],
  os.tmpdir(),
);
process.env["CC_CONFIG_DIR"] = VITEST_CONFIG_DIR;

beforeEach(() => {
  resetInstalledStateDbForTesting();
});

afterAll(() => {
  // Unconditional: this directory is always one this worker created, never a
  // caller's, so there is no longer an inherited path to guard against.
  //
  // Retried, because it can gain an entry while it is being removed.
  // `CC_CONFIG_DIR` is per WORKER (it lives in `process.env`) while this hook is
  // per TEST FILE, so a worker running several files removes the same directory
  // once per file — and a SQLite handle from the file that is finishing can
  // still flush a `-wal`/`-shm` sidecar into it between the readdir and the
  // rmdir, which fails as ENOTEMPTY. `force` does not cover that (it only
  // swallows ENOENT); `maxRetries` is the documented answer, retrying ENOTEMPTY
  // with a linear backoff until the writer settles.
  rmSync(VITEST_CONFIG_DIR, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 20,
  });
});
