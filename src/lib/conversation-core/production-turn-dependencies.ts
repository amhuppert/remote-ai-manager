import { productionPassiveSubscriptionDependencies } from "@/lib/conversation-core/contributions/passive-subscription-context";
import { conversationTargetStoreSessionName } from "@/lib/conversations/conversation-target";
import type {
  TranscriptEntry,
  TranscriptBroadcastMeta,
} from "@/lib/prompt/transcript";
import { createLogger } from "@/lib/logging";
import { executeAgentCall as defaultExecuteAgentCall } from "@/lib/workflows/primitives/agent-call-facade";
import { readLineageCumulativeCost } from "@/lib/conversation-core/turn/task-run-cost";
import type { ConversationTurnDependencies } from "@/lib/conversation-core/turn/dependencies";

const logger = createLogger("conversation-turn");

/**
 * The turn dependencies of a conversation in production, composed from the
 * domain services. Loaded lazily: composing them imports most of CC.
 */
export async function loadConversationTurnDependencies(): Promise<ConversationTurnDependencies> {
  const [
    transcriptMod,
    configMod,
    transcriptImagesMod,
    registryMod,
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
    ticketStorageMod,
    notepadServiceFactoryMod,
    modelSelectionAdmissionMod,
    memoryServiceFactoryMod,
    validatorInstructionsMod,
    repoConfigMod,
  ] = await Promise.all([
    import("@/lib/prompt/transcript"),
    import("@/lib/config/loader"),
    import("@/lib/images/transcript-images"),
    import("@/lib/agent-backends/registry"),
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
    import("@/lib/tickets/storage-production"),
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
      readConversationOverrides: async (projectPath, target) => {
        const conversation = await stateMod.getConversation(
          projectPath,
          conversationTargetStoreSessionName(target),
          target.conversationId,
        );
        return conversation?.mcpOverrides;
      },
      discoverSources: (input) => discoveryMod.discoverAllSources(input),
      globalConfigPath: () =>
        globalStoreMod.getDefaultGlobalMcpDefinitionPath(),
    });

  return {
    subscriptions: productionPassiveSubscriptionDependencies,
    execution: {
      readConfig: configMod.readConfig,
      getConversationBackendFactory: registryMod.getConversationBackendFactory,
      admitConfiguredModelSelection: (input) =>
        modelSelectionAdmissionMod.admitConfiguredModelSelection(input),
      getCodexToolPromptHint: codexToolMod.getCodexToolPromptHint,
      getProjectDisplayName: projectResolverMod.getProjectDisplayName,
      getConversation: stateMod.getConversation,
      getSessionState: stateMod.getSession,
      fileExists: (await import("node:fs")).existsSync,
      executeAgentCall: defaultExecuteAgentCall,
      getTaskRunner: registryMod.getTaskRunner,
    },
    transcript: {
      getTranscriptPath: transcriptMod.getTranscriptPath,
      readLineageCumulativeCost,
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
            import("@/lib/conversation-core/turn/runtime-cleanup-notification"),
            import("@/lib/push-notification/dispatcher"),
          ]);
        await notifyRuntimeCleanup(input, {
          appendNotice: transcriptMod.appendNotice,
          push: dispatchAgentNotification,
          log: logger,
        });
      },
      mutateConversation: stateMod.mutateConversation,
      async recordRuntimeLossNotice(input) {
        const { getSubscriptionService } =
          await import("@/lib/subscriptions/service-factory");
        return getSubscriptionService().recordRuntimeLossNotice(input);
      },
      async prepareRuntimeLossNotice(input) {
        const { getSubscriptionService } =
          await import("@/lib/subscriptions/service-factory");
        return getSubscriptionService().prepareRuntimeLossNotice(input);
      },
      recordNotepadDeliveries: (input) =>
        notepadServiceFactoryMod
          .getNotepadAcceptedContextRecorder()
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
        ticketStorageMod
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
    log: logger,
  };
}
