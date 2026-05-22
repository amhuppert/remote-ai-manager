import { sortFindings } from "../findings";
import type {
  LogAnalysisFinding,
  LogAnalysisThresholds,
  ParsedServerLogRecord,
} from "../types";

export interface DuplicateWorkItem {
  signature: string;
  traceId: string;
  count: number;
  totalMs: number;
  maxMs: number;
  firstTimestamp: string;
  lastTimestamp: string;
  lineNumbers: number[];
}

export interface DuplicateWorkAnalysis {
  duplicates: DuplicateWorkItem[];
  findings: LogAnalysisFinding[];
}

interface DuplicateBucket {
  signature: string;
  traceId: string;
  records: ParsedServerLogRecord[];
}

function rawString(
  record: ParsedServerLogRecord,
  key: string,
): string | undefined {
  const value = record.raw[key];
  return typeof value === "string" ? value : undefined;
}

function contextValue(value: string | undefined): string {
  return value ?? "unknown";
}

export function duplicateSignature(record: ParsedServerLogRecord): string {
  if (record.message === "state.read.timing") {
    return [
      "state.read",
      contextValue(rawString(record, "accessor")),
      contextValue(record.projectName),
      contextValue(record.sessionName),
      contextValue(record.conversationId),
    ].join(":");
  }

  if (
    record.message.startsWith("state-store.") &&
    record.message.endsWith(".timing")
  ) {
    return [
      record.message,
      contextValue(rawString(record, "rootPath")),
      contextValue(rawString(record, "projectPath")),
      contextValue(record.sessionName),
      contextValue(record.conversationId),
    ].join(":");
  }

  if (record.message === "transcript.read.complete") {
    return `transcript.read:${contextValue(record.conversationId)}`;
  }

  if (record.message === "diff.compute.complete") {
    return `diff.compute:${contextValue(rawString(record, "worktreePath"))}`;
  }

  if (record.message === "git.complete") {
    return `git:${contextValue(rawString(record, "cwd"))}:${contextValue(
      rawString(record, "argsPreview"),
    )}`;
  }

  if (record.message === "exec.complete") {
    return [
      "exec",
      contextValue(rawString(record, "cwd")),
      contextValue(rawString(record, "command")),
      contextValue(rawString(record, "argsPreview")),
    ].join(":");
  }

  return `${record.module}:${record.message}`;
}

function itemFromBucket(bucket: DuplicateBucket): DuplicateWorkItem {
  const sorted = [...bucket.records].sort(
    (a, b) => a.timestampMs - b.timestampMs,
  );
  const durations = sorted
    .map((record) => record.durationMs)
    .filter((duration): duration is number => duration !== undefined);
  const totalMs = durations.reduce((sum, duration) => sum + duration, 0);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  return {
    signature: bucket.signature,
    traceId: bucket.traceId,
    count: sorted.length,
    totalMs,
    maxMs: durations.length > 0 ? Math.max(...durations) : 0,
    firstTimestamp: first?.timestamp ?? "",
    lastTimestamp: last?.timestamp ?? "",
    lineNumbers: sorted.map((record) => record.lineNumber),
  };
}

function findingForDuplicate(
  duplicate: DuplicateWorkItem,
  thresholds: LogAnalysisThresholds,
): LogAnalysisFinding {
  let severity: LogAnalysisFinding["severity"] = "low";
  let confidence = 0.66;
  if (duplicate.count >= 5 && duplicate.totalMs >= thresholds.slowMs) {
    severity = "high";
    confidence = 0.9;
  } else if (
    duplicate.count >= 3 &&
    duplicate.totalMs >= thresholds.slowMs / 2
  ) {
    severity = "medium";
    confidence = 0.78;
  }

  return {
    id: `duplicate-work-${severity}:${duplicate.traceId}:${duplicate.signature}`,
    severity,
    confidence,
    category: "duplicate-work",
    title: `Repeated work in trace: ${duplicate.signature}`,
    explanation:
      "The same operation signature appears at least three times within one trace.",
    evidence: [
      { label: "count", value: duplicate.count, unit: "count" },
      { label: "totalMs", value: duplicate.totalMs, unit: "ms" },
      { label: "maxMs", value: duplicate.maxMs, unit: "ms" },
    ],
    traceIds: [duplicate.traceId],
    recommendedNextActions: [
      "Inspect the route or caller path for repeated reads or repeated command execution.",
    ],
  };
}

export function analyzeDuplicateWork(
  records: readonly ParsedServerLogRecord[],
  thresholds: LogAnalysisThresholds,
): DuplicateWorkAnalysis {
  const buckets = new Map<string, DuplicateBucket>();

  for (const record of records) {
    if (record.traceId === undefined || record.durationMs === undefined) {
      continue;
    }
    const signature = duplicateSignature(record);
    const key = `${record.traceId}\u0000${signature}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.records.push(record);
      continue;
    }
    buckets.set(key, {
      signature,
      traceId: record.traceId,
      records: [record],
    });
  }

  const duplicates = [...buckets.values()]
    .filter((bucket) => bucket.records.length >= 3)
    .map(itemFromBucket)
    .sort((a, b) => b.totalMs - a.totalMs || b.count - a.count)
    .slice(0, thresholds.top);

  return {
    duplicates,
    findings: sortFindings(
      duplicates.map((duplicate) => findingForDuplicate(duplicate, thresholds)),
    ),
  };
}
