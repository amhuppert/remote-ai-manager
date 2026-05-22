#!/usr/bin/env bun
/**
 * Convert `cc-debug.log` (or any timed-NDJSON file under the CC config dir)
 * into a Chrome Trace Event Format JSON for visual inspection in Perfetto.
 *
 * Usage:
 *   bun scripts/perfetto-export.ts                          # convert global.log → trace.json
 *   bun scripts/perfetto-export.ts --in path/to/log         # custom input
 *   bun scripts/perfetto-export.ts --out my-trace.json
 *   bun scripts/perfetto-export.ts --trace <traceId>        # filter to one HTTP trace
 *   bun scripts/perfetto-export.ts --since 2026-05-21T12:00:00Z
 *
 * Then open https://ui.perfetto.dev/ and drag the output JSON onto the page.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { getConfigDirPath } from "../src/lib/config";
import { buildTrace } from "../src/lib/logging/perfetto-export";

const HELP_TEXT = `Usage: bun scripts/perfetto-export.ts [options]

  --in <path>          Log file to read (default: <config-dir>/logs/global.log)
  --out <path>         Output trace JSON path (default: trace.json)
  --trace <traceId>    Only include entries for this traceId
  --since <iso>        Drop entries earlier than this ISO timestamp
  -h, --help           Show this help

After running, open https://ui.perfetto.dev/ and drop the output JSON in.
`;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    in: { type: "string" },
    out: { type: "string", default: "trace.json" },
    trace: { type: "string" },
    since: { type: "string" },
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
const outputPath = values.out ?? "trace.json";

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

const trace = buildTrace(raw.split("\n"), {
  ...(values.trace !== undefined ? { traceId: values.trace } : {}),
  ...(sinceMs !== undefined ? { sinceMs } : {}),
});

writeFileSync(outputPath, JSON.stringify(trace));

const durationCount = trace.traceEvents.filter((e) => e.ph === "X").length;
process.stderr.write(
  `wrote ${durationCount} duration events (${trace.traceEvents.length} total) → ${outputPath}\n` +
    `open https://ui.perfetto.dev/ and drop ${outputPath} onto the page.\n`,
);
