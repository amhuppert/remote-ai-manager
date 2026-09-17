import { describe, expect, it } from "vitest";

import {
  createWorkflowDefinition,
  createWorkflowExecution,
} from "./test-fixtures";

import { isUpstreamVisibleToDownstream } from "./lane-readiness";
import { getEligibleContextIds } from "./lane-readiness";

describe("route and lane eligibility", () => {
  it("finds all currently eligible contexts for MVP scheduling", () => {
    const definition = createWorkflowDefinition();
    const baseExecution = createWorkflowExecution();
    const execution = createWorkflowExecution({
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...baseExecution.contextStates["context-plan"]!,
          status: "completed",
          completedTaskCount: 1,
        },
      },
    });

    expect(getEligibleContextIds(definition, execution)).toEqual([
      "context-implement",
    ]);
  });

  it("requires worktree-isolation upstream to be merged before unlocking downstream", () => {
    const definition = createWorkflowDefinition();
    const baseExecution = createWorkflowExecution();
    const execution = createWorkflowExecution({
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...baseExecution.contextStates["context-plan"]!,
          status: "completed",
          completedTaskCount: 1,
          isolation: "worktree",
          mergeStatus: "pending",
        },
      },
    });

    expect(getEligibleContextIds(definition, execution)).toEqual([]);
  });

  it("keeps a lane-placed downstream eligible when its upstream landed on a lane the join has not merged yet", () => {
    // Eligibility answers "has every upstream landed"; WHERE it landed relative
    // to this context's lane is the classifier's call (it answers wait-for-join,
    // which is what plans the merge). Filtering the context out here instead
    // would leave nobody to plan the join and strand it (R3.2).
    const definition = createWorkflowDefinition();
    const baseExecution = createWorkflowExecution();
    const timestamp = "2026-03-27T12:00:00.000Z";
    const makeLane = (laneId: string, includedContextIds: string[]) => ({
      laneId,
      kind: "worktree" as const,
      status: "active" as const,
      worktreePath: `/tmp/${laneId}`,
      branchName: `csm/${laneId}`,
      includedContextIds,
      lastCommittingContextId: null,
      commitSnapshots: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const execution = createWorkflowExecution({
      executionLanes: {
        "lane-up": makeLane("lane-up", ["context-plan"]),
        "lane-down": makeLane("lane-down", []),
      },
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...baseExecution.contextStates["context-plan"]!,
          status: "completed",
          completedTaskCount: 1,
          isolation: "worktree",
          laneId: "lane-up",
          mergeStatus: "merged-success",
        },
        "context-implement": {
          ...baseExecution.contextStates["context-implement"]!,
          laneId: "lane-down",
        },
      },
    });

    expect(getEligibleContextIds(definition, execution)).toEqual([
      "context-implement",
    ]);
  });

  it("holds a guarded target while its completed source's merge is unresolved (D4 R2.5)", () => {
    const base = createWorkflowDefinition();
    const definition = {
      ...base,
      executionContexts: base.executionContexts.map((context) =>
        context.id === "context-plan"
          ? {
              ...context,
              outputSchema: {
                type: "object",
                properties: { verdict: { type: "string" } },
                required: ["verdict"],
              },
            }
          : context,
      ),
      edges: base.edges.map((edge) =>
        edge.id === "edge-plan-implement"
          ? {
              ...edge,
              when: {
                schema: {
                  type: "object",
                  properties: { verdict: { const: "go" } },
                  required: ["verdict"],
                },
              },
            }
          : edge,
      ),
    };
    const baseExecution = createWorkflowExecution({
      workingDefinition: {
        ...createWorkflowExecution().workingDefinition,
        executionContexts: definition.executionContexts.map((context) => ({
          ...createWorkflowExecution().workingDefinition.executionContexts.find(
            (resolved) => resolved.id === context.id,
          )!,
          ...(context.outputSchema
            ? { outputSchema: context.outputSchema }
            : {}),
        })),
        edges: definition.edges,
      },
      contextOutputs: {
        "context-plan": {
          value: { verdict: "go" },
          capturedAt: "2026-08-04T10:00:00.000Z",
          iteration: 1,
          parse: { source: "native" },
        },
      },
    });
    const blocked = createWorkflowExecution({
      ...baseExecution,
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...baseExecution.contextStates["context-plan"]!,
          status: "completed",
          completedTaskCount: 1,
          isolation: "worktree",
          mergeStatus: "pending",
        },
      },
    });

    // The guard is TRUE — the branch was taken — but the source's work has not
    // landed, so the target must not be scheduled and must not be skipped.
    expect(getEligibleContextIds(blocked.workingDefinition, blocked)).toEqual(
      [],
    );

    const merged = createWorkflowExecution({
      ...blocked,
      executionLanes: {
        "lane-plan": {
          laneId: "lane-plan",
          kind: "worktree",
          status: "active",
          worktreePath: "/tmp/lane-plan",
          branchName: "csm/lane-plan",
          includedContextIds: ["context-plan"],
          lastCommittingContextId: "context-plan",
          commitSnapshots: [],
          createdAt: "2026-08-04T10:00:00.000Z",
          updatedAt: "2026-08-04T10:00:00.000Z",
        },
      },
      contextStates: {
        ...blocked.contextStates,
        "context-plan": {
          ...blocked.contextStates["context-plan"]!,
          laneId: "lane-plan",
          mergeStatus: "merged-success",
        },
      },
    });
    expect(getEligibleContextIds(merged.workingDefinition, merged)).toEqual([
      "context-implement",
    ]);
  });

  it("makes a lane-pinned downstream's upstream visible once a join merges the upstream lane into it", () => {
    const definition = createWorkflowDefinition();
    const baseExecution = createWorkflowExecution();
    const execution = createWorkflowExecution({
      ...baseExecution,
      executionLanes: {
        "lane-up": {
          laneId: "lane-up",
          kind: "worktree",
          status: "merged",
          worktreePath: "/tmp/up",
          branchName: "csm/test-up",
          includedContextIds: ["context-plan"],
          lastCommittingContextId: "context-plan",
          commitSnapshots: [],
          createdAt: "2026-03-27T12:00:00.000Z",
          updatedAt: "2026-03-27T12:00:00.000Z",
        },
        "lane-down": {
          laneId: "lane-down",
          kind: "worktree",
          status: "active",
          worktreePath: "/tmp/down",
          branchName: "csm/test-down",
          includedContextIds: ["context-plan"],
          lastCommittingContextId: null,
          commitSnapshots: [],
          createdAt: "2026-03-27T12:00:00.000Z",
          updatedAt: "2026-03-27T12:00:00.000Z",
        },
      },
      joins: {
        "join-up-down": {
          joinId: "join-up-down",
          kind: "context_merge",
          contextId: null,
          targetLaneId: "lane-down",
          sourceLaneIds: ["lane-up"],
          mergedSourceLaneIds: ["lane-up"],
          validationDebtSourceLaneIds: [],
          status: "succeeded",
          errorMessage: null,
          conflicts: null,
          conflictGuidance: null,
          createdAt: "2026-03-27T12:00:00.000Z",
          updatedAt: "2026-03-27T12:00:00.000Z",
          completedAt: "2026-03-27T12:00:00.000Z",
        },
      },
      contextStates: {
        ...baseExecution.contextStates,
        "context-plan": {
          ...baseExecution.contextStates["context-plan"]!,
          status: "completed",
          isolation: "worktree",
          laneId: "lane-up",
          mergeStatus: "merged-success",
          completedTaskCount: 1,
        },
        "context-implement": {
          ...baseExecution.contextStates["context-implement"]!,
          laneId: "lane-down",
        },
      },
    });

    expect(getEligibleContextIds(definition, execution)).toEqual([
      "context-implement",
    ]);
    // Eligibility alone no longer proves the routing is satisfied — visibility
    // is the classifier's call — so assert the predicate that decides it.
    expect(
      isUpstreamVisibleToDownstream(
        "context-plan",
        "context-implement",
        execution,
      ),
    ).toBe(true);
  });
});
