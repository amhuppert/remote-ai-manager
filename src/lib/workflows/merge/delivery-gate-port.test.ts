import { afterEach, describe, expect, it } from "vitest";
import {
  _resetDeliveryGateEvaluatorForTesting,
  createRegisteredDeliveryGateEvaluator,
  registerDeliveryGateEvaluator,
} from "./delivery-gate-port";

describe("merge delivery-gate port composition", () => {
  afterEach(() => {
    _resetDeliveryGateEvaluatorForTesting();
  });

  it("forwards linked evaluations to the composition-registered adapter", async () => {
    const observed: string[] = [];
    registerDeliveryGateEvaluator({
      async evaluate(input) {
        if (!input.workflowExecutionId)
          throw new Error("Expected graph execution identity");
        observed.push(input.workflowExecutionId);
        return { status: "pass", satisfied: [], deferred: [] };
      },
    });

    const result = await createRegisteredDeliveryGateEvaluator().evaluate({
      workflowExecutionId: "workflow-execution-1",
      preparedSha: "prepared-sha",
      expectedTargetSha: "target-sha",
      projectPath: "/repo",
    });

    expect(result).toEqual({ status: "pass", satisfied: [], deferred: [] });
    expect(observed).toEqual(["workflow-execution-1"]);
  });

  it("fails closed when linked execution composition was not registered", async () => {
    await expect(
      createRegisteredDeliveryGateEvaluator().evaluate({
        workflowExecutionId: "workflow-execution-1",
        preparedSha: "prepared-sha",
        expectedTargetSha: "target-sha",
        projectPath: "/repo",
      }),
    ).rejects.toThrow(/evaluator is required/i);
  });
});
