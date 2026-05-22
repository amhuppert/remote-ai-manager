import { sortFindings } from "../findings";
import { summarizeNumbers } from "../stats";
import type {
  LogAnalysisFinding,
  LogAnalysisThresholds,
  ParsedClientTimingRecord,
} from "../types";

export interface ClientApiFetchSummary {
  key: string;
  action: string;
  method: string;
  url: string;
  count: number;
  p95TotalMs: number | null;
  p95ServerMs: number | null;
  p95NetworkMs: number | null;
  missingServerMsCount: number;
  traceIds: string[];
}

export interface ClientSseMessageSummary {
  eventType: string;
  count: number;
  p95TransportMs: number | null;
  p95HandlerMs: number | null;
}

export interface ClientTimingAnalysis {
  available: boolean;
  malformedRecordCount: number;
  apiFetches: ClientApiFetchSummary[];
  sseMessages: ClientSseMessageSummary[];
  findings: LogAnalysisFinding[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function nullableNumberField(
  record: Record<string, unknown>,
  key: string,
): number | null | undefined {
  if (record[key] === null) return null;
  return numberField(record, key);
}

function parseRawRecords(rawLog: string): {
  rawRecords: Record<string, unknown>[];
  malformedRecordCount: number;
} {
  const trimmed = rawLog.trim();
  if (!trimmed) return { rawRecords: [], malformedRecordCount: 0 };

  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) {
        return { rawRecords: [], malformedRecordCount: 1 };
      }
      const rawRecords: Record<string, unknown>[] = [];
      let malformedRecordCount = 0;
      for (const item of parsed) {
        const record = asRecord(item);
        if (record) {
          rawRecords.push(record);
        } else {
          malformedRecordCount += 1;
        }
      }
      return { rawRecords, malformedRecordCount };
    } catch {
      return { rawRecords: [], malformedRecordCount: 1 };
    }
  }

  const rawRecords: Record<string, unknown>[] = [];
  let malformedRecordCount = 0;
  for (const line of rawLog.split("\n")) {
    const lineTrimmed = line.trim();
    if (!lineTrimmed) continue;
    try {
      const parsed = JSON.parse(lineTrimmed);
      const record = asRecord(parsed);
      if (record) {
        rawRecords.push(record);
      } else {
        malformedRecordCount += 1;
      }
    } catch {
      malformedRecordCount += 1;
    }
  }
  return { rawRecords, malformedRecordCount };
}

function normalizeClientRecord(
  raw: Record<string, unknown>,
): ParsedClientTimingRecord | null {
  const event = stringField(raw, "event") ?? stringField(raw, "message");
  if (
    event !== "api.fetch" &&
    event !== "api.fetch.error" &&
    event !== "sse.message"
  ) {
    return null;
  }

  const record: ParsedClientTimingRecord = { event, raw };
  const traceId = stringField(raw, "traceId");
  if (traceId !== undefined) record.traceId = traceId;
  const action = stringField(raw, "action");
  if (action !== undefined) record.action = action;
  const method = stringField(raw, "method");
  if (method !== undefined) record.method = method;
  const url = stringField(raw, "url");
  if (url !== undefined) record.url = url;
  const status = numberField(raw, "status");
  if (status !== undefined) record.status = status;
  const totalMs = numberField(raw, "totalMs");
  if (totalMs !== undefined) record.totalMs = totalMs;
  const serverMs = nullableNumberField(raw, "serverMs");
  if (serverMs !== undefined) record.serverMs = serverMs;
  const networkMs = nullableNumberField(raw, "networkMs");
  if (networkMs !== undefined) record.networkMs = networkMs;
  const eventType = stringField(raw, "eventType");
  if (eventType !== undefined) record.eventType = eventType;
  const transportMs = nullableNumberField(raw, "transportMs");
  if (transportMs !== undefined) record.transportMs = transportMs;
  const handlerMs = numberField(raw, "handlerMs");
  if (handlerMs !== undefined) record.handlerMs = handlerMs;
  return record;
}

function parseClientTimingLog(rawLog: string): {
  records: ParsedClientTimingRecord[];
  malformedRecordCount: number;
} {
  const parsed = parseRawRecords(rawLog);
  const records: ParsedClientTimingRecord[] = [];
  let malformedRecordCount = parsed.malformedRecordCount;

  for (const rawRecord of parsed.rawRecords) {
    const record = normalizeClientRecord(rawRecord);
    if (record) {
      records.push(record);
    } else {
      malformedRecordCount += 1;
    }
  }

  return { records, malformedRecordCount };
}

function traceIds(records: readonly ParsedClientTimingRecord[]): string[] {
  return [
    ...new Set(
      records
        .map((record) => record.traceId)
        .filter((traceId): traceId is string => traceId !== undefined),
    ),
  ].slice(0, 5);
}

function summarizeApiFetches(
  records: readonly ParsedClientTimingRecord[],
  top: number,
): ClientApiFetchSummary[] {
  const groups = new Map<string, ParsedClientTimingRecord[]>();
  for (const record of records) {
    if (record.event !== "api.fetch") continue;
    const action = record.action ?? "unknown";
    const method = record.method ?? "unknown";
    const url = record.url ?? "unknown";
    const key = `${action} ${method} ${url}`;
    const existing = groups.get(key);
    if (existing) {
      existing.push(record);
    } else {
      groups.set(key, [record]);
    }
  }

  return [...groups.entries()]
    .map(([key, groupedRecords]) => {
      const [action = "unknown", method = "unknown", url = "unknown"] =
        key.split(" ");
      const totalSummary = summarizeNumbers(
        groupedRecords
          .map((record) => record.totalMs)
          .filter((value): value is number => value !== undefined),
      );
      const serverSummary = summarizeNumbers(
        groupedRecords
          .map((record) => record.serverMs)
          .filter((value): value is number => typeof value === "number"),
      );
      const networkSummary = summarizeNumbers(
        groupedRecords
          .map((record) => record.networkMs)
          .filter((value): value is number => typeof value === "number"),
      );
      return {
        key,
        action,
        method,
        url,
        count: groupedRecords.length,
        p95TotalMs: totalSummary.p95,
        p95ServerMs: serverSummary.p95,
        p95NetworkMs: networkSummary.p95,
        missingServerMsCount: groupedRecords.filter(
          (record) => record.serverMs === undefined || record.serverMs === null,
        ).length,
        traceIds: traceIds(groupedRecords),
      };
    })
    .sort((a, b) => (b.p95TotalMs ?? 0) - (a.p95TotalMs ?? 0))
    .slice(0, top);
}

function summarizeSseMessages(
  records: readonly ParsedClientTimingRecord[],
  top: number,
): ClientSseMessageSummary[] {
  const groups = new Map<string, ParsedClientTimingRecord[]>();
  for (const record of records) {
    if (record.event !== "sse.message") continue;
    const eventType = record.eventType ?? "unknown";
    const existing = groups.get(eventType);
    if (existing) {
      existing.push(record);
    } else {
      groups.set(eventType, [record]);
    }
  }

  return [...groups.entries()]
    .map(([eventType, groupedRecords]) => {
      const transportSummary = summarizeNumbers(
        groupedRecords
          .map((record) => record.transportMs)
          .filter((value): value is number => typeof value === "number"),
      );
      const handlerSummary = summarizeNumbers(
        groupedRecords
          .map((record) => record.handlerMs)
          .filter((value): value is number => value !== undefined),
      );
      return {
        eventType,
        count: groupedRecords.length,
        p95TransportMs: transportSummary.p95,
        p95HandlerMs: handlerSummary.p95,
      };
    })
    .sort((a, b) => (b.p95HandlerMs ?? 0) - (a.p95HandlerMs ?? 0))
    .slice(0, top);
}

function findingsForClientTiming(input: {
  apiFetches: readonly ClientApiFetchSummary[];
  sseMessages: readonly ClientSseMessageSummary[];
}): LogAnalysisFinding[] {
  const findings: LogAnalysisFinding[] = [];

  for (const apiFetch of input.apiFetches) {
    if ((apiFetch.p95NetworkMs ?? 0) >= 1000) {
      findings.push({
        id: `client-timing-high-network:${apiFetch.key}`,
        severity: "high",
        confidence: 0.84,
        category: "client-timing",
        title: `Client round trip dominated by network/client time: ${apiFetch.key}`,
        explanation:
          "The p95 client total minus server timing is at least 1000 ms.",
        evidence: [
          { label: "p95NetworkMs", value: apiFetch.p95NetworkMs, unit: "ms" },
        ],
        traceIds: apiFetch.traceIds,
        recommendedNextActions: [
          "Use browser/network tooling before optimizing server code.",
        ],
      });
    }

    if (apiFetch.missingServerMsCount > 0) {
      findings.push({
        id: `client-timing-low-missing-server:${apiFetch.key}`,
        severity: "low",
        confidence: 0.58,
        category: "client-timing",
        title: `Missing Server-Timing data: ${apiFetch.key}`,
        explanation:
          "Some client fetch records do not include server timing, so server/network split is incomplete.",
        evidence: [
          {
            label: "missingServerMsCount",
            value: apiFetch.missingServerMsCount,
            unit: "count",
          },
        ],
        traceIds: apiFetch.traceIds,
        recommendedNextActions: [
          "Confirm this route is wrapped with withTracing() and is not an SSE stream.",
        ],
      });
    }
  }

  for (const sseMessage of input.sseMessages) {
    if ((sseMessage.p95HandlerMs ?? 0) >= 16) {
      findings.push({
        id: `client-timing-medium-sse-handler:${sseMessage.eventType}`,
        severity: "medium",
        confidence: 0.78,
        category: "client-timing",
        title: `SSE handler work crosses frame budget: ${sseMessage.eventType}`,
        explanation:
          "The browser-side SSE handler p95 is at least 16 ms for this event type.",
        evidence: [
          {
            label: "p95HandlerMs",
            value: sseMessage.p95HandlerMs,
            unit: "ms",
          },
        ],
        traceIds: [],
        recommendedNextActions: [
          "Inspect client cache invalidation or store updates for this event type.",
        ],
      });
    }
  }

  return sortFindings(findings);
}

export function analyzeClientTiming(
  rawLog: string | null,
  thresholds: LogAnalysisThresholds,
): ClientTimingAnalysis {
  if (rawLog === null) {
    return {
      available: false,
      malformedRecordCount: 0,
      apiFetches: [],
      sseMessages: [],
      findings: [],
    };
  }

  const parsed = parseClientTimingLog(rawLog);
  const apiFetches = summarizeApiFetches(parsed.records, thresholds.top);
  const sseMessages = summarizeSseMessages(parsed.records, thresholds.top);

  return {
    available: true,
    malformedRecordCount: parsed.malformedRecordCount,
    apiFetches,
    sseMessages,
    findings: findingsForClientTiming({ apiFetches, sseMessages }),
  };
}
