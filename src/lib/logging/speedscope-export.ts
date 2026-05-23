/**
 * Convert `cc-debug.log` NDJSON entries into Chrome Trace Event Format
 * (https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU)
 * for hotspot analysis in https://speedscope.app — primarily the Left Heavy
 * and Sandwich views, which aggregate per-frame total time across the whole
 * app.
 *
 * Each `timed()`-emitted log carries a `durationMs` and inherits `traceId`
 * from AsyncLocalStorage. To make Speedscope's aggregating views meaningful,
 * every event is placed on a single "aggregated" thread (tid=1) with traces
 * serialized end-to-end. Within a group, parent/child nesting is reconstructed
 * from time containment; events that overlap as siblings (e.g. `Promise.all`)
 * are promoted to additional roots within the group. Wall-clock fidelity is
 * intentionally lost in exchange for trustworthy per-frame totals — the Time
 * Order view will show a synthetic serialized timeline, not real wall clock.
 *
 * The output is still valid Chrome Trace Event Format, so Perfetto and
 * chrome://tracing will load the file, but only Speedscope's aggregating
 * views answer the question this tool is designed for ("where does most
 * execution time go?").
 *
 * Entries without `durationMs` (e.g., bare info/warn logs) are skipped.
 * Entries without `traceId` each become their own single-event group.
 */

const STANDARD_LOG_FIELDS = new Set([
  "timestamp",
  "level",
  "module",
  "message",
  "durationMs",
]);

const PID = 1;
const AGGREGATED_TID = 1;

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

interface TraceEvent {
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

interface ForestNode {
  entry: TimedLogEntry;
  origStartMs: number;
  origEndMs: number;
  durMs: number;
  children: ForestNode[];
}

function nodeFromEntry(entry: TimedLogEntry): ForestNode {
  const endMs = Date.parse(entry.timestamp);
  return {
    entry,
    origEndMs: endMs,
    origStartMs: endMs - entry.durationMs,
    durMs: entry.durationMs,
    children: [],
  };
}

/**
 * Build a forest from a group of entries by interval containment. Sort so
 * containers come before their contents, then walk with a stack: an event
 * becomes a child of the most recent open ancestor that strictly contains it,
 * otherwise a new root.
 */
function buildForest(entries: TimedLogEntry[]): ForestNode[] {
  const nodes = entries.map(nodeFromEntry);
  nodes.sort(
    (a, b) => a.origStartMs - b.origStartMs || b.origEndMs - a.origEndMs,
  );

  const roots: ForestNode[] = [];
  const stack: ForestNode[] = [];

  for (const node of nodes) {
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      if (
        top.origEndMs >= node.origEndMs &&
        top.origStartMs <= node.origStartMs
      ) {
        break;
      }
      stack.pop();
    }

    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1]!.children.push(node);
    }
    stack.push(node);
  }

  return roots;
}

function argsFromEntry(entry: TimedLogEntry): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (!STANDARD_LOG_FIELDS.has(key)) args[key] = value;
  }
  return args;
}

/**
 * Emit one root's subtree starting at `virtualStartUs`. Each child keeps its
 * original offset relative to its parent (so nesting structure is preserved),
 * clamped so a child cannot extend past its parent's virtual end.
 */
function emitSubtree(
  root: ForestNode,
  virtualStartUs: number,
  out: TraceEvent[],
): void {
  const stack: Array<{ node: ForestNode; startUs: number }> = [
    { node: root, startUs: virtualStartUs },
  ];

  while (stack.length > 0) {
    const { node, startUs } = stack.pop()!;
    const endUs = startUs + node.durMs * 1000;

    out.push({
      name: node.entry.message,
      cat: node.entry.module,
      ph: "X",
      ts: startUs,
      dur: node.durMs * 1000,
      pid: PID,
      tid: AGGREGATED_TID,
      args: argsFromEntry(node.entry),
    });

    for (const child of node.children) {
      const offsetUs = (child.origStartMs - node.origStartMs) * 1000;
      const childStart = Math.min(
        startUs + offsetUs,
        endUs - child.durMs * 1000,
      );
      stack.push({ node: child, startUs: childStart });
    }
  }
}

function groupEntries(entries: TimedLogEntry[]): TimedLogEntry[][] {
  const byTraceId = new Map<string, TimedLogEntry[]>();
  const groups: TimedLogEntry[][] = [];

  for (const entry of entries) {
    if (entry.traceId !== undefined && entry.traceId !== "") {
      const existing = byTraceId.get(entry.traceId);
      if (existing) {
        existing.push(entry);
      } else {
        const fresh = [entry];
        byTraceId.set(entry.traceId, fresh);
        groups.push(fresh);
      }
    } else {
      groups.push([entry]);
    }
  }

  return groups;
}

function earliestStartMs(entries: TimedLogEntry[]): number {
  let min = Number.POSITIVE_INFINITY;
  for (const e of entries) {
    const start = Date.parse(e.timestamp) - e.durationMs;
    if (start < min) min = start;
  }
  return min;
}

/**
 * Convert an iterable of NDJSON log lines into a Chrome Trace Event Format
 * trace file. All events land on a single aggregated thread (tid=1); traces
 * are serialized end-to-end so Speedscope's Left Heavy and Sandwich views
 * aggregate per-frame time across the entire app.
 */
export function buildTrace(
  lines: Iterable<string>,
  options: BuildTraceOptions = {},
): TraceFile {
  const entries: TimedLogEntry[] = [];

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
    entries.push(entry);
  }

  const groups = groupEntries(entries);
  groups.sort((a, b) => earliestStartMs(a) - earliestStartMs(b));

  const durationEvents: TraceEvent[] = [];
  let cursorUs = 0;

  for (const group of groups) {
    const forest = buildForest(group);
    for (const root of forest) {
      emitSubtree(root, cursorUs, durationEvents);
      cursorUs += root.durMs * 1000;
    }
  }

  durationEvents.sort((a, b) => a.ts - b.ts);

  const metadata: TraceEvent[] = [
    {
      name: "process_name",
      cat: "__metadata",
      ph: "M",
      ts: 0,
      pid: PID,
      tid: AGGREGATED_TID,
      args: { name: "Command Center" },
    },
  ];

  if (durationEvents.length > 0) {
    metadata.push({
      name: "thread_name",
      cat: "__metadata",
      ph: "M",
      ts: 0,
      pid: PID,
      tid: AGGREGATED_TID,
      args: { name: "aggregated" },
    });
  }

  return {
    displayTimeUnit: "ms",
    traceEvents: [...metadata, ...durationEvents],
  };
}
