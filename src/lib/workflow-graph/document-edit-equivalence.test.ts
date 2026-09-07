import { describe, expect, it } from "vitest";
import {
  workflowDefinitionEditOperationSchema,
  workflowLiveEditOperationSchema,
} from "@/lib/workflows/edit-schemas";
import { createNonParticipatingGraphExecutionContract } from "./execution-contract-port";
import { applyDefinitionEdits } from "./definition-edits";
import { applyLiveExecutionEdits } from "./runtime-edits";
import {
  createWorkflowDefinition,
  createWorkflowDefinitionRecord,
} from "./test-fixtures";
import {
  executionFor,
  makeLiveEditDeps,
  workerJudgeDefinition,
} from "./loop-test-fixtures";
import type { GraphWorkflowTaskDefinition } from "./definition-schemas";

function taskOrder(tasks: GraphWorkflowTaskDefinition[]) {
  return tasks
    .filter((task) => task.contextId === "worker")
    .sort((a, b) => a.order - b.order)
    .map(({ id, order }) => ({ id, order }));
}

function bodyDefinition() {
  const definition = workerJudgeDefinition();
  const group = definition.loopGroups?.find((group) => group.id === "refine");
  if (!group) throw new Error("loop template missing");
  return {
    ...definition,
    executionContexts: group.template.contexts,
    tasks: group.template.tasks,
    edges: group.template.edges,
    loopGroups: [],
  };
}

function documentFor() {
  const definition = bodyDefinition();
  return createWorkflowDefinitionRecord({
    definition: createWorkflowDefinition({
      executionContexts: definition.executionContexts.map((context) => ({
        id: context.id,
        title: context.title,
        acceptanceCriteria: context.acceptanceCriteria,
        placement: context.placement,
        outputSchema: context.outputSchema,
      })),
      tasks: definition.tasks,
      edges: definition.edges,
    }),
  });
}

describe("document editing across tiers", () => {
  it("applies an ordered insertion, reorder and removal identically to saved, live and template tasks", () => {
    const operations = [
      {
        type: "add-task",
        id: "first",
        contextId: "worker",
        title: "First",
        instructions: "Prepare",
        position: { at: "start" },
      },
      {
        type: "add-task",
        id: "middle",
        contextId: "worker",
        title: "Middle",
        instructions: "Review",
        position: { after: "first" },
      },
      {
        type: "reorder-tasks",
        contextId: "worker",
        orderedTaskIds: ["middle", "task-worker", "first"],
      },
      { type: "remove-task", taskId: "task-worker" },
    ];
    const saved = applyDefinitionEdits(
      documentFor(),
      operations.map((op) => workflowDefinitionEditOperationSchema.parse(op)),
      createNonParticipatingGraphExecutionContract(),
    );
    const execution = executionFor(bodyDefinition());
    execution.status = "paused";
    const live = applyLiveExecutionEdits(
      execution,
      {
        operations: operations.map((op) =>
          workflowLiveEditOperationSchema.parse(op),
        ),
      },
      makeLiveEditDeps(),
    );
    const templateExecution = executionFor(workerJudgeDefinition());
    templateExecution.status = "paused";
    const template = applyLiveExecutionEdits(
      templateExecution,
      {
        source: "cli",
        operations: [
          workflowLiveEditOperationSchema.parse({
            type: "edit-loop-template",
            loopGroupId: "refine",
            operations,
          }),
        ],
      },
      makeLiveEditDeps(),
    );
    expect(saved.ok, JSON.stringify(saved)).toBe(true);
    expect(live.ok, JSON.stringify(live)).toBe(true);
    expect(template.ok, JSON.stringify(template)).toBe(true);
    if (!saved.ok || !live.ok || !template.ok)
      throw new Error("permitted edit refused");
    const expected = [
      { id: "middle", order: 1 },
      { id: "first", order: 2 },
    ];
    expect(taskOrder(saved.record.definition.tasks)).toEqual(expected);
    expect(taskOrder(live.execution.workingDefinition.tasks)).toEqual(expected);
    const group = template.execution.workingDefinition.loopGroups?.find(
      (group) => group.id === "refine",
    );
    if (!group) throw new Error("template missing");
    expect(taskOrder(group.template.tasks)).toEqual(expected);
    expect(template.execution.workingDefinition.tasks).toEqual(
      templateExecution.workingDefinition.tasks,
    );
    expect(live.execution.taskStates["task-worker"]).toBeUndefined();
    expect(live.execution.taskStates.middle).toMatchObject({
      contextId: "worker",
      order: 1,
      status: "pending",
    });
    expect(live.execution.taskStates.first).toMatchObject({
      contextId: "worker",
      order: 2,
      status: "pending",
    });
  });

  it.each(["remove-task", "move-task"] as const)(
    "keeps live locked-task policy for %s while the saved document remains editable",
    (type) => {
      const record = documentFor();
      const savedOp =
        type === "move-task"
          ? { type, taskId: "task-worker", contextId: "judge" }
          : { type, taskId: "task-worker" };
      const saved = applyDefinitionEdits(
        record,
        [workflowDefinitionEditOperationSchema.parse(savedOp)],
        createNonParticipatingGraphExecutionContract(),
      );
      const execution = executionFor(bodyDefinition());
      execution.status = "paused";
      const state = execution.taskStates["task-worker"];
      if (!state) throw new Error("task missing");
      state.status = "completed";
      const before = structuredClone(execution);
      const liveOp =
        type === "move-task"
          ? { type, taskId: "task-worker", targetContextId: "judge" }
          : { type, taskId: "task-worker" };
      const live = applyLiveExecutionEdits(
        execution,
        { operations: [workflowLiveEditOperationSchema.parse(liveOp)] },
        makeLiveEditDeps(),
      );
      expect(saved.ok, JSON.stringify(saved)).toBe(true);
      expect(live.ok).toBe(false);
      if (live.ok) throw new Error("locked edit accepted");
      expect(live.issues).toEqual([
        expect.objectContaining({
          code: "task-locked",
          taskId: "task-worker",
          operationIndex: 0,
        }),
      ]);
      expect(execution).toEqual(before);
    },
  );
});
