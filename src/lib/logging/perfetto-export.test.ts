import { describe, it, expect } from "vitest";
import { buildTrace, parseTimedLogLine } from "./perfetto-export";

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

  it("emits one duration event per timed-complete log, with args from extra fields", () => {
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
    expect(event.tid).toBeGreaterThan(0);
    expect(event.dur).toBe(500_000);
    expect(event.ts).toBe((Date.parse(T1) - 500) * 1000);
    expect(event.args).toEqual({
      traceId: "trace-1",
      action: "GET /api/diff",
      worktreePath: "/tmp/wt",
      fileCount: 4,
    });
  });

  it("places entries sharing a traceId on the same tid, and different traceIds on different tids", () => {
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
        traceId: "trace-A",
      }),
      logLine({
        timestamp: T2,
        level: "info",
        module: "git",
        message: "git.complete",
        durationMs: 5,
        traceId: "trace-B",
      }),
    ]);

    const duration = trace.traceEvents.filter((e) => e.ph === "X");
    expect(duration).toHaveLength(3);

    const tidByMessage = new Map<string, number[]>();
    for (const e of duration) {
      const key = `${e.name}@${e.cat}`;
      const list = tidByMessage.get(key) ?? [];
      list.push(e.tid);
      tidByMessage.set(key, list);
    }

    const traceAEvents = duration.filter(
      (e) => (e.args as { traceId: string }).traceId === "trace-A",
    );
    const traceBEvents = duration.filter(
      (e) => (e.args as { traceId: string }).traceId === "trace-B",
    );

    expect(new Set(traceAEvents.map((e) => e.tid)).size).toBe(1);
    expect(new Set(traceBEvents.map((e) => e.tid)).size).toBe(1);
    expect(traceAEvents[0]!.tid).not.toBe(traceBEvents[0]!.tid);
  });

  it("emits a thread_name metadata event labeled by action and short trace id", () => {
    const trace = buildTrace([
      logLine({
        timestamp: T1,
        level: "info",
        module: "git",
        message: "git.complete",
        durationMs: 10,
        traceId: "abcdef1234567890",
        action: "POST /api/sessions",
      }),
    ]);

    const threadName = trace.traceEvents.find(
      (e) => e.ph === "M" && e.name === "thread_name",
    );
    expect(threadName).toBeDefined();
    expect(threadName?.args).toEqual({ name: "POST /api/sessions (abcdef12)" });
  });

  it("routes entries without traceId to a shared 'background' track at tid 0", () => {
    const trace = buildTrace([
      logLine({
        timestamp: T1,
        level: "info",
        module: "init-script",
        message: "init-script.complete",
        durationMs: 200,
      }),
      logLine({
        timestamp: T2,
        level: "info",
        module: "tailscale",
        message: "tailscale.complete",
        durationMs: 50,
      }),
    ]);

    const duration = trace.traceEvents.filter((e) => e.ph === "X");
    expect(duration.every((e) => e.tid === 0)).toBe(true);

    const backgroundLabel = trace.traceEvents.find(
      (e) => e.ph === "M" && e.name === "thread_name" && e.tid === 0,
    );
    expect(backgroundLabel?.args).toEqual({ name: "background" });
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
