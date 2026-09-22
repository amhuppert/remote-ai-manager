import type { WorkflowDefinitionMutation } from "./definition-schemas";
import type { ManagedDefinitionPreflightResult } from "@/lib/workflows/managed-definition-preflight-contract";

export {
  managedDefinitionPreflightSuccessSchema,
  type ManagedDefinitionPreflightFinding,
  type ManagedDefinitionPreflightResult,
  type ManagedDefinitionPreflightSummary,
} from "@/lib/workflows/managed-definition-preflight-contract";

export interface ManagedDefinitionPreflightPort {
  preflight(input: {
    projectPath: string;
    workflowDefinitionId: string;
    launch: WorkflowDefinitionMutation;
  }): Promise<ManagedDefinitionPreflightResult>;
}
