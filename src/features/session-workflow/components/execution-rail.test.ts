import { describe, expect, it } from "vitest";
import type {
  GraphWorkflowAbandonment,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import {
  formatBoundInputsLine,
  formatExecutionRailMeta,
  partitionExecutionRail,
  resolveLaunchRevision,
  type ExecutionRailCandidate,
} from "./execution-rail";

const resumableHalt: GraphWorkflowHaltReason = {
  type: "agent_turn_failed",
  contextId: "context-plan",
  engine: "claude",
  cause: "sdk_error",
  message: "SDK stream ended unexpectedly",
};

const nonResumableHalt: GraphWorkflowHaltReason = {
  type: "recovery_error",
  message: "Recovery failed",
};

const abandonment: GraphWorkflowAbandonment = {
  abandonedAt: "2026-08-20T10:00:00.000Z",
  reason: "Operator abandoned the run.",
  actor: { kind: "human" },
};

function candidate(
  overrides: Partial<ExecutionRailCandidate> = {},
): ExecutionRailCandidate {
  return {
    executionId: "exec-lease",
    status: "running",
    haltReason: null,
    abandonment: null,
    startedAt: "2026-08-14T14:00:00.000Z",
    ...overrides,
  };
}

describe("partitionExecutionRail — tenure decides the section", () => {
  it.each(["pending", "running", "paused"] as const)(
    "keeps a %s run under Current",
    (status) => {
      const lease = candidate({ status });
      const rail = partitionExecutionRail(lease, []);
      expect(rail.current).toBe(lease);
      expect(rail.history).toEqual([]);
    },
  );

  it("keeps a resumably halted run that still holds its lease under Current", () => {
    const lease = candidate({ status: "halted", haltReason: resumableHalt });
    expect(partitionExecutionRail(lease, []).current).toBe(lease);
  });

  it("moves a non-resumable halt to History", () => {
    const lease = candidate({ status: "halted", haltReason: nonResumableHalt });
    const rail = partitionExecutionRail(lease, []);
    expect(rail.current).toBeNull();
    expect(rail.history).toEqual([lease]);
  });

  it("moves an abandoned resumable halt to History", () => {
    const lease = candidate({
      status: "halted",
      haltReason: resumableHalt,
      abandonment,
    });
    const rail = partitionExecutionRail(lease, []);
    expect(rail.current).toBeNull();
    expect(rail.history).toEqual([lease]);
  });

  it.each(["completed", "aborted"] as const)(
    "moves a %s run to History",
    (status) => {
      const lease = candidate({ status });
      const rail = partitionExecutionRail(lease, []);
      expect(rail.current).toBeNull();
      expect(rail.history.map((row) => row.executionId)).toEqual([
        "exec-lease",
      ]);
    },
  );

  it("orders History newest first and never lists the Current run twice", () => {
    const lease = candidate({ executionId: "exec-live" });
    const rail = partitionExecutionRail(lease, [
      candidate({
        executionId: "exec-older",
        status: "aborted",
        startedAt: "2026-08-12T16:40:00.000Z",
      }),
      candidate({
        executionId: "exec-live",
        status: "running",
        startedAt: "2026-08-14T14:00:00.000Z",
      }),
      candidate({
        executionId: "exec-newer",
        status: "completed",
        startedAt: "2026-08-14T09:12:00.000Z",
      }),
    ]);
    expect(rail.current?.executionId).toBe("exec-live");
    expect(rail.history.map((row) => row.executionId)).toEqual([
      "exec-newer",
      "exec-older",
    ]);
  });

  it("keeps a demoted lease candidate in History exactly once and in date order", () => {
    const lease = candidate({
      executionId: "exec-done",
      status: "completed",
      startedAt: "2026-08-13T10:00:00.000Z",
    });
    const rail = partitionExecutionRail(lease, [
      candidate({
        executionId: "exec-done",
        status: "completed",
        startedAt: "2026-08-13T10:00:00.000Z",
      }),
      candidate({
        executionId: "exec-old",
        status: "completed",
        startedAt: "2026-08-11T10:00:00.000Z",
      }),
      candidate({
        executionId: "exec-new",
        status: "aborted",
        startedAt: "2026-08-14T10:00:00.000Z",
      }),
    ]);
    expect(rail.current).toBeNull();
    expect(rail.history.map((row) => row.executionId)).toEqual([
      "exec-new",
      "exec-done",
      "exec-old",
    ]);
    expect(rail.history[1]).toBe(lease);
  });

  it("renders History alone when no run holds the lease", () => {
    const rail = partitionExecutionRail(null, [
      candidate({ executionId: "exec-a", status: "completed" }),
    ]);
    expect(rail.current).toBeNull();
    expect(rail.history.map((row) => row.executionId)).toEqual(["exec-a"]);
  });
});

describe("resolveLaunchRevision", () => {
  it("reads the revision off a template origin", () => {
    expect(
      resolveLaunchRevision({
        origin: {
          kind: "template",
          definitionId: "release-flow",
          definitionRevision: 4,
          tier: "project",
        },
        summaryDefinitionId: "release-flow",
        summaryDefinitionRevision: 4,
      }),
    ).toBe(4);
  });

  it("reports no revision for a definition-less origin", () => {
    expect(
      resolveLaunchRevision({
        origin: { kind: "one_off", planName: "Repair flaky tests" },
        summaryDefinitionId: "one-off:exec-1",
        summaryDefinitionRevision: 1,
      }),
    ).toBeNull();
  });

  it("refuses the compatibility filler a summary carries for a definition-less run", () => {
    expect(
      resolveLaunchRevision({
        origin: null,
        summaryDefinitionId: "one-off:exec-1",
        summaryDefinitionRevision: 1,
      }),
    ).toBeNull();
    expect(
      resolveLaunchRevision({
        origin: null,
        summaryDefinitionId: "spec-delivery:exec-2",
        summaryDefinitionRevision: 1,
      }),
    ).toBeNull();
  });

  it("falls back to the summary revision for a template run whose record is not loaded", () => {
    expect(
      resolveLaunchRevision({
        origin: null,
        summaryDefinitionId: "release-flow",
        summaryDefinitionRevision: 3,
      }),
    ).toBe(3);
  });
});

describe("formatExecutionRailMeta", () => {
  it("names the launch revision and context count for the Current run", () => {
    expect(
      formatExecutionRailMeta({
        tenure: "current",
        executionId: "exec_7f3a",
        launchRevision: 4,
        originLabel: "Template",
        contextCount: 6,
        launchedAtLabel: "Aug 14, 9:12",
      }),
    ).toBe("exec_7f3a · launched from r4 · 6 contexts");
  });

  it("names the origin instead when a definition-less run has no revision", () => {
    expect(
      formatExecutionRailMeta({
        tenure: "current",
        executionId: "exec_7f3a",
        launchRevision: null,
        originLabel: "One-off",
        contextCount: 1,
        launchedAtLabel: null,
      }),
    ).toBe("exec_7f3a · One-off · 1 context");
  });

  it("states the snapshot revision and launch time for a History row", () => {
    expect(
      formatExecutionRailMeta({
        tenure: "history",
        executionId: "exec_5c10",
        launchRevision: 3,
        originLabel: "Template",
        contextCount: 6,
        launchedAtLabel: "Aug 14, 9:12",
      }),
    ).toBe("exec_5c10 · r3 snapshot · Aug 14, 9:12");
  });

  it("drops segments it has no fact for", () => {
    expect(
      formatExecutionRailMeta({
        tenure: "history",
        executionId: "exec_5c10",
        launchRevision: null,
        originLabel: "One-off",
        contextCount: null,
        launchedAtLabel: null,
      }),
    ).toBe("exec_5c10 · One-off");
  });
});

describe("formatBoundInputsLine", () => {
  it("joins the bound launch inputs the run was started with", () => {
    expect(
      formatBoundInputsLine({ target_branch: "main", rollout: "canary" }),
    ).toBe("inputs: target_branch=main · rollout=canary");
  });

  it("has no line when the run bound no inputs", () => {
    expect(formatBoundInputsLine({})).toBeNull();
  });
});
