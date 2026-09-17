import { analyzeTrace } from "./analyses/trace";
import { buildLogComparisonReport } from "./analyses/compare";
import { applyServerLogFilters } from "./filters";
import { parseServerLogLines } from "./parser";
import { buildLogAnalysisReport } from "./report";
import { DEFAULT_BUDGET_CONFIG, type BudgetConfig } from "./budgets";
import type { AgentTraceAnalysisReport } from "./schemas";
import type { LogAnalysisFilters, LogAnalysisThresholds } from "./types";

export interface LogAnalysisOptions {
  readonly filters: LogAnalysisFilters;
  readonly thresholds: LogAnalysisThresholds;
  readonly generatedAt: string;
}

/** The same trace projection is consumed by each CLI transport. */
export function buildTraceAnalysisReport(
  records: ReturnType<typeof parseServerLogLines>["records"],
  traceId: string,
  options: LogAnalysisOptions,
): AgentTraceAnalysisReport {
  const filtered = applyServerLogFilters(records, options.filters);
  if (!filtered.some((record) => record.traceId === traceId))
    throw new Error(`Trace not found: ${traceId}`);
  const trace = analyzeTrace(filtered, traceId, options.thresholds);
  return {
    schemaVersion: 1,
    generatedAt: options.generatedAt,
    command: "trace",
    traceId,
    request: trace.request,
    summary: trace.summary,
    timeline: trace.timeline.map((row) => ({ ...row })),
    inclusiveSpans: trace.inclusiveSpans.map((row) => ({ ...row })),
    exclusiveSpans: trace.exclusiveSpans.map((row) => ({ ...row })),
    duplicateWork: trace.duplicateWork.map((row) => ({ ...row })),
    warningsAndErrors: trace.warningsAndErrors.map((row) => ({ ...row })),
    unexplainedTime: { ...trace.unexplainedTime },
    findings: trace.findings,
    artifacts: [],
  };
}

export function analyzeLogReport(
  raw: string,
  path: string,
  options: LogAnalysisOptions & {
    readonly clientLogRaw?: string;
    readonly budgetConfig?: BudgetConfig;
  },
) {
  const parsed = parseServerLogLines(raw.split(/\r?\n/));
  if (applyServerLogFilters(parsed.records, options.filters).length === 0)
    throw new Error("No usable records after parsing and filtering.");
  return buildLogAnalysisReport({
    records: parsed.records,
    parseStats: {
      malformedLineCount: parsed.malformedLineCount,
      invalidTimestampCount: parsed.invalidTimestampCount,
      invalidShapeCount: parsed.invalidShapeCount,
    },
    filters: options.filters,
    thresholds: options.thresholds,
    budgetConfig: options.budgetConfig ?? DEFAULT_BUDGET_CONFIG,
    input: { serverLogPath: path },
    generatedAt: options.generatedAt,
    clientLogRaw: options.clientLogRaw ?? null,
  });
}

export function analyzeLogComparison(
  before: { readonly raw: string; readonly path: string },
  after: { readonly raw: string; readonly path: string },
  options: LogAnalysisOptions,
) {
  return buildLogComparisonReport({
    beforeRecords: parseServerLogLines(before.raw.split(/\r?\n/)).records,
    afterRecords: parseServerLogLines(after.raw.split(/\r?\n/)).records,
    filters: options.filters,
    thresholds: options.thresholds,
    beforeInput: { serverLogPath: before.path },
    afterInput: { serverLogPath: after.path },
    generatedAt: options.generatedAt,
  });
}
