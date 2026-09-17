import type { GraphExecutionLifecycleCallbacks } from "@/lib/workflow-graph/execution-lifecycle-port";
import type { GraphExecutionContract } from "@/lib/workflow-graph/execution-contract-port";
import type { MergeAssociationResolver } from "./merge/association-port";
import type { MergeDeliveryLifecycle } from "./merge/delivery-lifecycle-port";
import type { DeliveryGateEvaluator } from "./merge/types";
export interface WorkflowComposition {
  deliveryGate: DeliveryGateEvaluator;
  lifecycleCallbacks: GraphExecutionLifecycleCallbacks;
  mergeAssociation: MergeAssociationResolver;
  mergeDeliveryLifecycle: MergeDeliveryLifecycle;
  executionContract: GraphExecutionContract;
}
