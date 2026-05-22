#!/usr/bin/env bun
/**
 * Audit `global.log` for `timed()` entries missing a `traceId`. Surfaces the
 * (module, message) pairs whose call sites are running outside any
 * `runAsTrace` / `withTracing` scope, so we can spot uncovered entrypoints
 * (pollers, background jobs, SDK callbacks, SSE handlers).
 *
 * Usage:
 *   bun scripts/check-trace-coverage.ts                       # report only
 *   bun scripts/check-trace-coverage.ts --in path/to/log
 *   bun scripts/check-trace-coverage.ts --since <iso>
 *   bun scripts/check-trace-coverage.ts --fail                # exit 1 if any uncovered
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { getConfigDirPath } from "../src/lib/config";
import { auditTraceCoverage } from "../src/lib/logging/trace-coverage";

const HELP_TEXT = `Usage: bun scripts/check-trace-coverage.ts [options]

  --in <path>          Log file to read (default: <config-dir>/logs/global.log)
  --since <iso>        Only count entries at or after this ISO timestamp
  --fail               Exit 1 if any uncovered entries are found
  -h, --help           Show this help
`;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    in: { type: "string" },
    since: { type: "string" },
    fail: { type: "boolean", default: false },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: false,
});

if (values.help === true) {
  process.stderr.write(HELP_TEXT);
  process.exit(0);
}

const inputPath =
  values.in ?? path.join(getConfigDirPath(), "logs", "global.log");

let sinceMs: number | undefined;
if (values.since !== undefined) {
  const parsed = Date.parse(values.since);
  if (!Number.isFinite(parsed)) {
    process.stderr.write(
      `error: --since "${values.since}" is not a valid ISO timestamp\n`,
    );
    process.exit(1);
  }
  sinceMs = parsed;
}

let raw: string;
try {
  raw = readFileSync(inputPath, "utf-8");
} catch (err) {
  process.stderr.write(
    `error: failed to read ${inputPath}: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}

const report = auditTraceCoverage(raw.split("\n"), {
  ...(sinceMs !== undefined ? { sinceMs } : {}),
});

const coveragePct =
  report.totalTimed === 0
    ? 100
    : Math.round((report.covered / report.totalTimed) * 1000) / 10;

process.stdout.write(
  `trace coverage: ${report.covered}/${report.totalTimed} timed entries (${coveragePct}%)\n`,
);
process.stdout.write(`uncovered: ${report.uncovered}\n\n`);

if (report.uncoveredByModuleMessage.length > 0) {
  process.stdout.write("uncovered (module → message → count):\n");
  for (const entry of report.uncoveredByModuleMessage) {
    process.stdout.write(
      `  ${entry.module.padEnd(32)}  ${entry.message.padEnd(48)}  ${entry.count}\n`,
    );
  }
  process.stdout.write("\n");
}

if (values.fail === true && report.uncovered > 0) {
  process.exit(1);
}

process.exit(0);
