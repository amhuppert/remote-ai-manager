import type { WorkflowDefinitionMutation } from "./definition-schemas";
import type { ManagedDefinitionPreflightResult } from "@/lib/workflows/managed-definition-preflight-contract";

export {
  managedDefinitionPreflightFindingSchema,
  managedDefinitionPreflightRefusalCodeSchema,
  managedDefinitionPreflightRefusalSchema,
  managedDefinitionPreflightResultSchema,
  managedDefinitionPreflightSeveritySchema,
  managedDefinitionPreflightSuccessSchema,
  managedDefinitionPreflightSummarySchema,
  type ManagedDefinitionPreflightFinding,
  type ManagedDefinitionPreflightRefusal,
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
