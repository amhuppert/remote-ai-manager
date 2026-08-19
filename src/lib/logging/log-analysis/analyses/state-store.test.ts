import { describe, expect, it } from "vitest";
import { analyzeStateStore } from "./state-store";
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
    durationMs: 10,
    raw: { accessor: "getSession", totalMs: 10 },
    ...overrides,
  };
}

describe("analyzeStateStore", () => {
  it("reports slow accessors by p95", () => {
    const analysis = analyzeStateStore(
      [
        record({
          durationMs: 10,
          raw: { accessor: "getSession", totalMs: 10 },
        }),
        record({
          durationMs: 60,
          raw: { accessor: "getSession", totalMs: 60 },
        }),
        record({
          durationMs: 70,
          raw: { accessor: "getSession", totalMs: 70 },
        }),
      ],
      { slowMs: 500, hotspotMs: 1000, top: 10 },
    );

    expect(analysis.slowAccessors[0]).toMatchObject({
      accessor: "getSession",
      count: 3,
      p95Ms: 70,
    });
    expect(analysis.findings[0]).toMatchObject({
      category: "state-store",
      severity: "high",
    });
  });

  it("carries the state-read floor and labels accessor statistics as a tail sample", () => {
    const analysis = analyzeStateStore(
      [
        record({
          durationMs: 60,
          raw: { accessor: "getSession", totalMs: 60 },
        }),
        record({
          durationMs: 65,
          raw: { accessor: "getSession", totalMs: 65 },
        }),
        record({
          durationMs: 70,
          raw: { accessor: "getSession", totalMs: 70 },
        }),
      ],
      { slowMs: 500, hotspotMs: 1000, top: 10 },
    );

    expect(analysis.stateReadFloorMs).toBe(5);
    const accessorFinding = analysis.findings.find((finding) =>
      finding.id.startsWith("state-store-accessor-high:"),
    );
    expect(accessorFinding?.explanation).toContain("tail");
    expect(accessorFinding?.explanation).toContain("5 ms");
  });

  it("groups write queue wait and hold timings by label", () => {
    const analysis = analyzeStateStore(
      [
        record({
          message: "state-store.write_queue.timing",
          durationMs: undefined,
          raw: { label: "mutateSession", waitMs: 25, holdMs: 10 },
        }),
        record({
          message: "state-store.write_queue.timing",
          durationMs: undefined,
          raw: { label: "mutateSession", waitMs: 125, holdMs: 20 },
        }),
      ],
      { slowMs: 500, hotspotMs: 1000, top: 10 },
    );

    expect(analysis.writeQueue[0]).toMatchObject({
      label: "mutateSession",
      p95WaitMs: 125,
      p95HoldMs: 20,
      maxWaitMs: 125,
      maxHoldMs: 20,
    });
  });

  it("surfaces write_queue.hold_budget_exceeded events as ranked findings with label evidence", () => {
    const analysis = analyzeStateStore(
      [
        record({
          level: "error",
          module: "state-store.write-queue",
          message: "state-store.write_queue.hold_budget_exceeded",
          durationMs: undefined,
          raw: { label: "createSession", holdMs: 14200, budgetMs: 500 },
        }),
        record({
          level: "error",
          module: "state-store.write-queue",
          message: "state-store.write_queue.hold_budget_exceeded",
          durationMs: undefined,
          raw: { label: "createSession", holdMs: 9000, budgetMs: 500 },
        }),
      ],
      { slowMs: 500, hotspotMs: 1000, top: 10 },
    );

    const finding = analysis.findings.find((f) => f.id.includes("hold-budget"));
    expect(finding).toBeDefined();
    expect(finding).toMatchObject({
      category: "state-store",
      severity: "high",
    });
    // Label + worst hold + budget + count are all evidence.
    expect(finding?.evidence).toEqual(
      expect.arrayContaining([
        { label: "queueLabel", value: "createSession" },
        { label: "maxHoldMs", value: 14200, unit: "ms" },
        { label: "budgetMs", value: 500, unit: "ms" },
        { label: "count", value: 2, unit: "count" },
      ]),
    );
  });

  it("computes facade-vs-repo gaps within traces", () => {
    const analysis = analyzeStateStore(
      [
        record({
          traceId: "trace-1",
          message: "state.read.timing",
          durationMs: 100,
          raw: { accessor: "getSession", totalMs: 100 },
        }),
        record({
          traceId: "trace-1",
          message: "state-store.projects.findByRootPath.timing",
          durationMs: 30,
          raw: { rootPath: "/repo" },
        }),
        record({
          traceId: "trace-1",
          message: "state-store.sessions.findByName.timing",
          durationMs: 20,
          raw: { sessionName: "session" },
        }),
      ],
      { slowMs: 500, hotspotMs: 1000, top: 10 },
    );

    expect(analysis.facadeRepoGaps[0]).toMatchObject({
      traceId: "trace-1",
      accessor: "getSession",
      facadeMs: 100,
      innerRepoMs: 50,
      gapMs: 50,
    });
  });
});
