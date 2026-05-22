import { describe, it, expect } from "vitest";
import { buildTrace, parseTimedLogLine } from "./speedscope-export";

function logLine(entry: Record<string, unknown>): string {
  return JSON.stringify(entry);
}

const T0 = "2026-05-21T12:00:00.000Z";
const T1 = "2026-05-21T12:00:00.500Z";
const T2 = "2026-05-21T12:00:01.000Z";

describe("parseTimedLogLine", () => {
  it("returns null for empty or whitespace lines", () => {
    expect(parseTimedLogLine("")).toBeNull();
    expect(parseTimedLogLine("   \n")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseTimedLogLine("not-json")).toBeNull();
  });

  it("returns null for entries missing durationMs", () => {
    const line = logLine({
      timestamp: T0,
      level: "info",
      module: "diff",
      message: "diff.compute.complete",
    });
    expect(parseTimedLogLine(line)).toBeNull();
  });

  it("returns null when durationMs is not a non-negative finite number", () => {
    expect(
      parseTimedLogLine(
        logLine({
          timestamp: T0,
          level: "info",
          module: "x",
          message: "y",
          durationMs: -1,
        }),
      ),
    ).toBeNull();
    expect(
      parseTimedLogLine(
        logLine({
          timestamp: T0,
          level: "info",
          module: "x",
          message: "y",
          durationMs: Number.NaN,
        }),
      ),
    ).toBeNull();
  });

  it("preserves additional fields for downstream args", () => {
    const entry = parseTimedLogLine(
      logLine({
        timestamp: T0,
        level: "info",
        module: "diff",
        message: "diff.compute.complete",
        durationMs: 42,
        traceId: "abc",
        action: "GET /api/diff",
        fileCount: 3,
      }),
    );
    expect(entry).not.toBeNull();
    expect(entry?.traceId).toBe("abc");
    expect(entry?.fileCount).toBe(3);
  });
});

describe("buildTrace", () => {
  it("returns at least a process_name metadata event for empty input", () => {
    const trace = buildTrace([]);
    expect(trace.displayTimeUnit).toBe("ms");
    expect(trace.traceEvents).toHaveLength(1);
    expect(trace.traceEvents[0]).toMatchObject({
      name: "process_name",
      ph: "M",
      args: { name: "Command Center" },
    });
  });

  it("places all duration events on a single aggregated tid for whole-app flamegraph aggregation", () => {
    const trace = buildTrace([
      logLine({
        timestamp: T1,
        level: "info",
        module: "git",
        message: "git.complete",
        durationMs: 10,
        traceId: "trace-A",
      }),
      logLine({
        timestamp: T2,
        level: "info",
        module: "diff",
        message: "diff.compute.complete",
        durationMs: 20,
        traceId: "trace-B",
      }),
      logLine({
        timestamp: T2,
        level: "info",
        module: "poll",
        message: "poll.tick",
        durationMs: 5,
      }),
    ]);

    const duration = trace.traceEvents.filter((e) => e.ph === "X");
    expect(duration).toHaveLength(3);
    const tids = new Set(duration.map((e) => e.tid));
    expect(tids.size).toBe(1);
    expect(tids.has(0)).toBe(false);
  });

  it("labels the aggregated thread", () => {
    const trace = buildTrace([
      logLine({
        timestamp: T1,
        level: "info",
        module: "git",
        message: "git.complete",
        durationMs: 10,
        traceId: "trace-A",
      }),
    ]);

    const threadName = trace.traceEvents.find(
      (e) => e.ph === "M" && e.name === "thread_name",
    );
    expect(threadName).toBeDefined();
    expect(threadName?.args).toEqual({ name: "aggregated" });
  });

  it("preserves traceId, action, and extra fields in args", () => {
    const trace = buildTrace([
      logLine({
        timestamp: T1,
        level: "info",
        module: "diff",
        message: "diff.compute.complete",
        durationMs: 500,
        traceId: "trace-1",
        action: "GET /api/diff",
        worktreePath: "/tmp/wt",
        fileCount: 4,
      }),
    ]);

    const durationEvents = trace.traceEvents.filter((e) => e.ph === "X");
    expect(durationEvents).toHaveLength(1);
    const event = durationEvents[0]!;
    expect(event.name).toBe("diff.compute.complete");
    expect(event.cat).toBe("diff");
    expect(event.pid).toBe(1);
    expect(event.dur).toBe(500_000);
    expect(event.args).toEqual({
      traceId: "trace-1",
      action: "GET /api/diff",
      worktreePath: "/tmp/wt",
      fileCount: 4,
    });
  });

  it("serializes traces end-to-end so the total span sums per-trace durations", () => {
    // Two non-overlapping traces in wall-clock, each with one event.
    // Serialized span should equal sum of durations (not max), proving
    // groups are placed back-to-back rather than overlapping.
    const trace = buildTrace([
      logLine({
        timestamp: T1,
        level: "info",
        module: "git",
        message: "git.complete",
        durationMs: 100,
        traceId: "trace-A",
      }),
      logLine({
        timestamp: T2,
        level: "info",
        module: "diff",
        message: "diff.compute.complete",
        durationMs: 200,
        traceId: "trace-B",
      }),
    ]);

    const duration = trace.traceEvents.filter((e) => e.ph === "X");
    expect(duration).toHaveLength(2);
    const minTs = Math.min(...duration.map((e) => e.ts));
    const maxEnd = Math.max(...duration.map((e) => e.ts + (e.dur ?? 0)));
    expect(maxEnd - minTs).toBe(300_000);
  });

  it("preserves within-trace nesting: child sits inside parent in virtual time", () => {
    // Parent spans T0..T0+100ms; child spans T0+10..T0+30ms.
    // After serialization, child.ts should be parent.ts + 10ms and
    // child end <= parent end.
    const parentEnd = "2026-05-21T12:00:00.100Z";
    const childEnd = "2026-05-21T12:00:00.030Z";

    const trace = buildTrace([
      logLine({
        timestamp: parentEnd,
        level: "info",
        module: "handler",
        message: "handler.complete",
        durationMs: 100,
        traceId: "trace-A",
      }),
      logLine({
        timestamp: childEnd,
        level: "info",
        module: "db",
        message: "db.read",
        durationMs: 20,
        traceId: "trace-A",
      }),
    ]);

    const duration = trace.traceEvents.filter((e) => e.ph === "X");
    const parent = duration.find((e) => e.name === "handler.complete");
    const child = duration.find((e) => e.name === "db.read");
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(child!.ts).toBe(parent!.ts + 10_000);
    expect(child!.ts + (child!.dur ?? 0)).toBeLessThanOrEqual(
      parent!.ts + (parent!.dur ?? 0),
    );
  });

  it("promotes overlapping-but-not-nested siblings to roots within the same group", () => {
    // Two events in same traceId that overlap as siblings (e.g. Promise.all).
    // Each ends at T2 but with different durations, so neither contains the other.
    // Result: both should be roots, serialized back-to-back, no nesting.
    const trace = buildTrace([
      logLine({
        timestamp: "2026-05-21T12:00:00.100Z",
        level: "info",
        module: "a",
        message: "a.complete",
        durationMs: 60, // starts at T+40ms
        traceId: "trace-A",
      }),
      logLine({
        timestamp: "2026-05-21T12:00:00.120Z",
        level: "info",
        module: "b",
        message: "b.complete",
        durationMs: 50, // starts at T+70ms — overlaps a but ends later
        traceId: "trace-A",
      }),
    ]);

    const duration = trace.traceEvents.filter((e) => e.ph === "X");
    expect(duration).toHaveLength(2);
    const a = duration.find((e) => e.name === "a.complete")!;
    const b = duration.find((e) => e.name === "b.complete")!;
    // a was promoted as the first root, b as the second root, back-to-back
    expect(b.ts).toBeGreaterThanOrEqual(a.ts + (a.dur ?? 0));
  });

  it("treats each background entry as its own group", () => {
    // Two concurrent background polls; they should be serialized one after
    // the other rather than collapsed into a single parent/child pair.
    const trace = buildTrace([
      logLine({
        timestamp: T1,
        level: "info",
        module: "poll",
        message: "poll.tick",
        durationMs: 200,
      }),
      logLine({
        timestamp: T1,
        level: "info",
        module: "poll",
        message: "poll.tick",
        durationMs: 50,
      }),
    ]);

    const duration = trace.traceEvents.filter((e) => e.ph === "X");
    expect(duration).toHaveLength(2);
    const sortedByTs = [...duration].sort((a, b) => a.ts - b.ts);
    expect(sortedByTs[1]!.ts).toBeGreaterThanOrEqual(
      sortedByTs[0]!.ts + (sortedByTs[0]!.dur ?? 0),
    );
  });

  it("filters by traceId when options.traceId is set", () => {
    const trace = buildTrace(
      [
        logLine({
          timestamp: T1,
          level: "info",
          module: "git",
          message: "git.complete",
          durationMs: 10,
          traceId: "keep",
        }),
        logLine({
          timestamp: T2,
          level: "info",
          module: "git",
          message: "git.complete",
          durationMs: 20,
          traceId: "drop",
        }),
      ],
      { traceId: "keep" },
    );

    const duration = trace.traceEvents.filter((e) => e.ph === "X");
    expect(duration).toHaveLength(1);
    expect((duration[0]!.args as { traceId: string }).traceId).toBe("keep");
  });

  it("filters by sinceMs when set", () => {
    const trace = buildTrace(
      [
        logLine({
          timestamp: T0,
          level: "info",
          module: "git",
          message: "git.complete",
          durationMs: 1,
          traceId: "old",
        }),
        logLine({
          timestamp: T2,
          level: "info",
          module: "git",
          message: "git.complete",
          durationMs: 1,
          traceId: "new",
        }),
      ],
      { sinceMs: Date.parse(T1) },
    );

    const duration = trace.traceEvents.filter((e) => e.ph === "X");
    expect(duration).toHaveLength(1);
    expect((duration[0]!.args as { traceId: string }).traceId).toBe("new");
  });

  it("sorts duration events by ts ascending", () => {
    const trace = buildTrace([
      logLine({
        timestamp: T2,
        level: "info",
        module: "git",
        message: "git.complete",
        durationMs: 5,
        traceId: "t",
      }),
      logLine({
        timestamp: T1,
        level: "info",
        module: "diff",
        message: "diff.compute.complete",
        durationMs: 5,
        traceId: "t",
      }),
    ]);

    const duration = trace.traceEvents.filter((e) => e.ph === "X");
    expect(duration).toHaveLength(2);
    expect(duration[0]!.ts).toBeLessThanOrEqual(duration[1]!.ts);
  });

  it("ignores blank lines and non-JSON garbage interspersed in the input", () => {
    const trace = buildTrace([
      "",
      "garbage line not json",
      logLine({
        timestamp: T1,
        level: "info",
        module: "git",
        message: "git.complete",
        durationMs: 5,
        traceId: "t",
      }),
      "",
    ]);

    const duration = trace.traceEvents.filter((e) => e.ph === "X");
    expect(duration).toHaveLength(1);
  });
});
