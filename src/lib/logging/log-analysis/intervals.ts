import type { ParsedServerLogRecord } from "./types";

export interface IntervalInput {
  id: string;
  name: string;
  startMs: number;
  endMs: number;
  record?: ParsedServerLogRecord;
}

export interface TimedInterval {
  id: string;
  name: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  children: TimedInterval[];
  record?: ParsedServerLogRecord;
}

export interface TraceTimingSummary {
  requestDurationMs: number;
  rootUnionMs: number;
  unexplainedMs: number;
  unexplainedPercent: number;
}

function createInterval(input: IntervalInput): TimedInterval {
  const interval: TimedInterval = {
    id: input.id,
    name: input.name,
    startMs: input.startMs,
    endMs: input.endMs,
    durationMs: Math.max(0, input.endMs - input.startMs),
    children: [],
  };
  if (input.record !== undefined) interval.record = input.record;
  return interval;
}

function contains(parent: TimedInterval, child: TimedInterval): boolean {
  return parent.startMs <= child.startMs && parent.endMs >= child.endMs;
}

export function buildIntervalForest(
  inputs: readonly IntervalInput[],
): TimedInterval[] {
  const intervals = inputs
    .filter(
      (input) =>
        Number.isFinite(input.startMs) &&
        Number.isFinite(input.endMs) &&
        input.endMs >= input.startMs,
    )
    .map(createInterval)
    .sort((a, b) => a.startMs - b.startMs || b.endMs - a.endMs);

  const roots: TimedInterval[] = [];
  const stack: TimedInterval[] = [];

  for (const interval of intervals) {
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (top !== undefined && contains(top, interval)) break;
      stack.pop();
    }

    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      roots.push(interval);
    } else {
      parent.children.push(interval);
    }
    stack.push(interval);
  }

  return roots;
}

function computeUnionDuration(
  intervals: readonly Pick<TimedInterval, "startMs" | "endMs">[],
): number {
  const sorted = intervals
    .filter(
      (interval) =>
        Number.isFinite(interval.startMs) &&
        Number.isFinite(interval.endMs) &&
        interval.endMs >= interval.startMs,
    )
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  let total = 0;
  let currentStart: number | null = null;
  let currentEnd: number | null = null;

  for (const interval of sorted) {
    if (currentStart === null || currentEnd === null) {
      currentStart = interval.startMs;
      currentEnd = interval.endMs;
      continue;
    }

    if (interval.startMs > currentEnd) {
      total += currentEnd - currentStart;
      currentStart = interval.startMs;
      currentEnd = interval.endMs;
      continue;
    }

    currentEnd = Math.max(currentEnd, interval.endMs);
  }

  if (currentStart !== null && currentEnd !== null) {
    total += currentEnd - currentStart;
  }

  return total;
}

export function computeExclusiveMs(interval: TimedInterval): number {
  const childUnionMs = computeUnionDuration(interval.children);
  return Math.max(0, interval.durationMs - childUnionMs);
}

export function flattenIntervalForest(
  roots: readonly TimedInterval[],
): TimedInterval[] {
  const flattened: TimedInterval[] = [];
  const stack = [...roots].reverse();

  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) continue;
    flattened.push(next);
    for (let i = next.children.length - 1; i >= 0; i -= 1) {
      const child = next.children[i];
      if (child !== undefined) stack.push(child);
    }
  }

  return flattened;
}

export function computeTraceTimingSummary(
  requestDurationMs: number,
  roots: readonly TimedInterval[],
): TraceTimingSummary {
  const rootUnionMs = computeUnionDuration(roots);
  const unexplainedMs = Math.max(0, requestDurationMs - rootUnionMs);
  const unexplainedPercent =
    requestDurationMs > 0 ? (unexplainedMs / requestDurationMs) * 100 : 0;

  return {
    requestDurationMs,
    rootUnionMs,
    unexplainedMs,
    unexplainedPercent,
  };
}

export function intervalInputFromRecord(
  record: ParsedServerLogRecord,
): IntervalInput | null {
  if (record.durationMs === undefined) return null;
  return {
    id: `${record.lineNumber}`,
    name: record.message,
    startMs: record.timestampMs - record.durationMs,
    endMs: record.timestampMs,
    record,
  };
}
