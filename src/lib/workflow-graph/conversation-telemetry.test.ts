import { describe, expect, it } from "vitest";
import { summarizeTranscriptTelemetry } from "./conversation-telemetry";

function resultLine(
  sessionId: string,
  totalCostUsd: number,
  numTurns: number,
): string {
  return JSON.stringify({
    id: `entry-${sessionId}-${totalCostUsd}`,
    role: "system",
    raw: {
      type: "result",
      session_id: sessionId,
      total_cost_usd: totalCostUsd,
      num_turns: numTurns,
    },
  });
}

function codexResultLine(threadRef: string, cumulativeCostUsd: number): string {
  return JSON.stringify({
    timestamp: "2026-08-04T18:14:22.991Z",
    type: "result",
    raw: {
      backend: "codex",
      backendRef: { backend: "codex", ref: threadRef },
      durationMs: 1000,
      numTurns: 1,
      contextTokens: 1_000_000,
      contextWindowMax: null,
      costUsd: cumulativeCostUsd,
      aborted: false,
      error: null,
    },
  });
}

function assistantReadLine(...filePaths: string[]): string {
  return JSON.stringify({
    id: `entry-read-${filePaths.join(",")}`,
    role: "assistant",
    content: filePaths.map((filePath, i) => ({
      type: "tool_use",
      id: `tu-${i}`,
      name: "Read",
      input: { file_path: filePath },
    })),
  });
}

describe("summarizeTranscriptTelemetry", () => {
  it("takes the final cumulative cost per session lineage, not the sum of results", () => {
    // A single lineage whose SDK results report cumulative cost 11.78 → 23.50.
    // Summing results (the conversations-table double-count bug) would give
    // 35.28; the true conversation cost is the lineage's final cumulative.
    const summary = summarizeTranscriptTelemetry(
      [
        resultLine("lineage-a", 11.78, 82),
        resultLine("lineage-a", 14.83, 14),
        resultLine("lineage-a", 23.5, 41),
      ].join("\n"),
    );

    expect(summary.costUsd).toBeCloseTo(23.5, 5);
    expect(summary.lineageCount).toBe(1);
    expect(summary.apiTurns).toBe(82 + 14 + 41);
  });

  it("sums final cumulatives across lineages when the session was restarted", () => {
    const summary = summarizeTranscriptTelemetry(
      [
        resultLine("lineage-a", 42.37, 112),
        resultLine("lineage-a", 64.85, 19),
        resultLine("lineage-b", 43.73, 116),
        resultLine("lineage-b", 50.79, 13),
      ].join("\n"),
    );

    expect(summary.costUsd).toBeCloseTo(115.64, 5);
    expect(summary.lineageCount).toBe(2);
  });

  it("treats a same-session-id cumulative drop as a lineage restart", () => {
    // A restarted SDK subprocess can resume the SAME session id with its
    // cumulative reset (observed live: 07afd581 reports one session id for
    // 42.37→64.85 then 43.73→50.79). The drop is the lineage boundary; keying
    // by session id alone would keep only the last value (50.79).
    const summary = summarizeTranscriptTelemetry(
      [
        resultLine("same-id", 42.37, 112),
        resultLine("same-id", 64.85, 19),
        resultLine("same-id", 43.73, 116),
        resultLine("same-id", 50.79, 13),
      ].join("\n"),
    );

    expect(summary.costUsd).toBeCloseTo(115.64, 5);
    expect(summary.lineageCount).toBe(2);
  });

  it("takes the final cumulative per Codex thread, not the sum of snapshots", () => {
    // Audit 1beec403: regenerate-api's DB row ($7.26) was exactly the sum of
    // its two thread-cumulative snapshots (3.186902 + 4.072798); the true
    // thread cost is the final cumulative.
    const summary = summarizeTranscriptTelemetry(
      [
        codexResultLine("thread-regen", 3.186902),
        codexResultLine("thread-regen", 4.072798),
      ].join("\n"),
    );

    expect(summary.costUsd).toBeCloseTo(4.072798, 6);
    expect(summary.lineageCount).toBe(1);
    expect(summary.apiTurns).toBe(2);
  });

  it("sums final cumulatives across distinct Codex threads", () => {
    const summary = summarizeTranscriptTelemetry(
      [
        codexResultLine("thread-a", 1.5),
        codexResultLine("thread-a", 2.25),
        codexResultLine("thread-b", 0.75),
      ].join("\n"),
    );

    expect(summary.costUsd).toBeCloseTo(3.0, 6);
    expect(summary.lineageCount).toBe(2);
  });

  it("tallies Read tool calls into unique, total, repeat, and top re-read stats", () => {
    const summary = summarizeTranscriptTelemetry(
      [
        assistantReadLine("/repo/a.ts", "/repo/b.ts"),
        assistantReadLine("/repo/a.ts"),
        assistantReadLine("/repo/a.ts", "/repo/c.ts"),
        assistantReadLine("/repo/b.ts"),
      ].join("\n"),
    );

    expect(summary.reads).toEqual({
      uniqueFiles: 3,
      totalReads: 6,
      repeatReads: 3,
    });
    expect(summary.topReReads).toEqual([
      { path: "/repo/a.ts", count: 3 },
      { path: "/repo/b.ts", count: 2 },
    ]);
  });

  it("tolerates garbage lines and reports null cost when no results exist", () => {
    const summary = summarizeTranscriptTelemetry(
      [
        "not json at all",
        '{"half": ',
        "",
        assistantReadLine("/repo/a.ts"),
      ].join("\n"),
    );

    expect(summary.costUsd).toBeNull();
    expect(summary.apiTurns).toBeNull();
    expect(summary.lineageCount).toBe(0);
    expect(summary.reads.totalReads).toBe(1);
  });
});
