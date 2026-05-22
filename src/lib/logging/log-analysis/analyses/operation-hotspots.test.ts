import { describe, expect, it } from "vitest";
import { analyzeOperationHotspots } from "./operation-hotspots";
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
    durationMs: 10,
    raw: {},
    ...overrides,
  };
}

describe("analyzeOperationHotspots", () => {
  it("excludes request lifecycle duration events", () => {
    const analysis = analyzeOperationHotspots(
      [
        record({
          module: "tracing",
          message: "request.complete",
          durationMs: 5000,
        }),
        record({
          module: "transcript",
          message: "transcript.read.complete",
          durationMs: 25,
        }),
      ],
      { slowMs: 500, hotspotMs: 1000, top: 10 },
    );

    expect(analysis.hotspots).toHaveLength(1);
    expect(analysis.hotspots[0]?.key).toBe(
      "transcript:transcript.read.complete",
    );
  });

  it("applies operation-specific grouping dimensions", () => {
    const analysis = analyzeOperationHotspots(
      [
        record({
          message: "state.read.timing",
          durationMs: 20,
          raw: { accessor: "getSession" },
        }),
        record({
          message: "state.read.timing",
          durationMs: 30,
          raw: { accessor: "readState" },
        }),
        record({
          module: "git-client",
          message: "git.complete",
          durationMs: 40,
          raw: { command: "git", argsPreview: "status --short" },
        }),
      ],
      { slowMs: 500, hotspotMs: 1000, top: 10 },
    );

    expect(analysis.hotspots.map((hotspot) => hotspot.key)).toEqual([
      "git-client:git.complete command=git args=status --short",
      "state-store:state.read.timing accessor=readState",
      "state-store:state.read.timing accessor=getSession",
    ]);
  });

  it("creates sorted hotspot findings by severity and magnitude", () => {
    const analysis = analyzeOperationHotspots(
      [
        record({ traceId: "a", durationMs: 1100 }),
        record({ traceId: "b", durationMs: 1200 }),
        record({ traceId: "c", durationMs: 1300 }),
        record({
          module: "diff",
          message: "diff.compute.complete",
          durationMs: 900,
        }),
        record({
          module: "diff",
          message: "diff.compute.complete",
          durationMs: 900,
        }),
        record({
          module: "diff",
          message: "diff.compute.complete",
          durationMs: 900,
        }),
        record({
          module: "diff",
          message: "diff.compute.complete",
          durationMs: 900,
        }),
        record({
          module: "diff",
          message: "diff.compute.complete",
          durationMs: 900,
        }),
        record({
          module: "diff",
          message: "diff.compute.complete",
          durationMs: 900,
        }),
      ],
      { slowMs: 500, hotspotMs: 1000, top: 10 },
    );

    expect(analysis.findings.map((finding) => finding.severity)).toEqual([
      "high",
      "medium",
    ]);
    expect(analysis.findings[0]?.category).toBe("operation-hotspot");
  });
});
