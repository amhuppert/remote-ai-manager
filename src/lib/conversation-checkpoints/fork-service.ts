import { createHash } from "node:crypto";

import type { AgentProfileSnapshot } from "@/lib/agent-profiles/schemas";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { ConversationTarget } from "@/lib/conversations/conversation-target";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { stableStringify } from "@/lib/state-store/serialization";
import { buildConversation } from "@/lib/conversations/build-conversation";
import { createLogger } from "@/lib/logging";

import type {
  CheckpointForkRequest,
  CheckpointRelatedWork,
} from "./fork-schemas";
import type {
  ConversationCheckpointsRepo,
  CreatedCheckpointFork,
} from "./repo";
import type { CheckpointScopeKey } from "./schemas";
import { isValidCheckpointForkPayload } from "./fork-validation";
import { checkpointForkFraming } from "./fork-framing";

const logger = createLogger("conversation-checkpoints.fork");

export class CheckpointForkError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "CheckpointForkError";
  }
}

export interface CheckpointForkServiceDeps {
  repo(): ConversationCheckpointsRepo;
  load(
    projectPath: string,
    target: ConversationTarget,
  ): Promise<ConversationState | null>;
  admit(
    projectPath: string,
    backend: AgentBackendId,
    model: BackendModelSelection,
  ): Promise<BackendModelSelection>;
  resolveWork(
    projectPath: string,
    target: ConversationTarget,
    work: CheckpointRelatedWork,
  ): Promise<void>;
  profile(projectPath: string): Promise<AgentProfileSnapshot>;
  publish(target: ConversationTarget, conversation: ConversationState): void;
  now(): string;
}

export interface CheckpointForkServiceInput {
  projectPath: string;
  source: ConversationTarget;
  operationId: string;
  request: CheckpointForkRequest;
}

export function createCheckpointForkService(deps: CheckpointForkServiceDeps) {
  function requestHash(input: CheckpointForkServiceInput) {
    return createHash("sha256")
      .update(
        stableStringify({
          source: input.source,
          operationId: input.operationId,
          request: input.request,
        }),
      )
      .digest("hex");
  }
  async function replay(
    input: CheckpointForkServiceInput,
  ): Promise<CreatedCheckpointFork | null> {
    const conversation = await deps.load(input.projectPath, {
      ...input.source,
      conversationId: input.request.requestId,
    });
    if (!conversation) return null;
    if (conversation.checkpointFork?.requestHash !== requestHash(input)) {
      throw new CheckpointForkError(
        "request_id_conflict",
        "The request id already belongs to another fork",
      );
    }
    const operation = await deps.repo().getOperation(
      {
        projectPath: input.projectPath,
        scope: input.source.scope,
        sessionName:
          input.source.scope === "session" ? input.source.sessionName : null,
        conversationId: conversation.id,
      },
      conversation.checkpointFork.operationId,
    );
    if (!operation)
      throw new CheckpointForkError(
        "checkpoint_not_found",
        "The fork's saved operation is unavailable",
        404,
      );
    logger.info("checkpoint.fork.reused", {
      conversationId: conversation.id,
      operationId: operation.id,
    });
    return { conversation, operation, reused: true };
  }
  async function prepare(input: CheckpointForkServiceInput) {
    const { projectPath, source, operationId, request } = input;
    const sourceKey: CheckpointScopeKey = {
      projectPath,
      scope: source.scope,
      sessionName: source.scope === "session" ? source.sessionName : null,
      conversationId: source.conversationId,
    };
    const key = { ...sourceKey, conversationId: request.requestId };
    const repo = deps.repo();
    const sourceConversation = await deps.load(projectPath, source);
    if (sourceConversation === null)
      throw new CheckpointForkError(
        "conversation_not_found",
        "Source conversation not found",
        404,
      );
    if (
      sourceConversation.archived ||
      sourceConversation.role !== null ||
      sourceConversation.owner !== null
    ) {
      throw new CheckpointForkError(
        "conversation_owned",
        "Choose an ordinary, non-archived, unowned source conversation",
      );
    }
    const operation = await repo.getOperation(sourceKey, operationId);
    const payload = await repo.getPayload(sourceKey, operationId);
    if (operation === null || payload === null)
      throw new CheckpointForkError(
        "checkpoint_not_found",
        "Choose a saved checkpoint",
        404,
      );
    if (!isValidCheckpointForkPayload(payload))
      throw new CheckpointForkError(
        "invalid_payload",
        "The saved checkpoint failed its version, byte-count or integrity check",
      );
    const modelSelection = await deps.admit(
      projectPath,
      request.backend,
      request.modelSelection,
    );
    if (request.relatedWork)
      await deps.resolveWork(projectPath, source, request.relatedWork);
    const parentOrigin = sourceConversation.checkpointFork;
    const origin = {
      source,
      sourceOperationId: operation.id,
      operationId: request.requestId,
      ordinal: operation.ordinal,
      evidenceSource:
        parentOrigin?.operationId === operation.id
          ? parentOrigin.evidenceSource
          : source,
      schemaVersion: payload.schemaVersion,
      seedSha256: payload.seedSha256,
      capturedThroughSeq: payload.sourceBasis.capturedThroughSeq,
      requestHash: requestHash(input),
      relatedWork: request.relatedWork,
      initialSelection: { backend: request.backend, modelSelection },
    };
    checkpointForkFraming(key.conversationId, origin);
    return { repo, sourceKey, key, origin };
  }

  return {
    async check(input: CheckpointForkServiceInput): Promise<void> {
      if (await replay(input)) return;
      await prepare(input);
    },
    async create(
      input: CheckpointForkServiceInput,
    ): Promise<CreatedCheckpointFork> {
      const existing = await replay(input);
      if (existing) return existing;
      const { repo, sourceKey, key, origin } = await prepare(input);
      const conversation = buildConversation({
        id: input.request.requestId,
        scope: input.source.scope,
        name: input.request.name,
        pendingPromptText: input.request.task,
        createdAt: deps.now(),
        agentBackend: input.request.backend,
        profileSnapshot: await deps.profile(input.projectPath),
      });
      const result = await repo.createFork({
        sourceKey,
        key,
        sourceOperationId: input.operationId,
        origin,
        conversation,
      });
      if (!result.ok) {
        logger.warn("checkpoint.fork.refused", {
          conversationId: input.source.conversationId,
          code: result.refusal.code,
        });
        throw new CheckpointForkError(
          result.refusal.code,
          result.refusal.reason,
        );
      }
      if (!result.value.reused)
        deps.publish(
          { ...input.source, conversationId: conversation.id },
          result.value.conversation,
        );
      return result.value;
    },
  };
}
