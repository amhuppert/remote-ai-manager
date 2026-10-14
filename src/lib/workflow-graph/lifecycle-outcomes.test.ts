import { describe, expect, it } from "vitest";
import { lifecycleRefusalFromError } from "./lifecycle-outcomes";
import { GraphWorkflowRuntimeEditValidationError } from "./runtime-edits";
import { GraphWorkflowResourceMissingError } from "./lifecycle-errors";
import {
  GraphWorkflowTransitionConflictError,
  WorkflowDefinitionNotFoundError,
  WorkflowDefinitionRevisionMismatchError,
  WorkflowPrerequisitesUnmetError,
} from "./workflow-manager";
import { WorkflowStartGuardError } from "./start-guards";
import { WorkflowStartInputError } from "./start-input-service";
import { GraphExecutionContractViolationError } from "./execution-contract-port";
import { GraphWorkflowValidationError } from "./definition-validation";
import { ResetExecutionContextError } from "./reset-context";
import { ResetAssignmentError } from "./reset-assignment";

/**
 * The graph runtime is composed at server startup, so the refusals it throws
 * are instances of that bundle's copy of each error class, not the copy a
 * route imports. A copy with the same name stands in for it.
 */
function thrownByAnotherCopy(name: string): Error {
  class Copy extends Error {
    constructor() {
      super(`${name} refused`);
      this.name = name;
    }
  }
  return new Copy();
}

describe("a lifecycle refusal thrown by the startup-composed runtime", () => {
  const refusals: Array<[Error, string]> = [
    [
      new GraphWorkflowResourceMissingError("execution", "No execution"),
      "missing_resource",
    ],
    [new WorkflowDefinitionNotFoundError("def", "project"), "missing_resource"],
    [
      new GraphWorkflowTransitionConflictError("resume", "running", [], "No"),
      "invalid_transition",
    ],
    [
      new WorkflowDefinitionRevisionMismatchError("def", 1, 2),
      "definition_revision_mismatch",
    ],
    [new WorkflowStartGuardError("launches_frozen", "Frozen"), "launch_guard"],
    [
      new WorkflowStartInputError(
        { kind: "missing_required", name: "goal" },
        "Missing goal",
      ),
      "launch_input",
    ],
    [new WorkflowPrerequisitesUnmetError([], "Unmet"), "prerequisites_unmet"],
    [
      new GraphExecutionContractViolationError({
        ok: false,
        code: "contract",
        issues: [],
        instruction: "Fix it",
      }),
      "execution_contract",
    ],
    [new GraphWorkflowValidationError([]), "definition_validation"],
    [
      new ResetExecutionContextError("context_missing", "No context"),
      "reset_refused",
    ],
    [
      new ResetAssignmentError("assignment_missing", "No assignment"),
      "reset_refused",
    ],
  ];

  it.each(refusals)(
    "recognises %s, and another copy of its class by the name it assigns",
    (refusal, code) => {
      expect(lifecycleRefusalFromError(refusal)?.code).toBe(code);
      expect(
        lifecycleRefusalFromError(thrownByAnotherCopy(refusal.name))?.code,
      ).toBe(code);
    },
  );

  it("recognises a runtime edit's validation failure as a definition validation refusal", () => {
    const refusal = new GraphWorkflowRuntimeEditValidationError([]);
    expect(lifecycleRefusalFromError(refusal)?.code).toBe(
      "definition_validation",
    );
  });

  it("leaves any other error to the caller", () => {
    expect(lifecycleRefusalFromError(new Error("boom"))).toBeNull();
  });
});
