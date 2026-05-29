import { describe, expect, it } from "vitest";
import { runLogAnalysisCli, type LogAnalysisCliRuntime } from "./cli";

interface RuntimeOptions {
  stats?: Record<string, { size: number; mtimeMs: number }>;
  nowIso?: string;
}

function runtime(
  files: Record<string, string>,
  options: RuntimeOptions = {},
): LogAnalysisCliRuntime & {
  stdoutText(): string;
  stderrText(): string;
} {
  let stdout = "";
  let stderr = "";
  return {
    env: {},
    cwd: () => "/repo",
    stdout: { write: (chunk: string) => void (stdout += chunk) },
    stderr: { write: (chunk: string) => void (stderr += chunk) },
    readFile: async (filePath) => {
      const content = files[filePath];
      if (content === undefined) throw new Error(`missing ${filePath}`);
      return content;
    },
    writeFile: async () => {},
    stat: async (filePath) => {
      const s = options.stats?.[filePath];
      if (!s) throw new Error(`no stat for ${filePath}`);
      return s;
    },
    ...(options.nowIso !== undefined
      ? { now: () => options.nowIso as string }
      : {}),
    resolveDefaultServerLogPath: async () => ({
      path: "/default.log",
      paths: ["/default.log"],
      checkedPaths: ["/default.log"],
    }),
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

const logLine = JSON.stringify({
  timestamp: "2026-05-21T12:00:00.000Z",
  level: "info",
  module: "tracing",
  message: "request.complete",
  traceId: "trace-1",
  durationMs: 600,
  method: "GET",
  path: "/api/test",
  status: 200,
});

describe("runLogAnalysisCli", () => {
  it("report reads explicit --in", async () => {
    const rt = runtime({ "/explicit.log": logLine });
    const exitCode = await runLogAnalysisCli(
      ["report", "--in", "/explicit.log", "--format", "json"],
      rt,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(rt.stdoutText())).toMatchObject({
      command: "report",
      summary: { recordsAnalyzed: 1 },
    });
  });

  it("report uses the injected default log resolver", async () => {
    const rt = runtime({ "/default.log": logLine });
    const exitCode = await runLogAnalysisCli(
      ["report", "--format", "json"],
      rt,
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(rt.stdoutText())).toMatchObject({
      input: { serverLogPath: "/default.log" },
    });
  });

  it("trace returns code 3 when the trace does not exist", async () => {
    const rt = runtime({ "/explicit.log": logLine });
    const exitCode = await runLogAnalysisCli(
      ["trace", "missing-trace", "--in", "/explicit.log"],
      rt,
    );

    expect(exitCode).toBe(3);
    expect(rt.stderrText()).toContain("trace not found");
  });

  it("compare requires --before and --after", async () => {
    const rt = runtime({});
    const exitCode = await runLogAnalysisCli(["compare"], rt);

    expect(exitCode).toBe(2);
    expect(rt.stderrText()).toContain("--before and --after are required");
  });

  it("rejects invalid dates", async () => {
    const rt = runtime({ "/explicit.log": logLine });
    const exitCode = await runLogAnalysisCli(
      ["report", "--in", "/explicit.log", "--since", "not-a-date"],
      rt,
    );

    expect(exitCode).toBe(2);
    expect(rt.stderrText()).toContain("invalid --since");
  });

  describe("input banner", () => {
    it("announces explicit --in path with size, mtime, and age on stderr", async () => {
      const nowIso = "2026-05-22T12:00:00.000Z";
      const mtimeMs = Date.parse("2026-05-22T11:53:00.000Z");
      const rt = runtime(
        { "/explicit.log": logLine },
        {
          stats: { "/explicit.log": { size: 2048, mtimeMs } },
          nowIso,
        },
      );

      const exitCode = await runLogAnalysisCli(
        ["report", "--in", "/explicit.log", "--format", "json"],
        rt,
      );

      expect(exitCode).toBe(0);
      const stderr = rt.stderrText();
      expect(stderr).toContain("[logs:analyze] reading /explicit.log");
      expect(stderr).toContain("resolved=explicit");
      expect(stderr).toContain("size=2.0KB");
      expect(stderr).toContain("mtime=2026-05-22T11:53:00.000Z");
      expect(stderr).toContain("age=7m");
    });

    it("announces default-resolved path and labels resolution as default", async () => {
      const nowIso = "2026-05-22T12:00:00.000Z";
      const mtimeMs = Date.parse("2026-05-20T12:00:00.000Z");
      const rt = runtime(
        { "/default.log": logLine },
        {
          stats: { "/default.log": { size: 16_777_216, mtimeMs } },
          nowIso,
        },
      );

      const exitCode = await runLogAnalysisCli(
        ["report", "--format", "json"],
        rt,
      );

      expect(exitCode).toBe(0);
      expect(rt.stderrText()).toContain("[logs:analyze] reading /default.log");
      expect(rt.stderrText()).toContain("resolved=default");
      expect(rt.stderrText()).toContain("size=16.0MB");
      expect(rt.stderrText()).toContain("age=2d");
    });

    it("never writes the banner to stdout (keeps JSON output clean)", async () => {
      const rt = runtime(
        { "/explicit.log": logLine },
        {
          stats: {
            "/explicit.log": {
              size: 100,
              mtimeMs: Date.parse("2026-05-22T12:00:00.000Z"),
            },
          },
          nowIso: "2026-05-22T12:00:00.000Z",
        },
      );

      const exitCode = await runLogAnalysisCli(
        ["report", "--in", "/explicit.log", "--format", "json"],
        rt,
      );

      expect(exitCode).toBe(0);
      expect(rt.stdoutText()).not.toContain("[logs:analyze]");
      expect(() => JSON.parse(rt.stdoutText())).not.toThrow();
    });

    it("falls back to a stat-unavailable banner when stat throws", async () => {
      const rt = runtime(
        { "/explicit.log": logLine },
        { stats: {}, nowIso: "2026-05-22T12:00:00.000Z" },
      );

      const exitCode = await runLogAnalysisCli(
        ["report", "--in", "/explicit.log", "--format", "json"],
        rt,
      );

      expect(exitCode).toBe(0);
      expect(rt.stderrText()).toContain("stat unavailable");
      expect(rt.stderrText()).toContain("/explicit.log");
    });

    it("announces both files for compare", async () => {
      const nowIso = "2026-05-22T12:00:00.000Z";
      const rt = runtime(
        { "/before.log": logLine, "/after.log": logLine },
        {
          stats: {
            "/before.log": {
              size: 512,
              mtimeMs: Date.parse("2026-05-22T11:30:00.000Z"),
            },
            "/after.log": {
              size: 1024,
              mtimeMs: Date.parse("2026-05-22T11:59:00.000Z"),
            },
          },
          nowIso,
        },
      );

      const exitCode = await runLogAnalysisCli(
        [
          "compare",
          "--before",
          "/before.log",
          "--after",
          "/after.log",
          "--format",
          "json",
        ],
        rt,
      );

      expect(exitCode).toBe(0);
      expect(rt.stderrText()).toContain("/before.log");
      expect(rt.stderrText()).toContain("/after.log");
      expect(rt.stderrText()).toContain("age=30m");
      expect(rt.stderrText()).toContain("age=1m");
    });
  });

  describe("multi-file default resolution", () => {
    const traceA = JSON.stringify({
      timestamp: "2026-05-21T12:00:00.000Z",
      level: "info",
      module: "tracing",
      message: "request.complete",
      traceId: "trace-multi",
      durationMs: 600,
      method: "GET",
      path: "/api/test",
      status: 200,
    });

    const traceAScoped = JSON.stringify({
      timestamp: "2026-05-21T12:00:00.300Z",
      level: "info",
      module: "voice",
      message: "voice.transcribe.upstream.complete",
      traceId: "trace-multi",
      durationMs: 350,
      ok: true,
      status: 200,
    });

    it("reads scoped session log alongside global log when resolver returns multiple paths", async () => {
      const rt: LogAnalysisCliRuntime & {
        stdoutText(): string;
        stderrText(): string;
      } = {
        ...runtime({
          "/global.log": traceA,
          "/sessions/proj__sess/session.log": traceAScoped,
        }),
        resolveDefaultServerLogPath: async () => ({
          path: "/global.log",
          paths: ["/global.log", "/sessions/proj__sess/session.log"],
          checkedPaths: ["/global.log", "/sessions/proj__sess/session.log"],
        }),
      };

      const exitCode = await runLogAnalysisCli(
        ["trace", "trace-multi", "--format", "json"],
        rt,
      );

      expect(exitCode).toBe(0);
      const report = JSON.parse(rt.stdoutText()) as {
        request: { message: string } | null;
        timeline: { message: string; module: string }[];
      };
      expect(report.request?.message).toBe("request.complete");
      const timelineMessages = report.timeline.map((row) => row.message);
      expect(timelineMessages).toContain("voice.transcribe.upstream.complete");
    });
  });
});
