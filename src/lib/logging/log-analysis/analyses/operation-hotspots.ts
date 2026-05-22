import { sortFindings } from "../findings";
import { summarizeNumbers } from "../stats";
import type {
  LogAnalysisFinding,
  LogAnalysisThresholds,
  ParsedServerLogRecord,
} from "../types";

export interface OperationHotspot {
  key: string;
  module: string;
  message: string;
  count: number;
  totalMs: number;
  avgMs: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  exampleTraceIds: string[];
  exampleFields: Record<string, unknown>;
}

export interface OperationHotspotAnalysis {
  hotspots: OperationHotspot[];
  findings: LogAnalysisFinding[];
}

interface OperationBucket {
  key: string;
  module: string;
  message: string;
  records: ParsedServerLogRecord[];
  exampleFields: Record<string, unknown>;
}

function isRequestDurationEvent(record: ParsedServerLogRecord): boolean {
  return (
    record.message === "request.complete" || record.message === "request.error"
  );
}

function rawString(
  record: ParsedServerLogRecord,
  key: string,
): string | undefined {
  const value = record.raw[key];
  return typeof value === "string" ? value : undefined;
}

function groupingParts(record: ParsedServerLogRecord): {
  suffix: string;
  fields: Record<string, unknown>;
} {
  const accessor = rawString(record, "accessor");
  if (record.message === "state.read.timing" && accessor !== undefined) {
    return {
      suffix: ` accessor=${accessor}`,
      fields: { accessor },
    };
  }

  const label = rawString(record, "label");
  if (label !== undefined) {
    return {
      suffix: ` label=${label}`,
      fields: { label },
    };
  }

  const command = rawString(record, "command");
  const argsPreview = rawString(record, "argsPreview");
  if (command !== undefined || argsPreview !== undefined) {
    return {
      suffix: ` command=${command ?? "unknown"} args=${argsPreview ?? ""}`,
      fields: { command, argsPreview },
    };
  }

  const eventType = rawString(record, "eventType");
  if (eventType !== undefined) {
    return {
      suffix: ` eventType=${eventType}`,
      fields: { eventType },
    };
  }

  return { suffix: "", fields: {} };
}

function keyForRecord(record: ParsedServerLogRecord): {
  key: string;
  fields: Record<string, unknown>;
} {
  const grouping = groupingParts(record);
  return {
    key: `${record.module}:${record.message}${grouping.suffix}`,
    fields: grouping.fields,
  };
}

function exampleTraceIds(records: readonly ParsedServerLogRecord[]): string[] {
  return records
    .filter(
      (record) =>
        record.traceId !== undefined && record.durationMs !== undefined,
    )
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
    .map((record) => record.traceId)
    .filter((traceId): traceId is string => traceId !== undefined)
    .slice(0, 5);
}

function hotspotFromBucket(bucket: OperationBucket): OperationHotspot {
  const durations = bucket.records
    .map((record) => record.durationMs)
    .filter((duration): duration is number => duration !== undefined);
  const summary = summarizeNumbers(durations);
  return {
    key: bucket.key,
    module: bucket.module,
    message: bucket.message,
    count: summary.count,
    totalMs: summary.total,
    avgMs: summary.avg,
    p95Ms: summary.p95,
    maxMs: summary.max,
    exampleTraceIds: exampleTraceIds(bucket.records),
    exampleFields: bucket.exampleFields,
  };
}

function findingForHotspot(
  hotspot: OperationHotspot,
  thresholds: LogAnalysisThresholds,
): LogAnalysisFinding | null {
  if (
    hotspot.p95Ms !== null &&
    hotspot.p95Ms >= thresholds.hotspotMs &&
    hotspot.count >= 3
  ) {
    return {
      id: `operation-hotspot-high:${hotspot.key}`,
      severity: "high",
      confidence: 0.88,
      category: "operation-hotspot",
      title: `High p95 operation latency: ${hotspot.key}`,
      explanation:
        "This operation has sustained p95 latency above the configured hotspot threshold.",
      evidence: [
        { label: "p95Ms", value: hotspot.p95Ms, unit: "ms" },
        { label: "count", value: hotspot.count, unit: "count" },
      ],
      traceIds: hotspot.exampleTraceIds,
      recommendedNextActions: [
        `Inspect the timed operation ${hotspot.module}:${hotspot.message} and run trace analysis for an example trace.`,
      ],
    };
  }

  if (hotspot.totalMs >= thresholds.hotspotMs * 5) {
    return {
      id: `operation-hotspot-medium:${hotspot.key}`,
      severity: "medium",
      confidence: 0.78,
      category: "operation-hotspot",
      title: `High cumulative operation cost: ${hotspot.key}`,
      explanation:
        "This operation consumes enough cumulative wall time to be worth inspecting even though p95 does not cross the high threshold.",
      evidence: [
        { label: "totalMs", value: hotspot.totalMs, unit: "ms" },
        { label: "count", value: hotspot.count, unit: "count" },
      ],
      traceIds: hotspot.exampleTraceIds,
      recommendedNextActions: [
        `Check whether ${hotspot.module}:${hotspot.message} is repeated unnecessarily across request traces.`,
      ],
    };
  }

  if ((hotspot.maxMs ?? 0) >= thresholds.hotspotMs) {
    return {
      id: `operation-hotspot-low:${hotspot.key}`,
      severity: "low",
      confidence: 0.62,
      category: "operation-hotspot",
      title: `Single slow operation observed: ${hotspot.key}`,
      explanation:
        "One operation instance exceeded the hotspot threshold, but the sample does not show sustained high p95 latency.",
      evidence: [{ label: "maxMs", value: hotspot.maxMs, unit: "ms" }],
      traceIds: hotspot.exampleTraceIds,
      recommendedNextActions: [
        "Inspect this only if it correlates with a user-visible slow request.",
      ],
    };
  }

  return null;
}

export function analyzeOperationHotspots(
  records: readonly ParsedServerLogRecord[],
  thresholds: LogAnalysisThresholds,
): OperationHotspotAnalysis {
  const buckets = new Map<string, OperationBucket>();

  for (const record of records) {
    if (record.durationMs === undefined || isRequestDurationEvent(record)) {
      continue;
    }

    const keyed = keyForRecord(record);
    const existing = buckets.get(keyed.key);
    if (existing) {
      existing.records.push(record);
      continue;
    }

    buckets.set(keyed.key, {
      key: keyed.key,
      module: record.module,
      message: record.message,
      records: [record],
      exampleFields: keyed.fields,
    });
  }

  const hotspots = [...buckets.values()]
    .map(hotspotFromBucket)
    .sort(
      (a, b) =>
        (b.maxMs ?? 0) - (a.maxMs ?? 0) ||
        b.totalMs - a.totalMs ||
        a.key.localeCompare(b.key),
    )
    .slice(0, thresholds.top);

  const findings = sortFindings(
    hotspots
      .map((hotspot) => findingForHotspot(hotspot, thresholds))
      .filter((finding): finding is LogAnalysisFinding => finding !== null),
  );

  return { hotspots, findings };
}
