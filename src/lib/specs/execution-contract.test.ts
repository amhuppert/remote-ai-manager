import { describe, expect, it } from "vitest";
import {
  createWorkflowDefinition,
  createWorkflowExecution,
} from "@/lib/workflow-graph/test-fixtures";
import type {
  GraphWorkflowTaskDefinition,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import { createSpecExecutionContract } from "./execution-contract";

const GROUP_ACCEPTANCE_CRITERIA =
  "Validate the locked criterion briefs of every task currently assigned to this context. The effective contract is the union of those task briefs; regrouping must never drop or weaken one.";

function compiledTask(
  task: GraphWorkflowTaskDefinition,
  input: {
    elementId: string;
    handle: string;
    dependencies?: string[];
    criterionId?: string;
    criterionBrief?: string;
  },
): GraphWorkflowTaskDefinition {
  const criterionId = input.criterionId ?? `criterion-${input.elementId}`;
  const criterionBrief = input.criterionBrief ?? `Validate ${input.handle}.`;
  return {
    ...task,
    metadata: {
      specRevisionId: "revision-1",
      specTaskElementId: input.elementId,
      specTaskHandle: input.handle,
      specDependsOnTaskElementIds: JSON.stringify(input.dependencies ?? []),
      specCriterionElementIds: JSON.stringify([criterionId]),
      specCriterionHandles: JSON.stringify([`R1.${input.handle.slice(1)}`]),
      specValidationStrategies: "{}",
      specCriterionBriefs: JSON.stringify({
        [criterionId]: criterionBrief,
      }),
    },
  };
}

function specDefinition(): WorkflowSemanticDefinition {
  const base = createWorkflowDefinition();
  const tasks = base.tasks.map((task, index) =>
    compiledTask(task, {
      elementId: `task-${index + 1}`,
      handle: `T${index + 1}`,
      dependencies: index === 0 ? [] : ["task-1"],
    }),
  );
  return createWorkflowDefinition({
    origin: {
      sourceUri:
        "spec-execution://spec-native-sdd/revisions/revision-1?scope=scope-1",
    },
    executionContexts: base.executionContexts.map((context) => ({
      ...context,
      origin: { sourceUri: "spec://native-sdd/revisions/revision-1" },
    })),
    tasks,
    lockedRegions: tasks.map((task) => ({
      paths: [`/tasks/${task.id}/metadata`],
      sourceUri: "spec://native-sdd/revisions/revision-1",
      reason: "Compiled task contract",
    })),
  });
}

describe("spec execution contract", () => {
  const contract = createSpecExecutionContract();

  it("accepts dependencies embedded through transitive context reachability", () => {
    expect(contract.validateDefinition(specDefinition())).toEqual({ ok: true });
  });

  it("rejects a dependency whose contexts have no reachable precedence", () => {
    const definition = specDefinition();
    definition.edges = definition.edges.filter(
      (edge) => edge.id !== "edge-plan-implement",
    );

    const result = contract.validateDefinition(definition);
    expect(result).toMatchObject({
      ok: false,
      code: "spec_dependency_embedding_invalid",
    });
    if (result.ok) return;
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "spec-dependency-path-missing",
          message: expect.stringContaining("T1 must precede T2"),
        }),
      ]),
    );
  });

  it("rejects same-context tasks ordered before their declared predecessors", () => {
    const definition = specDefinition();
    const predecessor = definition.tasks[0]!;
    const dependent = definition.tasks[1]!;
    dependent.contextId = predecessor.contextId;
    dependent.order = 1;
    predecessor.order = 2;

    expect(contract.validateDefinition(definition)).toMatchObject({
      ok: false,
      code: "spec_dependency_embedding_invalid",
      issues: [
        expect.objectContaining({
          code: "spec-dependency-order-invalid",
          message: expect.stringContaining("T1 must precede T2"),
        }),
      ],
    });
  });

  it("accepts declared predecessors ordered earlier in the same context", () => {
    const definition = specDefinition();
    const predecessor = definition.tasks[0]!;
    const dependent = definition.tasks[1]!;
    dependent.contextId = predecessor.contextId;
    predecessor.order = 1;
    dependent.order = 2;

    expect(contract.validateDefinition(definition)).toEqual({ ok: true });
  });

  it("freezes spec task grouping for launched executions without affecting ordinary workflows", () => {
    const specExecution = createWorkflowExecution({
      status: "paused",
      workingDefinition: specDefinition() as never,
    });
    const ordinaryExecution = createWorkflowExecution({ status: "paused" });
    const operation = {
      type: "move-task" as const,
      taskId: "task-plan-1",
      targetContextId: "context-implement",
    };

    expect(contract.validateLiveEdit(specExecution, operation)).toMatchObject({
      ok: false,
      code: "spec_grouping_frozen",
      issues: [expect.objectContaining({ code: "spec-grouping-frozen" })],
    });
    expect(contract.validateLiveEdit(ordinaryExecution, operation)).toEqual({
      ok: true,
    });
  });

  it("refuses completion while a declared same-context predecessor is incomplete", () => {
    const definition = specDefinition();
    const predecessor = definition.tasks[0]!;
    const dependent = definition.tasks[1]!;
    dependent.contextId = predecessor.contextId;
    predecessor.order = 1;
    dependent.order = 2;
    const execution = createWorkflowExecution({
      status: "running",
      workingDefinition: definition as never,
    });
    execution.taskStates[dependent.id] = {
      ...execution.taskStates["task-implement-1"]!,
      taskId: dependent.id,
      contextId: dependent.contextId,
      order: dependent.order,
    };

    expect(
      contract.validateTaskCompletion(execution, dependent.id),
    ).toMatchObject({
      ok: false,
      code: "spec_predecessor_incomplete",
      issues: [
        expect.objectContaining({
          code: "spec-predecessor-incomplete",
          message: expect.stringContaining("Complete T1 before T2"),
        }),
      ],
    });
    execution.taskStates[predecessor.id]!.status = "completed";
    expect(contract.validateTaskCompletion(execution, dependent.id)).toEqual({
      ok: true,
    });
  });

  it("derives each compiler context contract from its current member briefs", () => {
    const definition = specDefinition();
    const secondTask = definition.tasks[1]!;
    secondTask.contextId = "context-plan";
    secondTask.order = 2;

    const result = contract.deriveContextAcceptanceCriteria(definition);

    expect(result).toEqual({
      ok: true,
      acceptanceCriteriaByContextId: {
        "context-plan": `${GROUP_ACCEPTANCE_CRITERIA}\n\nValidate T1.\nValidate T2.`,
        "context-implement": GROUP_ACCEPTANCE_CRITERIA,
        "context-verify": `${GROUP_ACCEPTANCE_CRITERIA}\n\nValidate T3.`,
      },
    });
  });

  it("derives criterion coverage from the compiled task metadata (R5.2)", () => {
    const definition = specDefinition();
    definition.tasks[1]!.contextId = "context-plan";

    expect(contract.deriveCriterionContextCoverage(definition)).toEqual({
      "criterion-task-1": ["context-plan"],
      "criterion-task-2": ["context-plan"],
      "criterion-task-3": ["context-verify"],
    });
  });

  it("derives no criterion coverage for an execution that is not spec-linked", () => {
    expect(
      contract.deriveCriterionContextCoverage(createWorkflowDefinition()),
    ).toEqual({});
  });

  it("derives the contract of an execution-only context added for regrouping", () => {
    const definition = specDefinition();
    definition.executionContexts.push({
      id: "context-regrouped",
      title: "Regrouped lane",
      acceptanceCriteria: "Stale manually entered criteria.",
    });
    definition.tasks[1]!.contextId = "context-regrouped";
    definition.tasks[1]!.order = 1;

    expect(contract.deriveContextAcceptanceCriteria(definition)).toMatchObject({
      ok: true,
      acceptanceCriteriaByContextId: {
        "context-regrouped": `${GROUP_ACCEPTANCE_CRITERIA}\n\nValidate T2.`,
      },
    });
  });
});
