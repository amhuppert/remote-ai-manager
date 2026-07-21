import { describe, expect, it } from "vitest";
import { analyzeConventions } from "./conventions";
import type { ParsedServerLogRecord } from "../types";

function request(
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
    method: "POST",
    path: "/api/projects/demo/dev-servers",
    status: 202,
    durationMs: 5000,
    raw: {},
    ...overrides,
  };
}

const THRESHOLDS = { slowMs: 500, hotspotMs: 1000, top: 10 };

describe("analyzeConventions — slow 202 acceptance", () => {
  it("flags a 202 response that took longer than 1s as a convention violation", () => {
    const analysis = analyzeConventions(
      [request({ traceId: "t-1", durationMs: 5000 })],
      THRESHOLDS,
    );

    expect(analysis.findings).toHaveLength(1);
    const finding = analysis.findings[0]!;
    expect(finding.category).toBe("convention-violation");
    expect(finding.title).toContain("202");
    expect(finding.traceIds).toContain("t-1");
    expect(finding.evidence).toEqual(
      expect.arrayContaining([
        { label: "maxDurationMs", value: 5000, unit: "ms" },
        { label: "count", value: 1, unit: "count" },
      ]),
    );
  });

  it("ignores a fast 202 (accepted-and-quick is fine)", () => {
    const analysis = analyzeConventions(
      [request({ durationMs: 200 })],
      THRESHOLDS,
    );
    expect(analysis.findings).toHaveLength(0);
  });

  it("ignores a slow non-202 response (that is the slow-request rule's job)", () => {
    const analysis = analyzeConventions(
      [request({ status: 200, durationMs: 5000 })],
      THRESHOLDS,
    );
    expect(analysis.findings).toHaveLength(0);
  });

  it("groups repeated slow 202s on the same route and counts them", () => {
    const analysis = analyzeConventions(
      [
        request({ traceId: "t-1", durationMs: 3000 }),
        request({ traceId: "t-2", durationMs: 9000 }),
      ],
      THRESHOLDS,
    );
    expect(analysis.findings).toHaveLength(1);
    expect(analysis.findings[0]!.evidence).toEqual(
      expect.arrayContaining([
        { label: "maxDurationMs", value: 9000, unit: "ms" },
        { label: "count", value: 2, unit: "count" },
      ]),
    );
  });
});
