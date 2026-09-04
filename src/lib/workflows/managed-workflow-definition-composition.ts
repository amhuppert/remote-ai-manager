import {
  createManagedWorkflowDefinitionService,
  type ManagedWorkflowDefinitionService,
} from "@/lib/specs/managed-workflow-definition-service";
import { definitionMutationCoordinator } from "@/lib/workflow-graph/definition-mutation-coordinator";
import { createWorkflowStorageService } from "@/lib/workflow-graph/storage";

export function createProductionManagedWorkflowDefinitionService(): ManagedWorkflowDefinitionService {
  return createManagedWorkflowDefinitionService({
    storage: createWorkflowStorageService(),
    mutationCoordinator: definitionMutationCoordinator,
  });
}
