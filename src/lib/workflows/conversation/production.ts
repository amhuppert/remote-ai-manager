import { admitCheckpointForkSubmission } from "@/lib/conversation-checkpoints/fork-submission";
import { readRuntimeInstructions } from "./runtime-instructions";
import { conversationTargetStoreSessionName } from "@/lib/conversations/conversation-target";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type {
  TranscriptEntry,
  TranscriptBroadcastMeta,
} from "@/lib/prompt/transcript";

import {
  getConversationRuntime,
  applyHostedCostSettlement,
} from "./runtime-state";
import { createLogger } from "@/lib/logging";

import { executeAgentCall as defaultExecuteAgentCall } from "@/lib/workflows/primitives/agent-call-facade";

import {
  createConversationRuntimePolicy,
  type ConversationPolicyInfrastructure,
} from "./runtime-policy";
import { createConversationPolicyState } from "./policy-state";
import { conversationRuntimeKey } from "./runtime-state";
import type { ConversationActorDependencies } from "./actor-dependencies";
const logger = createLogger("conversation-actor");

type ProductionActorDependencies = Omit<
  ConversationActorDependencies,
  "policy"
> & { policy: ConversationPolicyInfrastructure };

export async function loadProductionActorDependencies(): Promise<ProductionActorDependencies> {
  const [
    lockMod,
    semaphoreMod,
    transcriptMod,
    configMod,
    transcriptImagesMod,
    registryMod,
    runtimeRegistryMod,
    childEnvMod,
    commandsMod,
    codexToolMod,
    projectResolverMod,
    debugLogMod,
    stateMod,
    composeForConversationMod,
    globalStoreMod,
    discoveryMod,
    capabilitiesDepsMod,
    messageQueueMod,
    alignmentServiceFactoryMod,
    ticketServiceFactoryMod,
    notepadServiceFactoryMod,
    modelSelectionAdmissionMod,
    memoryServiceFactoryMod,
    validatorInstructionsMod,
    repoConfigMod,
  ] = await Promise.all([
    import("@/lib/prompt/single-flight"),
    import("@/lib/shared/query-semaphore"),
    import("@/lib/prompt/transcript"),
    import("@/lib/config/loader"),
    import("@/lib/images/transcript-images"),
    import("@/lib/agent-backends/registry"),
    import("@/lib/agent-backends/runtime-registry"),
    import("@/lib/shared/child-env"),
    import("@/lib/commands/service"),
    import("@/lib/agent-runs/tool-hint"),
    import("@/lib/projects/resolver"),
    import("@/lib/debug-log/service"),
    import("@/lib/state-store"),
    import("@/lib/mcp/compose-for-conversation"),
    import("@/lib/mcp/global-store"),
    import("@/lib/mcp/discovery"),
    import("@/lib/agent-capabilities/default-deps"),
    import("@/lib/conversations/message-queue-service"),
    import("@/lib/session-alignment/service-factory"),
    import("@/lib/tickets/service-factory"),
    import("@/lib/notepads/service-factory"),
    import("@/lib/agent-backends/model-selection-admission"),
    import("@/lib/memory/service-factory"),
    import("@/lib/workflow-graph/validator-runtime-instructions"),
    import("@/lib/projects/repo-config"),
  ]);

  // The alignment service holds a repo bound to the live DB; construct it once
  // here (the production dependency loader runs lazily) rather than per turn.
  const alignmentService =
    alignmentServiceFactoryMod.createSessionAlignmentServiceForProduction();

  const composePortableMcpForConversation =
    composeForConversationMod.createComposePortableMcpForConversation({
      readGlobalOverrides: () =>
        globalStoreMod.defaultGlobalOverrideStore.read(),
      readProjectOverrides: async (projectPath) => {
        return stateMod.getProjectMcpOverrides(projectPath);
      },
      readSessionOverrides: async (projectPath, sessionName) => {
        const session = await stateMod.getSession(projectPath, sessionName);
        return session?.mcpOverrides;
      },
      readConversationOverrides: async (
        projectPath,
        sessionName,
        conversationId,
      ) => {
        const session = await stateMod.getSession(projectPath, sessionName);
        return session?.conversations.find((c) => c.id === conversationId)
          ?.mcpOverrides;
      },
      discoverSources: (input) => discoveryMod.discoverAllSources(input),
      globalConfigPath: () =>
        globalStoreMod.getDefaultGlobalMcpDefinitionPath(),
    });

  return {
    execution: {
      acquireConversationLock: lockMod.acquireConversationLock,
      acquireQuerySlot: semaphoreMod.acquireQuerySlot,
      readConfig: configMod.readConfig,
      getConversationBackendFactory: registryMod.getConversationBackendFactory,
      backendSupportsCheckpointFork: (backend) =>
        registryMod.getBackendDescriptor(backend).conversation?.capabilities
          .checkpointFork ?? false,
      admitConfiguredModelSelection: (input) =>
        modelSelectionAdmissionMod.admitConfiguredModelSelection(input),
      getConversationCapabilities: (backend: AgentBackendId) =>
        registryMod.getBackendDescriptor(backend).conversation?.capabilities,
      registerBackendRuntime: runtimeRegistryMod.registerRuntime,
      unregisterBackendRuntime: runtimeRegistryMod.unregisterRuntime,
      buildChildEnv: childEnvMod.buildChildEnv,
      resolvePluginPaths: commandsMod.resolvePluginPaths,
      getCodexToolPromptHint: codexToolMod.getCodexToolPromptHint,
      getProjectDisplayName: projectResolverMod.getProjectDisplayName,
      getConversation: stateMod.getConversation,
      getSessionState: stateMod.getSession,
      fileExists: (await import("node:fs")).existsSync,
      executeAgentCall: defaultExecuteAgentCall,
      getTaskRunner: registryMod.getTaskRunner,
      getRuntime: getConversationRuntime,
      applyCostSettlementToHostedActor: applyHostedCostSettlement,
    },
    transcript: {
      getTranscriptPath: transcriptMod.getTranscriptPath,
      appendTranscriptEntryOnce: (cid, entry, meta) =>
        transcriptMod.appendTranscriptEntryOnce(cid, entry, undefined, meta),
      safeAppendTranscriptEntry: (
        cid: string,
        entry: TranscriptEntry,
        meta?: TranscriptBroadcastMeta,
      ) =>
        transcriptMod.safeAppendTranscriptEntry(
          cid,
          entry,
          undefined,
          undefined,
          meta,
        ),
      safeAppendTranscriptEntryOnce: (
        cid: string,
        entry: TranscriptEntry & { id: string },
        meta?: TranscriptBroadcastMeta,
      ) =>
        transcriptMod.safeAppendTranscriptEntryOnce(
          cid,
          entry,
          undefined,
          undefined,
          meta,
        ),
      saveTranscriptImage: transcriptImagesMod.saveTranscriptImage,
      getNextImageIndex: transcriptImagesMod.getNextImageIndex,
      readConversationMessages: transcriptMod.readConversationMessages,
    },
    effects: {
      notifyRuntimeCleanup: async (input) => {
        const [{ notifyRuntimeCleanup }, { dispatchAgentNotification }] =
          await Promise.all([
            import("./runtime-cleanup-notification"),
            import("@/lib/push-notification/dispatcher"),
          ]);
        await notifyRuntimeCleanup(input, {
          appendNotice: transcriptMod.appendNotice,
          push: dispatchAgentNotification,
          log: logger,
        });
      },
      mutateConversation: stateMod.mutateConversation,
      recordNotepadDeliveries: (input) =>
        notepadServiceFactoryMod
          .getNotepadDeliveryTracker()
          .recordDelivered(input),
      recordMemoryIndexDeliveries: (input) =>
        memoryServiceFactoryMod.getMemoryTelemetryService().recordDelivery({
          conversationId: input.conversationId,
          channel: "index",
          kind: input.kind,
          composedAt: input.composedAt,
          notes: input.notes,
        }),
      resetMemoryIndexDelivery: (conversationId) =>
        memoryServiceFactoryMod
          .getMemoryTelemetryService()
          .resetIndexDelivery(conversationId),
      settleNotepadChangeNotice: (notice) =>
        notepadServiceFactoryMod.getNotepadDeliveryTracker().settle(notice),
      claimWorkflowResults: ({
        projectPath,
        sessionName,
        originConversationId,
        attemptId,
      }) =>
        stateMod.claimGraphWorkflowResultDeliveries(
          projectPath,
          sessionName,
          originConversationId,
          attemptId,
        ),
      settleWorkflowResults: ({
        projectPath,
        sessionName,
        originConversationId,
        attemptId,
      }) =>
        stateMod.settleGraphWorkflowResultDeliveries(
          projectPath,
          sessionName,
          originConversationId,
          attemptId,
        ),
      releaseWorkflowResults: ({
        projectPath,
        sessionName,
        originConversationId,
        attemptId,
      }) =>
        stateMod.releaseGraphWorkflowResultDeliveries(
          projectPath,
          sessionName,
          originConversationId,
          attemptId,
        ),
      createReferenceDocument: stateMod.createReferenceDocument,
      confirmQueuedDelivery:
        messageQueueMod.messageQueueService.confirmDelivery,
      markQueuedPending: messageQueueMod.messageQueueService.markPending,
      markQueuedFailed: messageQueueMod.messageQueueService.markFailed,
      markQueuedUncertain: messageQueueMod.messageQueueService.markUncertain,
    },
    context: {
      getWorkflowLaneInstructions:
        validatorInstructionsMod.createValidatorRuntimeInstructionReader({
          getActiveExecution: stateMod.getActiveGraphWorkflowExecution,
          readValidationConfig: async (projectPath) =>
            (await repoConfigMod.readRepoConfig(projectPath))?.validation,
        }),
      getActiveAlignmentInjection: (projectPath: string, sessionName: string) =>
        alignmentService.getActiveInjection(projectPath, sessionName),
      getActiveAlignmentVersion: (projectPath: string, sessionName: string) =>
        alignmentService.getActiveVersion(projectPath, sessionName),
      getLiveTicketBlock: (projectPath: string, sessionName: string) =>
        ticketServiceFactoryMod
          .getLiveTicketContextProvider()
          .getForSession(projectPath, sessionName),
      getMemoryIndexBlock: (request) =>
        memoryServiceFactoryMod
          .getMemoryIndexContextProvider()
          .getForConversation(request),
      readLiveReference: async (target) =>
        (await import("@/lib/live-references/reader")).liveReferenceReader.read(
          target,
        ),
      readNotepadForInjection: (notepadId: string) =>
        notepadServiceFactoryMod
          .getNotepadInjectionReader()
          .readForInjection(notepadId),
      prepareNotepadChangeNotice: (conversationId, references) =>
        notepadServiceFactoryMod
          .getNotepadDeliveryTracker()
          .prepare(conversationId, references),
      getReferenceDocuments: stateMod.getReferenceDocuments,
    },
    policy: {
      composePortableMcp: composePortableMcpForConversation,
      composeCapabilities: capabilitiesDepsMod.defaultComposeForConversation,
      composeDurableProject:
        capabilitiesDepsMod.composeCapabilityConfigForProjectConversation,
      applyRuntimeConfig:
        capabilitiesDepsMod.applyRuntimeConfigToConversationRuntime,
    },
    debug: {
      getDebugLogUrl: debugLogMod.getDebugLogUrl,
    },
    checkpoint: {
      async repo() {
        const { getConversationCheckpointsRepo } =
          await import("@/lib/conversation-checkpoints/service-factory");
        return getConversationCheckpointsRepo();
      },
      now: () => new Date().toISOString(),
    },
    log: logger,
  } satisfies ProductionActorDependencies;
}
import type { ConversationManagerDependencies } from "./manager";
import {
  createConversationActorHost,
  createProvidedMachine,
} from "./actor-host";
import type { ConversationActorRef } from "./machine";
import {
  registerConversationRuntime,
  cleanupConversationRuntime,
} from "./runtime-state";
import {
  resolveConversationPersistenceAdapter,
  forgetConversationPersistence,
} from "./persistence-adapter";
import { loadActorInput } from "./actor-input-loader";
import { admitConversationProfileForTurn } from "@/lib/conversations/profile-admission";
import { getConversationQueueDeps } from "@/lib/conversations/message-queue-drain";
import {
  registerAbortController,
  unregisterAbortController,
} from "@/lib/conversations/abort-registry";
import { queuedMessageNeedsReview } from "@/lib/conversations/message-queue-schemas";
import { ephemeralConversationEffects } from "./effects";
import { conversationCapabilitiesForBackend } from "@/lib/agent-backends/catalog";
import { getBackgroundActivityChannel } from "@/lib/conversations/background-activity";
import { generateCheckpoint } from "@/lib/conversation-checkpoints/generation";
import type { CheckpointScopeKey } from "@/lib/conversation-checkpoints/schemas";
import type { CheckpointAuthorityHydration } from "./checkpoint-restart";

const ACTOR_REGISTRY_KEY = "__cc_conversation_actors";
function productionActorRegistry(): Map<string, ConversationActorRef> {
  const host = globalThis as typeof globalThis & {
    [ACTOR_REGISTRY_KEY]?: Map<string, ConversationActorRef>;
  };
  return (host[ACTOR_REGISTRY_KEY] ??= new Map());
}

/**
 * The checkpoint repository's authority with the restart rules applied, over
 * the production singleton repository. Shared by the actor input loader and
 * startup rehydration so both read the same authority the same way.
 */
async function hydrateProductionCheckpointAuthority(
  key: CheckpointScopeKey,
): Promise<CheckpointAuthorityHydration> {
  const [{ getConversationCheckpointsRepo }, { hydrateCheckpointAuthority }] =
    await Promise.all([
      import("@/lib/conversation-checkpoints/service-factory"),
      import("./checkpoint-restart"),
    ]);
  return hydrateCheckpointAuthority(key, {
    repo: getConversationCheckpointsRepo(),
    now: () => new Date().toISOString(),
    log: createLogger("conversation-manager"),
  });
}

/** Assembles infrastructure without resolving the default manager instance. */
export function createProductionConversationManagerDependencies(): ConversationManagerDependencies {
  let actorDependencies: Promise<ProductionActorDependencies> | undefined;
  return {
    async readRuntimeInstructions(input) {
      return readRuntimeInstructions(
        await loadProductionActorDependencies(),
        input,
        undefined,
      );
    },
    async rehydrate(host) {
      const [
        { loadRehydrationInfrastructure, rehydrateConversationActors },
        { repairQueuedAcceptanceFromCheckpoint },
        { getConversationCheckpointsRepo },
        stateMod,
        { appendTranscriptEntryOnce },
        { messageQueueService },
      ] = await Promise.all([
        import("./rehydration"),
        import("./checkpoint-queue-repair"),
        import("@/lib/conversation-checkpoints/service-factory"),
        import("@/lib/state-store"),
        import("@/lib/prompt/transcript"),
        import("@/lib/conversations/message-queue-service"),
      ]);
      const queue = getConversationQueueDeps();
      return rehydrateConversationActors({
        ...(await loadRehydrationInfrastructure()),
        hydrateCheckpointAuthority: hydrateProductionCheckpointAuthority,
        host,
        queue,
        repairQueuedAcceptance: (identity) =>
          repairQueuedAcceptanceFromCheckpoint(identity, {
            repo: getConversationCheckpointsRepo(),
            readQueue: async (target) =>
              (
                await stateMod.getConversation(
                  target.projectPath,
                  target.sessionName,
                  target.conversationId,
                )
              )?.pendingQueue ?? null,
            confirmDelivery: (input) =>
              messageQueueService.confirmDelivery(input),
            appendUserEntryOnce: (conversationId, entry) =>
              appendTranscriptEntryOnce(conversationId, entry),
            now: () => new Date().toISOString(),
            log: createLogger("conversation-manager"),
          }),
      });
    },
    createHost(callbacks) {
      return createConversationActorHost({
        registry: productionActorRegistry(),
        registerRuntime: registerConversationRuntime,
        getRuntime: getConversationRuntime,
        removeRuntime: cleanupConversationRuntime,
        persistence: resolveConversationPersistenceAdapter,
        machine: (adapter) =>
          createProvidedMachine(adapter, {
            executeDebugCommand: callbacks.executeDebugCommand,
            verifyDebugCleanup: async (input) =>
              (
                await import("@/lib/workflows/debug/cleanup-verification")
              ).runDebugCleanupVerification(input),
            getRuntime: getConversationRuntime,
            drainQueue: callbacks.drainQueue,
            async loadActors(input) {
              actorDependencies ??= loadProductionActorDependencies();
              const deps = await actorDependencies;
              const { createConversationActorImplementations } =
                await import("./actor-implementations");
              const runtime = getConversationRuntime(
                conversationRuntimeKey(
                  input.projectPath,
                  conversationTargetStoreSessionName(input.target),
                  input.target.conversationId,
                ),
              );
              if (!runtime)
                throw new Error("Conversation host is not registered");
              const state = createConversationPolicyState({
                persistence: input.persistence,
                managed: runtime.managed,
                effects: deps.effects,
                getConversation: deps.execution.getConversation,
              });
              const policy = createConversationRuntimePolicy(deps.policy, {
                persistence: input.persistence,
                projectName: input.target.projectName,
                worktreePath:
                  "worktreePath" in input
                    ? input.worktreePath
                    : input.projectPath,
                state,
                getRuntime: () => runtime.managed.backend,
                getTooling: () => runtime.tooling,
              });
              return createConversationActorImplementations({
                ...deps,
                policy,
                effects:
                  input.persistence === "ephemeral"
                    ? ephemeralConversationEffects
                    : deps.effects,
              });
            },
          }),
      });
    },
    getRuntime: getConversationRuntime,
    async loadActorInput(projectPath, sessionName, conversationId) {
      const [
        { getSession, getProjectConversation },
        { getProjectDisplayName },
      ] = await Promise.all([
        import("@/lib/state-store"),
        import("@/lib/projects/resolver"),
      ]);
      return loadActorInput(
        {
          getSession,
          getProjectConversation,
          getProjectDisplayName,
          hydrateCheckpointAuthority: (key) =>
            hydrateProductionCheckpointAuthority(key),
        },
        projectPath,
        sessionName,
        conversationId,
      );
    },
    async readAdmissionState(identity) {
      const { getConversation } = await import("@/lib/state-store");
      const row = await getConversation(
        identity.projectPath,
        identity.sessionName,
        identity.conversationId,
      );
      return {
        found: row !== null,
        requiresQueueReview:
          row?.pendingQueue.some((item) =>
            queuedMessageNeedsReview(item.status),
          ) ?? false,
      };
    },
    admitProfileForTurn: admitConversationProfileForTurn,
    async admitCheckpointForkForTurn(
      identity,
      backend,
      modelSelection,
      isCurrent,
    ) {
      const { getConversation, mutateConversation } =
        await import("@/lib/state-store");
      const row = await getConversation(
        identity.projectPath,
        identity.sessionName,
        identity.conversationId,
      );
      if (!row?.checkpointFork) return null;
      const { admitCheckpointForkTurnSelection } =
        await import("@/lib/conversation-checkpoints/fork-production");
      const selection = await admitCheckpointForkTurnSelection({
        projectPath: identity.projectPath,
        conversation: row,
        backend,
        ...(modelSelection ? { modelSelection } : {}),
      });
      await admitCheckpointForkSubmission(
        { mutateConversation },
        identity,
        backend,
        isCurrent,
      );
      return selection;
    },
    queue: getConversationQueueDeps(),
    persistence: resolveConversationPersistenceAdapter,
    forgetPersistence: forgetConversationPersistence,
    abortIndex: {
      register: registerAbortController,
      unregister: unregisterAbortController,
    },
    checkpoint: {
      async repo() {
        const { getConversationCheckpointsRepo } =
          await import("@/lib/conversation-checkpoints/service-factory");
        return getConversationCheckpointsRepo();
      },
      async readConversation(identity) {
        const { getConversation } = await import("@/lib/state-store");
        return getConversation(
          identity.projectPath,
          identity.sessionName,
          identity.conversationId,
        );
      },
      async readEntries(transcriptPath) {
        const { readTranscriptEntriesWithSeq } =
          await import("@/lib/prompt/transcript");
        return readTranscriptEntriesWithSeq(transcriptPath);
      },
      async findArtifact(conversationId) {
        const { getContextArtifactsRepo } =
          await import("@/lib/context-artifacts/route-handlers");
        return (
          getContextArtifactsRepo()
            .findByConversation(conversationId)
            .find((row) => row.kind === "conversation_compaction") ?? null
        );
      },
      async resolveConfig(projectPath) {
        const [
          { readConfig },
          { resolveCompactionConfig },
          { readRepoConfig },
        ] = await Promise.all([
          import("@/lib/config/loader"),
          import("@/lib/config/cascade"),
          import("@/lib/projects/repo-config"),
        ]);
        return resolveCompactionConfig(
          await readConfig(),
          await readRepoConfig(projectPath),
        );
      },
      async executeTaskRun(input) {
        const { executeWorkflowTaskRun } =
          await import("./execute-workflow-task-run");
        return executeWorkflowTaskRun(input);
      },
      backendSupportsCheckpoint: (backend) =>
        conversationCapabilitiesForBackend(backend).checkpoint,
      captureAvailability: (backend) =>
        conversationCapabilitiesForBackend(backend).handoffCapture,
      async resolveCaptureModel(input) {
        const { resolveCheckpointCaptureSelection } =
          await import("./actor-implementations");
        return resolveCheckpointCaptureSelection(
          await loadProductionActorDependencies(),
          input,
        );
      },
      async acquireCaptureRuntime(input, signal) {
        const { acquireCheckpointCaptureRuntime } =
          await import("./actor-implementations");
        actorDependencies ??= loadProductionActorDependencies();
        const deps = await actorDependencies;
        const runtime = getConversationRuntime(
          conversationRuntimeKey(
            input.projectPath,
            conversationTargetStoreSessionName(input.target),
            input.target.conversationId,
          ),
        );
        if (!runtime) return undefined;
        const state = createConversationPolicyState({
          persistence: "durable",
          managed: runtime.managed,
          effects: deps.effects,
          getConversation: deps.execution.getConversation,
        });
        const policy = createConversationRuntimePolicy(deps.policy, {
          persistence: "durable",
          projectName: input.target.projectName,
          worktreePath: input.worktreePath,
          state,
          getRuntime: () => runtime.managed.backend,
          getTooling: () => runtime.tooling,
        });
        return acquireCheckpointCaptureRuntime(
          { execution: deps.execution, policy },
          input,
          signal,
        );
      },
      async appendCaptureEntryOnce(conversationId, entry) {
        const { appendTranscriptEntryOnce } =
          await import("@/lib/prompt/transcript");
        await appendTranscriptEntryOnce(conversationId, entry);
      },
      async appendUserEntryOnce(conversationId, entry) {
        const { appendTranscriptEntryOnce } =
          await import("@/lib/prompt/transcript");
        await appendTranscriptEntryOnce(conversationId, entry);
      },
      async confirmQueuedDelivery(input) {
        const { messageQueueService } =
          await import("@/lib/conversations/message-queue-service");
        return messageQueueService.confirmDelivery(input);
      },
      getBackgroundActivity: (conversationId) =>
        getBackgroundActivityChannel().get(conversationId),
      getBackgroundActivityEpoch: (conversationId) =>
        getBackgroundActivityChannel().epoch(conversationId),
      generate: (input, deps) => generateCheckpoint(input, deps),
      now: () => new Date().toISOString(),
    },
  };
}
