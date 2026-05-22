import { describe, expect, it } from "vitest";
import { parseServerLogLines } from "./parser";

describe("parseServerLogLines", () => {
  it("parses valid NDJSON records with normalized fields", () => {
    const result = parseServerLogLines([
      JSON.stringify({
        timestamp: "2026-05-21T12:00:01.000Z",
        level: "info",
        module: "tracing",
        message: "request.complete",
        traceId: "trace-1",
        action: "load-page",
        projectName: "project",
        sessionName: "session",
        conversationId: "conversation",
        method: "GET",
        path: "/api/test",
        status: 200,
        durationMs: 42,
      }),
    ]);

    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      lineNumber: 1,
      timestamp: "2026-05-21T12:00:01.000Z",
      timestampMs: Date.parse("2026-05-21T12:00:01.000Z"),
      level: "info",
      module: "tracing",
      message: "request.complete",
      traceId: "trace-1",
      action: "load-page",
      projectName: "project",
      sessionName: "session",
      conversationId: "conversation",
      method: "GET",
      path: "/api/test",
      status: 200,
      durationMs: 42,
    });
    expect(result.malformedLineCount).toBe(0);
    expect(result.invalidTimestampCount).toBe(0);
  });

  it("counts malformed JSON lines without failing", () => {
    const result = parseServerLogLines([
      "{not json",
      JSON.stringify({
        timestamp: "2026-05-21T12:00:01.000Z",
        level: "info",
        module: "tracing",
        message: "request.start",
      }),
    ]);

    expect(result.records).toHaveLength(1);
    expect(result.malformedLineCount).toBe(1);
  });

  it("uses state.read.timing totalMs as normalized durationMs", () => {
    const result = parseServerLogLines([
      JSON.stringify({
        timestamp: "2026-05-21T12:00:01.000Z",
        level: "info",
        module: "state-store",
        message: "state.read.timing",
        accessor: "getSession",
        totalMs: 12.5,
      }),
    ]);

    expect(result.records[0]?.durationMs).toBe(12.5);
    expect(result.records[0]?.raw["totalMs"]).toBe(12.5);
  });

  it("ignores invalid duration values", () => {
    const result = parseServerLogLines([
      JSON.stringify({
        timestamp: "2026-05-21T12:00:01.000Z",
        level: "info",
        module: "tracing",
        message: "request.complete",
        durationMs: -1,
      }),
      JSON.stringify({
        timestamp: "2026-05-21T12:00:02.000Z",
        level: "info",
        module: "tracing",
        message: "request.complete",
        durationMs: Number.NaN,
      }),
    ]);

    expect(result.records[0]?.durationMs).toBeUndefined();
    expect(result.records[1]?.durationMs).toBeUndefined();
  });

  it("excludes invalid timestamps and counts them", () => {
    const result = parseServerLogLines([
      JSON.stringify({
        timestamp: "not-a-date",
        level: "info",
        module: "tracing",
        message: "request.complete",
      }),
      JSON.stringify({
        timestamp: "2026-05-21T12:00:01.000Z",
        level: "info",
        module: "tracing",
        message: "request.start",
      }),
    ]);

    expect(result.records).toHaveLength(1);
    expect(result.invalidTimestampCount).toBe(1);
  });
});
