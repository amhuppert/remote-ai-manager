import { sortFindings } from "../findings";
import type {
  LogAnalysisFinding,
  LogAnalysisThresholds,
  ParsedServerLogRecord,
} from "../types";

/**
 * Convention checks made measurable (Design 5). A `202 Accepted` promises the
 * work was *accepted*, not *performed* — "work expected to exceed ~1s runs as a
 * job with SSE progress." A `request.complete` with status 202 and
 * `durationMs > 1000` means the route held the request across the very work it
 * claimed to defer, so it surfaces as a convention violation. Route authors see
 * the drift in the next report instead of the next incident.
 */

/** A 202 response is only a convention violation once it crosses ~1s. */
const SLOW_202_MS = 1000;

interface Slow202Group {
  key: string;
  method: string;
  path: string;
  count: number;
  maxDurationMs: number;
  traceIds: string[];
}

export interface ConventionsAnalysis {
  slow202s: Slow202Group[];
  findings: LogAnalysisFinding[];
}

function isSlow202(record: ParsedServerLogRecord): boolean {
  return (
    record.message === "request.complete" &&
    record.status === 202 &&
    record.durationMs !== undefined &&
    record.durationMs > SLOW_202_MS
  );
}

function groupSlow202s(
  records: readonly ParsedServerLogRecord[],
): Slow202Group[] {
  const groups = new Map<string, Slow202Group>();
  for (const record of records) {
    if (!isSlow202(record)) continue;
    const method = record.method ?? "unknown";
    const path = record.path ?? "unknown";
    const key = `${method} ${path}`;
    const durationMs = record.durationMs ?? 0;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.maxDurationMs = Math.max(existing.maxDurationMs, durationMs);
      if (record.traceId !== undefined) existing.traceIds.push(record.traceId);
    } else {
      groups.set(key, {
        key,
        method,
        path,
        count: 1,
        maxDurationMs: durationMs,
        traceIds: record.traceId !== undefined ? [record.traceId] : [],
      });
    }
  }
  return [...groups.values()].sort((a, b) => b.maxDurationMs - a.maxDurationMs);
}

function findingForSlow202(group: Slow202Group): LogAnalysisFinding {
  return {
    id: `convention-slow-202:${group.key}`,
    severity: "medium",
    confidence: 0.9,
    category: "convention-violation",
    title: `202 response held ${Math.round(group.maxDurationMs)}ms: ${group.key}`,
    explanation:
      "A 202 (Accepted) must not await the work it accepts — work expected to exceed ~1s runs as a job with SSE progress (Design 5). This endpoint returned 202 but held the request past 1s.",
    evidence: [
      { label: "maxDurationMs", value: group.maxDurationMs, unit: "ms" },
      { label: "count", value: group.count, unit: "count" },
    ],
    traceIds: group.traceIds.slice(0, 5),
    recommendedNextActions: [
      "Move the awaited work behind the 202: record intent, initiate the job, and report readiness via SSE instead of blocking the response.",
    ],
  };
}

export function analyzeConventions(
  records: readonly ParsedServerLogRecord[],
  thresholds: LogAnalysisThresholds,
): ConventionsAnalysis {
  const slow202s = groupSlow202s(records);
  const findings = sortFindings(slow202s.map(findingForSlow202)).slice(
    0,
    thresholds.top,
  );
  return { slow202s, findings };
}
