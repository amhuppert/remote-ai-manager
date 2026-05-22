import { sortFindings } from "../findings";
import { summarizeNumbers } from "../stats";
import type {
  LogAnalysisFinding,
  LogAnalysisThresholds,
  ParsedServerLogRecord,
} from "../types";

export interface ExternalCommandSummary {
  key: string;
  command: string;
  argsPreview: string;
  cwd: string;
  count: number;
  p95Ms: number | null;
  maxMs: number | null;
  totalMs: number;
  nonZeroExitCount: number;
  stderrBytes: number;
  exampleTraceIds: string[];
}

export interface ExternalCommandAnalysis {
  commands: ExternalCommandSummary[];
  findings: LogAnalysisFinding[];
}

interface CommandBucket {
  key: string;
  command: string;
  argsPreview: string;
  cwd: string;
  records: ParsedServerLogRecord[];
}

function rawString(
  record: ParsedServerLogRecord,
  key: string,
): string | undefined {
  const value = record.raw[key];
  return typeof value === "string" ? value : undefined;
}

function rawNumber(
  record: ParsedServerLogRecord,
  key: string,
): number | undefined {
  const value = record.raw[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isExternalCommand(record: ParsedServerLogRecord): boolean {
  if (record.durationMs === undefined) return false;
  return (
    record.module === "exec" ||
    record.message.startsWith("git.") ||
    record.message.startsWith("tailscale.") ||
    record.message.startsWith("pre-merge.script.") ||
    record.message.startsWith("init-script.")
  );
}

function commandKey(record: ParsedServerLogRecord): {
  key: string;
  command: string;
  argsPreview: string;
  cwd: string;
} {
  const command = rawString(record, "command") ?? "unknown";
  const argsPreview = rawString(record, "argsPreview") ?? "";
  const cwd = rawString(record, "cwd") ?? "unknown";
  return {
    key: `${command} ${argsPreview} cwd=${cwd}`.trim(),
    command,
    argsPreview,
    cwd,
  };
}

function traceIds(records: readonly ParsedServerLogRecord[]): string[] {
  return [
    ...new Set(
      records
        .map((record) => record.traceId)
        .filter((traceId): traceId is string => traceId !== undefined),
    ),
  ].slice(0, 5);
}

function summaryFromBucket(bucket: CommandBucket): ExternalCommandSummary {
  const durations = bucket.records
    .map((record) => record.durationMs)
    .filter((duration): duration is number => duration !== undefined);
  const summary = summarizeNumbers(durations);
  return {
    key: bucket.key,
    command: bucket.command,
    argsPreview: bucket.argsPreview,
    cwd: bucket.cwd,
    count: summary.count,
    p95Ms: summary.p95,
    maxMs: summary.max,
    totalMs: summary.total,
    nonZeroExitCount: bucket.records.filter(
      (record) => (rawNumber(record, "exitCode") ?? 0) !== 0,
    ).length,
    stderrBytes: bucket.records.reduce(
      (sum, record) => sum + (rawNumber(record, "stderrBytes") ?? 0),
      0,
    ),
    exampleTraceIds: traceIds(bucket.records),
  };
}

function slowRequestTraceIds(
  records: readonly ParsedServerLogRecord[],
  slowMs: number,
): Set<string> {
  return new Set(
    records
      .filter(
        (record) =>
          (record.message === "request.complete" ||
            record.message === "request.error") &&
          record.durationMs !== undefined &&
          record.durationMs >= slowMs &&
          record.traceId !== undefined,
      )
      .map((record) => record.traceId)
      .filter((traceId): traceId is string => traceId !== undefined),
  );
}

function findingForCommand(
  command: ExternalCommandSummary,
  slowTraces: ReadonlySet<string>,
): LogAnalysisFinding | null {
  const failedInSlowTrace =
    command.nonZeroExitCount > 0 &&
    command.exampleTraceIds.some((traceId) => slowTraces.has(traceId));

  if (failedInSlowTrace) {
    return {
      id: `external-command-high:${command.key}`,
      severity: "high",
      confidence: 0.9,
      category: "external-command",
      title: `Failed external command in slow trace: ${command.key}`,
      explanation:
        "A non-zero external command exit occurred in a trace whose request exceeded the slow threshold.",
      evidence: [
        {
          label: "nonZeroExitCount",
          value: command.nonZeroExitCount,
          unit: "count",
        },
        { label: "maxMs", value: command.maxMs, unit: "ms" },
      ],
      traceIds: command.exampleTraceIds,
      recommendedNextActions: [
        "Inspect command stderr and caller error handling before optimizing application code.",
      ],
    };
  }

  if ((command.p95Ms ?? 0) >= 2000) {
    return {
      id: `external-command-high-latency:${command.key}`,
      severity: "high",
      confidence: 0.84,
      category: "external-command",
      title: `High p95 external command latency: ${command.key}`,
      explanation: "This command has p95 duration above 2000 ms.",
      evidence: [{ label: "p95Ms", value: command.p95Ms, unit: "ms" }],
      traceIds: command.exampleTraceIds,
      recommendedNextActions: ["Inspect command usage and repository size."],
    };
  }

  if ((command.p95Ms ?? 0) >= 1000) {
    return {
      id: `external-command-medium-latency:${command.key}`,
      severity: "medium",
      confidence: 0.76,
      category: "external-command",
      title: `Elevated external command latency: ${command.key}`,
      explanation: "This command has p95 duration above 1000 ms.",
      evidence: [{ label: "p95Ms", value: command.p95Ms, unit: "ms" }],
      traceIds: command.exampleTraceIds,
      recommendedNextActions: [
        "Check whether the command is avoidable or repeated.",
      ],
    };
  }

  if (command.stderrBytes > 0 && command.nonZeroExitCount === 0) {
    return {
      id: `external-command-low-stderr:${command.key}`,
      severity: "low",
      confidence: 0.58,
      category: "external-command",
      title: `External command wrote stderr: ${command.key}`,
      explanation:
        "The command wrote stderr without failing; inspect only if it correlates with user-visible latency.",
      evidence: [
        { label: "stderrBytes", value: command.stderrBytes, unit: "bytes" },
      ],
      traceIds: command.exampleTraceIds,
      recommendedNextActions: [
        "Inspect stderr contents if available in nearby logs.",
      ],
    };
  }

  return null;
}

export function analyzeExternalCommands(
  records: readonly ParsedServerLogRecord[],
  thresholds: LogAnalysisThresholds,
): ExternalCommandAnalysis {
  const buckets = new Map<string, CommandBucket>();

  for (const record of records) {
    if (!isExternalCommand(record)) continue;
    const keyed = commandKey(record);
    const existing = buckets.get(keyed.key);
    if (existing) {
      existing.records.push(record);
      continue;
    }
    buckets.set(keyed.key, {
      ...keyed,
      records: [record],
    });
  }

  const commands = [...buckets.values()]
    .map(summaryFromBucket)
    .sort((a, b) => (b.maxMs ?? 0) - (a.maxMs ?? 0))
    .slice(0, thresholds.top);
  const slowTraces = slowRequestTraceIds(records, thresholds.slowMs);

  return {
    commands,
    findings: sortFindings(
      commands
        .map((command) => findingForCommand(command, slowTraces))
        .filter((finding): finding is LogAnalysisFinding => finding !== null),
    ),
  };
}
