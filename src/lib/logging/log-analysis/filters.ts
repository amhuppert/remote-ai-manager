import type { LogAnalysisFilters, ParsedServerLogRecord } from "./types";

export function applyServerLogFilters(
  records: readonly ParsedServerLogRecord[],
  filters: LogAnalysisFilters,
): ParsedServerLogRecord[] {
  return records.filter((record) => {
    if (!filters.includeSelf && record.module === "log-analysis") return false;
    if (filters.sinceMs !== undefined && record.timestampMs < filters.sinceMs) {
      return false;
    }
    if (filters.untilMs !== undefined && record.timestampMs > filters.untilMs) {
      return false;
    }
    if (
      filters.projectName !== undefined &&
      record.projectName !== filters.projectName
    ) {
      return false;
    }
    if (
      filters.sessionName !== undefined &&
      record.sessionName !== filters.sessionName
    ) {
      return false;
    }
    if (
      filters.conversationId !== undefined &&
      record.conversationId !== filters.conversationId
    ) {
      return false;
    }
    if (filters.path !== undefined && record.path !== filters.path)
      return false;
    if (filters.action !== undefined && record.action !== filters.action) {
      return false;
    }
    return true;
  });
}
