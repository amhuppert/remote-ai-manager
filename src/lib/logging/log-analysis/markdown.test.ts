import { describe, expect, it } from "vitest";
import { renderLogAnalysisMarkdown } from "./markdown";
import { buildLogAnalysisReport } from "./report";
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
    durationMs: 600,
    method: "GET",
    path: "/api/test",
    status: 200,
    raw: {},
    ...overrides,
  };
}

describe("renderLogAnalysisMarkdown", () => {
  it("renders the key report sections and follow-up commands", () => {
    const report = buildLogAnalysisReport({
      records: [record({ traceId: "trace-1", durationMs: 600 })],
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

    const markdown = renderLogAnalysisMarkdown(report);

    expect(markdown).toContain("## Summary");
    expect(markdown).toContain("## Findings");
    expect(markdown).toContain("## Top Slow Requests");
    expect(markdown).toContain("## Recommended Next Commands");
    expect(markdown).toContain(
      "bun run logs:analyze -- trace trace-1 --format markdown",
    );
  });

  it("labels state.read aggregates as a censored tail sample and breaks them down per accessor", () => {
    const stateRead = (durationMs: number): ParsedServerLogRecord =>
      record({
        module: "state-store",
        message: "state.read.timing",
        traceId: "trace-state",
        durationMs,
        method: undefined,
        path: undefined,
        status: undefined,
        raw: { accessor: "getSession", durationMs },
      });

    const report = buildLogAnalysisReport({
      records: [stateRead(10), stateRead(60), stateRead(70)],
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

    const markdown = renderLogAnalysisMarkdown(report);

    expect(markdown).toContain(
      "- Slow accessors: 1 (tail sample: state.read.timing is logged only at or above the 5 ms floor, so counts and p95 are tail statistics, not typical latency)",
    );
    expect(markdown).toContain("- getSession: count=3, p95=70 ms, max=70 ms");
    expect(markdown).toContain(
      "- state-store:state.read.timing accessor=getSession: p95=70 ms, total=140 ms, count=3 (>= 5 ms tail sample; faster reads unlogged)",
    );
  });

  it("labels a state-read budget violation as measured on the censored tail", () => {
    const stateRead = (durationMs: number): ParsedServerLogRecord =>
      record({
        module: "state-store",
        message: "state.read.timing",
        traceId: "trace-state",
        durationMs,
        method: undefined,
        path: undefined,
        status: undefined,
        raw: { accessor: "getSession", durationMs },
      });

    const report = buildLogAnalysisReport({
      records: [stateRead(120), stateRead(130), stateRead(140)],
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

    const markdown = renderLogAnalysisMarkdown(report);

    expect(markdown).toContain(
      "- state-read: getSession observed=140 ms > ceiling=100 ms (>= 5 ms tail sample; faster reads unlogged)",
    );
  });

  it("does not include raw JSON blobs", () => {
    const report = buildLogAnalysisReport({
      records: [record({ traceId: "trace-1", durationMs: 600 })],
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

    const markdown = renderLogAnalysisMarkdown(report);

    expect(markdown).not.toContain('"schemaVersion"');
    expect(markdown).not.toContain('"raw"');
  });
});
