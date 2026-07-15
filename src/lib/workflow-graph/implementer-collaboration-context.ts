import { randomUUID } from "node:crypto";
import type { GraphWorkflowHaltReason } from "@/lib/workflow-graph/schemas";
import type { ResolvedCollaborationConfig } from "@/lib/workflow-graph/collaboration-schemas";
import type { GraphWorkflowCollaborationContextBlock } from "./lane-tool-service";

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
  /**
   * The collaboration config resolved for this context — the execution's frozen
   * working-copy value, or the legacy saved-definition cascade for pre-field
   * executions. Resolved by `resolveLaneToolCollaborationConfig` (doc 06, D11)
   * so the working-copy-vs-reload decision lives in exactly one place.
   */
  resolvedCollaboration: ResolvedCollaborationConfig;
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
    resolveCollaborationConfig: () => input.resolvedCollaboration,
    triggerWorkflowCollaboration: deps.triggerWorkflowCollaboration,
    setPendingHaltReason: deps.setPendingHaltReason,
  };
}
