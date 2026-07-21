import { readFile, stat, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { buildTrace } from "@/lib/logging/speedscope-export";
import { createLogger } from "@/lib/logging";
import { buildLogComparisonReport } from "./analyses/compare";
import { analyzeTrace } from "./analyses/trace";
import {
  resolveDefaultServerLogPath,
  type ResolvedServerLogPath,
} from "./default-paths";
import { applyServerLogFilters } from "./filters";
import {
  renderComparisonMarkdown,
  renderLogAnalysisMarkdown,
  renderTraceAnalysisMarkdown,
} from "./markdown";
import { parseServerLogLines } from "./parser";
import { buildLogAnalysisReport, type ReportParseStats } from "./report";
import {
  DEFAULT_BUDGET_CONFIG,
  parseBudgetConfig,
  type BudgetConfig,
} from "./budgets";
import type {
  AgentLogAnalysisReport,
  AgentLogComparisonReport,
  AgentTraceAnalysisReport,
} from "./schemas";
import { clampTop } from "./stats";
import type { LogAnalysisFilters, LogAnalysisThresholds } from "./types";
import { getErrorMessage } from "@/lib/shared/errors";

const logger = createLogger("log-analysis");

export interface LogAnalysisCliRuntime {
  env: Record<string, string | undefined>;
  cwd(): string;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  readFile?(filePath: string): Promise<string> | string;
  writeFile?(filePath: string, content: string): Promise<void> | void;
  stat?(
    filePath: string,
  ):
    | Promise<{ size: number; mtimeMs: number }>
    | { size: number; mtimeMs: number };
  resolveDefaultServerLogPath?():
    | Promise<ResolvedServerLogPath>
    | ResolvedServerLogPath;
  now?(): string;
}

interface ParsedCliOptions {
  command: "report" | "trace" | "compare";
  traceId?: string;
  inPath?: string;
  beforePath?: string;
  afterPath?: string;
  clientLogPath?: string;
  format: "json" | "markdown";
  outPath?: string;
  markdownOutPath?: string;
  speedscopeOutPath?: string;
  pretty: boolean;
  assertBudgets: boolean;
  budgetsPath: string;
  filters: LogAnalysisFilters;
  thresholds: LogAnalysisThresholds;
}

/** Default location of the checked-in budget config (beside the CLI entry). */
const DEFAULT_BUDGETS_PATH = "scripts/log-budgets.json";

const HELP_TEXT = `Usage: bun run logs:analyze -- <command> [options]

Commands:
  report              Analyze one server log (default)
  trace <traceId>     Deep-dive one trace
  compare             Compare --before and --after logs

Options:
  --in <path>
  --before <path>
  --after <path>
  --client-log <path>
  --format <json|markdown>
  --out <path>
  --markdown-out <path>
  --speedscope-out <path>
  --since <iso>
  --until <iso>
  --projectName <name>
  --sessionName <name>
  --conversationId <id>
  --path <api-path>
  --action <action>
  --top <n>
  --slow-ms <n>
  --hotspot-ms <n>
  --include-self
  --pretty
  --budgets <path>        Budget config (default: scripts/log-budgets.json)
  --assert-budgets        Exit non-zero if any budget ceiling is exceeded
                          (report mode stays advisory without this flag)
`;

function writeStderr(runtime: LogAnalysisCliRuntime, message: string): void {
  runtime.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
}

function dateOptionMs(
  name: "--since" | "--until",
  value: string | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid ${name}: ${value}`);
  }
  return parsed;
}

function numberOption(value: string | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function parseCliOptions(args: readonly string[]): ParsedCliOptions | "help" {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    options: {
      in: { type: "string" },
      before: { type: "string" },
      after: { type: "string" },
      "client-log": { type: "string" },
      format: { type: "string", default: "json" },
      out: { type: "string" },
      "markdown-out": { type: "string" },
      "speedscope-out": { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      projectName: { type: "string" },
      sessionName: { type: "string" },
      conversationId: { type: "string" },
      path: { type: "string" },
      action: { type: "string" },
      top: { type: "string" },
      "slow-ms": { type: "string" },
      "hotspot-ms": { type: "string" },
      "include-self": { type: "boolean", default: false },
      pretty: { type: "boolean", default: false },
      "assert-budgets": { type: "boolean", default: false },
      budgets: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (parsed.values.help === true) return "help";

  const command = (parsed.positionals[0] ?? "report") as string;
  if (command !== "report" && command !== "trace" && command !== "compare") {
    throw new Error(`unknown command: ${command}`);
  }

  const format = parsed.values.format;
  if (format !== "json" && format !== "markdown") {
    throw new Error(`invalid --format: ${String(format)}`);
  }

  return {
    command,
    ...(parsed.positionals[1] !== undefined
      ? { traceId: parsed.positionals[1] }
      : {}),
    ...(parsed.values.in !== undefined ? { inPath: parsed.values.in } : {}),
    ...(parsed.values.before !== undefined
      ? { beforePath: parsed.values.before }
      : {}),
    ...(parsed.values.after !== undefined
      ? { afterPath: parsed.values.after }
      : {}),
    ...(parsed.values["client-log"] !== undefined
      ? { clientLogPath: parsed.values["client-log"] }
      : {}),
    format,
    ...(parsed.values.out !== undefined ? { outPath: parsed.values.out } : {}),
    ...(parsed.values["markdown-out"] !== undefined
      ? { markdownOutPath: parsed.values["markdown-out"] }
      : {}),
    ...(parsed.values["speedscope-out"] !== undefined
      ? { speedscopeOutPath: parsed.values["speedscope-out"] }
      : {}),
    pretty: parsed.values.pretty === true,
    assertBudgets: parsed.values["assert-budgets"] === true,
    budgetsPath: parsed.values.budgets ?? DEFAULT_BUDGETS_PATH,
    filters: {
      ...(dateOptionMs("--since", parsed.values.since) !== undefined
        ? { sinceMs: dateOptionMs("--since", parsed.values.since) }
        : {}),
      ...(dateOptionMs("--until", parsed.values.until) !== undefined
        ? { untilMs: dateOptionMs("--until", parsed.values.until) }
        : {}),
      ...(parsed.values.projectName !== undefined
        ? { projectName: parsed.values.projectName }
        : {}),
      ...(parsed.values.sessionName !== undefined
        ? { sessionName: parsed.values.sessionName }
        : {}),
      ...(parsed.values.conversationId !== undefined
        ? { conversationId: parsed.values.conversationId }
        : {}),
      ...(parsed.values.path !== undefined ? { path: parsed.values.path } : {}),
      ...(parsed.values.action !== undefined
        ? { action: parsed.values.action }
        : {}),
      includeSelf: parsed.values["include-self"] === true,
    },
    thresholds: {
      slowMs: numberOption(parsed.values["slow-ms"], 500),
      hotspotMs: numberOption(parsed.values["hotspot-ms"], 1000),
      top: clampTop(numberOption(parsed.values.top, 10)),
    },
  };
}

async function readText(
  runtime: LogAnalysisCliRuntime,
  filePath: string,
): Promise<string> {
  if (runtime.readFile) return await runtime.readFile(filePath);
  return await readFile(filePath, "utf-8");
}

async function writeText(
  runtime: LogAnalysisCliRuntime,
  filePath: string,
  content: string,
): Promise<void> {
  if (runtime.writeFile) {
    await runtime.writeFile(filePath, content);
    return;
  }
  await writeFile(filePath, content);
}

/**
 * Load the checked-in budget config, falling back to the baked-in default so
 * the analyzer always has budgets even when the file is absent or unreadable
 * (advisory reporting must never crash on a missing config). A malformed file
 * is announced on stderr and treated as "use defaults".
 */
async function loadBudgetConfig(
  runtime: LogAnalysisCliRuntime,
  budgetsPath: string,
): Promise<BudgetConfig> {
  try {
    const raw = await readText(runtime, budgetsPath);
    return parseBudgetConfig(JSON.parse(raw));
  } catch (err) {
    writeStderr(
      runtime,
      `[logs:analyze] budget config unavailable at ${budgetsPath} (${getErrorMessage(
        err,
      )}); using defaults`,
    );
    return DEFAULT_BUDGET_CONFIG;
  }
}

async function resolveInputPath(
  runtime: LogAnalysisCliRuntime,
  explicitPath: string | undefined,
): Promise<ResolvedServerLogPath> {
  if (explicitPath !== undefined) {
    return {
      path: explicitPath,
      paths: [explicitPath],
      checkedPaths: [explicitPath],
    };
  }
  if (runtime.resolveDefaultServerLogPath) {
    return await runtime.resolveDefaultServerLogPath();
  }
  return await resolveDefaultServerLogPath();
}

async function readAllPaths(
  runtime: LogAnalysisCliRuntime,
  paths: readonly string[],
): Promise<string> {
  const chunks = await Promise.all(paths.map((p) => readText(runtime, p)));
  return chunks.join("\n");
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
  if (size < 1024 * 1024 * 1024)
    return `${(size / (1024 * 1024)).toFixed(1)}MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

function formatAge(ageMs: number): string {
  if (ageMs < 0) return "0s";
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

async function emitInputBanner(input: {
  runtime: LogAnalysisCliRuntime;
  filePath: string;
  resolution: "explicit" | "default";
}): Promise<void> {
  const { runtime, filePath, resolution } = input;
  try {
    const stats = runtime.stat
      ? await runtime.stat(filePath)
      : await stat(filePath);
    const nowMs = Date.parse(runtime.now?.() ?? new Date().toISOString());
    const ageMs = Number.isFinite(nowMs) ? nowMs - stats.mtimeMs : 0;
    const mtimeIso = new Date(stats.mtimeMs).toISOString();
    writeStderr(
      runtime,
      `[logs:analyze] reading ${filePath} (resolved=${resolution}, size=${formatBytes(stats.size)}, mtime=${mtimeIso}, age=${formatAge(ageMs)})`,
    );
  } catch (err) {
    const reason = getErrorMessage(err);
    writeStderr(
      runtime,
      `[logs:analyze] reading ${filePath} (resolved=${resolution}, stat unavailable: ${reason})`,
    );
  }
}

function parseLog(raw: string): {
  records: ReturnType<typeof parseServerLogLines>["records"];
  parseStats: ReportParseStats;
} {
  const parsed = parseServerLogLines(raw.split(/\r?\n/));
  return {
    records: parsed.records,
    parseStats: {
      malformedLineCount: parsed.malformedLineCount,
      invalidTimestampCount: parsed.invalidTimestampCount,
      invalidShapeCount: parsed.invalidShapeCount,
    },
  };
}

function stringifyJson(value: unknown, pretty: boolean): string {
  return `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`;
}

function asUnknownRecord<T extends object>(value: T): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    record[key] = entryValue;
  }
  return record;
}

function asUnknownRecords<T extends object>(
  values: readonly T[],
): Record<string, unknown>[] {
  return values.map(asUnknownRecord);
}

async function emitOutput(
  runtime: LogAnalysisCliRuntime,
  options: ParsedCliOptions,
  report:
    | AgentLogAnalysisReport
    | AgentTraceAnalysisReport
    | AgentLogComparisonReport,
  markdown: string,
): Promise<void> {
  const primary =
    options.format === "json"
      ? stringifyJson(report, options.pretty)
      : markdown;
  if (options.outPath) {
    await writeText(runtime, options.outPath, primary);
  } else {
    runtime.stdout.write(primary);
  }

  if (options.markdownOutPath) {
    await writeText(runtime, options.markdownOutPath, markdown);
  }
}

async function maybeWriteSpeedscope(input: {
  runtime: LogAnalysisCliRuntime;
  options: ParsedCliOptions;
  rawLog: string;
  traceId?: string;
}): Promise<void> {
  if (!input.options.speedscopeOutPath) return;
  const trace = buildTrace(input.rawLog.split(/\r?\n/), {
    ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
    ...(input.options.filters.sinceMs !== undefined
      ? { sinceMs: input.options.filters.sinceMs }
      : {}),
  });
  await writeText(
    input.runtime,
    input.options.speedscopeOutPath,
    JSON.stringify(trace),
  );
}

async function runReport(
  runtime: LogAnalysisCliRuntime,
  options: ParsedCliOptions,
): Promise<number> {
  const resolved = await resolveInputPath(runtime, options.inPath);
  const resolution = options.inPath !== undefined ? "explicit" : "default";
  for (const p of resolved.paths) {
    await emitInputBanner({ runtime, filePath: p, resolution });
  }
  const rawLog = await readAllPaths(runtime, resolved.paths);
  const clientLogRaw = options.clientLogPath
    ? await readText(runtime, options.clientLogPath)
    : null;
  const parsed = parseLog(rawLog);
  const filtered = applyServerLogFilters(parsed.records, options.filters);
  if (filtered.length === 0) {
    writeStderr(runtime, "no usable records after parsing and filtering");
    return 3;
  }

  const budgetConfig = await loadBudgetConfig(runtime, options.budgetsPath);
  const report = buildLogAnalysisReport({
    records: parsed.records,
    parseStats: parsed.parseStats,
    filters: options.filters,
    thresholds: options.thresholds,
    budgetConfig,
    input: { serverLogPath: resolved.path },
    generatedAt: runtime.now?.() ?? new Date().toISOString(),
    clientLogRaw,
  });
  await emitOutput(runtime, options, report, renderLogAnalysisMarkdown(report));
  await maybeWriteSpeedscope({ runtime, options, rawLog });

  // Advisory by default: the report always reports violations, but only
  // `--assert-budgets` turns them into a non-zero exit for CI gating.
  if (options.assertBudgets && report.budgets.violationCount > 0) {
    writeStderr(
      runtime,
      `[logs:analyze] budget assertion failed: ${report.budgets.violationCount} violation(s) — see budgets.violations`,
    );
    return 1;
  }
  return 0;
}

async function runTrace(
  runtime: LogAnalysisCliRuntime,
  options: ParsedCliOptions,
): Promise<number> {
  if (!options.traceId) {
    writeStderr(runtime, "trace requires a traceId");
    return 2;
  }

  const resolved = await resolveInputPath(runtime, options.inPath);
  const resolution = options.inPath !== undefined ? "explicit" : "default";
  for (const p of resolved.paths) {
    await emitInputBanner({ runtime, filePath: p, resolution });
  }
  const rawLog = await readAllPaths(runtime, resolved.paths);
  const parsed = parseLog(rawLog);
  const filtered = applyServerLogFilters(parsed.records, options.filters);
  if (!filtered.some((record) => record.traceId === options.traceId)) {
    writeStderr(runtime, `trace not found: ${options.traceId}`);
    return 3;
  }

  const traceAnalysis = analyzeTrace(
    filtered,
    options.traceId,
    options.thresholds,
  );
  const report: AgentTraceAnalysisReport = {
    schemaVersion: 1,
    generatedAt: runtime.now?.() ?? new Date().toISOString(),
    command: "trace",
    traceId: options.traceId,
    request: traceAnalysis.request,
    summary: traceAnalysis.summary,
    timeline: asUnknownRecords(traceAnalysis.timeline),
    inclusiveSpans: asUnknownRecords(traceAnalysis.inclusiveSpans),
    exclusiveSpans: asUnknownRecords(traceAnalysis.exclusiveSpans),
    duplicateWork: asUnknownRecords(traceAnalysis.duplicateWork),
    warningsAndErrors: asUnknownRecords(traceAnalysis.warningsAndErrors),
    unexplainedTime: asUnknownRecord(traceAnalysis.unexplainedTime),
    findings: traceAnalysis.findings,
    artifacts: [],
  };
  await emitOutput(
    runtime,
    options,
    report,
    renderTraceAnalysisMarkdown(report),
  );
  await maybeWriteSpeedscope({
    runtime,
    options,
    rawLog,
    traceId: options.traceId,
  });
  return 0;
}

async function runCompare(
  runtime: LogAnalysisCliRuntime,
  options: ParsedCliOptions,
): Promise<number> {
  if (!options.beforePath || !options.afterPath) {
    writeStderr(runtime, "--before and --after are required for compare");
    return 2;
  }

  await emitInputBanner({
    runtime,
    filePath: options.beforePath,
    resolution: "explicit",
  });
  await emitInputBanner({
    runtime,
    filePath: options.afterPath,
    resolution: "explicit",
  });
  const beforeRaw = await readText(runtime, options.beforePath);
  const afterRaw = await readText(runtime, options.afterPath);
  const beforeParsed = parseLog(beforeRaw);
  const afterParsed = parseLog(afterRaw);
  const report = buildLogComparisonReport({
    beforeRecords: beforeParsed.records,
    afterRecords: afterParsed.records,
    filters: options.filters,
    thresholds: options.thresholds,
    beforeInput: { serverLogPath: options.beforePath },
    afterInput: { serverLogPath: options.afterPath },
    generatedAt: runtime.now?.() ?? new Date().toISOString(),
  });
  await emitOutput(runtime, options, report, renderComparisonMarkdown(report));
  await maybeWriteSpeedscope({ runtime, options, rawLog: afterRaw });
  return 0;
}

export async function runLogAnalysisCli(
  args: readonly string[],
  runtime: LogAnalysisCliRuntime,
): Promise<number> {
  const start = Date.now();
  let command = "unknown";
  try {
    const options = parseCliOptions(args);
    if (options === "help") {
      runtime.stdout.write(HELP_TEXT);
      return 0;
    }
    command = options.command;
    logger.info("log_analysis.start", {
      command,
      format: options.format,
      filters: options.filters,
    });

    let exitCode: number;
    if (options.command === "report") {
      exitCode = await runReport(runtime, options);
    } else if (options.command === "trace") {
      exitCode = await runTrace(runtime, options);
    } else {
      exitCode = await runCompare(runtime, options);
    }

    logger.info("log_analysis.complete", {
      command,
      durationMs: Date.now() - start,
      exitCode,
    });
    return exitCode;
  } catch (err) {
    const error = getErrorMessage(err);
    logger.error("log_analysis.error", {
      command,
      durationMs: Date.now() - start,
      error,
    });
    writeStderr(runtime, error);
    return error.startsWith("invalid") || error.startsWith("unknown") ? 2 : 1;
  }
}
