import { describe, expect, it } from "vitest";
import {
  executionScopeSchema,
  validateExecutionScope,
  type ExecutionScope,
  type ScopePlan,
} from "./scope-validation";

const plan: ScopePlan = {
  tasks: [
    {
      id: "task-1",
      handle: "T1",
      dependsOnTaskIds: [],
      coveredCriterionIds: ["criterion-1"],
    },
    {
      id: "task-2",
      handle: "T2",
      dependsOnTaskIds: ["task-1"],
      coveredCriterionIds: ["criterion-2"],
    },
    {
      id: "task-3",
      handle: "T3",
      dependsOnTaskIds: [],
      coveredCriterionIds: ["criterion-3"],
    },
  ],
  criteria: [
    { id: "criterion-1", handle: "R1.1" },
    { id: "criterion-2", handle: "R1.2" },
    { id: "criterion-3", handle: "R2.1" },
  ],
};

const scope = (overrides: Partial<ExecutionScope> = {}): ExecutionScope => ({
  selectedTaskIds: ["task-1", "task-2"],
  selectedCriterionIds: ["criterion-1", "criterion-2"],
  exclusionDispositions: [
    { criterionId: "criterion-3", disposition: "deferred" },
  ],
  ...overrides,
});

describe("validateExecutionScope", () => {
  it("accepts a dependency-closed partial scope", () => {
    expect(validateExecutionScope(plan, scope())).toEqual({
      valid: true,
      defects: [],
    });
  });

  it("16.4 rejects a selected task whose dependency is not selected", () => {
    const result = validateExecutionScope(
      plan,
      scope({
        selectedTaskIds: ["task-2"],
        selectedCriterionIds: ["criterion-2"],
        exclusionDispositions: [
          { criterionId: "criterion-1", disposition: "deferred" },
          { criterionId: "criterion-3", disposition: "delivered_elsewhere" },
        ],
      }),
    );

    expect(result).toEqual({
      valid: false,
      reason: "invalid_smaller_unit",
      defects: [
        {
          kind: "missing_task_dependency",
          taskId: "task-2",
          taskHandle: "T2",
          dependencyTaskId: "task-1",
          dependencyTaskHandle: "T1",
          message: "T2 requires selected dependency T1.",
        },
      ],
    });
  });

  it("16.5 rejects a selected criterion without selected task coverage", () => {
    const result = validateExecutionScope(
      plan,
      scope({
        selectedTaskIds: ["task-1"],
        selectedCriterionIds: ["criterion-2"],
        exclusionDispositions: [
          { criterionId: "criterion-1", disposition: "waived" },
          { criterionId: "criterion-3", disposition: "deferred" },
        ],
      }),
    );

    expect(result).toEqual({
      valid: false,
      reason: "invalid_smaller_unit",
      defects: [
        {
          kind: "uncovered_selected_criterion",
          criterionId: "criterion-2",
          criterionHandle: "R1.2",
          message: "Selected criterion R1.2 has no selected covering task.",
        },
      ],
    });
  });

  it("16.6 rejects each excluded criterion without a disposition", () => {
    const result = validateExecutionScope(
      plan,
      scope({
        selectedTaskIds: ["task-1"],
        selectedCriterionIds: ["criterion-1"],
        exclusionDispositions: [
          { criterionId: "criterion-3", disposition: "deferred" },
        ],
      }),
    );

    expect(result).toEqual({
      valid: false,
      reason: "invalid_smaller_unit",
      defects: [
        {
          kind: "missing_exclusion_disposition",
          criterionId: "criterion-2",
          criterionHandle: "R1.2",
          message:
            "Excluded criterion R1.2 needs a deferred, delivered_elsewhere, or waived disposition.",
        },
      ],
    });
  });

  it("16.7 reports every plan-unit defect under one invalid-smaller-unit rejection", () => {
    const result = validateExecutionScope(
      plan,
      scope({
        selectedTaskIds: ["task-2"],
        selectedCriterionIds: ["criterion-3"],
        exclusionDispositions: [],
      }),
    );

    expect(result).toEqual({
      valid: false,
      reason: "invalid_smaller_unit",
      defects: [
        {
          kind: "missing_task_dependency",
          taskId: "task-2",
          taskHandle: "T2",
          dependencyTaskId: "task-1",
          dependencyTaskHandle: "T1",
          message: "T2 requires selected dependency T1.",
        },
        {
          kind: "uncovered_selected_criterion",
          criterionId: "criterion-3",
          criterionHandle: "R2.1",
          message: "Selected criterion R2.1 has no selected covering task.",
        },
        {
          kind: "missing_exclusion_disposition",
          criterionId: "criterion-1",
          criterionHandle: "R1.1",
          message:
            "Excluded criterion R1.1 needs a deferred, delivered_elsewhere, or waived disposition.",
        },
        {
          kind: "missing_exclusion_disposition",
          criterionId: "criterion-2",
          criterionHandle: "R1.2",
          message:
            "Excluded criterion R1.2 needs a deferred, delivered_elsewhere, or waived disposition.",
        },
      ],
    });
  });

  it("16.7 rejects a selected task that is not in the approved plan", () => {
    const result = validateExecutionScope(
      plan,
      scope({
        selectedTaskIds: ["task-1", "task-unknown"],
        selectedCriterionIds: ["criterion-1"],
        exclusionDispositions: [
          { criterionId: "criterion-2", disposition: "deferred" },
          { criterionId: "criterion-3", disposition: "deferred" },
        ],
      }),
    );

    expect(result).toEqual({
      valid: false,
      reason: "invalid_smaller_unit",
      defects: [
        {
          kind: "unknown_selected_task",
          taskId: "task-unknown",
          message: "Selected task task-unknown is not in the approved plan.",
        },
      ],
    });
  });

  it("16.7 rejects a selected criterion that is not in the approved plan", () => {
    const result = validateExecutionScope(
      plan,
      scope({
        selectedTaskIds: ["task-1"],
        selectedCriterionIds: ["criterion-1", "criterion-unknown"],
        exclusionDispositions: [
          { criterionId: "criterion-2", disposition: "deferred" },
          { criterionId: "criterion-3", disposition: "deferred" },
        ],
      }),
    );

    expect(result).toEqual({
      valid: false,
      reason: "invalid_smaller_unit",
      defects: [
        {
          kind: "unknown_selected_criterion",
          criterionId: "criterion-unknown",
          message:
            "Selected criterion criterion-unknown is not in the approved plan.",
        },
      ],
    });
  });

  it("16.7 rejects a scope that selects no delivery criteria", () => {
    const result = validateExecutionScope(
      plan,
      scope({
        selectedTaskIds: ["task-1"],
        selectedCriterionIds: [],
        exclusionDispositions: [
          { criterionId: "criterion-1", disposition: "deferred" },
          { criterionId: "criterion-2", disposition: "deferred" },
          { criterionId: "criterion-3", disposition: "deferred" },
        ],
      }),
    );

    expect(result).toEqual({
      valid: false,
      reason: "invalid_smaller_unit",
      defects: [
        {
          kind: "empty_selected_criteria",
          message: "Execution scope selects no criteria to deliver.",
        },
      ],
    });
  });
});

describe("executionScopeSchema", () => {
  it("canonicalizes duplicate ids to their first occurrence on parse", () => {
    // Persisted scopes written before canonicalization may carry duplicates;
    // parsing is the single choke point every read and write path shares, so
    // deduping here keeps counters like "n/m proof recorded" coherent.
    const parsed = executionScopeSchema.parse({
      selectedTaskIds: ["task-1", "task-2", "task-1"],
      selectedCriterionIds: ["criterion-1", "criterion-1", "criterion-2"],
      exclusionDispositions: [
        { criterionId: "criterion-3", disposition: "deferred" },
        { criterionId: "criterion-3", disposition: "waived" },
      ],
    });

    expect(parsed).toEqual({
      selectedTaskIds: ["task-1", "task-2"],
      selectedCriterionIds: ["criterion-1", "criterion-2"],
      exclusionDispositions: [
        { criterionId: "criterion-3", disposition: "deferred" },
      ],
    });
  });

  it("leaves an already-canonical scope untouched", () => {
    const canonical = {
      selectedTaskIds: ["task-1"],
      selectedCriterionIds: ["criterion-1"],
      exclusionDispositions: [
        { criterionId: "criterion-2", disposition: "deferred" },
      ],
    };

    expect(executionScopeSchema.parse(canonical)).toEqual(canonical);
  });
});
