/**
 * Convert `cc-debug.log` NDJSON entries into Chrome Trace Event Format
 * (https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU)
 * for visual inspection in https://ui.perfetto.dev/ or chrome://tracing.
 *
 * Each `timed()`-emitted log carries a `durationMs` and inherits `traceId`
 * from AsyncLocalStorage. We treat one `traceId` as one "thread track" so all
 * spans for a single HTTP request stack on the same row, with nesting inferred
 * from overlapping time intervals.
 *
 * Entries without `durationMs` (e.g., bare info/warn logs) are skipped.
 * Entries without `traceId` land on a shared "background" track.
 */

const STANDARD_LOG_FIELDS = new Set([
  "timestamp",
  "level",
  "module",
  "message",
  "durationMs",
]);

const PID = 1;
const BACKGROUND_TID = 0;

export interface TimedLogEntry {
  timestamp: string;
  level: string;
  module: string;
  message: string;
  durationMs: number;
  traceId?: string;
  action?: string;
  projectName?: string;
  sessionName?: string;
  conversationId?: string;
  [key: string]: unknown;
}

export interface TraceEvent {
  name: string;
  cat: string;
  ph: "X" | "M";
  ts: number;
  pid: number;
  tid: number;
  dur?: number;
  args?: Record<string, unknown>;
}

export interface TraceFile {
  displayTimeUnit: "ms" | "ns";
  traceEvents: TraceEvent[];
}

export interface BuildTraceOptions {
  /** If set, include only entries with this `traceId`. */
  traceId?: string;
  /** If set, drop entries with timestamps earlier than this (ms since epoch). */
  sinceMs?: number;
}

/**
 * Parse one NDJSON line into a `TimedLogEntry`. Returns `null` for lines that
 * are blank, not valid JSON, or do not carry the fields needed for a duration
 * event (`durationMs`, `timestamp`, `module`, `message`).
 */
export function parseTimedLogLine(line: string): TimedLogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;

  if (
    typeof record.timestamp !== "string" ||
    typeof record.module !== "string" ||
    typeof record.message !== "string" ||
    typeof record.level !== "string" ||
    typeof record.durationMs !== "number" ||
    !Number.isFinite(record.durationMs) ||
    record.durationMs < 0
  ) {
    return null;
  }

  return record as TimedLogEntry;
}

function entryToDurationEvent(entry: TimedLogEntry, tid: number): TraceEvent {
  const endMs = Date.parse(entry.timestamp);
  const startUs = (endMs - entry.durationMs) * 1000;
  const durUs = entry.durationMs * 1000;

  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (!STANDARD_LOG_FIELDS.has(key)) args[key] = value;
  }

  return {
    name: entry.message,
    cat: entry.module,
    ph: "X",
    ts: startUs,
    dur: durUs,
    pid: PID,
    tid,
    args,
  };
}

function threadNameMetadata(tid: number, name: string): TraceEvent {
  return {
    name: "thread_name",
    cat: "__metadata",
    ph: "M",
    ts: 0,
    pid: PID,
    tid,
    args: { name },
  };
}

function processNameMetadata(): TraceEvent {
  return {
    name: "process_name",
    cat: "__metadata",
    ph: "M",
    ts: 0,
    pid: PID,
    tid: 0,
    args: { name: "Command Center" },
  };
}

function labelForTrace(entry: TimedLogEntry): string {
  if (!entry.traceId) return "background";
  const prefix = entry.action ?? "trace";
  const shortId = entry.traceId.slice(0, 8);
  return `${prefix} (${shortId})`;
}

/**
 * Convert an iterable of NDJSON log lines into a Chrome Trace Event Format
 * trace file. Suitable for dropping into https://ui.perfetto.dev/.
 */
export function buildTrace(
  lines: Iterable<string>,
  options: BuildTraceOptions = {},
): TraceFile {
  const tidByTraceId = new Map<string, number>();
  const labelByTid = new Map<number, string>();
  const durationEvents: TraceEvent[] = [];
  let nextTid = 1;

  for (const line of lines) {
    const entry = parseTimedLogLine(line);
    if (!entry) continue;

    if (options.traceId !== undefined && entry.traceId !== options.traceId) {
      continue;
    }
    if (options.sinceMs !== undefined) {
      const entryMs = Date.parse(entry.timestamp);
      if (!Number.isFinite(entryMs) || entryMs < options.sinceMs) continue;
    }

    let tid: number;
    if (entry.traceId) {
      const existing = tidByTraceId.get(entry.traceId);
      if (existing !== undefined) {
        tid = existing;
      } else {
        tid = nextTid;
        nextTid += 1;
        tidByTraceId.set(entry.traceId, tid);
      }
    } else {
      tid = BACKGROUND_TID;
    }

    if (!labelByTid.has(tid)) {
      labelByTid.set(tid, labelForTrace(entry));
    }

    durationEvents.push(entryToDurationEvent(entry, tid));
  }

  durationEvents.sort((a, b) => a.ts - b.ts);

  const metadata: TraceEvent[] = [processNameMetadata()];
  for (const [tid, name] of labelByTid) {
    metadata.push(threadNameMetadata(tid, name));
  }

  return {
    displayTimeUnit: "ms",
    traceEvents: [...metadata, ...durationEvents],
  };
}
