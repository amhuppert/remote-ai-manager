import { afterEach, describe, expect, it, vi } from "vitest";
import { createRegisteredGraphExecutionLifecycleCallbacks } from "@/lib/workflow-graph/execution-lifecycle-port";
import { createRegisteredDeliveryGateEvaluator } from "@/lib/workflows/merge/delivery-gate-port";
import { resetGraphExecutionLifecycleCallbacksForTesting } from "@/lib/workflow-graph/execution-lifecycle-port";
import { _resetDeliveryGateEvaluatorForTesting } from "@/lib/workflows/merge/delivery-gate-port";
import {
  resolveRegisteredMergeAssociation,
  _resetMergeAssociationResolverForTesting,
} from "@/lib/workflows/merge/association-port";
import {
  notifyRegisteredMergeDelivered,
  _resetMergeDeliveryLifecycleForTesting,
} from "@/lib/workflows/merge/delivery-lifecycle-port";
import { registerSpecWorkflowComposition } from "./workflow-composition";

describe("spec workflow composition", () => {
  afterEach(() => {
    _resetDeliveryGateEvaluatorForTesting();
    resetGraphExecutionLifecycleCallbacksForTesting();
    _resetMergeAssociationResolverForTesting();
    _resetMergeDeliveryLifecycleForTesting();
  });

  it("injects the spec delivery gate, lifecycle callbacks, association resolver, and delivery lifecycle through generic ports", async () => {
    const evaluate = vi.fn(async () => ({
      status: "pass" as const,
      satisfied: [],
      deferred: [],
    }));
    const markRunning = vi.fn(async () => {});
    const markDelivered = vi.fn(async () => {});
    const resolve = vi.fn(() => ({
      kind: "linked" as const,
      executionId: "workflow-execution-1",
      finalPublish: true,
    }));
    const mergeMarkDelivered = vi.fn(async () => {});

    registerSpecWorkflowComposition({
      deliveryGate: { evaluate },
      lifecycleCallbacks: { markRunning, markDelivered },
      mergeAssociation: { resolve },
      mergeDeliveryLifecycle: { markDelivered: mergeMarkDelivered },
    });

    await createRegisteredDeliveryGateEvaluator().evaluate({
      workflowExecutionId: "workflow-execution-1",
      projectPath: "/repo",
      preparedSha: "prepared-sha",
      expectedTargetSha: "target-sha",
    });
    const callbacks = createRegisteredGraphExecutionLifecycleCallbacks();
    await callbacks.markRunning("workflow-execution-1", "definition-1");
    await callbacks.markDelivered("workflow-execution-1", "merge-sha");
    const association = resolveRegisteredMergeAssociation({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session-1",
    });
    notifyRegisteredMergeDelivered("workflow-execution-1", "merge-sha");

    expect(evaluate).toHaveBeenCalledOnce();
    expect(markRunning).toHaveBeenCalledWith(
      "workflow-execution-1",
      "definition-1",
    );
    expect(markDelivered).toHaveBeenCalledWith(
      "workflow-execution-1",
      "merge-sha",
    );
    expect(association).toEqual({
      kind: "linked",
      executionId: "workflow-execution-1",
      finalPublish: true,
    });
    expect(mergeMarkDelivered).toHaveBeenCalledWith(
      "workflow-execution-1",
      "merge-sha",
    );
  });
});
