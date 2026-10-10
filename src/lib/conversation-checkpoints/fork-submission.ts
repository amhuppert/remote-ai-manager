import type { ConversationState } from "@/lib/conversations/schemas";
import type {
  ConversationProfileAdmissionDeps,
  ConversationProfileAdmissionIdentity,
} from "@/lib/conversations/profile-admission";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";

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
/**
 * The selection a checkpoint fork's message asks for: the one it names, else
 * on its first message the selection it was forked with. Its backend is fixed
 * by its first submission.
 */
export function checkpointForkSelection(
  conversation: ConversationState,
  backend: AgentBackendId,
  modelSelection: BackendModelSelection | undefined,
): BackendModelSelection | undefined {
  assertCheckpointForkBackend(conversation, backend);
  const initial = conversation.checkpointFork?.initialSelection;
  return (
    modelSelection ??
    (conversation.promptCount === 0 && initial?.backend === backend
      ? initial.modelSelection
      : undefined)
  );
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

/**
 * A checkpoint fork's turn: its backend is fixed by its first submission, and
 * its first message runs on the selection it was forked with unless the
 * message names one. Null for a conversation that is not a checkpoint fork.
 */
export function createCheckpointForkTurnAdmission(deps: {
  getConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
  mutateConversation: ConversationProfileAdmissionDeps["mutateConversation"];
  /** The backend's certified checkpoint fork continuation, and the selection configured models admit. */
  admitSelection(
    projectPath: string,
    backend: AgentBackendId,
    modelSelection?: BackendModelSelection,
  ): Promise<BackendModelSelection>;
}): (
  identity: ConversationProfileAdmissionIdentity,
  backend: AgentBackendId,
  modelSelection: BackendModelSelection | undefined,
  isCurrent?: () => boolean,
) => Promise<BackendModelSelection | null> {
  return async (identity, backend, modelSelection, isCurrent = () => true) => {
    const conversation = await deps.getConversation(
      identity.projectPath,
      identity.sessionName,
      identity.conversationId,
    );
    if (!conversation?.checkpointFork) return null;
    const selection = await deps.admitSelection(
      identity.projectPath,
      backend,
      checkpointForkSelection(conversation, backend, modelSelection),
    );
    await admitCheckpointForkSubmission(
      { mutateConversation: deps.mutateConversation },
      identity,
      backend,
      isCurrent,
    );
    return selection;
  };
}
