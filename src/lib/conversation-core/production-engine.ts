import { getConversationTranscriptProjection } from "@/lib/agent-backends/conversation-policy";
import { createCapabilityConfigComposer } from "@/lib/agent-capabilities/runtime-seed";
import { getBackgroundActivityChannel } from "@/lib/conversations/background-activity";
import {
  conversationTargetStoreSessionName,
  type ConversationTarget,
} from "@/lib/conversations/conversation-target";
import { recordConversationCostSettlement } from "@/lib/conversations/cost-settlement";
import { publishEvent } from "@/lib/events/publication";
import { createLogger } from "@/lib/logging";
import { generateAndApplyConversationName } from "@/lib/conversations/name-generation";
import { getProjectDisplayName } from "@/lib/projects/resolver";
import { admitExplicitModelSelection } from "@/lib/agent-backends/model-selection-admission";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  getConversation,
  getSession,
  mutateConversation,
} from "@/lib/state-store";
import { resolveCapabilitySeedForNewRuntime } from "@/lib/conversation-core/contributions/capability-cascade";
import {
  resolveBackendStallTimeoutMs,
  resolveBackendTimeoutMs,
  resolveTurnModelSelection,
} from "@/lib/conversation-core/contributions/resolve-model-effort";
import { loadConversationTurnDependencies } from "@/lib/conversation-core/production-turn-dependencies";
import { prepareRuntimeInstructions } from "@/lib/conversation-core/turn/runtime-instructions";
import { createQueuedDeliveryAccounting } from "@/lib/conversation-core/contributions/queued-delivery-accounting";
import { persistTurnImages } from "@/lib/conversation-core/contributions/image-persistence";
import { getConversationCheckpointsRepo } from "@/lib/conversation-checkpoints/service-factory";
import { createCheckpointContinuation } from "./checkpoints";
import type { TaskTurnPort } from "./executor";
import {
  createTaskLane,
  createTaskTurns,
  type TaskLane,
  type TaskLaneDeps,
} from "./task-turns";
import { acquireQuerySlot } from "@/lib/shared/query-semaphore";
import { assertBackendExecution } from "@/lib/agent-backends/task-execution";
import {
  getTaskTranscriptProjection,
  resolveAgentBackendTurnDefaults,
} from "@/lib/agent-backends/conversation-policy";
import { prepareTaskPrompt } from "@/lib/conversation-core/turn/turn-context";
import { readLineageCumulativeCost } from "@/lib/conversation-core/turn/task-run-cost";
import {
  createInteractiveTurns,
  type InteractiveTurnDeps,
  type InteractiveTurns,
} from "./interactive-turns";
import { createProductionConversationRecords } from "./production-records";
import { createRuntimeApplicationState } from "./runtime-application-state";
import { prepareTurnInput } from "./turn-input";
import { runtimeRegistryIndex } from "@/lib/agent-backends/runtime-registry";
import { createRuntimeHost, type RuntimeHost } from "./runtime-host";
import { createTurnEngine, type TurnEngine } from "./turn-engine";

export interface CoreTurnRuntime {
  host: RuntimeHost;
  engine: TurnEngine;
  interactiveTurns: InteractiveTurns;
  taskTurns: TaskTurnPort;
  /** A fresh lane for a sequence of related tasks on no conversation (one checkpoint build's generation). */
  taskLane(): TaskLane;
}

const log = createLogger("conversation-core");

/** A session conversation works in its session's worktree; a project conversation in the project root. */
async function worktreeOf(
  projectPath: string,
  target: ConversationTarget,
): Promise<string> {
  if (target.scope === "project") return projectPath;
  const session = await getSession(projectPath, target.sessionName);
  if (session === null)
    throw new Error(`Session ${target.sessionName} no longer exists`);
  return session.worktreePath;
}

/**
 * The core's turn engine over the same production primitives the conversation
 * actor uses: instruction composition, MCP and capability seeds, the backend
 * registry, AgentCall, transcript appends and cost settlement.
 */
export async function createProductionTurnRuntime(options: {
  /** The debug workflow's cleanup verification, owned by the composition that runs the core. */
  startDebugVerification: InteractiveTurnDeps["startDebugVerification"];
}): Promise<CoreTurnRuntime> {
  const deps = await loadConversationTurnDependencies();
  const composeCapabilitySeed = createCapabilityConfigComposer(
    deps.policy.composeCapabilities,
  );
  const applicationState = createRuntimeApplicationState({
    conversations: { getConversation, mutateConversation },
    publish: publishEvent,
    log,
  });

  const host = createRuntimeHost({
    factory: (backend) => deps.execution.getConversationBackendFactory(backend),
    async instructions(conversation, selection) {
      const prepared = await prepareRuntimeInstructions(
        deps,
        {
          projectPath: conversation.projectPath,
          worktreePath: conversation.worktreePath,
          target: conversation.target,
          turn: selection,
        },
        conversation.profile,
      );
      return {
        sessionInstructions: prepared.sessionInstructions,
        alignmentVersion: prepared.alignmentVersion,
      };
    },
    async tooling(conversation) {
      const portableMcp = await deps.policy.composePortableMcp({
        backend: conversation.backend,
        projectPath: conversation.projectPath,
        target: conversation.target,
        worktreePath: conversation.worktreePath,
      });
      const seed = await resolveCapabilitySeedForNewRuntime(
        {
          composeCapabilityConfigForConversation: composeCapabilitySeed,
          composeCapabilityConfigForProjectConversation:
            deps.policy.composeDurableProject,
        },
        {
          projectPath: conversation.projectPath,
          projectName: conversation.projectName,
          sessionName: conversationTargetStoreSessionName(conversation.target),
          conversationId: conversation.conversationId,
          worktreePath: conversation.worktreePath,
          backend: conversation.backend,
          isProjectConversation: conversation.target.scope === "project",
          emitStreamError: (message) =>
            log.warn("conversation_core.capability_seed_error", {
              conversationId: conversation.conversationId,
              message,
            }),
        },
      );
      return {
        overrides: {
          portableMcp,
          ...(seed?.capabilities !== undefined
            ? { capabilities: seed.capabilities }
            : {}),
        },
        ...(seed?.runtimeState !== undefined
          ? { capabilityState: seed.runtimeState }
          : {}),
      };
    },
    beginSeed: applicationState.beginSeed,
    callbacks(conversation) {
      const storeSessionName = conversationTargetStoreSessionName(
        conversation.target,
      );
      const identity = {
        projectPath: conversation.projectPath,
        projectName: conversation.projectName,
        storeSessionName,
        conversationId: conversation.conversationId,
      };
      return {
        onCostSettled(settlement) {
          void recordConversationCostSettlement(identity, settlement, {
            mutateConversation: deps.effects.mutateConversation,
            // The core hosts no actor: the row is the only total to fold into.
            applyToHostedActor: () => ({ applied: false }),
            publish: publishEvent,
            appendTranscriptEntryOnce: (conversationId, entry) =>
              deps.transcript.safeAppendTranscriptEntryOnce(
                conversationId,
                entry,
                {
                  projectName: conversation.projectName,
                  storeSessionName,
                },
              ),
          }).catch((error: unknown) =>
            log.warn("conversation_core.cost_settlement_failed", {
              conversationId: conversation.conversationId,
              error: getErrorMessage(error),
            }),
          );
        },
        onBackgroundTasksLost(info) {
          // Nothing runs outside a core attempt: tasks still alive when a runtime
          // closes are gone, and the indicator must not keep claiming otherwise.
          getBackgroundActivityChannel().record(
            {
              projectName: conversation.projectName,
              sessionName: storeSessionName,
              conversationId: conversation.conversationId,
            },
            null,
          );
          const summary = info.tasks
            .map((task) =>
              task.description !== null
                ? `${task.taskId} (${task.description})`
                : task.taskId,
            )
            .join(", ");
          log.warn("conversation_core.background_tasks_lost", {
            conversationId: conversation.conversationId,
            reason: info.reason,
            taskCount: info.tasks.length,
          });
          void deps.transcript.safeAppendTranscriptEntry(
            conversation.conversationId,
            {
              timestamp: new Date().toISOString(),
              type: "notice",
              role: "notice",
              content: [
                {
                  type: "text",
                  text: `${info.tasks.length} background task(s) ended with the agent session (${info.reason}): ${summary}.`,
                },
              ],
            },
            { projectName: conversation.projectName, storeSessionName },
          );
        },
        onBackgroundActivity(activity) {
          // A background task's progress after the agent's own output: the turn still works.
          engine.notifyActivity(conversation.conversationId);
          getBackgroundActivityChannel().record(
            {
              projectName: conversation.projectName,
              sessionName: storeSessionName,
              conversationId: conversation.conversationId,
            },
            activity,
          );
        },
      };
    },
    index: runtimeRegistryIndex,
    log,
  });

  const engine = createTurnEngine({
    host,
    executeAgentCall: deps.execution.executeAgentCall,
    transcript: deps.transcript,
    projection: getConversationTranscriptProjection,
    async timeouts(backend) {
      const config = await deps.execution.readConfig();
      return {
        timeoutMs: resolveBackendTimeoutMs(backend, config),
        stallTimeoutMs: resolveBackendStallTimeoutMs(backend, config),
      };
    },
    onCompacted: (conversationId) =>
      deps.effects.resetMemoryIndexDelivery(conversationId),
    recordAccepted: applicationState.recordAccepted,
    onCleanupUnverified(conversation) {
      void deps.effects
        .notifyRuntimeCleanup({
          target: conversation.target,
          worktreePath: conversation.worktreePath,
        })
        .catch((error: unknown) =>
          log.error("conversation_core.cleanup_notification_failed", {
            conversationId: conversation.conversationId,
            error: getErrorMessage(error),
          }),
        );
    },
    log,
  });

  const interactiveTurns = createInteractiveTurns({
    engine,
    records: createProductionConversationRecords(),
    host,
    worktreeOf,
    continuation: createCheckpointContinuation({
      repo: getConversationCheckpointsRepo,
      transcript: deps.transcript,
      release: (conversationId) => host.release(conversationId),
      now: () => new Date().toISOString(),
      log,
    }),
    async resolveModelSelection({
      projectPath,
      backend,
      transcriptPath,
      explicit,
    }) {
      const priorMessages =
        explicit === null
          ? await deps.transcript.readConversationMessages(transcriptPath)
          : [];
      const selection = resolveTurnModelSelection({
        backend,
        config: await deps.execution.readConfig(),
        explicitModelSelection: explicit,
        priorMessages,
      });
      return admitExplicitModelSelection({
        projectPath,
        backend,
        selection,
        factory: deps.execution.getConversationBackendFactory(backend),
      });
    },
    prepareInput: (request) => prepareTurnInput(deps, request),
    nameConversation(input) {
      void generateAndApplyConversationName({
        ...input,
        trigger: "auto",
      }).catch((error: unknown) =>
        log.warn("conversation_core.naming_failed", {
          conversationId: input.conversationId,
          error: getErrorMessage(error),
        }),
      );
    },
    async requestUserQuestion(scope, questions, signal) {
      const { inTurnQuestionService } =
        await import("@/lib/conversations/in-turn-question-service");
      return inTurnQuestionService.request(scope, questions, signal);
    },
    async persistImages({ conversationId, promptText, images }) {
      const persisted = await persistTurnImages(deps.transcript, {
        conversationId,
        promptText,
        images,
      });
      return {
        promptText: persisted.assembled.rewrittenPromptText,
        imageRefs: persisted.imageRefs,
      };
    },
    queuedDelivery: ({ identity, delivery, appendUserEntry }) =>
      createQueuedDeliveryAccounting(deps.effects, {
        projectPath: identity.projectPath,
        sessionName: identity.storeSessionName,
        conversationId: identity.conversationId,
        queuedDelivery: delivery,
        appendUserEntry,
      }),
    failQueued: ({ identity, delivery, error }) =>
      deps.effects.markQueuedFailed({
        projectPath: identity.projectPath,
        sessionName: identity.storeSessionName,
        conversationId: identity.conversationId,
        ids: delivery.messageIds,
        deliveryAttemptId: delivery.deliveryAttemptId,
        error,
      }),
    returnQueued: ({ identity, delivery, error }) =>
      deps.effects.markQueuedPending({
        projectPath: identity.projectPath,
        sessionName: identity.storeSessionName,
        conversationId: identity.conversationId,
        ids: delivery.messageIds,
        deliveryAttemptId: delivery.deliveryAttemptId,
        error,
      }),
    transcript: {
      appendTranscriptEntryOnce: (conversationId, entry, meta) =>
        deps.transcript.appendTranscriptEntryOnce(conversationId, entry, meta),
    },
    getProjectDisplayName,
    startDebugVerification: options.startDebugVerification,
    log,
  });
  const taskProtocol: Omit<TaskLaneDeps, "acquireSlot"> = {
    async admit({ backend, turn }) {
      await assertBackendExecution(backend, {
        facet: "tasks",
        operation: "task-run",
        executionClass: turn.executionClass,
        executionProfile: turn.executionProfile ?? "standard",
        requiresPrivilegedInstructions: turn.requiresPrivilegedInstructions,
        requiresFsWriteRestriction: turn.fsWritePolicy !== undefined,
      });
    },
    async resolveSettings({ projectPath, backend, modelSelection, timeoutMs }) {
      const config = await deps.execution.readConfig();
      const defaults = resolveAgentBackendTurnDefaults({
        backend,
        config,
        explicit: { modelSelection },
      });
      const admission = await deps.execution.admitConfiguredModelSelection({
        backend,
        projectPath,
        modelSelection: defaults.modelSelection,
        config,
      });
      if (!admission.ok) throw new Error(admission.message);
      return {
        modelSelection: admission.modelSelection,
        timeoutMs: timeoutMs ?? defaults.timeoutMs,
        stallTimeoutMs: defaults.stallTimeoutMs,
      };
    },
    executeAgentCall: deps.execution.executeAgentCall,
    getTaskRunner: (backend) => deps.execution.getTaskRunner(backend),
    log,
  };
  const taskTurns = createTaskTurns({
    ...taskProtocol,
    records: createProductionConversationRecords(),
    host,
    preparePrompt: (input) => prepareTaskPrompt(deps, input),
    worktreeOf,
    transcript: deps.transcript,
    projection: getTaskTranscriptProjection,
    getProjectDisplayName,
    lineageCost: (conversationId, lineageId) =>
      readLineageCumulativeCost(conversationId, lineageId),
  });
  return {
    host,
    engine,
    interactiveTurns,
    taskTurns,
    // A conversation's task takes its capacity from the executor; a lane task takes its own.
    taskLane: () =>
      createTaskLane({
        ...taskProtocol,
        acquireSlot: (label, signal) =>
          acquireQuerySlot(label, signal !== undefined ? { signal } : {}),
      }),
  };
}
