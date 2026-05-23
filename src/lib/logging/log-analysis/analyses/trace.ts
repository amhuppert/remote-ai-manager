import { analyzeDuplicateWork, type DuplicateWorkItem } from "./duplicate-work";
import { sortFindings } from "../findings";
import {
  buildIntervalForest,
  computeExclusiveMs,
  computeTraceTimingSummary,
  flattenIntervalForest,
  intervalInputFromRecord,
  type TraceTimingSummary,
} from "../intervals";
import type {
  LogAnalysisFinding,
  LogAnalysisThresholds,
  ParsedServerLogRecord,
} from "../types";

interface TraceSpanSummary {
  lineNumber: number;
  module: string;
  message: string;
  durationMs: number;
  exclusiveMs: number;
  startMs: number;
  endMs: number;
}

interface TraceRequestSummary {
  method?: string;
  path?: string;
  action?: string;
  status?: number;
  durationMs: number;
  message: string;
}

export interface TraceAnalysis {
  traceId: string;
  request: TraceRequestSummary | null;
  summary: {
    recordCount: number;
    timedOperationCount: number;
  };
  timeline: TraceSpanSummary[];
  inclusiveSpans: TraceSpanSummary[];
  exclusiveSpans: TraceSpanSummary[];
  duplicateWork: DuplicateWorkItem[];
  warningsAndErrors: ParsedServerLogRecord[];
  unexplainedTime: TraceTimingSummary;
  findings: LogAnalysisFinding[];
}

function isRequestRecord(record: ParsedServerLogRecord): boolean {
  return (
    record.message === "request.complete" || record.message === "request.error"
  );
}

function requestSummary(record: ParsedServerLogRecord): TraceRequestSummary {
  const summary: TraceRequestSummary = {
    durationMs: record.durationMs ?? 0,
    message: record.message,
  };
  if (record.method !== undefined) summary.method = record.method;
  if (record.path !== undefined) summary.path = record.path;
  if (record.action !== undefined) summary.action = record.action;
  if (record.status !== undefined) summary.status = record.status;
  return summary;
}

function spanFromInterval(input: {
  record: ParsedServerLogRecord;
  startMs: number;
  endMs: number;
  durationMs: number;
  exclusiveMs: number;
}): TraceSpanSummary {
  return {
    lineNumber: input.record.lineNumber,
    module: input.record.module,
    message: input.record.message,
    durationMs: input.durationMs,
    exclusiveMs: input.exclusiveMs,
    startMs: input.startMs,
    endMs: input.endMs,
  };
}

function findingsForTrace(input: {
  traceId: string;
  unexplainedTime: TraceTimingSummary;
  exclusiveSpans: readonly TraceSpanSummary[];
  thresholds: LogAnalysisThresholds;
}): LogAnalysisFinding[] {
  const findings: LogAnalysisFinding[] = [];

  if (
    input.unexplainedTime.unexplainedPercent >= 50 &&
    input.unexplainedTime.unexplainedMs >= input.thresholds.slowMs
  ) {
    findings.push({
      id: `instrumentation-gap-high:${input.traceId}`,
      severity: "high",
      confidence: 0.86,
      category: "instrumentation-gap",
      title: "Most request time is not covered by timed spans",
      explanation:
        "The request duration is substantially larger than the union of timed operation spans, so the next step is to add instrumentation before optimizing code.",
      evidence: [
        {
          label: "unexplainedMs",
          value: input.unexplainedTime.unexplainedMs,
          unit: "ms",
        },
        {
          label: "unexplainedPercent",
          value: input.unexplainedTime.unexplainedPercent,
          unit: "percent",
        },
      ],
      traceIds: [input.traceId],
      recommendedNextActions: [
        "Add timed() coverage around uninstrumented work in this route before choosing an optimization.",
      ],
    });
  } else if (
    input.unexplainedTime.unexplainedPercent >= 25 &&
    input.unexplainedTime.unexplainedMs >= 100
  ) {
    findings.push({
      id: `instrumentation-gap-medium:${input.traceId}`,
      severity: "medium",
      confidence: 0.74,
      category: "instrumentation-gap",
      title: "Request has meaningful uninstrumented time",
      explanation:
        "A meaningful portion of request time is outside timed operation spans.",
      evidence: [
        {
          label: "unexplainedMs",
          value: input.unexplainedTime.unexplainedMs,
          unit: "ms",
        },
      ],
      traceIds: [input.traceId],
      recommendedNextActions: [
        "Inspect route code for work not wrapped in timed().",
      ],
    });
  }

  const topExclusive = input.exclusiveSpans[0];
  if (
    topExclusive !== undefined &&
    topExclusive.exclusiveMs >= input.thresholds.hotspotMs
  ) {
    findings.push({
      id: `operation-hotspot-high:${input.traceId}:${topExclusive.lineNumber}`,
      severity: "high",
      confidence: 0.84,
      category: "operation-hotspot",
      title: `Trace dominated by ${topExclusive.message}`,
      explanation:
        "The highest exclusive span in this trace exceeds the hotspot threshold.",
      evidence: [
        { label: "exclusiveMs", value: topExclusive.exclusiveMs, unit: "ms" },
      ],
      traceIds: [input.traceId],
      recommendedNextActions: [
        `Inspect ${topExclusive.module}:${topExclusive.message}.`,
      ],
    });
  }

  return sortFindings(findings);
}

export function analyzeTrace(
  records: readonly ParsedServerLogRecord[],
  traceId: string,
  thresholds: LogAnalysisThresholds,
): TraceAnalysis {
  const traceRecords = records.filter((record) => record.traceId === traceId);
  const requestRecord = traceRecords
    .filter(
      (record) => isRequestRecord(record) && record.durationMs !== undefined,
    )
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))[0];

  const operationIntervals = traceRecords
    .filter((record) => !isRequestRecord(record))
    .map(intervalInputFromRecord)
    .filter(
      (interval): interval is NonNullable<typeof interval> => interval !== null,
    );

  const roots = buildIntervalForest(operationIntervals);
  const flattened = flattenIntervalForest(roots);
  const timeline = flattened
    .map((interval) => {
      if (interval.record === undefined) return null;
      return spanFromInterval({
        record: interval.record,
        startMs: interval.startMs,
        endMs: interval.endMs,
        durationMs: interval.durationMs,
        exclusiveMs: computeExclusiveMs(interval),
      });
    })
    .filter((span): span is TraceSpanSummary => span !== null);

  const inclusiveSpans = [...timeline].sort(
    (a, b) => b.durationMs - a.durationMs,
  );
  const exclusiveSpans = [...timeline].sort(
    (a, b) => b.exclusiveMs - a.exclusiveMs,
  );
  const requestDurationMs = requestRecord?.durationMs ?? 0;
  const unexplainedTime = computeTraceTimingSummary(requestDurationMs, roots);
  const warningsAndErrors = traceRecords.filter(
    (record) => record.level === "warn" || record.level === "error",
  );

  const duplicateWork = analyzeDuplicateWork(traceRecords, thresholds);
  const findings = sortFindings([
    ...findingsForTrace({
      traceId,
      unexplainedTime,
      exclusiveSpans,
      thresholds,
    }),
    ...duplicateWork.findings,
  ]);

  return {
    traceId,
    request: requestRecord ? requestSummary(requestRecord) : null,
    summary: {
      recordCount: traceRecords.length,
      timedOperationCount: timeline.length,
    },
    timeline,
    inclusiveSpans: inclusiveSpans.slice(0, thresholds.top),
    exclusiveSpans: exclusiveSpans.slice(0, thresholds.top),
    duplicateWork: duplicateWork.duplicates,
    warningsAndErrors,
    unexplainedTime,
    findings,
  };
}
