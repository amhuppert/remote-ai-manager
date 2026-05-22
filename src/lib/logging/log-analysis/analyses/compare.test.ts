import { describe, expect, it } from "vitest";
import { buildLogComparisonReport } from "./compare";
import type { ParsedServerLogRecord } from "../types";

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
    durationMs: 100,
    method: "GET",
    path: "/api/test",
    status: 200,
    raw: {},
    ...overrides,
  };
}

describe("buildLogComparisonReport", () => {
  it("reports endpoint p95 deltas", () => {
    const report = buildLogComparisonReport({
      beforeRecords: [record({ durationMs: 100 })],
      afterRecords: [record({ durationMs: 250 })],
      filters: { includeSelf: false },
      thresholds: { slowMs: 500, hotspotMs: 1000, top: 10 },
      beforeInput: { serverLogPath: "/tmp/before.log" },
      afterInput: { serverLogPath: "/tmp/after.log" },
      generatedAt: "2026-05-21T12:00:00.000Z",
    });

    expect(report.endpointDeltas[0]).toMatchObject({
      key: "GET /api/test action=unknown status=200",
      p95DeltaMs: 150,
      p95DeltaPercent: 150,
    });
    expect(report.findings[0]).toMatchObject({
      category: "regression",
      severity: "high",
    });
  });

  it("reports operation regression findings", () => {
    const report = buildLogComparisonReport({
      beforeRecords: [
        record({
          module: "state-store",
          message: "state.read.timing",
          durationMs: 100,
          raw: { accessor: "getSession", totalMs: 100 },
        }),
      ],
      afterRecords: [
        record({
          module: "state-store",
          message: "state.read.timing",
          durationMs: 200,
          raw: { accessor: "getSession", totalMs: 200 },
        }),
      ],
      filters: { includeSelf: false },
      thresholds: { slowMs: 500, hotspotMs: 1000, top: 10 },
      beforeInput: { serverLogPath: "/tmp/before.log" },
      afterInput: { serverLogPath: "/tmp/after.log" },
      generatedAt: "2026-05-21T12:00:00.000Z",
    });

    expect(report.operationDeltas[0]).toMatchObject({
      key: "state-store:state.read.timing accessor=getSession",
      p95DeltaMs: 100,
      p95DeltaPercent: 100,
    });
    expect(report.findings[0]).toMatchObject({
      category: "regression",
      severity: "medium",
    });
  });

  it("reports new errors and duplicate signatures", () => {
    const report = buildLogComparisonReport({
      beforeRecords: [],
      afterRecords: [
        record({
          level: "error",
          module: "prompt",
          message: "prompt.failure",
          durationMs: undefined,
        }),
        record({
          traceId: "trace-dup",
          module: "state-store",
          message: "state.read.timing",
          durationMs: 100,
          raw: { accessor: "getSession", totalMs: 100 },
        }),
        record({
          traceId: "trace-dup",
          module: "state-store",
          message: "state.read.timing",
          durationMs: 100,
          raw: { accessor: "getSession", totalMs: 100 },
        }),
        record({
          traceId: "trace-dup",
          module: "state-store",
          message: "state.read.timing",
          durationMs: 100,
          raw: { accessor: "getSession", totalMs: 100 },
        }),
      ],
      filters: { includeSelf: false },
      thresholds: { slowMs: 500, hotspotMs: 1000, top: 10 },
      beforeInput: { serverLogPath: "/tmp/before.log" },
      afterInput: { serverLogPath: "/tmp/after.log" },
      generatedAt: "2026-05-21T12:00:00.000Z",
    });

    expect(report.newWarningsAndErrors[0]).toMatchObject({
      key: "error:prompt:prompt.failure",
      afterCount: 1,
    });
    expect(report.duplicateWorkDeltas[0]).toMatchObject({
      signature: "state.read:getSession:unknown:unknown:unknown",
      status: "new",
    });
  });
});
