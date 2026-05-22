import { describe, expect, it } from "vitest";
import { buildLogAnalysisReport } from "./report";
import { agentLogAnalysisReportSchema } from "./schemas";
import type { ParsedServerLogRecord } from "./types";

function record(
  overrides: Partial<ParsedServerLogRecord>,
): ParsedServerLogRecord {
  return {
    lineNumber: 1,
    timestamp: "2026-05-21T12:00:00.000Z",
    timestampMs: Date.parse("2026-05-21T12:00:00.000Z"),
    level: "info",
    module: "tracing",
    message: "request.complete",
    traceId: "trace-1",
    projectName: "project-a",
    durationMs: 600,
    method: "GET",
    path: "/api/test",
    status: 200,
    raw: {},
    ...overrides,
  };
}

describe("buildLogAnalysisReport", () => {
  it("builds a report that validates against the public schema", () => {
    const report = buildLogAnalysisReport({
      records: [record({ durationMs: 600 })],
      parseStats: {
        malformedLineCount: 0,
        invalidTimestampCount: 0,
        invalidShapeCount: 0,
      },
      filters: { includeSelf: false },
      thresholds: { slowMs: 500, hotspotMs: 1000, top: 10 },
      input: { serverLogPath: "/tmp/cc-debug.log" },
      generatedAt: "2026-05-21T12:00:00.000Z",
      clientLogRaw: null,
    });

    expect(agentLogAnalysisReportSchema.parse(report)).toEqual(report);
  });

  it("sorts and caps findings", () => {
    const report = buildLogAnalysisReport({
      records: [
        record({
          traceId: "a",
          durationMs: 6000,
          message: "request.error",
          level: "error",
        }),
        record({
          traceId: "b",
          module: "state-store",
          message: "state.read.timing",
          durationMs: 60,
          raw: { accessor: "getSession", totalMs: 60 },
        }),
        record({
          traceId: "c",
          module: "state-store",
          message: "state.read.timing",
          durationMs: 70,
          raw: { accessor: "getSession", totalMs: 70 },
        }),
        record({
          traceId: "d",
          module: "state-store",
          message: "state.read.timing",
          durationMs: 80,
          raw: { accessor: "getSession", totalMs: 80 },
        }),
      ],
      parseStats: {
        malformedLineCount: 0,
        invalidTimestampCount: 0,
        invalidShapeCount: 0,
      },
      filters: { includeSelf: false },
      thresholds: { slowMs: 500, hotspotMs: 1000, top: 1 },
      input: { serverLogPath: "/tmp/cc-debug.log" },
      generatedAt: "2026-05-21T12:00:00.000Z",
      clientLogRaw: null,
    });

    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.severity).toBe("critical");
  });

  it("applies filters and excludes analyzer self logs by default", () => {
    const report = buildLogAnalysisReport({
      records: [
        record({ projectName: "project-a", durationMs: 600 }),
        record({ projectName: "project-b", durationMs: 700 }),
        record({
          module: "log-analysis",
          message: "log_analysis.complete",
          projectName: "project-a",
          durationMs: 800,
        }),
      ],
      parseStats: {
        malformedLineCount: 0,
        invalidTimestampCount: 0,
        invalidShapeCount: 0,
      },
      filters: { includeSelf: false, projectName: "project-a" },
      thresholds: { slowMs: 500, hotspotMs: 1000, top: 10 },
      input: { serverLogPath: "/tmp/cc-debug.log" },
      generatedAt: "2026-05-21T12:00:00.000Z",
      clientLogRaw: null,
    });

    expect(report.summary.recordsAnalyzed).toBe(1);
    expect(report.slowRequests).toHaveLength(1);
  });
});
