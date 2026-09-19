import { describe, expect, it } from "vitest";
import { buildAgentProfileSnapshot } from "@/lib/agent-profiles/composer";
import { computeContentHash } from "@/lib/agent-profiles/hashing";
import type { WorkflowLiveEditOperation } from "@/lib/workflows/edit-schemas";
import type { GraphWorkflowResolvedContext } from "./definition-schemas";
import { graphWorkflowAgentSessionStateSchema } from "./schemas";
import {
  applyLiveExecutionEdits,
  prepareLiveExecutionEdits,
  finalizePreparedEdits,
  type LiveEditDeps,
} from "./runtime-edits";
import {
  createWorkflowExecution,
  makeProfileSnapshot,
  makeSeededValidatorAssignment,
} from "./test-fixtures";
import { resetExecutionContext } from "./reset-context";

function fixture(started = true) {
  const execution = createWorkflowExecution({ status: "paused" });
  const context = execution.workingDefinition.executionContexts[0];
  if (!context) throw new Error("Missing fixture context");
  context.contextValidator = {
    enabled: true,
    assignments: [makeSeededValidatorAssignment({ id: "reviewer" })],
  };
  const lane = (role: "implementer" | "context_validator") =>
    graphWorkflowAgentSessionStateSchema.parse({
      lane: role,
      contextId: context.id,
      assignmentId: role === "context_validator" ? "reviewer" : undefined,
      backend: "claude",
      workflowConversationId: `conversation-${role}`,
      sessionRef: { backend: "claude", ref: `conversation-${role}` },
      metrics: {},
      lastUsedAt: "2026-09-18T00:00:00Z",
    });
  if (started) {
    execution.laneStates[context.id] = {
      implementer: lane("implementer"),
      "context_validator:reviewer": lane("context_validator"),
    };
  }
  const deps: LiveEditDeps = {
    createTaskId: () => "new-task",
    resolvedGlobalDefaults() {
      throw new Error("No defaults required");
    },
    validationCommandPreflight: () => ({
      commandCosts: {},
      concurrencyLimit: 8,
    }),
    snapshotFor: () => makeProfileSnapshot(),
    now: () => "2026-09-18T00:00:00Z",
  };
  return { execution, context, deps, lane };
}

function modelEdit(
  context: GraphWorkflowResolvedContext,
): WorkflowLiveEditOperation {
  return {
    type: "update-context",
    contextId: context.id,
    implementer: {
      ...context.implementer,
      agent: {
        backend: "claude",
        modelSelection: { modelId: "sonnet", parameters: { effort: "medium" } },
      },
    },
  };
}

const locked = {
  ok: false,
  issues: [{ code: "assignment-started" }],
};

describe("started workflow assignment freeze", () => {
  it.each(["ui", "cli", "plan-repair"] as const)(
    "refuses assignment changes from %s atomically",
    (source) => {
      const { execution, context, deps } = fixture();
      const before = structuredClone(execution);
      const result = applyLiveExecutionEdits(
        execution,
        { source, operations: [modelEdit(context)] },
        deps,
      );
      expect(result).toMatchObject({
        ok: false,
        code: "invalid_edit",
        issues: [
          {
            code: "assignment-started",
            contextId: context.id,
            operationIndex: 0,
          },
        ],
      });
      expect(execution).toEqual(before);
    },
  );

  it.each(["focus", "authority", "remove"] as const)(
    "refuses a started validator's %s edit",
    (field) => {
      const { execution, context, deps } = fixture();
      const assignment = context.contextValidator.assignments[0];
      if (!assignment) throw new Error("Missing reviewer");
      const updated = { ...assignment };
      if (field === "focus") updated.focus = "Review race conditions";
      if (field === "authority") {
        updated.authority =
          assignment.authority === "blocking" ? "advisory" : "blocking";
      }
      const result = applyLiveExecutionEdits(
        execution,
        {
          operations: [
            {
              type: "update-context",
              contextId: context.id,
              contextValidator: {
                enabled: field !== "remove",
                assignments: field === "remove" ? [] : [updated],
              },
            },
          ],
        },
        deps,
      );
      expect(result).toMatchObject(locked);
    },
  );

  it("permits assignment edits before the first conversation", () => {
    const { execution, context, deps } = fixture(false);
    const result = applyLiveExecutionEdits(
      execution,
      { operations: [modelEdit(context)] },
      deps,
    );
    expect(result).toMatchObject({ ok: true });
  });

  it("preserves frozen instructions when an unchanged assignment is restated", () => {
    const { execution, context, deps } = fixture();
    deps.snapshotFor = () =>
      makeProfileSnapshot({
        resolvedInstructionHash: `sha256:${"c".repeat(64)}`,
      });
    const result = applyLiveExecutionEdits(
      execution,
      {
        operations: [
          {
            type: "update-context",
            contextId: context.id,
            implementer: context.implementer,
          },
        ],
      },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.execution.workingDefinition.executionContexts[0]?.implementer
        .profileSnapshot,
    ).toEqual(context.implementer.profileSnapshot);
  });

  it.each(["implementer", "context_validator"] as const)(
    "refuses changing a started %s between profiles with empty instructions",
    (role) => {
      const { execution, context, deps } = fixture();
      const emptyProfile = (id: string) =>
        buildAgentProfileSnapshot({
          ...makeProfileSnapshot({ tier: "project", id }),
          instructions: "",
          sourceContentHash: computeContentHash(""),
        });
      const before =
        role === "implementer"
          ? context.implementer
          : context.contextValidator.assignments[0];
      if (!before) throw new Error("Missing assignment");
      before.profile = { tier: "project", id: "empty-before" };
      before.profileSnapshot = emptyProfile("empty-before");
      deps.snapshotFor = () => emptyProfile("empty-after");
      const after = {
        ...before,
        profile: { tier: "project" as const, id: "empty-after" },
      };
      const operation: WorkflowLiveEditOperation = {
        type: "update-context",
        contextId: context.id,
        ...(role === "implementer"
          ? { implementer: after }
          : {
              contextValidator: {
                ...context.contextValidator,
                assignments: context.contextValidator.assignments.map(
                  (assignment) => ({ ...assignment, profile: after.profile }),
                ),
              },
            }),
      };
      expect(
        applyLiveExecutionEdits(execution, { operations: [operation] }, deps),
      ).toMatchObject(locked);
    },
  );

  it("requires reprepare if an assignment starts between preparation and commit", () => {
    const { execution, context, deps, lane } = fixture(false);
    const operations = [modelEdit(context)];
    const prepared = prepareLiveExecutionEdits(execution, { operations }, deps);
    expect(prepared).toMatchObject({ ok: true });
    if (!prepared.ok) return;
    execution.executionStateRevision += 1;
    execution.laneStates[context.id] = { implementer: lane("implementer") };
    expect(finalizePreparedEdits(execution, prepared.prepared)).toMatchObject({
      ok: false,
      outcome: "reprepare",
    });
    expect(
      applyLiveExecutionEdits(execution, { operations }, deps),
    ).toMatchObject(locked);
  });

  it("reset preserves every conversation and the resulting assignment locks", () => {
    const { execution, context, deps } = fixture();
    const reset = resetExecutionContext(execution, context.id);
    expect(reset.laneStates).toEqual(execution.laneStates);
    expect(
      applyLiveExecutionEdits(
        reset,
        { operations: [modelEdit(context)] },
        deps,
      ),
    ).toMatchObject(locked);
  });
});
