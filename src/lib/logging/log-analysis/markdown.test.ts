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
