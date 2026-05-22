import { describe, expect, it } from "vitest";
import { analyzeExternalCommands } from "./external-commands";
import type { ParsedServerLogRecord } from "../types";

function record(
  overrides: Partial<ParsedServerLogRecord>,
): ParsedServerLogRecord {
  return {
    lineNumber: 1,
    timestamp: "2026-05-21T12:00:00.000Z",
    timestampMs: Date.parse("2026-05-21T12:00:00.000Z"),
    level: "info",
    module: "exec",
    message: "exec.complete",
    traceId: "trace-1",
    durationMs: 100,
    raw: {
      command: "git",
      argsPreview: "status --short",
      cwd: "/repo",
      exitCode: 0,
      stderrBytes: 0,
    },
    ...overrides,
  };
}

describe("analyzeExternalCommands", () => {
  it("groups commands by command, argsPreview, and cwd", () => {
    const analysis = analyzeExternalCommands(
      [
        record({ durationMs: 100 }),
        record({ durationMs: 200 }),
        record({
          message: "git.complete",
          raw: {
            command: "git",
            argsPreview: "diff --stat",
            cwd: "/repo",
            exitCode: 0,
            stderrBytes: 0,
          },
          durationMs: 300,
        }),
      ],
      { slowMs: 500, hotspotMs: 1000, top: 10 },
    );

    expect(analysis.commands.map((command) => command.key)).toEqual([
      "git diff --stat cwd=/repo",
      "git status --short cwd=/repo",
    ]);
    expect(analysis.commands[1]).toMatchObject({
      count: 2,
      p95Ms: 200,
      maxMs: 200,
    });
  });

  it("creates a high finding for non-zero exits in slow request traces", () => {
    const analysis = analyzeExternalCommands(
      [
        record({
          module: "tracing",
          message: "request.complete",
          durationMs: 1200,
          raw: {},
        }),
        record({
          durationMs: 800,
          raw: {
            command: "git",
            argsPreview: "merge main",
            cwd: "/repo",
            exitCode: 1,
            stderrBytes: 120,
          },
        }),
      ],
      { slowMs: 500, hotspotMs: 1000, top: 10 },
    );

    expect(analysis.findings[0]).toMatchObject({
      category: "external-command",
      severity: "high",
    });
  });

  it("reports stderr bytes", () => {
    const analysis = analyzeExternalCommands(
      [
        record({
          raw: {
            command: "git",
            argsPreview: "status --short",
            cwd: "/repo",
            exitCode: 0,
            stderrBytes: 10,
          },
        }),
        record({
          raw: {
            command: "git",
            argsPreview: "status --short",
            cwd: "/repo",
            exitCode: 0,
            stderrBytes: 20,
          },
        }),
      ],
      { slowMs: 500, hotspotMs: 1000, top: 10 },
    );

    expect(analysis.commands[0]).toMatchObject({
      stderrBytes: 30,
      nonZeroExitCount: 0,
    });
  });
});
