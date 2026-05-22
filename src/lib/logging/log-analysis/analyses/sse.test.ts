import { describe, expect, it } from "vitest";
import { analyzeSse } from "./sse";
import type { ParsedServerLogRecord } from "../types";

function record(
  overrides: Partial<ParsedServerLogRecord>,
): ParsedServerLogRecord {
  return {
    lineNumber: 1,
    timestamp: "2026-05-21T12:00:00.000Z",
    timestampMs: Date.parse("2026-05-21T12:00:00.000Z"),
    level: "info",
    module: "sse-broadcaster",
    message: "sse.broadcast.complete",
    traceId: "trace-1",
    durationMs: 10,
    raw: {
      eventType: "conversation-status",
      subscriberCount: 2,
      payloadBytes: 100,
    },
    ...overrides,
  };
}

describe("analyzeSse", () => {
  it("groups broadcasts by eventType with payload and subscriber metrics", () => {
    const analysis = analyzeSse(
      [
        record({ durationMs: 10 }),
        record({
          durationMs: 30,
          raw: {
            eventType: "conversation-status",
            subscriberCount: 4,
            payloadBytes: 300,
          },
        }),
      ],
      { slowMs: 500, hotspotMs: 1000, top: 10 },
    );

    expect(analysis.events[0]).toMatchObject({
      eventType: "conversation-status",
      count: 2,
      p95Ms: 30,
      maxMs: 30,
      avgSubscriberCount: 3,
      maxSubscriberCount: 4,
      avgPayloadBytes: 200,
      maxPayloadBytes: 300,
    });
  });

  it("creates findings when SSE thresholds are crossed", () => {
    const analysis = analyzeSse(
      [
        record({ traceId: "a", durationMs: 55 }),
        record({ traceId: "b", durationMs: 60 }),
        record({ traceId: "c", durationMs: 65 }),
        record({
          traceId: "d",
          durationMs: 1,
          raw: {
            eventType: "large-payload",
            subscriberCount: 1,
            payloadBytes: 300 * 1024,
          },
        }),
      ],
      { slowMs: 500, hotspotMs: 1000, top: 10 },
    );

    expect(analysis.findings.map((finding) => finding.severity)).toEqual([
      "high",
      "low",
    ]);
    expect(analysis.findings[0]?.category).toBe("sse");
  });
});
