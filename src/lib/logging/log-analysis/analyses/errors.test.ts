import { describe, expect, it } from "vitest";
import { analyzeErrorCorrelation } from "./errors";
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
    durationMs: 600,
    raw: {},
    ...overrides,
  };
}

describe("analyzeErrorCorrelation", () => {
  it("attaches warnings and errors to slow traces", () => {
    const analysis = analyzeErrorCorrelation(
      [
        record({ traceId: "trace-1", durationMs: 700 }),
        record({
          traceId: "trace-1",
          level: "warn",
          module: "state-store",
          message: "state.warning",
          durationMs: undefined,
        }),
        record({
          traceId: "trace-1",
          level: "error",
          module: "prompt",
          message: "prompt.failure",
          durationMs: undefined,
        }),
      ],
      { slowMs: 500, hotspotMs: 1000, top: 10 },
    );

    expect(analysis.slowTraceCorrelations[0]?.warningsAndErrors).toHaveLength(
      2,
    );
  });

  it("creates findings for failed commands in slow traces", () => {
    const analysis = analyzeErrorCorrelation(
      [
        record({ traceId: "trace-1", durationMs: 700 }),
        record({
          traceId: "trace-1",
          module: "exec",
          message: "exec.complete",
          durationMs: 100,
          raw: { command: "git", argsPreview: "merge main", exitCode: 1 },
        }),
      ],
      { slowMs: 500, hotspotMs: 1000, top: 10 },
    );

    expect(analysis.findings[0]).toMatchObject({
      category: "error-correlation",
      severity: "high",
    });
  });
});
