import type { WorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";
import { isDeliveryPlanDefinition } from "@/lib/workflow-graph/execution-amendment";

import { readCompiledOriginMap, type CompiledOriginMapEntry } from "./compiler";
import {
  deliveryPlanMaterializationCriteria,
  readDeliveryPlanSourceMap,
} from "./delivery-plan-materializer";
import type { SpecRevisionSnapshot } from "./schemas";

export type LoadSpecRevisionSnapshot = (
  revisionId: string,
) => Promise<SpecRevisionSnapshot | null>;

export interface SpecExecutionOriginMapEntry extends Omit<
  CompiledOriginMapEntry,
  "taskElementId" | "taskHandle"
> {
  taskElementId: string | null;
  taskHandle: string | null;
}

export async function readSpecExecutionOriginMap(
  definition: WorkflowSemanticDefinition,
  loadRevisionSnapshot: LoadSpecRevisionSnapshot,
): Promise<SpecExecutionOriginMapEntry[]> {
  if (!isDeliveryPlanDefinition(definition)) {
    return readCompiledOriginMap(definition);
  }

  const sourceMap = readDeliveryPlanSourceMap(definition);
  const snapshot = await loadRevisionSnapshot(sourceMap.pinnedRevisionId);
  if (snapshot === null) {
    throw new Error(
      `Delivery plan ${sourceMap.attemptId} pins missing revision ${sourceMap.pinnedRevisionId}`,
    );
  }

  const criteria = new Map(
    deliveryPlanMaterializationCriteria(snapshot).map((criterion) => [
      criterion.criterionElementId,
      criterion,
    ]),
  );

  return sourceMap.contexts.flatMap((context) => {
    const ownedCriteria = context.criterionElementIds.map(
      (criterionElementId) => {
        const criterion = criteria.get(criterionElementId);
        if (criterion === undefined) {
          throw new Error(
            `Delivery plan ${sourceMap.attemptId} maps missing criterion ${criterionElementId} from pinned revision ${sourceMap.pinnedRevisionId}`,
          );
        }
        return criterion;
      },
    );
    const criterionHandles = ownedCriteria.map((criterion) => criterion.handle);
    const validationStrategies = Object.fromEntries(
      ownedCriteria.map((criterion) => [
        criterion.criterionElementId,
        criterion.validationStrategy,
      ]),
    );
    const criterionBriefs = Object.fromEntries(
      ownedCriteria.map((criterion) => [
        criterion.criterionElementId,
        criterion.text,
      ]),
    );
    const taskIds = context.taskIds.length === 0 ? [null] : context.taskIds;

    return taskIds.map((taskId) => ({
      contextId: context.contextId,
      taskElementId: taskId,
      taskHandle: taskId,
      touchedPaths: [],
      criterionElementIds: [...context.criterionElementIds],
      criterionHandles,
      validationStrategies,
      criterionBriefs,
    }));
  });
}
