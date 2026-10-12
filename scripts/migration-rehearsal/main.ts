/**
 * Usage (server stopped; Node, because better-sqlite3 does not load under bun):
 *   bun run migrations:rehearse -- --from <data directory> --to <empty scratch directory>
 * Both paths absolute: `bun run` resolves relative ones against the checkout.
 *
 * Prints the migrations this build would apply, the schema versions before and
 * after, and the integrity and foreign-key checks before and after; it fails
 * on a problem the migrations introduced, not one the data already had.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import { getConfigDirPath } from "../../src/lib/config/loader";
import { isProcessAlive } from "../../src/lib/shared/process-liveness";
import { getDb } from "../../src/lib/state-store/state-db";
import {
  canonicalPath,
  rehearsalEnvironment,
  rehearseMigrations,
} from "./rehearse";

let values: { from?: string; to?: string };
try {
  ({ values } = parseArgs({
    args: process.argv.slice(2),
    options: { from: { type: "string" }, to: { type: "string" } },
    strict: true,
    allowPositionals: false,
  }));
} catch (err) {
  console.error(
    `migration-rehearsal: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(2);
}
if (values.from === undefined || values.to === undefined) {
  console.error(
    "migration-rehearsal: pass --from <data directory> --to <empty scratch directory>",
  );
  process.exit(2);
}
if (!path.isAbsolute(values.from) || !path.isAbsolute(values.to)) {
  console.error("migration-rehearsal: --from and --to must be absolute paths");
  process.exit(2);
}
const to = canonicalPath(values.to);

// The config loader resolves the data directory when its module loads, so run
// again with it, and the logger, pointed at the scratch copy.
if (
  process.env["CC_CONFIG_DIR"] !== to ||
  process.env["CC_LOG_FILE"] !== undefined
) {
  const child = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: "inherit",
    env: rehearsalEnvironment(process.env, to),
  });
  process.exit(child.status ?? 1);
}

const result = await rehearseMigrations(
  { from: values.from, to },
  {
    openStateDatabase: (dbPath) => {
      const expected = path.join(getConfigDirPath(), "command-center.db");
      if (path.resolve(dbPath) !== path.resolve(expected)) {
        throw new Error(`refusing to open ${expected}; expected ${dbPath}`);
      }
      return getDb();
    },
    isProcessAlive,
  },
);
if (!result.ok) {
  console.error(`migration-rehearsal: refused: ${result.reason}`);
  process.exit(1);
}
const { report } = result;
const newProblems = report.after.integrityProblems.filter(
  (problem) => !report.before.integrityProblems.includes(problem),
);
const newViolations =
  report.after.foreignKeyViolations - report.before.foreignKeyViolations;
const list = (items: string[]) =>
  items.length === 0 ? "none" : items.join(", ");
console.log(`Rehearsed on ${report.scratchDir}`);
console.log(
  `  schema version ${report.schemaVersionBefore ?? "none"} -> ${report.schemaVersionAfter ?? "none"}`,
);
console.log(`  pending: ${list(report.pendingBefore)}`);
console.log(`  applied: ${list(report.applied)}`);
console.log(
  `  integrity: before ${report.before.integrityProblems.length === 0 ? "ok" : report.before.integrityProblems.join("; ")}, after ${report.after.integrityProblems.length === 0 ? "ok" : report.after.integrityProblems.join("; ")}`,
);
console.log(
  `  foreign key violations: before ${report.before.foreignKeyViolations}, after ${report.after.foreignKeyViolations}`,
);
process.exit(newProblems.length === 0 && newViolations <= 0 ? 0 : 1);
