import { sortFindings } from "../findings";
import type {
  LogAnalysisFinding,
  LogAnalysisThresholds,
  ParsedServerLogRecord,
} from "../types";

export interface SlowTraceCorrelation {
  traceId: string;
  request: ParsedServerLogRecord;
  warningsAndErrors: ParsedServerLogRecord[];
  failedCommands: ParsedServerLogRecord[];
}

export interface ErrorCorrelationAnalysis {
  slowTraceCorrelations: SlowTraceCorrelation[];
  findings: LogAnalysisFinding[];
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

function isRequest(record: ParsedServerLogRecord): boolean {
  return (
    record.message === "request.complete" || record.message === "request.error"
  );
}

function isFailedCommand(record: ParsedServerLogRecord): boolean {
  return (
    rawNumber(record, "exitCode") !== undefined &&
    rawNumber(record, "exitCode") !== 0
  );
}

function slowRequests(
  records: readonly ParsedServerLogRecord[],
  slowMs: number,
): ParsedServerLogRecord[] {
  return records.filter(
    (record) =>
      isRequest(record) &&
      record.traceId !== undefined &&
      record.durationMs !== undefined &&
      record.durationMs >= slowMs,
  );
}

function buildCorrelations(
  records: readonly ParsedServerLogRecord[],
  thresholds: LogAnalysisThresholds,
): SlowTraceCorrelation[] {
  return slowRequests(records, thresholds.slowMs).map((request) => {
    const traceId = request.traceId ?? "unknown";
    const traceRecords = records.filter((record) => record.traceId === traceId);
    return {
      traceId,
      request,
      warningsAndErrors: traceRecords.filter(
        (record) => record.level === "warn" || record.level === "error",
      ),
      failedCommands: traceRecords.filter(isFailedCommand),
    };
  });
}

function findingsForCorrelations(
  correlations: readonly SlowTraceCorrelation[],
): LogAnalysisFinding[] {
  const findings: LogAnalysisFinding[] = [];

  for (const correlation of correlations) {
    if (correlation.request.message === "request.error") {
      findings.push({
        id: `error-correlation-critical:${correlation.traceId}`,
        severity: "critical",
        confidence: 0.94,
        category: "error-correlation",
        title: `Slow request ended in error: ${correlation.traceId}`,
        explanation:
          "The request is both slow and failed, so fix the error path before latency tuning.",
        evidence: [
          {
            label: "durationMs",
            value: correlation.request.durationMs ?? null,
            unit: "ms",
          },
        ],
        traceIds: [correlation.traceId],
        recommendedNextActions: [
          `Run bun run logs:analyze -- trace ${correlation.traceId} --format markdown`,
        ],
      });
    }

    if (correlation.failedCommands.length > 0) {
      findings.push({
        id: `error-correlation-command-high:${correlation.traceId}`,
        severity: "high",
        confidence: 0.88,
        category: "error-correlation",
        title: `Failed command in slow trace: ${correlation.traceId}`,
        explanation:
          "At least one external command failed inside a trace whose request exceeded the slow threshold.",
        evidence: [
          {
            label: "failedCommandCount",
            value: correlation.failedCommands.length,
            unit: "count",
          },
        ],
        traceIds: [correlation.traceId],
        recommendedNextActions: [
          "Inspect command stderr and caller error handling before optimizing successful paths.",
        ],
      });
    }
  }

  const warningTraceCounts = new Map<string, Set<string>>();
  for (const correlation of correlations) {
    for (const warning of correlation.warningsAndErrors) {
      if (warning.level !== "warn") continue;
      const key = `${warning.module}:${warning.message}`;
      const existing = warningTraceCounts.get(key);
      if (existing) {
        existing.add(correlation.traceId);
      } else {
        warningTraceCounts.set(key, new Set([correlation.traceId]));
      }
    }
  }

  for (const [key, traceIds] of warningTraceCounts) {
    if (traceIds.size >= 3) {
      findings.push({
        id: `error-correlation-warning-medium:${key}`,
        severity: "medium",
        confidence: 0.72,
        category: "error-correlation",
        title: `Warning appears across slow traces: ${key}`,
        explanation:
          "The same warning appears in at least three slow request traces.",
        evidence: [
          { label: "affectedTraces", value: traceIds.size, unit: "count" },
        ],
        traceIds: [...traceIds].slice(0, 5),
        recommendedNextActions: [
          "Inspect whether the warning identifies a shared slow-path symptom.",
        ],
      });
    }
  }

  return sortFindings(findings);
}

export function analyzeErrorCorrelation(
  records: readonly ParsedServerLogRecord[],
  thresholds: LogAnalysisThresholds,
): ErrorCorrelationAnalysis {
  const slowTraceCorrelations = buildCorrelations(records, thresholds);
  return {
    slowTraceCorrelations: slowTraceCorrelations.slice(0, thresholds.top),
    findings: findingsForCorrelations(slowTraceCorrelations),
  };
}
