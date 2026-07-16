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
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach } from "vitest";

const VITEST_TMP_PREFIX = path.join(os.tmpdir(), "cc-vitest-");
if (!process.env["CC_CONFIG_DIR"]) {
  process.env["CC_CONFIG_DIR"] = mkdtempSync(VITEST_TMP_PREFIX);
}
const VITEST_CONFIG_DIR = process.env["CC_CONFIG_DIR"];

beforeEach(async () => {
  const { _resetForTesting } = await import("@/lib/state-store/state-db");
  _resetForTesting();
});

afterAll(() => {
  if (VITEST_CONFIG_DIR.startsWith(VITEST_TMP_PREFIX)) {
    rmSync(VITEST_CONFIG_DIR, { recursive: true, force: true });
  }
});
