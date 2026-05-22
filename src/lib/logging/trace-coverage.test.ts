import { describe, it, expect } from "vitest";
import { auditTraceCoverage } from "./trace-coverage";

function makeLine(entry: Record<string, unknown>): string {
  return JSON.stringify(entry);
}

describe("auditTraceCoverage", () => {
  it("counts only timed entries (those with durationMs) and ignores non-timed log lines", () => {
    const lines = [
      makeLine({
        timestamp: "2026-05-22T00:00:00.000Z",
        level: "info",
        module: "m1",
        message: "evt.timing",
        durationMs: 12,
        traceId: "t-1",
      }),
      makeLine({
        timestamp: "2026-05-22T00:00:00.000Z",
        level: "info",
        module: "m2",
        message: "bare.info",
      }),
      "",
      "not json",
    ];

    const report = auditTraceCoverage(lines);

    expect(report.totalTimed).toBe(1);
    expect(report.covered).toBe(1);
    expect(report.uncovered).toBe(0);
    expect(report.uncoveredByModuleMessage).toEqual([]);
  });

  it("groups uncovered entries by module+message and sorts by count descending so the biggest gaps surface first", () => {
    const lines = [
      makeLine({
        timestamp: "2026-05-22T00:00:00.000Z",
        level: "info",
        module: "state-store",
        message: "sessions.findAll.timing",
        durationMs: 5,
      }),
      makeLine({
        timestamp: "2026-05-22T00:00:01.000Z",
        level: "info",
        module: "state-store",
        message: "sessions.findAll.timing",
        durationMs: 5,
      }),
      makeLine({
        timestamp: "2026-05-22T00:00:02.000Z",
        level: "info",
        module: "state-store",
        message: "sessions.findAll.timing",
        durationMs: 5,
      }),
      makeLine({
        timestamp: "2026-05-22T00:00:03.000Z",
        level: "info",
        module: "git",
        message: "diff.timing",
        durationMs: 5,
      }),
      makeLine({
        timestamp: "2026-05-22T00:00:04.000Z",
        level: "info",
        module: "git",
        message: "diff.timing",
        durationMs: 5,
        traceId: "covered",
      }),
    ];

    const report = auditTraceCoverage(lines);

    expect(report.totalTimed).toBe(5);
    expect(report.covered).toBe(1);
    expect(report.uncovered).toBe(4);
    expect(report.uncoveredByModuleMessage).toEqual([
      {
        module: "state-store",
        message: "sessions.findAll.timing",
        count: 3,
      },
      { module: "git", message: "diff.timing", count: 1 },
    ]);
  });

  it("filters out entries earlier than sinceMs so callers can scope to a recent window", () => {
    const lines = [
      makeLine({
        timestamp: "2026-05-22T00:00:00.000Z",
        level: "info",
        module: "old",
        message: "timing",
        durationMs: 1,
      }),
      makeLine({
        timestamp: "2026-05-22T01:00:00.000Z",
        level: "info",
        module: "new",
        message: "timing",
        durationMs: 1,
      }),
    ];

    const since = Date.parse("2026-05-22T00:30:00.000Z");
    const report = auditTraceCoverage(lines, { sinceMs: since });

    expect(report.totalTimed).toBe(1);
    expect(report.uncovered).toBe(1);
    expect(report.uncoveredByModuleMessage).toEqual([
      { module: "new", message: "timing", count: 1 },
    ]);
  });

  it("treats explicitly null traceId the same as missing traceId so logger-emitted JSON nulls still surface as gaps", () => {
    const lines = [
      makeLine({
        timestamp: "2026-05-22T00:00:00.000Z",
        level: "info",
        module: "m",
        message: "evt.timing",
        durationMs: 1,
        traceId: null,
      }),
    ];

    const report = auditTraceCoverage(lines);

    expect(report.uncovered).toBe(1);
    expect(report.uncoveredByModuleMessage[0]?.module).toBe("m");
  });
});
