import { analyzeDuplicateWork } from "./duplicate-work";
import { analyzeOperationHotspots } from "./operation-hotspots";
import { analyzeSlowRequests } from "./requests";
import { applyServerLogFilters } from "../filters";
import { sortFindings } from "../findings";
import type { AgentLogComparisonReport } from "../schemas";
import type {
  LogAnalysisFilters,
  LogAnalysisFinding,
  LogAnalysisThresholds,
  ParsedServerLogRecord,
} from "../types";

export interface BuildLogComparisonReportInput {
  beforeRecords: readonly ParsedServerLogRecord[];
  afterRecords: readonly ParsedServerLogRecord[];
  filters: LogAnalysisFilters;
  thresholds: LogAnalysisThresholds;
  beforeInput: Record<string, unknown>;
  afterInput: Record<string, unknown>;
  generatedAt: string;
}

interface MetricDelta {
  key: string;
  beforeP95Ms: number | null;
  afterP95Ms: number | null;
  p95DeltaMs: number | null;
  p95DeltaPercent: number | null;
  beforeCount: number;
  afterCount: number;
}

interface WarningErrorDelta {
  key: string;
  beforeCount: number;
  afterCount: number;
}

interface DuplicateWorkDelta {
  signature: string;
  status: "new";
  beforeCount: number;
  afterCount: number;
}

function asUnknownRecords<T extends object>(
  values: readonly T[],
): Record<string, unknown>[] {
  return values.map((value) => {
    const record: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value)) {
      record[key] = entryValue;
    }
    return record;
  });
}

function percentDelta(
  before: number | null,
  after: number | null,
): number | null {
  if (before === null || after === null || before === 0) return null;
  return ((after - before) / before) * 100;
}

function metricDelta(input: {
  key: string;
  beforeP95Ms: number | null;
  afterP95Ms: number | null;
  beforeCount: number;
  afterCount: number;
}): MetricDelta {
  const p95DeltaMs =
    input.beforeP95Ms !== null && input.afterP95Ms !== null
      ? input.afterP95Ms - input.beforeP95Ms
      : null;
  return {
    key: input.key,
    beforeP95Ms: input.beforeP95Ms,
    afterP95Ms: input.afterP95Ms,
    p95DeltaMs,
    p95DeltaPercent: percentDelta(input.beforeP95Ms, input.afterP95Ms),
    beforeCount: input.beforeCount,
    afterCount: input.afterCount,
  };
}

function endpointDeltas(
  beforeRecords: readonly ParsedServerLogRecord[],
  afterRecords: readonly ParsedServerLogRecord[],
  thresholds: LogAnalysisThresholds,
): MetricDelta[] {
  const before = new Map(
    analyzeSlowRequests(beforeRecords, thresholds).groups.map((group) => [
      group.key,
      group,
    ]),
  );
  const after = new Map(
    analyzeSlowRequests(afterRecords, thresholds).groups.map((group) => [
      group.key,
      group,
    ]),
  );
  const keys = [...new Set([...before.keys(), ...after.keys()])];
  return keys
    .map((key) =>
      metricDelta({
        key,
        beforeP95Ms: before.get(key)?.p95Ms ?? null,
        afterP95Ms: after.get(key)?.p95Ms ?? null,
        beforeCount: before.get(key)?.count ?? 0,
        afterCount: after.get(key)?.count ?? 0,
      }),
    )
    .filter((delta) => delta.afterCount > 0)
    .sort((a, b) => (b.p95DeltaMs ?? 0) - (a.p95DeltaMs ?? 0))
    .slice(0, thresholds.top);
}

function operationDeltas(
  beforeRecords: readonly ParsedServerLogRecord[],
  afterRecords: readonly ParsedServerLogRecord[],
  thresholds: LogAnalysisThresholds,
): MetricDelta[] {
  const before = new Map(
    analyzeOperationHotspots(beforeRecords, thresholds).hotspots.map(
      (hotspot) => [hotspot.key, hotspot],
    ),
  );
  const after = new Map(
    analyzeOperationHotspots(afterRecords, thresholds).hotspots.map(
      (hotspot) => [hotspot.key, hotspot],
    ),
  );
  const keys = [...new Set([...before.keys(), ...after.keys()])];
  return keys
    .map((key) =>
      metricDelta({
        key,
        beforeP95Ms: before.get(key)?.p95Ms ?? null,
        afterP95Ms: after.get(key)?.p95Ms ?? null,
        beforeCount: before.get(key)?.count ?? 0,
        afterCount: after.get(key)?.count ?? 0,
      }),
    )
    .filter((delta) => delta.afterCount > 0)
    .sort((a, b) => (b.p95DeltaMs ?? 0) - (a.p95DeltaMs ?? 0))
    .slice(0, thresholds.top);
}

function warningErrorKey(record: ParsedServerLogRecord): string {
  return `${record.level}:${record.module}:${record.message}`;
}

function warningErrorCounts(
  records: readonly ParsedServerLogRecord[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of records) {
    if (record.level !== "warn" && record.level !== "error") continue;
    const key = warningErrorKey(record);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function newWarningsAndErrors(
  beforeRecords: readonly ParsedServerLogRecord[],
  afterRecords: readonly ParsedServerLogRecord[],
  top: number,
): WarningErrorDelta[] {
  const before = warningErrorCounts(beforeRecords);
  const after = warningErrorCounts(afterRecords);
  return [...after.entries()]
    .map(([key, afterCount]) => ({
      key,
      beforeCount: before.get(key) ?? 0,
      afterCount,
    }))
    .filter((delta) => delta.afterCount > delta.beforeCount)
    .sort((a, b) => b.afterCount - a.afterCount)
    .slice(0, top);
}

function duplicateDeltas(
  beforeRecords: readonly ParsedServerLogRecord[],
  afterRecords: readonly ParsedServerLogRecord[],
  thresholds: LogAnalysisThresholds,
): DuplicateWorkDelta[] {
  const before = new Set(
    analyzeDuplicateWork(beforeRecords, thresholds).duplicates.map(
      (duplicate) => duplicate.signature,
    ),
  );
  return analyzeDuplicateWork(afterRecords, thresholds)
    .duplicates.filter((duplicate) => !before.has(duplicate.signature))
    .map((duplicate) => ({
      signature: duplicate.signature,
      status: "new" as const,
      beforeCount: 0,
      afterCount: duplicate.count,
    }))
    .slice(0, thresholds.top);
}

function findingsForComparison(input: {
  endpointDeltas: readonly MetricDelta[];
  operationDeltas: readonly MetricDelta[];
  duplicateWorkDeltas: readonly DuplicateWorkDelta[];
  newWarningsAndErrors: readonly WarningErrorDelta[];
}): LogAnalysisFinding[] {
  const findings: LogAnalysisFinding[] = [];

  for (const delta of input.endpointDeltas) {
    if ((delta.p95DeltaPercent ?? 0) >= 50 && (delta.p95DeltaMs ?? 0) >= 100) {
      findings.push({
        id: `regression-endpoint-high:${delta.key}`,
        severity: "high",
        confidence: 0.86,
        category: "regression",
        title: `Endpoint p95 regressed: ${delta.key}`,
        explanation:
          "The endpoint p95 worsened by at least 50% and at least 100 ms.",
        evidence: [
          { label: "p95DeltaMs", value: delta.p95DeltaMs, unit: "ms" },
          {
            label: "p95DeltaPercent",
            value: delta.p95DeltaPercent,
            unit: "percent",
          },
        ],
        traceIds: [],
        recommendedNextActions: [
          "Run report on the after log and trace the slowest affected request.",
        ],
      });
    }
  }

  for (const delta of input.operationDeltas) {
    if ((delta.p95DeltaPercent ?? 0) >= 50 && (delta.p95DeltaMs ?? 0) >= 50) {
      findings.push({
        id: `regression-operation-medium:${delta.key}`,
        severity: "medium",
        confidence: 0.78,
        category: "regression",
        title: `Operation p95 regressed: ${delta.key}`,
        explanation:
          "The operation p95 worsened by at least 50% and at least 50 ms.",
        evidence: [
          { label: "p95DeltaMs", value: delta.p95DeltaMs, unit: "ms" },
          {
            label: "p95DeltaPercent",
            value: delta.p95DeltaPercent,
            unit: "percent",
          },
        ],
        traceIds: [],
        recommendedNextActions: [
          "Inspect call sites for this operation in the after branch.",
        ],
      });
    }
  }

  for (const delta of input.newWarningsAndErrors) {
    if (delta.key.startsWith("error:")) {
      findings.push({
        id: `regression-new-error-high:${delta.key}`,
        severity: "high",
        confidence: 0.9,
        category: "regression",
        title: `New error category: ${delta.key}`,
        explanation:
          "An error appears in the after log that was absent or rarer before.",
        evidence: [
          { label: "afterCount", value: delta.afterCount, unit: "count" },
        ],
        traceIds: [],
        recommendedNextActions: [
          "Fix new errors before interpreting latency deltas.",
        ],
      });
    }
  }

  for (const delta of input.duplicateWorkDeltas) {
    findings.push({
      id: `regression-duplicate-low:${delta.signature}`,
      severity: "low",
      confidence: 0.64,
      category: "regression",
      title: `New duplicate-work signature: ${delta.signature}`,
      explanation: "A duplicate-work signature appears only in the after log.",
      evidence: [
        { label: "afterCount", value: delta.afterCount, unit: "count" },
      ],
      traceIds: [],
      recommendedNextActions: [
        "Inspect repeated calls in traces containing this signature.",
      ],
    });
  }

  return sortFindings(findings);
}

export function buildLogComparisonReport(
  input: BuildLogComparisonReportInput,
): AgentLogComparisonReport {
  const beforeRecords = applyServerLogFilters(
    input.beforeRecords,
    input.filters,
  );
  const afterRecords = applyServerLogFilters(input.afterRecords, input.filters);
  const endpointDeltaRows = endpointDeltas(
    beforeRecords,
    afterRecords,
    input.thresholds,
  );
  const operationDeltaRows = operationDeltas(
    beforeRecords,
    afterRecords,
    input.thresholds,
  );
  const duplicateWorkDeltaRows = duplicateDeltas(
    beforeRecords,
    afterRecords,
    input.thresholds,
  );
  const warningErrorRows = newWarningsAndErrors(
    beforeRecords,
    afterRecords,
    input.thresholds.top,
  );

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    command: "compare",
    before: {
      ...input.beforeInput,
      recordsAnalyzed: beforeRecords.length,
    },
    after: {
      ...input.afterInput,
      recordsAnalyzed: afterRecords.length,
    },
    summaryDelta: {
      recordsAnalyzedDelta: afterRecords.length - beforeRecords.length,
    },
    endpointDeltas: asUnknownRecords(endpointDeltaRows),
    operationDeltas: asUnknownRecords(operationDeltaRows),
    duplicateWorkDeltas: asUnknownRecords(duplicateWorkDeltaRows),
    newWarningsAndErrors: asUnknownRecords(warningErrorRows),
    findings: sortFindings(
      findingsForComparison({
        endpointDeltas: endpointDeltaRows,
        operationDeltas: operationDeltaRows,
        duplicateWorkDeltas: duplicateWorkDeltaRows,
        newWarningsAndErrors: warningErrorRows,
      }),
    ).slice(0, input.thresholds.top),
  };
}
