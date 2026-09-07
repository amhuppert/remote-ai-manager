import type { GraphExecutionLifecycleCallbacks } from "@/lib/workflow-graph/execution-lifecycle-port";
import {
  registerGraphExecutionLifecycleCallbacks,
  assertGraphExecutionLifecycleCallbacksRegistered,
} from "@/lib/workflow-graph/execution-lifecycle-port";
import { registerDeliveryGateEvaluator } from "@/lib/workflows/merge/delivery-gate-port";
import type { MergeAssociationResolver } from "@/lib/workflows/merge/association-port";
import { registerMergeAssociationResolver } from "@/lib/workflows/merge/association-port";
import type { MergeDeliveryLifecycle } from "@/lib/workflows/merge/delivery-lifecycle-port";
import { registerMergeDeliveryLifecycle } from "@/lib/workflows/merge/delivery-lifecycle-port";
import type { DeliveryGateEvaluator } from "@/lib/workflows/merge/types";
import {
  registerGraphExecutionContract,
  assertGraphExecutionContractRegistered,
  type GraphExecutionContract,
} from "@/lib/workflow-graph/execution-contract-port";

export interface SpecWorkflowComposition {
  deliveryGate: DeliveryGateEvaluator;
  lifecycleCallbacks: GraphExecutionLifecycleCallbacks;
  mergeAssociation: MergeAssociationResolver;
  mergeDeliveryLifecycle: MergeDeliveryLifecycle;
  executionContract: GraphExecutionContract;
}

export function registerSpecWorkflowComposition(
  composition: SpecWorkflowComposition,
): void {
  registerDeliveryGateEvaluator(composition.deliveryGate);
  registerGraphExecutionLifecycleCallbacks(composition.lifecycleCallbacks);
  registerMergeAssociationResolver(composition.mergeAssociation);
  registerMergeDeliveryLifecycle(composition.mergeDeliveryLifecycle);
  registerGraphExecutionContract(composition.executionContract);
  assertGraphExecutionContractRegistered();
  assertGraphExecutionLifecycleCallbacksRegistered();
}
