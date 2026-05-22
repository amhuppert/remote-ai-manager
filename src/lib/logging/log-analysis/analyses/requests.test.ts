import { describe, expect, it } from "vitest";
import { analyzeSlowRequests } from "./requests";
import type { ParsedServerLogRecord } from "../types";

function requestRecord(
  overrides: Partial<ParsedServerLogRecord>,
): ParsedServerLogRecord {
  return {
    lineNumber: 1,
    timestamp: "2026-05-21T12:00:00.000Z",
    timestampMs: Date.parse("2026-05-21T12:00:00.000Z"),
    level: "info",
    module: "tracing",
    message: "request.complete",
    raw: {},
    ...overrides,
  };
}

describe("analyzeSlowRequests", () => {
  it("groups requests by method, path, action, and status", () => {
    const analysis = analyzeSlowRequests(
      [
        requestRecord({
          method: "GET",
          path: "/api/a",
          action: "load",
          status: 200,
          durationMs: 100,
        }),
        requestRecord({
          method: "GET",
          path: "/api/a",
          action: "load",
          status: 500,
          durationMs: 200,
        }),
      ],
      { slowMs: 500, hotspotMs: 1000, top: 10 },
    );

    expect(analysis.groups.map((group) => group.key)).toEqual([
      "GET /api/a action=load status=500",
      "GET /api/a action=load status=200",
    ]);
  });

  it("reports p95, max, and slow trace IDs", () => {
    const analysis = analyzeSlowRequests(
      [
        requestRecord({ traceId: "a", durationMs: 100 }),
        requestRecord({ traceId: "b", durationMs: 600 }),
        requestRecord({ traceId: "c", durationMs: 900 }),
      ],
      { slowMs: 500, hotspotMs: 1000, top: 10 },
    );

    expect(analysis.groups[0]).toMatchObject({
      count: 3,
      p95Ms: 900,
      maxMs: 900,
      slowTraceIds: ["c", "b"],
    });
  });

  it("creates findings according to request thresholds", () => {
    const records = [
      requestRecord({ traceId: "a", status: 200, durationMs: 1100 }),
      requestRecord({ traceId: "b", status: 200, durationMs: 1200 }),
      requestRecord({ traceId: "c", status: 200, durationMs: 1300 }),
      requestRecord({
        traceId: "d",
        message: "request.error",
        durationMs: 6000,
        level: "error",
      }),
    ];

    const analysis = analyzeSlowRequests(records, {
      slowMs: 500,
      hotspotMs: 1000,
      top: 10,
    });

    expect(analysis.findings.map((finding) => finding.severity)).toEqual([
      "critical",
      "high",
    ]);
    expect(analysis.findings[0]?.category).toBe("slow-request");
  });
});
