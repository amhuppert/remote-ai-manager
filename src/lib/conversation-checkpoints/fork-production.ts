import type { ConversationState } from "@/lib/conversations/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import { assertCheckpointForkBackend } from "./fork-submission";
import { getBackendDescriptor } from "@/lib/agent-backends/registry";
import { admitConfiguredModelSelection } from "@/lib/agent-backends/model-selection-admission";
import { assertBackendExecution } from "@/lib/agent-backends/task-execution";
import { resolveConversationProfileSnapshot } from "@/lib/conversations/profile-resolution";
import { buildConversationCreatedEvent } from "@/lib/conversations/created-event";
import { publishEventBestEffort } from "@/lib/events/publication";
import { createLogger } from "@/lib/logging";
import {
  getConversation,
  getProjectConversation,
  getSession,
  getStateDb,
  getGraphWorkflowExecutionById,
} from "@/lib/state-store";
import { createSpecsRepo } from "@/lib/state-store/specs-repo";
import { getSharedWriteQueue } from "@/lib/state-store/write-queue";
import { getTicketsRepo } from "@/lib/tickets/service-factory";

import { getConversationCheckpointsRepo } from "./service-factory";
import {
  CheckpointForkError,
  createCheckpointForkService,
} from "./fork-service";

import { createCheckpointWorkResolver } from "./fork-work-resolver";

import { checkpointErrorFields } from "./diagnostics";

const logger = createLogger("conversation-checkpoints.fork");

export const admitCheckpointForkSelection = async (
  projectPath: string,
  backend: AgentBackendId,
  modelSelection?: BackendModelSelection,
) => {
  await assertBackendExecution(backend, {
    facet: "conversation",
    executionClass: "ordinary-conversation",
    operation: "checkpoint-fork",
  });
  if (
    !getBackendDescriptor(backend).conversation?.capabilities.checkpointFork
  ) {
    throw new CheckpointForkError(
      "backend_unsupported",
      "This backend has no certified checkpoint fork continuation",
      422,
    );
  }
  const admitted = await admitConfiguredModelSelection({
    backend,
    projectPath,
    modelSelection,
  });
  if (!admitted.ok)
    throw new CheckpointForkError(admitted.code, admitted.message, 422);
  return admitted.modelSelection;
};

export async function admitCheckpointForkTurnSelection(input: {
  projectPath: string;
  conversation: ConversationState;
  backend: AgentBackendId;
  modelSelection?: BackendModelSelection;
}): Promise<BackendModelSelection> {
  const { projectPath, conversation, backend, modelSelection } = input;
  assertCheckpointForkBackend(conversation, backend);
  const initial =
    conversation.promptCount === 0 &&
    conversation.checkpointFork?.initialSelection.backend === backend
      ? conversation.checkpointFork.initialSelection.modelSelection
      : undefined;
  return admitCheckpointForkSelection(
    projectPath,
    backend,
    modelSelection ?? initial,
  );
}

const resolveWork = createCheckpointWorkResolver({
  ticket: (projectPath, number) => getTicketsRepo().find(projectPath, number),
  spec: (id) =>
    createSpecsRepo(getStateDb(), getSharedWriteQueue()).findById(id),
  revision: (id) =>
    createSpecsRepo(getStateDb(), getSharedWriteQueue()).getRevisionSnapshot(
      id,
    ),
  execution: getGraphWorkflowExecutionById,
});

export function getCheckpointForkService() {
  return createCheckpointForkService({
    repo: getConversationCheckpointsRepo,
    async load(projectPath, target) {
      if (target.scope === "project")
        return getProjectConversation(projectPath, target.conversationId);
      const session = await getSession(projectPath, target.sessionName);
      if (session?.archived)
        throw new CheckpointForkError(
          "session_archived",
          "The source session is archived",
        );
      return getConversation(
        projectPath,
        target.sessionName,
        target.conversationId,
      );
    },
    admit: admitCheckpointForkSelection,
    resolveWork: (projectPath, _target, work) => resolveWork(projectPath, work),
    profile: resolveConversationProfileSnapshot,
    publish(target, conversation) {
      publishEventBestEffort({
        build: () =>
          buildConversationCreatedEvent(
            target.scope === "session"
              ? {
                  scope: "session",
                  projectName: target.projectName,
                  sessionName: target.sessionName,
                  conversation,
                }
              : {
                  scope: "project",
                  projectName: target.projectName,
                  conversation,
                },
          ),
        logger,
        failureEvent: "checkpoint.fork.publish_failed",
        describeError: checkpointErrorFields,
        context: { conversationId: conversation.id },
      });
    },
    now: () => new Date().toISOString(),
  });
}
