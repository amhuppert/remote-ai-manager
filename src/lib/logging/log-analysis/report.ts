import { analyzeClientTiming } from "./analyses/client-timing";
import { analyzeConventions } from "./analyses/conventions";
import { analyzeDuplicateWork } from "./analyses/duplicate-work";
import { analyzeErrorCorrelation } from "./analyses/errors";
import { analyzeExternalCommands } from "./analyses/external-commands";
import { analyzeOperationHotspots } from "./analyses/operation-hotspots";
import { analyzeSlowRequests } from "./analyses/requests";
import { analyzeSse } from "./analyses/sse";
import { analyzeStateStore } from "./analyses/state-store";
import { analyzeTrace } from "./analyses/trace";
import { applyServerLogFilters } from "./filters";
import { capFindings, sortFindings } from "./findings";
import {
  DEFAULT_BUDGET_CONFIG,
  evaluateBudgets,
  extractRowSizeEvents,
  type BudgetConfig,
} from "./budgets";
import type { AgentLogAnalysisReport } from "./schemas";
import type {
  LogAnalysisFilters,
  LogAnalysisFinding,
  LogAnalysisThresholds,
  ParsedServerLogRecord,
} from "./types";

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

export interface ReportParseStats {
  malformedLineCount: number;
  invalidTimestampCount: number;
  invalidShapeCount: number;
}

export interface BuildLogAnalysisReportInput {
  records: readonly ParsedServerLogRecord[];
  parseStats: ReportParseStats;
  filters: LogAnalysisFilters;
  thresholds: LogAnalysisThresholds;
  /** Budget ceilings for advisory evaluation; defaults to the baked-in config. */
  budgetConfig?: BudgetConfig;
  input: Record<string, unknown>;
  generatedAt: string;
  clientLogRaw: string | null;
}

function isRequest(record: ParsedServerLogRecord): boolean {
  return (
    record.message === "request.complete" || record.message === "request.error"
  );
}

function uniqueTraceIds(traceIds: readonly string[]): string[] {
  return [...new Set(traceIds)];
}

function traceIdsFromSlowRequests(
  slowRequestFindings: readonly LogAnalysisFinding[],
): string[] {
  return uniqueTraceIds(
    slowRequestFindings.flatMap((finding) => finding.traceIds),
  );
}

function instrumentationFindingsForSlowTraces(input: {
  records: readonly ParsedServerLogRecord[];
  traceIds: readonly string[];
  thresholds: LogAnalysisThresholds;
}): LogAnalysisFinding[] {
  return input.traceIds.flatMap((traceId) =>
    analyzeTrace(input.records, traceId, input.thresholds).findings.filter(
      (finding) => finding.category === "instrumentation-gap",
    ),
  );
}

export function buildLogAnalysisReport(
  input: BuildLogAnalysisReportInput,
): AgentLogAnalysisReport {
  const filteredRecords = applyServerLogFilters(input.records, input.filters);
  const slowRequests = analyzeSlowRequests(filteredRecords, input.thresholds);
  const operationHotspots = analyzeOperationHotspots(
    filteredRecords,
    input.thresholds,
  );
  const duplicateWork = analyzeDuplicateWork(filteredRecords, input.thresholds);
  const stateStore = analyzeStateStore(filteredRecords, input.thresholds);
  const externalCommands = analyzeExternalCommands(
    filteredRecords,
    input.thresholds,
  );
  const sse = analyzeSse(filteredRecords, input.thresholds);
  const clientTiming = analyzeClientTiming(
    input.clientLogRaw,
    input.thresholds,
  );
  const errorCorrelation = analyzeErrorCorrelation(
    filteredRecords,
    input.thresholds,
  );
  const conventions = analyzeConventions(filteredRecords, input.thresholds);
  const instrumentationGaps = instrumentationFindingsForSlowTraces({
    records: filteredRecords,
    traceIds: traceIdsFromSlowRequests(slowRequests.findings).slice(
      0,
      input.thresholds.top,
    ),
    thresholds: input.thresholds,
  });

  // Budgets are evaluated on every report (advisory); `--assert-budgets` in the
  // CLI turns a non-empty violation list into a non-zero exit. Bounded to `top`
  // so the report contract stays size-bounded.
  const budgetConfig = input.budgetConfig ?? DEFAULT_BUDGET_CONFIG;
  const budgetViolations = evaluateBudgets({
    config: budgetConfig,
    routeP95s: slowRequests.groups.map((group) => ({
      key: group.key,
      p95Ms: group.p95Ms,
    })),
    writeQueueHolds: stateStore.writeQueue.map((queue) => ({
      label: queue.label,
      maxHoldMs: queue.maxHoldMs,
    })),
    stateReadP95s: stateStore.slowAccessors.map((accessor) => ({
      accessor: accessor.accessor,
      p95Ms: accessor.p95Ms,
    })),
    rowSizes: extractRowSizeEvents(filteredRecords),
  }).sort((a, b) => b.observed / b.ceiling - a.observed / a.ceiling);

  const findings = capFindings(
    sortFindings([
      ...slowRequests.findings,
      ...operationHotspots.findings,
      ...duplicateWork.findings,
      ...stateStore.findings,
      ...externalCommands.findings,
      ...sse.findings,
      ...clientTiming.findings,
      ...errorCorrelation.findings,
      ...conventions.findings,
      ...instrumentationGaps,
    ]),
    input.thresholds.top,
  );

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    command: "report",
    input: {
      ...input.input,
      filters: input.filters,
      thresholds: input.thresholds,
    },
    summary: {
      recordsRead: input.records.length,
      recordsAnalyzed: filteredRecords.length,
      malformedLineCount: input.parseStats.malformedLineCount,
      invalidTimestampCount: input.parseStats.invalidTimestampCount,
      invalidShapeCount: input.parseStats.invalidShapeCount,
      timedEventCount: filteredRecords.filter(
        (record) => record.durationMs !== undefined,
      ).length,
      requestCount: filteredRecords.filter(isRequest).length,
      warnCount: filteredRecords.filter((record) => record.level === "warn")
        .length,
      errorCount: filteredRecords.filter((record) => record.level === "error")
        .length,
    },
    findings,
    slowRequests: asUnknownRecords(slowRequests.groups),
    operationHotspots: asUnknownRecords(operationHotspots.hotspots),
    duplicateWork: asUnknownRecords(duplicateWork.duplicates),
    stateStore: {
      slowAccessors: stateStore.slowAccessors,
      repoOperations: stateStore.repoOperations,
      writeQueue: stateStore.writeQueue,
      holdBudgetExceeded: stateStore.holdBudgetExceeded,
      facadeRepoGaps: stateStore.facadeRepoGaps,
    },
    externalCommands: asUnknownRecords(externalCommands.commands),
    sse: asUnknownRecords(sse.events),
    clientTiming: asUnknownRecord(clientTiming),
    errorCorrelation: {
      slowTraceCorrelations: errorCorrelation.slowTraceCorrelations,
    },
    instrumentationGaps,
    budgets: {
      config: budgetConfig,
      violationCount: budgetViolations.length,
      violations: asUnknownRecords(
        budgetViolations.slice(0, input.thresholds.top),
      ),
    },
    artifacts: [],
  };
}
