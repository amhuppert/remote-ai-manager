import { describe, expect, it } from "vitest";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import {
  createVolatileValueNormalizer,
  diffContextStatuses,
  normalizeRecording,
  projectTypedEvent,
  type CompatibilityRecording,
} from "./projections";

function withContextStatus(
  execution: GraphWorkflowExecution,
  contextId: string,
  status: GraphWorkflowExecution["contextStates"][string]["status"],
): GraphWorkflowExecution {
  return {
    ...execution,
    contextStates: {
      ...execution.contextStates,
      [contextId]: { ...execution.contextStates[contextId]!, status },
    },
  };
}

describe("diffContextStatuses", () => {
  it("reports every context as newly observed when there is no previous snapshot", () => {
    const execution = createWorkflowExecution();

    expect(diffContextStatuses(null, execution)).toEqual([
      { contextId: "context-implement", from: null, to: "pending" },
      { contextId: "context-plan", from: null, to: "pending" },
      { contextId: "context-verify", from: null, to: "pending" },
    ]);
  });

  it("reports only the contexts whose status moved", () => {
    const previous = createWorkflowExecution();
    const next = withContextStatus(previous, "context-plan", "ready");

    expect(diffContextStatuses(previous, next)).toEqual([
      { contextId: "context-plan", from: "pending", to: "ready" },
    ]);
  });

  it("reports a context that appears mid-run as newly observed", () => {
    const previous = createWorkflowExecution();
    const next: GraphWorkflowExecution = {
      ...previous,
      contextStates: {
        ...previous.contextStates,
        "context-generated": {
          ...previous.contextStates["context-plan"]!,
          contextId: "context-generated",
          status: "ready",
        },
      },
    };

    expect(diffContextStatuses(previous, next)).toEqual([
      { contextId: "context-generated", from: null, to: "ready" },
    ]);
  });

  it("orders a multi-context commit by context id", () => {
    const previous = createWorkflowExecution();
    const next = withContextStatus(
      withContextStatus(previous, "context-verify", "ready"),
      "context-implement",
      "ready",
    );

    expect(diffContextStatuses(previous, next).map((t) => t.contextId)).toEqual(
      ["context-implement", "context-verify"],
    );
  });
});

describe("createVolatileValueNormalizer", () => {
  it("collapses timestamps and renames generated ids by first appearance", () => {
    const normalize = createVolatileValueNormalizer();

    expect(normalize("2026-03-27T12:00:00.000Z")).toBe("<timestamp>");
    expect(normalize("join-6f1b2f0e-5c2e-4a1b-9c3d-2f8a7b6c5d4e")).toBe(
      "join-<generated-1>",
    );
    expect(normalize("11111111-2222-3333-4444-555555555555")).toBe(
      "<generated-2>",
    );
    // The same id keeps the same token, so identity relationships survive.
    expect(normalize("6f1b2f0e-5c2e-4a1b-9c3d-2f8a7b6c5d4e")).toBe(
      "<generated-1>",
    );
  });

  it("leaves stable ids untouched", () => {
    const normalize = createVolatileValueNormalizer();

    expect(normalize("ctx-plan")).toBe("ctx-plan");
    expect(normalize("__session__")).toBe("__session__");
  });
});

describe("normalizeRecording", () => {
  it("keeps two runs that differ only in minted ids and stamps equal", () => {
    const runOne = normalizeRecording({
      scenario: "x",
      terminalStatus: "completed",
      haltReason: null,
      scheduling: [
        {
          decision: "join",
          joinKind: "final_publish",
          contextId: null,
          sourceLaneIds: ["lane-a"],
          targetLaneId: "__session__",
        },
      ],
      statusTransitions: [],
      events: [
        {
          kind: "graph-workflow-join-status",
          subject: "6f1b2f0e-5c2e-4a1b-9c3d-2f8a7b6c5d4e",
          detail: "final_publish:succeeded",
        },
      ],
    });
    const runTwo = normalizeRecording({
      scenario: "x",
      terminalStatus: "completed",
      haltReason: null,
      scheduling: [
        {
          decision: "join",
          joinKind: "final_publish",
          contextId: null,
          sourceLaneIds: ["lane-a"],
          targetLaneId: "__session__",
        },
      ],
      statusTransitions: [],
      events: [
        {
          kind: "graph-workflow-join-status",
          subject: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          detail: "final_publish:succeeded",
        },
      ],
    });

    expect(runTwo).toEqual(runOne);
  });

  it("still distinguishes runs that mint a different NUMBER of ids", () => {
    const base: Omit<CompatibilityRecording, "events"> = {
      scenario: "x",
      terminalStatus: "completed",
      haltReason: null,
      scheduling: [],
      statusTransitions: [],
    };
    const oneJoin = normalizeRecording({
      ...base,
      events: [
        {
          kind: "graph-workflow-join-status",
          subject: "6f1b2f0e-5c2e-4a1b-9c3d-2f8a7b6c5d4e",
          detail: "final_publish:succeeded",
        },
      ],
    });
    const twoJoins = normalizeRecording({
      ...base,
      events: [
        {
          kind: "graph-workflow-join-status",
          subject: "6f1b2f0e-5c2e-4a1b-9c3d-2f8a7b6c5d4e",
          detail: "final_publish:succeeded",
        },
        {
          kind: "graph-workflow-join-status",
          subject: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
          detail: "final_publish:succeeded",
        },
      ],
    });

    expect(twoJoins).not.toEqual(oneJoin);
  });
});

describe("projectTypedEvent", () => {
  it("keeps the fields that discriminate one context-status event from another", () => {
    const base = {
      projectName: "repo",
      sessionName: "session-1",
      executionId: "execution-1",
      remainingTaskCount: 0,
      iterationCount: 1,
    } as const;

    expect(
      projectTypedEvent({
        type: "graph-workflow-context-status",
        contextId: "ctx-a",
        status: "running",
        ...base,
      }),
    ).toEqual({
      kind: "graph-workflow-context-status",
      subject: "ctx-a",
      detail: "running",
    });
    expect(
      projectTypedEvent({
        type: "graph-workflow-context-status",
        contextId: "ctx-a",
        status: "completed",
        ...base,
      }),
    ).not.toEqual(
      projectTypedEvent({
        type: "graph-workflow-context-status",
        contextId: "ctx-a",
        status: "running",
        ...base,
      }),
    );
  });

  it("carries the join kind and status together so a join change is visible", () => {
    expect(
      projectTypedEvent({
        type: "graph-workflow-join-status",
        projectName: "repo",
        sessionName: "session-1",
        executionId: "execution-1",
        joinId: "join-1",
        kind: "context_merge",
        contextId: "ctx-converge",
        status: "succeeded",
        sourceLaneIds: ["lane-a"],
        mergedSourceLaneIds: ["lane-a"],
        targetLaneId: "lane-b",
        errorMessage: null,
        conflicts: null,
      }),
    ).toEqual({
      kind: "graph-workflow-join-status",
      subject: "join-1",
      detail: "context_merge:succeeded",
    });
  });
});
