import { describe, expect, it } from "vitest";
import { analyzeClientTiming } from "./client-timing";

describe("analyzeClientTiming", () => {
  it("parses JSONL api.fetch records and reports server/network split", () => {
    const analysis = analyzeClientTiming(
      [
        JSON.stringify({
          event: "api.fetch",
          traceId: "trace-1",
          action: "load",
          method: "GET",
          url: "/api/test",
          status: 200,
          totalMs: 120,
          serverMs: 40,
          networkMs: 80,
        }),
        JSON.stringify({
          event: "api.fetch",
          traceId: "trace-2",
          action: "load",
          method: "GET",
          url: "/api/test",
          status: 200,
          totalMs: 220,
          serverMs: 50,
          networkMs: 170,
        }),
      ].join("\n"),
      { slowMs: 500, hotspotMs: 1000, top: 10 },
    );

    expect(analysis.available).toBe(true);
    expect(analysis.apiFetches[0]).toMatchObject({
      key: "load GET /api/test",
      count: 2,
      p95TotalMs: 220,
      p95ServerMs: 50,
      p95NetworkMs: 170,
    });
  });

  it("parses JSON array sse.message records and reports handler metrics", () => {
    const analysis = analyzeClientTiming(
      JSON.stringify([
        {
          message: "sse.message",
          eventType: "conversation-status",
          transportMs: 25,
          handlerMs: 12,
        },
        {
          message: "sse.message",
          eventType: "conversation-status",
          transportMs: 75,
          handlerMs: 20,
        },
      ]),
      { slowMs: 500, hotspotMs: 1000, top: 10 },
    );

    expect(analysis.sseMessages[0]).toMatchObject({
      eventType: "conversation-status",
      count: 2,
      p95TransportMs: 75,
      p95HandlerMs: 20,
    });
    expect(analysis.findings[0]).toMatchObject({
      category: "client-timing",
      severity: "medium",
    });
  });

  it("reports unavailable client timing when no log is provided", () => {
    const analysis = analyzeClientTiming(null, {
      slowMs: 500,
      hotspotMs: 1000,
      top: 10,
    });

    expect(analysis).toMatchObject({
      available: false,
      apiFetches: [],
      sseMessages: [],
      findings: [],
    });
  });
});
