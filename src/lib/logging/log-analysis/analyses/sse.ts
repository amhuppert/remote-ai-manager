import { sortFindings } from "../findings";
import { summarizeNumbers } from "../stats";
import type {
  LogAnalysisFinding,
  LogAnalysisThresholds,
  ParsedServerLogRecord,
} from "../types";

export interface SseEventSummary {
  eventType: string;
  count: number;
  p95Ms: number | null;
  maxMs: number | null;
  avgSubscriberCount: number | null;
  maxSubscriberCount: number | null;
  avgPayloadBytes: number | null;
  maxPayloadBytes: number | null;
  exampleTraceIds: string[];
}

export interface SseAnalysis {
  events: SseEventSummary[];
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

function isSseBroadcast(record: ParsedServerLogRecord): boolean {
  return (
    record.message === "sse.broadcast.complete" &&
    record.durationMs !== undefined
  );
}

function traceIds(records: readonly ParsedServerLogRecord[]): string[] {
  return [
    ...new Set(
      records
        .map((record) => record.traceId)
        .filter((traceId): traceId is string => traceId !== undefined),
    ),
  ].slice(0, 5);
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summaryForEvent(
  eventType: string,
  records: readonly ParsedServerLogRecord[],
): SseEventSummary {
  const durations = records
    .map((record) => record.durationMs)
    .filter((duration): duration is number => duration !== undefined);
  const subscribers = records
    .map((record) => rawNumber(record, "subscriberCount"))
    .filter((value): value is number => value !== undefined);
  const payloadBytes = records
    .map((record) => rawNumber(record, "payloadBytes"))
    .filter((value): value is number => value !== undefined);
  const durationSummary = summarizeNumbers(durations);
  const subscriberSummary = summarizeNumbers(subscribers);
  const payloadSummary = summarizeNumbers(payloadBytes);

  return {
    eventType,
    count: records.length,
    p95Ms: durationSummary.p95,
    maxMs: durationSummary.max,
    avgSubscriberCount: average(subscribers),
    maxSubscriberCount: subscriberSummary.max,
    avgPayloadBytes: average(payloadBytes),
    maxPayloadBytes: payloadSummary.max,
    exampleTraceIds: traceIds(records),
  };
}

function findingForEvent(event: SseEventSummary): LogAnalysisFinding | null {
  if ((event.p95Ms ?? 0) >= 50) {
    return {
      id: `sse-high:${event.eventType}`,
      severity: "high",
      confidence: 0.86,
      category: "sse",
      title: `Slow SSE broadcast: ${event.eventType}`,
      explanation:
        "This SSE event type has p95 server broadcast duration above 50 ms.",
      evidence: [
        { label: "p95Ms", value: event.p95Ms, unit: "ms" },
        { label: "count", value: event.count, unit: "count" },
      ],
      traceIds: event.exampleTraceIds,
      recommendedNextActions: [
        "Inspect payload size and subscriber fan-out for this SSE event type.",
      ],
    };
  }

  if ((event.p95Ms ?? 0) >= 25) {
    return {
      id: `sse-medium:${event.eventType}`,
      severity: "medium",
      confidence: 0.76,
      category: "sse",
      title: `Elevated SSE broadcast cost: ${event.eventType}`,
      explanation:
        "This SSE event type has p95 server broadcast duration above 25 ms.",
      evidence: [{ label: "p95Ms", value: event.p95Ms, unit: "ms" }],
      traceIds: event.exampleTraceIds,
      recommendedNextActions: [
        "Check whether payload size or subscriber count is driving broadcast cost.",
      ],
    };
  }

  if ((event.maxPayloadBytes ?? 0) >= 256 * 1024) {
    return {
      id: `sse-low-payload:${event.eventType}`,
      severity: "low",
      confidence: 0.62,
      category: "sse",
      title: `Large SSE payload: ${event.eventType}`,
      explanation:
        "This SSE event type emitted at least one payload of 256 KB or larger.",
      evidence: [
        {
          label: "maxPayloadBytes",
          value: event.maxPayloadBytes,
          unit: "bytes",
        },
      ],
      traceIds: event.exampleTraceIds,
      recommendedNextActions: [
        "Inspect payload shape before treating this as a latency problem.",
      ],
    };
  }

  return null;
}

export function analyzeSse(
  records: readonly ParsedServerLogRecord[],
  thresholds: LogAnalysisThresholds,
): SseAnalysis {
  const groups = new Map<string, ParsedServerLogRecord[]>();
  for (const record of records) {
    if (!isSseBroadcast(record)) continue;
    const eventType = rawString(record, "eventType") ?? "unknown";
    const existing = groups.get(eventType);
    if (existing) {
      existing.push(record);
    } else {
      groups.set(eventType, [record]);
    }
  }

  const events = [...groups.entries()]
    .map(([eventType, groupedRecords]) =>
      summaryForEvent(eventType, groupedRecords),
    )
    .sort((a, b) => (b.p95Ms ?? 0) - (a.p95Ms ?? 0))
    .slice(0, thresholds.top);

  return {
    events,
    findings: sortFindings(
      events
        .map(findingForEvent)
        .filter((finding): finding is LogAnalysisFinding => finding !== null),
    ),
  };
}
