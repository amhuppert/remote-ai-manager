import { describe, expect, it } from "vitest";
import { analyzeTrace } from "./trace";
import type { ParsedServerLogRecord } from "../types";

function record(
  overrides: Partial<ParsedServerLogRecord>,
): ParsedServerLogRecord {
  return {
    lineNumber: 1,
    timestamp: "2026-05-21T12:00:00.000Z",
    timestampMs: Date.parse("2026-05-21T12:00:00.000Z"),
    level: "info",
    module: "state-store",
    message: "state.read.timing",
    traceId: "trace-1",
    durationMs: 10,
    raw: {},
    ...overrides,
  };
}

describe("analyzeTrace", () => {
  it("reports inclusive and exclusive span rankings", () => {
    const analysis = analyzeTrace(
      [
        record({
          lineNumber: 1,
          module: "tracing",
          message: "request.complete",
          timestampMs: 120,
          durationMs: 120,
        }),
        record({
          lineNumber: 2,
          message: "parent.complete",
          timestampMs: 100,
          durationMs: 100,
        }),
        record({
          lineNumber: 3,
          message: "child.complete",
          timestampMs: 30,
          durationMs: 20,
        }),
      ],
      "trace-1",
      { slowMs: 500, hotspotMs: 1000, top: 10 },
    );

    expect(analysis.inclusiveSpans.map((span) => span.message)).toEqual([
      "parent.complete",
      "child.complete",
    ]);
    expect(analysis.exclusiveSpans[0]).toMatchObject({
      message: "parent.complete",
      exclusiveMs: 80,
    });
  });

  it("creates an instrumentation-gap finding for unexplained request time", () => {
    const analysis = analyzeTrace(
      [
        record({
          module: "tracing",
          message: "request.complete",
          timestampMs: 1500,
          durationMs: 1500,
        }),
        record({
          message: "known.complete",
          timestampMs: 100,
          durationMs: 100,
        }),
      ],
      "trace-1",
      { slowMs: 500, hotspotMs: 1000, top: 10 },
    );

    expect(analysis.unexplainedTime).toMatchObject({
      unexplainedMs: 1400,
    });
    expect(analysis.findings[0]).toMatchObject({
      category: "instrumentation-gap",
      severity: "high",
    });
  });

  it("attaches warnings and errors inside the trace", () => {
    const analysis = analyzeTrace(
      [
        record({
          module: "tracing",
          message: "request.complete",
          timestampMs: 50,
          durationMs: 50,
        }),
        record({
          level: "warn",
          module: "state-store",
          message: "state-store.warning",
          durationMs: undefined,
        }),
        record({
          level: "error",
          module: "prompt",
          message: "prompt.failure",
          durationMs: undefined,
          raw: { error: "failed" },
        }),
      ],
      "trace-1",
      { slowMs: 500, hotspotMs: 1000, top: 10 },
    );

    expect(analysis.warningsAndErrors.map((entry) => entry.message)).toEqual([
      "state-store.warning",
      "prompt.failure",
    ]);
  });

  it("includes duplicate work inside the trace", () => {
    const records = [
      record({
        module: "tracing",
        message: "request.complete",
        timestampMs: 1000,
        durationMs: 1000,
      }),
      record({
        lineNumber: 2,
        message: "state.read.timing",
        durationMs: 100,
        raw: { accessor: "getSession", totalMs: 100 },
      }),
      record({
        lineNumber: 3,
        message: "state.read.timing",
        durationMs: 100,
        raw: { accessor: "getSession", totalMs: 100 },
      }),
      record({
        lineNumber: 4,
        message: "state.read.timing",
        durationMs: 100,
        raw: { accessor: "getSession", totalMs: 100 },
      }),
    ];

    const analysis = analyzeTrace(records, "trace-1", {
      slowMs: 500,
      hotspotMs: 1000,
      top: 10,
    });

    expect(analysis.duplicateWork[0]).toMatchObject({
      signature: "state.read:getSession:unknown:unknown:unknown",
      count: 3,
    });
  });
});
