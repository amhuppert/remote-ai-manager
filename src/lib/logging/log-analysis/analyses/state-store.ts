import { sortFindings } from "../findings";
import { summarizeNumbers } from "../stats";
import type {
  LogAnalysisFinding,
  LogAnalysisThresholds,
  ParsedServerLogRecord,
} from "../types";

export interface StateAccessorSummary {
  accessor: string;
  count: number;
  p95Ms: number | null;
  maxMs: number | null;
}

export interface StateRepoOperationSummary {
  operation: string;
  count: number;
  p95Ms: number | null;
  maxMs: number | null;
}

export interface StateWriteQueueSummary {
  label: string;
  count: number;
  p95WaitMs: number | null;
  p95HoldMs: number | null;
  maxWaitMs: number | null;
  maxHoldMs: number | null;
}

export interface FacadeRepoGap {
  traceId: string;
  accessor: string;
  facadeMs: number;
  innerRepoMs: number;
  gapMs: number;
}

export interface StateStoreAnalysis {
  slowAccessors: StateAccessorSummary[];
  repoOperations: StateRepoOperationSummary[];
  writeQueue: StateWriteQueueSummary[];
  facadeRepoGaps: FacadeRepoGap[];
  findings: LogAnalysisFinding[];
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

function groupByString<T>(
  items: readonly T[],
  keyForItem: (item: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyForItem(item);
    const existing = groups.get(key);
    if (existing) {
      existing.push(item);
    } else {
      groups.set(key, [item]);
    }
  }
  return groups;
}

function summarizeAccessors(
  records: readonly ParsedServerLogRecord[],
): StateAccessorSummary[] {
  const stateReads = records.filter(
    (record) =>
      record.message === "state.read.timing" && record.durationMs !== undefined,
  );
  return [
    ...groupByString(
      stateReads,
      (record) => rawString(record, "accessor") ?? "unknown",
    ),
  ]
    .map(([accessor, groupedRecords]) => {
      const durations = groupedRecords
        .map((record) => record.durationMs)
        .filter((duration): duration is number => duration !== undefined);
      const summary = summarizeNumbers(durations);
      return {
        accessor,
        count: summary.count,
        p95Ms: summary.p95,
        maxMs: summary.max,
      };
    })
    .sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0));
}

function isRepoTiming(record: ParsedServerLogRecord): boolean {
  return (
    record.message.startsWith("state-store.") &&
    record.message.endsWith(".timing") &&
    record.message !== "state-store.write_queue.timing" &&
    record.durationMs !== undefined
  );
}

function summarizeRepoOperations(
  records: readonly ParsedServerLogRecord[],
): StateRepoOperationSummary[] {
  const repoTimings = records.filter(isRepoTiming);
  return [...groupByString(repoTimings, (record) => record.message)]
    .map(([operation, groupedRecords]) => {
      const durations = groupedRecords
        .map((record) => record.durationMs)
        .filter((duration): duration is number => duration !== undefined);
      const summary = summarizeNumbers(durations);
      return {
        operation,
        count: summary.count,
        p95Ms: summary.p95,
        maxMs: summary.max,
      };
    })
    .sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0));
}

function summarizeWriteQueue(
  records: readonly ParsedServerLogRecord[],
): StateWriteQueueSummary[] {
  const writeQueueRecords = records.filter(
    (record) => record.message === "state-store.write_queue.timing",
  );

  return [
    ...groupByString(
      writeQueueRecords,
      (record) => rawString(record, "label") ?? "unknown",
    ),
  ]
    .map(([label, groupedRecords]) => {
      const waits = groupedRecords
        .map((record) => rawNumber(record, "waitMs"))
        .filter((duration): duration is number => duration !== undefined);
      const holds = groupedRecords
        .map((record) => rawNumber(record, "holdMs"))
        .filter((duration): duration is number => duration !== undefined);
      const waitSummary = summarizeNumbers(waits);
      const holdSummary = summarizeNumbers(holds);
      return {
        label,
        count: groupedRecords.length,
        p95WaitMs: waitSummary.p95,
        p95HoldMs: holdSummary.p95,
        maxWaitMs: waitSummary.max,
        maxHoldMs: holdSummary.max,
      };
    })
    .sort((a, b) => (b.p95WaitMs ?? 0) - (a.p95WaitMs ?? 0));
}

function computeFacadeRepoGaps(
  records: readonly ParsedServerLogRecord[],
): FacadeRepoGap[] {
  const repoMsByTrace = new Map<string, number>();
  for (const record of records) {
    if (
      !record.traceId ||
      !isRepoTiming(record) ||
      record.durationMs === undefined
    ) {
      continue;
    }
    repoMsByTrace.set(
      record.traceId,
      (repoMsByTrace.get(record.traceId) ?? 0) + record.durationMs,
    );
  }

  return records
    .filter(
      (record) =>
        record.traceId !== undefined &&
        record.message === "state.read.timing" &&
        record.durationMs !== undefined,
    )
    .map((record) => {
      const traceId = record.traceId ?? "unknown";
      const facadeMs = record.durationMs ?? 0;
      const innerRepoMs = repoMsByTrace.get(traceId) ?? 0;
      return {
        traceId,
        accessor: rawString(record, "accessor") ?? "unknown",
        facadeMs,
        innerRepoMs,
        gapMs: Math.max(0, facadeMs - innerRepoMs),
      };
    })
    .sort((a, b) => b.gapMs - a.gapMs);
}

function findingsForStateStore(input: {
  accessors: readonly StateAccessorSummary[];
  writeQueue: readonly StateWriteQueueSummary[];
  gaps: readonly FacadeRepoGap[];
}): LogAnalysisFinding[] {
  const findings: LogAnalysisFinding[] = [];

  for (const queue of input.writeQueue) {
    if ((queue.p95WaitMs ?? 0) >= 100) {
      findings.push({
        id: `state-store-write-queue-high:${queue.label}`,
        severity: "high",
        confidence: 0.88,
        category: "state-store",
        title: `State write queue contention: ${queue.label}`,
        explanation:
          "The state-store write queue has high p95 wait time, indicating serialized write contention.",
        evidence: [
          { label: "p95WaitMs", value: queue.p95WaitMs, unit: "ms" },
          { label: "count", value: queue.count, unit: "count" },
        ],
        traceIds: [],
        recommendedNextActions: [
          "Inspect callers for concurrent or long-running state mutations.",
        ],
      });
    }
  }

  for (const accessor of input.accessors) {
    if ((accessor.p95Ms ?? 0) >= 50 && accessor.count >= 3) {
      findings.push({
        id: `state-store-accessor-high:${accessor.accessor}`,
        severity: "high",
        confidence: 0.86,
        category: "state-store",
        title: `Slow state accessor: ${accessor.accessor}`,
        explanation:
          "This state accessor has p95 latency above the state read target.",
        evidence: [
          { label: "p95Ms", value: accessor.p95Ms, unit: "ms" },
          { label: "count", value: accessor.count, unit: "count" },
        ],
        traceIds: [],
        recommendedNextActions: [
          "Compare facade timing with inner repo timings to locate SQL, mapping, or aggregation cost.",
        ],
      });
    }
  }

  const largeGaps = input.gaps.filter((gap) => gap.gapMs >= 25);
  if (largeGaps.length >= 3) {
    findings.push({
      id: "state-store-facade-gap-medium",
      severity: "medium",
      confidence: 0.76,
      category: "state-store",
      title: "State facade time exceeds inner repo time",
      explanation:
        "Multiple traces spend meaningful state read time outside inner repository timing.",
      evidence: [
        { label: "affectedTraces", value: largeGaps.length, unit: "count" },
        { label: "maxGapMs", value: largeGaps[0]?.gapMs ?? 0, unit: "ms" },
      ],
      traceIds: largeGaps.map((gap) => gap.traceId).slice(0, 5),
      recommendedNextActions: [
        "Inspect aggregation, Zod mapping, and uninstrumented state facade work.",
      ],
    });
  }

  return sortFindings(findings);
}

export function analyzeStateStore(
  records: readonly ParsedServerLogRecord[],
  _thresholds: LogAnalysisThresholds,
): StateStoreAnalysis {
  const slowAccessors = summarizeAccessors(records);
  const repoOperations = summarizeRepoOperations(records);
  const writeQueue = summarizeWriteQueue(records);
  const facadeRepoGaps = computeFacadeRepoGaps(records);

  return {
    slowAccessors,
    repoOperations,
    writeQueue,
    facadeRepoGaps,
    findings: findingsForStateStore({
      accessors: slowAccessors,
      writeQueue,
      gaps: facadeRepoGaps,
    }),
  };
}
