import type { ParsedServerLogRecord, ServerLogParseResult } from "./types";

function finiteNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
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

function durationFromRecord(
  record: Record<string, unknown>,
): number | undefined {
  const durationMs = finiteNonNegativeNumber(record["durationMs"]);
  if (durationMs !== undefined) return durationMs;

  // Legacy logs (pre-canonicalization) recorded the duration under `totalMs`
  // on state.read.timing / diff.timing; fall back so old logs still parse.
  return finiteNonNegativeNumber(record["totalMs"]);
}

function parseRecord(
  raw: Record<string, unknown>,
  lineNumber: number,
): ParsedServerLogRecord | null {
  const timestamp = stringField(raw, "timestamp");
  const level = stringField(raw, "level");
  const moduleName = stringField(raw, "module");
  const message = stringField(raw, "message");
  if (!timestamp || !level || !moduleName || !message) return null;

  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) {
    return {
      lineNumber,
      timestamp,
      timestampMs: Number.NaN,
      level,
      module: moduleName,
      message,
      raw,
    };
  }

  const parsed: ParsedServerLogRecord = {
    lineNumber,
    timestamp,
    timestampMs,
    level,
    module: moduleName,
    message,
    raw,
  };

  const traceId = stringField(raw, "traceId");
  if (traceId !== undefined) parsed.traceId = traceId;
  const action = stringField(raw, "action");
  if (action !== undefined) parsed.action = action;
  const projectName = stringField(raw, "projectName");
  if (projectName !== undefined) parsed.projectName = projectName;
  const sessionName = stringField(raw, "sessionName");
  if (sessionName !== undefined) parsed.sessionName = sessionName;
  const conversationId = stringField(raw, "conversationId");
  if (conversationId !== undefined) parsed.conversationId = conversationId;
  const method = stringField(raw, "method");
  if (method !== undefined) parsed.method = method;
  const path = stringField(raw, "path");
  if (path !== undefined) parsed.path = path;
  const status = numberField(raw, "status");
  if (status !== undefined) parsed.status = status;
  const durationMs = durationFromRecord(raw);
  if (durationMs !== undefined) parsed.durationMs = durationMs;

  return parsed;
}

export function parseServerLogLines(
  lines: Iterable<string>,
): ServerLogParseResult {
  const records: ParsedServerLogRecord[] = [];
  let malformedLineCount = 0;
  let invalidTimestampCount = 0;
  let invalidShapeCount = 0;
  let lineNumber = 0;

  for (const line of lines) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      malformedLineCount += 1;
      continue;
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      invalidShapeCount += 1;
      continue;
    }

    const record = parseRecord(parsed as Record<string, unknown>, lineNumber);
    if (!record) {
      invalidShapeCount += 1;
      continue;
    }
    if (!Number.isFinite(record.timestampMs)) {
      invalidTimestampCount += 1;
      continue;
    }
    records.push(record);
  }

  return {
    records,
    malformedLineCount,
    invalidTimestampCount,
    invalidShapeCount,
  };
}
