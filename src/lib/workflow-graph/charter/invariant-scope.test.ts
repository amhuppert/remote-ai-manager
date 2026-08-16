import { describe, expect, it } from "vitest";

import type { WorkflowCharter } from "@/lib/workflows/charter-schemas";
import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
} from "@/lib/workflow-graph/test-fixtures";
import {
  executionFor,
  workerJudgeDefinition,
} from "@/lib/workflow-graph/loop-test-fixtures";
import {
  resolveApplicableCharterInvariants,
  resolveLogicalAuthoredContextId,
  resolveScopedCharterForContext,
} from "./invariant-scope";

function charter(
  scopedContextId: string,
  unrelatedContextId: string,
): WorkflowCharter {
  return {
    mission: "Apply invariants only where the graph assigns them.",
    invariants: [
      { id: "global", statement: "Always applies." },
      {
        id: "scoped",
        statement: "Applies only to the selected logical context.",
        appliesTo: { contextIds: [scopedContextId] },
      },
      {
        id: "unrelated",
        statement: "Must not leak into a different logical context.",
        appliesTo: { contextIds: [unrelatedContextId] },
      },
    ],
    sourcesOfTruth: [
      {
        rank: 1,
        id: "design",
        label: "Design",
        type: "document",
        locator: "docs/design.md",
        description: "The governing design.",
        accessPolicy: "worktree-relative",
      },
    ],
  };
}

function applicableIds(
  execution: ReturnType<typeof createWorkflowExecution>,
  contextId: string,
): string[] {
  return resolveApplicableCharterInvariants({
    execution,
    contextId,
  }).invariants.map((invariant) => invariant.id);
}

describe("charter invariant scope resolution", () => {
  it("filters global and scoped invariants for an ordinary authored context", () => {
    const execution = createWorkflowExecution({
      charter: charter("context-implement", "context-verify"),
    });

    expect(
      resolveLogicalAuthoredContextId({
        execution,
        contextId: "context-implement",
      }),
    ).toBe("context-implement");
    expect(applicableIds(execution, "context-implement")).toEqual([
      "global",
      "scoped",
    ]);
    expect(
      resolveScopedCharterForContext({
        execution,
        contextId: "context-implement",
      }).invariants?.map((invariant) => invariant.id),
    ).toEqual(["global", "scoped"]);
  });

  it("resolves a loop pass to its authored body template context", () => {
    const execution = executionFor(workerJudgeDefinition());
    execution.charter = charter("worker", "judge");

    expect(
      execution.workingDefinition.loopGroups?.[0]?.template.contexts.map(
        (context) => context.id,
      ),
    ).toEqual(["worker", "judge"]);

    expect(
      resolveLogicalAuthoredContextId({
        execution,
        contextId: "refine__p1__worker",
      }),
    ).toBe("worker");
    expect(applicableIds(execution, "refine__p1__worker")).toEqual([
      "global",
      "scoped",
    ]);
  });

  it("inherits an expansion-generated context's scope from its invoker receipt", () => {
    const definition = createResolvedWorkflowDefinition();
    const generatedContextId = "context-implement-xa1b2c3d4-child";
    const invoker = definition.executionContexts.find(
      (context) => context.id === "context-implement",
    );
    if (!invoker) throw new Error("fixture must include the expansion invoker");

    const execution = createWorkflowExecution({
      charter: charter("context-implement", "context-verify"),
      workingDefinition: {
        ...definition,
        executionContexts: [
          ...definition.executionContexts,
          { ...invoker, id: generatedContextId },
        ],
      },
      expansionReceipts: {
        accepted: [
          {
            requestId: "add-child",
            payloadHash: "a".repeat(64),
            invokerContextId: "context-implement",
            initiatorConversationId: "conversation-1",
            rationale: "Split implementation work into a focused child.",
            addedContextIds: [generatedContextId],
            addedTaskIds: [],
            rejoinContextIds: [],
            liveRevision: 2,
            acceptedAt: "2026-08-15T00:00:00.000Z",
          },
        ],
        refusals: [],
      },
    });

    expect(
      resolveLogicalAuthoredContextId({
        execution,
        contextId: generatedContextId,
      }),
    ).toBe("context-implement");
    expect(applicableIds(execution, generatedContextId)).toEqual([
      "global",
      "scoped",
    ]);
  });
});
