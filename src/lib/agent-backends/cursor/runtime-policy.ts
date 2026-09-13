import { createLogger } from "@/lib/logging";
import type { ConversationBackendCreateInput } from "../conversation";
import type { AgentTaskRequest, FsWritePolicy } from "../task";
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
      requiresFsWriteRestriction: input.fsWritePolicy !== undefined,
    },
  );
  if (refusal) {
    logger.warn("backend.execution_admission_rejected", {
      ...refusal,
      conversationId: input.conversationId,
    });
    throw new BackendAdmissionError(refusal);
  }
  if (input.fsWritePolicy === undefined) return;
  logger.warn("cursor.fs_policy_instruction_only", {
    conversationId: input.conversationId,
    mode: input.persistedRef === null ? "fresh" : "resume",
    allowCount: input.fsWritePolicy.allowWrite.length,
    denyCount: input.fsWritePolicy.denyWrite.length,
  });
}

export function cursorWritePolicyInstructions(
  policy: FsWritePolicy | undefined,
): string[] {
  if (policy === undefined) return [];
  return [
    "Filesystem limits for this run:\n" +
      `Write only within these paths: ${JSON.stringify(policy.allowWrite)}.\n` +
      `Do not modify these paths: ${JSON.stringify(policy.denyWrite)}.\n` +
      "All other paths are read-only. Do not escape these limits through symlinks, path traversal, shell commands, subprocesses, MCP tools, or delegated agents. Include these limits when delegating.",
  ];
}

export function cursorTaskPolicyInstructions(
  input: AgentTaskRequest,
): string[] {
  const instructions: string[] = [];
  if (input.fsWritePolicy === undefined && input.sandboxMode === "read-only") {
    instructions.push(
      "Do not modify any files. This task is read-only, including all tools and delegated agents.",
    );
  }
  if (
    input.fsWritePolicy === undefined &&
    input.sandboxMode === "workspace-write"
  ) {
    instructions.push(
      `Write only within these paths: ${JSON.stringify([input.workingDirectory, ...(input.additionalDirectories ?? [])])}. All other paths are read-only.`,
    );
  }
  if (input.networkAccessEnabled === false)
    instructions.push("Do not use the network or network-capable tools.");
  if (input.webSearchMode === "disabled" || input.webSearchMode === "cached")
    instructions.push(
      "Do not perform live web searches. Use the information already provided.",
    );
  return instructions;
}
