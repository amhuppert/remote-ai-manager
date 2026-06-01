import { randomUUID } from "node:crypto";
import type { WorkflowDefaults } from "@/lib/config/schemas";
import type {
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowHaltReason,
  WorkflowConfigOverride,
} from "@/lib/workflows/schemas";
import { resolveCollaborationConfigWithProvenance } from "./resolve-config";
import type { GraphWorkflowCollaborationContextBlock } from "./tool-server";

export interface ImplementerCollaborationContextInput {
  projectPath: string;
  sessionName: string;
  executionId: string;
  contextId: string;
  conversationId: string;
  /**
   * Implementer iteration index at the moment this context block is built.
   * Threaded through `GraphWorkflowCollaborationContextBlock` so the workflow
   * collaboration envelope can stamp the transcript writeback's `origin`
   * field with `iterationIndex`, linking the final answer back to the
   * implementer turn that requested the collaboration.
   */
  iterationIndex: number;
  globalDefaults: WorkflowDefaults;
  workflowConfig: WorkflowConfigOverride;
  executionContextDefinition: GraphWorkflowExecutionContextDefinition;
}

export interface ImplementerCollaborationContextDeps {
  parentImplementerTurnIdFactory?(): string;
  setPendingHaltReason(reason: GraphWorkflowHaltReason): Promise<void>;
  triggerWorkflowCollaboration: GraphWorkflowCollaborationContextBlock["triggerWorkflowCollaboration"];
}

export function buildImplementerCollaborationContext(
  input: ImplementerCollaborationContextInput,
  deps: ImplementerCollaborationContextDeps,
): GraphWorkflowCollaborationContextBlock {
  const turnIdFactory =
    deps.parentImplementerTurnIdFactory ?? (() => randomUUID());
  const parentImplementerTurnId = turnIdFactory();

  return {
    parentImplementerTurnId,
    executionContextId: input.contextId,
    conversationId: input.conversationId,
    executionId: input.executionId,
    iterationIndex: input.iterationIndex,
    resolveCollaborationConfig: () =>
      resolveCollaborationConfigWithProvenance(
        input.globalDefaults,
        input.workflowConfig,
        input.executionContextDefinition,
      ),
    triggerWorkflowCollaboration: deps.triggerWorkflowCollaboration,
    setPendingHaltReason: deps.setPendingHaltReason,
  };
}
