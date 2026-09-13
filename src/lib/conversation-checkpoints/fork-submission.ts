import type { ConversationState } from "@/lib/conversations/schemas";
import type {
  ConversationProfileAdmissionDeps,
  ConversationProfileAdmissionIdentity,
} from "@/lib/conversations/profile-admission";
import type { AgentBackendId } from "@/lib/shared/schemas";

import { createLogger } from "@/lib/logging";
import { CheckpointForkError } from "./fork-service";
const logger = createLogger("conversation-checkpoints.fork");

export function assertCheckpointForkBackend(
  conversation: ConversationState,
  backend: AgentBackendId,
): void {
  const submitted = conversation.checkpointFork?.submission;
  if (submitted && submitted.backend !== backend) {
    throw new CheckpointForkError(
      "checkpoint_fork_backend_locked",
      "The checkpoint fork backend is fixed after its first submission",
    );
  }
}
export function stampCheckpointForkSubmission(
  conversation: ConversationState,
  backend: AgentBackendId,
  at: string,
): void {
  if (!conversation.checkpointFork) return;
  assertCheckpointForkBackend(conversation, backend);
  conversation.agentBackend = backend;
  conversation.checkpointFork.submission ??= { backend, at };
}
export async function admitCheckpointForkSubmission(
  deps: ConversationProfileAdmissionDeps,
  identity: ConversationProfileAdmissionIdentity,
  backend: AgentBackendId,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const stamped = await deps.mutateConversation(
    identity.projectPath,
    identity.sessionName,
    identity.conversationId,
    "admit-checkpoint-fork",
    (conversation) => {
      if (!conversation.checkpointFork || !isCurrent()) return false;
      stampCheckpointForkSubmission(
        conversation,
        backend,
        new Date().toISOString(),
      );
      return true;
    },
  );
  if (stamped)
    logger.info("checkpoint.fork.submission_admitted", {
      ...identity,
      backend,
    });
}
