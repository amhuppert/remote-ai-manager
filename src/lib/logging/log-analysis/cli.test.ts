import { describe, expect, it } from "vitest";
import { runLogAnalysisCli, type LogAnalysisCliRuntime } from "./cli";

function runtime(files: Record<string, string>): LogAnalysisCliRuntime & {
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
    resolveDefaultServerLogPath: async () => ({
      path: "/default.log",
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
});
