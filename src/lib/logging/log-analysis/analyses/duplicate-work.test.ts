import { describe, expect, it } from "vitest";
import { analyzeDuplicateWork } from "./duplicate-work";
import type { ParsedServerLogRecord } from "../types";

function record(
  overrides: Partial<ParsedServerLogRecord>,
): ParsedServerLogRecord {
  return {
    lineNumber: 1,
    timestamp: "2026-05-21T12:00:00.000Z",
    timestampMs: Date.parse("2026-05-21T12:00:00.000Z"),
    level: "info",
    module: "state-store",
    message: "state.read.timing",
    traceId: "trace-1",
    projectName: "project",
    sessionName: "session",
    conversationId: "conversation",
    durationMs: 100,
    raw: { accessor: "getSession" },
    ...overrides,
  };
}

describe("analyzeDuplicateWork", () => {
  it("detects repeated state reads in a trace", () => {
    const analysis = analyzeDuplicateWork(
      [
        record({ lineNumber: 1 }),
        record({ lineNumber: 2 }),
        record({ lineNumber: 3 }),
      ],
      { slowMs: 500, hotspotMs: 1000, top: 10 },
    );

    expect(analysis.duplicates[0]).toMatchObject({
      signature: "state.read:getSession:project:session:conversation",
      traceId: "trace-1",
      count: 3,
      totalMs: 300,
      maxMs: 100,
    });
  });

  it("uses specialized signatures for transcript, diff, git, and exec events", () => {
    const analysis = analyzeDuplicateWork(
      [
        record({
          module: "transcript",
          message: "transcript.read.complete",
          raw: {},
        }),
        record({
          module: "transcript",
          message: "transcript.read.complete",
          raw: {},
        }),
        record({
          module: "transcript",
          message: "transcript.read.complete",
          raw: {},
        }),
        record({
          module: "diff",
          message: "diff.compute.complete",
          raw: { worktreePath: "/tmp/wt" },
        }),
        record({
          module: "diff",
          message: "diff.compute.complete",
          raw: { worktreePath: "/tmp/wt" },
        }),
        record({
          module: "diff",
          message: "diff.compute.complete",
          raw: { worktreePath: "/tmp/wt" },
        }),
        record({
          module: "git-client",
          message: "git.complete",
          raw: { cwd: "/repo", argsPreview: "status --short" },
        }),
        record({
          module: "git-client",
          message: "git.complete",
          raw: { cwd: "/repo", argsPreview: "status --short" },
        }),
        record({
          module: "git-client",
          message: "git.complete",
          raw: { cwd: "/repo", argsPreview: "status --short" },
        }),
      ],
      { slowMs: 500, hotspotMs: 1000, top: 10 },
    );

    expect(
      analysis.duplicates.map((duplicate) => duplicate.signature),
    ).toContain("transcript.read:conversation");
    expect(
      analysis.duplicates.map((duplicate) => duplicate.signature),
    ).toContain("diff.compute:/tmp/wt");
    expect(
      analysis.duplicates.map((duplicate) => duplicate.signature),
    ).toContain("git:/repo:status --short");
  });

  it("creates duplicate-work findings according to thresholds", () => {
    const analysis = analyzeDuplicateWork(
      [
        record({ lineNumber: 1, durationMs: 150 }),
        record({ lineNumber: 2, durationMs: 150 }),
        record({ lineNumber: 3, durationMs: 150 }),
        record({ lineNumber: 4, durationMs: 150 }),
        record({ lineNumber: 5, durationMs: 150 }),
      ],
      { slowMs: 500, hotspotMs: 1000, top: 10 },
    );

    expect(analysis.findings[0]).toMatchObject({
      category: "duplicate-work",
      severity: "high",
    });
  });
});
