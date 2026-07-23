import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkflowDefinition,
  createWorkflowExecution,
} from "./test-fixtures";
import {
  createRegisteredGraphExecutionContract,
  registerGraphExecutionContract,
  resetGraphExecutionContractForTesting,
} from "./execution-contract-port";

describe("graph execution contract port", () => {
  afterEach(() => {
    resetGraphExecutionContractForTesting();
  });

  it("keeps every contract operation behavior-neutral when no consumer is registered", () => {
    const contract = createRegisteredGraphExecutionContract();
    const definition = createWorkflowDefinition();
    const execution = createWorkflowExecution();

    expect(contract.validateDefinition(definition)).toEqual({ ok: true });
    expect(
      contract.validateLiveEdit(execution, {
        type: "move-task",
        taskId: "task-plan-1",
        targetContextId: "context-implement",
      }),
    ).toEqual({ ok: true });
    expect(contract.validateTaskCompletion(execution, "task-plan-1")).toEqual({
      ok: true,
    });
    expect(contract.deriveContextAcceptanceCriteria(definition)).toEqual({
      ok: true,
      acceptanceCriteriaByContextId: {},
    });
  });

  it("delegates to the currently registered contract", () => {
    const contract = createRegisteredGraphExecutionContract();
    const definition = createWorkflowDefinition();
    registerGraphExecutionContract({
      validateDefinition() {
        return {
          ok: false,
          code: "contract_refused",
          issues: [{ code: "contract-refused", message: "refused" }],
          instruction: "Repair the contract.",
        };
      },
      validateLiveEdit() {
        return { ok: true };
      },
      validateTaskCompletion() {
        return { ok: true };
      },
      deriveContextAcceptanceCriteria() {
        return {
          ok: true,
          acceptanceCriteriaByContextId: { "context-plan": "Derived" },
        };
      },
    });

    expect(contract.validateDefinition(definition)).toMatchObject({
      ok: false,
      code: "contract_refused",
    });
    expect(contract.deriveContextAcceptanceCriteria(definition)).toEqual({
      ok: true,
      acceptanceCriteriaByContextId: { "context-plan": "Derived" },
    });
  });
});
