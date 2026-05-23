import { summarizeNumbers } from "../stats";
import type {
  LogAnalysisFinding,
  LogAnalysisThresholds,
  ParsedServerLogRecord,
} from "../types";

interface SlowRequestGroup {
  key: string;
  method: string;
  path: string;
  action: string;
  status: string;
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  warnCount: number;
  errorCount: number;
  slowTraceIds: string[];
}

export interface SlowRequestAnalysis {
  groups: SlowRequestGroup[];
  findings: LogAnalysisFinding[];
}

interface RequestBucket {
  method: string;
  path: string;
  action: string;
  status: string;
  records: ParsedServerLogRecord[];
}

const SEVERITY_RANK = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
} as const;

function isRequestRecord(record: ParsedServerLogRecord): boolean {
  return (
    (record.message === "request.complete" ||
      record.message === "request.error") &&
    record.durationMs !== undefined
  );
}

function bucketKey(input: {
  method: string;
  path: string;
  action: string;
  status: string;
}): string {
  return `${input.method} ${input.path} action=${input.action} status=${input.status}`;
}

function bucketFor(record: ParsedServerLogRecord): RequestBucket {
  const method = record.method ?? "unknown";
  const path = record.path ?? "unknown";
  const action = record.action ?? "unknown";
  const status = record.status !== undefined ? String(record.status) : "error";
  return {
    method,
    path,
    action,
    status,
    records: [],
  };
}

function slowTraceIds(
  records: readonly ParsedServerLogRecord[],
  slowMs: number,
): string[] {
  return records
    .filter(
      (record) =>
        record.traceId !== undefined &&
        record.durationMs !== undefined &&
        record.durationMs >= slowMs,
    )
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
    .map((record) => record.traceId)
    .filter((traceId): traceId is string => traceId !== undefined);
}

function groupFromBucket(
  bucket: RequestBucket,
  thresholds: LogAnalysisThresholds,
): SlowRequestGroup {
  const durations = bucket.records
    .map((record) => record.durationMs)
    .filter((duration): duration is number => duration !== undefined);
  const summary = summarizeNumbers(durations);
  return {
    key: bucketKey(bucket),
    method: bucket.method,
    path: bucket.path,
    action: bucket.action,
    status: bucket.status,
    count: summary.count,
    p50Ms: summary.p50,
    p95Ms: summary.p95,
    p99Ms: summary.p99,
    maxMs: summary.max,
    warnCount: bucket.records.filter((record) => record.level === "warn")
      .length,
    errorCount: bucket.records.filter((record) => record.level === "error")
      .length,
    slowTraceIds: slowTraceIds(bucket.records, thresholds.slowMs),
  };
}

function findingForGroup(
  group: SlowRequestGroup,
  thresholds: LogAnalysisThresholds,
): LogAnalysisFinding | null {
  if (group.errorCount > 0 && (group.maxMs ?? 0) >= 5000) {
    return {
      id: `slow-request-critical:${group.key}`,
      severity: "critical",
      confidence: 0.95,
      category: "slow-request",
      title: `Slow failing request: ${group.key}`,
      explanation:
        "A request error exceeded 5000 ms, so latency and failure are correlated in this endpoint group.",
      evidence: [
        { label: "maxMs", value: group.maxMs, unit: "ms" },
        { label: "errorCount", value: group.errorCount, unit: "count" },
        { label: "count", value: group.count, unit: "count" },
      ],
      traceIds: group.slowTraceIds,
      recommendedNextActions: [
        `Run bun run logs:analyze -- trace ${group.slowTraceIds[0] ?? "<traceId>"} --format markdown`,
      ],
    };
  }

  if (
    group.p95Ms !== null &&
    group.p95Ms >= thresholds.slowMs * 2 &&
    group.count >= 3
  ) {
    return {
      id: `slow-request-high:${group.key}`,
      severity: "high",
      confidence: 0.9,
      category: "slow-request",
      title: `High p95 request latency: ${group.key}`,
      explanation:
        "This endpoint group has sustained p95 latency above twice the configured slow request threshold.",
      evidence: [
        { label: "p95Ms", value: group.p95Ms, unit: "ms" },
        { label: "count", value: group.count, unit: "count" },
      ],
      traceIds: group.slowTraceIds,
      recommendedNextActions: [
        `Run bun run logs:analyze -- trace ${group.slowTraceIds[0] ?? "<traceId>"} --format markdown`,
      ],
    };
  }

  if (
    group.p95Ms !== null &&
    group.p95Ms >= thresholds.slowMs &&
    group.count >= 3
  ) {
    return {
      id: `slow-request-medium:${group.key}`,
      severity: "medium",
      confidence: 0.82,
      category: "slow-request",
      title: `Elevated p95 request latency: ${group.key}`,
      explanation:
        "This endpoint group has sustained p95 latency above the configured slow request threshold.",
      evidence: [
        { label: "p95Ms", value: group.p95Ms, unit: "ms" },
        { label: "count", value: group.count, unit: "count" },
      ],
      traceIds: group.slowTraceIds,
      recommendedNextActions: [
        `Run bun run logs:analyze -- trace ${group.slowTraceIds[0] ?? "<traceId>"} --format markdown`,
      ],
    };
  }

  if ((group.maxMs ?? 0) >= thresholds.slowMs) {
    return {
      id: `slow-request-low:${group.key}`,
      severity: "low",
      confidence: 0.65,
      category: "slow-request",
      title: `Single slow request observed: ${group.key}`,
      explanation:
        "At least one request exceeded the configured slow request threshold, but the sample does not show sustained p95 latency.",
      evidence: [{ label: "maxMs", value: group.maxMs, unit: "ms" }],
      traceIds: group.slowTraceIds,
      recommendedNextActions: [
        "Collect a larger log window or inspect the slow trace if the symptom is reproducible.",
      ],
    };
  }

  return null;
}

function sortFindings(
  findings: readonly LogAnalysisFinding[],
): LogAnalysisFinding[] {
  return [...findings].sort((a, b) => {
    const severityDelta = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (severityDelta !== 0) return severityDelta;
    return b.confidence - a.confidence;
  });
}

export function analyzeSlowRequests(
  records: readonly ParsedServerLogRecord[],
  thresholds: LogAnalysisThresholds,
): SlowRequestAnalysis {
  const buckets = new Map<string, RequestBucket>();

  for (const record of records) {
    if (!isRequestRecord(record)) continue;
    const nextBucket = bucketFor(record);
    const key = bucketKey(nextBucket);
    const existing = buckets.get(key);
    if (existing) {
      existing.records.push(record);
    } else {
      nextBucket.records.push(record);
      buckets.set(key, nextBucket);
    }
  }

  const groups = [...buckets.values()]
    .map((bucket) => groupFromBucket(bucket, thresholds))
    .sort((a, b) => (b.maxMs ?? 0) - (a.maxMs ?? 0));

  const findings = sortFindings(
    groups
      .map((group) => findingForGroup(group, thresholds))
      .filter((finding): finding is LogAnalysisFinding => finding !== null),
  );

  return { groups, findings };
}
