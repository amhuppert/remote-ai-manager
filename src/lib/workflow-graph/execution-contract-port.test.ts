import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkflowDefinition,
  createWorkflowExecution,
} from "./test-fixtures";
import {
  createRegisteredGraphExecutionContract,
  createNonParticipatingGraphExecutionContract,
  registerGraphExecutionContract,
  resetGraphExecutionContractForTesting,
} from "./execution-contract-port";

describe("graph execution contract port", () => {
  afterEach(() => {
    resetGraphExecutionContractForTesting();
  });

  it("refuses semantic work when mandatory policy is unregistered", async () => {
    const contract = createRegisteredGraphExecutionContract();
    const definition = createWorkflowDefinition();
    const execution = createWorkflowExecution();
    const refusal = { ok: false, code: "execution_contract_unregistered" };
    expect(contract.validateDefinition(definition)).toMatchObject(refusal);
    expect(
      contract.validateTaskCompletion(execution, "task-plan-1"),
    ).toMatchObject(refusal);
    expect(contract.deriveContextAcceptanceCriteria(definition)).toMatchObject(
      refusal,
    );
    expect(() => contract.loadLiveEdit(execution)).toThrowError(
      expect.objectContaining({ code: "execution_contract_unregistered" }),
    );
    await expect(
      contract.loadPromptProjection?.(execution),
    ).rejects.toMatchObject({ code: "execution_contract_unregistered" });
  });

  it("allows deliberate non-participation and observes registration after wrapper creation", async () => {
    const contract = createRegisteredGraphExecutionContract();
    registerGraphExecutionContract(
      createNonParticipatingGraphExecutionContract(),
    );
    const definition = createWorkflowDefinition();
    const execution = createWorkflowExecution();
    expect(contract.validateDefinition(definition)).toEqual({ ok: true });
    expect(contract.validateTaskCompletion(execution, "task-plan-1")).toEqual({
      ok: true,
    });
    expect(contract.deriveContextAcceptanceCriteria(definition)).toEqual({
      ok: true,
      acceptanceCriteriaByContextId: {},
    });
    expect(
      contract.loadLiveEdit(execution).accountabilityCoverageGroups,
    ).toEqual([]);
    await expect(contract.loadPromptProjection(execution)).resolves.toBeNull();
  });

  it("delegates to the currently registered contract", () => {
    const contract = createRegisteredGraphExecutionContract();
    const definition = createWorkflowDefinition();
    const execution = createWorkflowExecution();
    registerGraphExecutionContract({
      loadPromptProjection: async () => null,

      validateDefinition() {
        return {
          ok: false,
          code: "contract_refused",
          issues: [{ code: "contract-refused", message: "refused" }],
          instruction: "Repair the contract.",
        };
      },
      loadLiveEdit() {
        return {
          validateOperation: () => ({ ok: true }),
          accountabilityCoverageGroups: [
            {
              bindingKey: "criterion-1",
              claimantContextIds: ["context-plan"],
            },
          ],
        };
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
    expect(
      contract.loadLiveEdit(execution).accountabilityCoverageGroups,
    ).toEqual([
      {
        bindingKey: "criterion-1",
        claimantContextIds: ["context-plan"],
      },
    ]);
  });
});
