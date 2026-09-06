import { createLogger } from "@/lib/logging";
import type { ConversationBackendCreateInput } from "../conversation";
import {
  BackendAdmissionError,
  backendExecutionRefusal,
} from "../execution-admission";
import { CURSOR_BACKEND_ID } from "./backend-id";
import {
  cursorBackendMetadata,
  cursorConversationExecution,
  cursorConversationFsWriteRestriction,
} from "./descriptor";

const logger = createLogger("agent-backends.cursor.policy");

export function assertCursorRuntimePolicy(
  input: ConversationBackendCreateInput,
): void {
  if (input.fsWritePolicy === undefined) {
    const refusal = backendExecutionRefusal(
      {
        id: CURSOR_BACKEND_ID,
        label: cursorBackendMetadata.label,
        facets: { conversation: true, tasks: false },
        execution: {
          conversation: {
            ...cursorConversationExecution,
            fsWriteRestriction: cursorConversationFsWriteRestriction,
          },
          tasks: null,
        },
      },
      {
        facet: "conversation",
        operation: "conversation-create",
        executionClass: input.executionClass,
        requiresPrivilegedInstructions: input.requiresPrivilegedInstructions,
      },
    );
    if (!refusal) return;
    logger.warn("backend.execution_admission_rejected", {
      ...refusal,
      conversationId: input.conversationId,
    });
    throw new BackendAdmissionError(refusal);
  }
  const refusal = {
    backend: CURSOR_BACKEND_ID,
    operation: "conversation-create",
    code: "backend-fs-policy-unsupported" as const,
    message: `${cursorBackendMetadata.label} cannot enforce an exact filesystem write policy on its conversation runtime`,
  };
  logger.warn("cursor.fs_policy_rejected", {
    ...refusal,
    conversationId: input.conversationId,
    mode: input.persistedRef === null ? "fresh" : "resume",
    allowCount: input.fsWritePolicy.allowWrite.length,
    denyCount: input.fsWritePolicy.denyWrite.length,
  });
  throw new BackendAdmissionError(refusal);
}
