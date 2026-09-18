import { conversationStoreIdentity } from "@/lib/conversations/conversation-target";
import { ManagedConversationRuntime } from "../runtime-binding";
import type { ConversationActorDependencies } from "../actor-dependencies";
import {
  createConversationActorImplementations,
  type ConversationActorImplementations,
} from "../actor-implementations";
import { ephemeralConversationEffects } from "../effects";
import { createConversationPolicyState } from "../policy-state";
import {
  getConversationRuntime,
  conversationRuntimeKey,
} from "../runtime-state";
import type { Logger } from "@/lib/logging";
import type { CheckpointDeliveryDependencies } from "../pre-turn/checkpoint-seed";
/**
 * Actor dependency fixture for tests that drive the REAL conversation actor
 * implementations (`runTaskRunTurnForMachine`, `executePromptForMachine`).
 *
 * Each fixture constructs the production execution core with explicit dependencies. Every
 * seam here is inert (no filesystem, no store, no network); `executeAgentCall`
 * defaults to the REAL facade so the structured-output gate, its candidate
 * extraction fall-through, and its bounded repair all run for real, with only
 * the backend runner faked via `getTaskRunner`.
 *
 * Test-only: never imported by production code.
 */

import { vi } from "vitest";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import { executeAgentCall as defaultExecuteAgentCall } from "@/lib/workflows/primitives/agent-call-facade";

import type { ConversationBackendRuntime } from "@/lib/agent-backends/conversation";

export function createMockBackendRuntime(
  overrides: Partial<ConversationBackendRuntime> = {},
): ConversationBackendRuntime {
  return {
    backend: overrides.backend ?? "claude",
    status: "alive",
    // Callers that want a specific backend's model pass it explicitly; deriving
    // one from the backend id here would just be another identity branch.
    modelSelection: {
      modelId: "opus",
      parameters: { effort: "high" },
    },
    outputFormat: undefined,

    sendTurn: vi.fn(),
    close: vi.fn(async () => {}),
    ...overrides,
  } satisfies ConversationBackendRuntime;
}

export function createActorDependenciesFixture(
  overrides: Partial<ActorFixtureDependencies> = {},
): ActorFixtureDependencies {
  const backendRuntime = createMockBackendRuntime();
  const factory = {
    backend: "claude" as const,
    createRuntime: vi.fn(async () => backendRuntime),
    validateModelSelection: vi.fn(),
  };

  return {
    acquireConversationLock: vi.fn(() => vi.fn()),
    acquireQuerySlot: vi.fn(async () => vi.fn()),
    getTranscriptPath: vi.fn(async (id: string) => `/transcripts/${id}.jsonl`),
    readConfig: vi.fn(async () => ({
      agentBackends: {
        claude: {
          modelSelection: {
            modelId: "opus",
            parameters: { effort: "high" },
          },
          timeoutMs: 300_000,
        },
        codex: {
          modelSelection: {
            modelId: "gpt-5.4",
            parameters: { fast: "false", reasoning: "high" },
          },
          timeoutMs: null,
        },
        cursor: {
          modelSelection: {
            modelId: "composer-2.5",
            parameters: { fast: "true" },
          },
          timeoutMs: null,
        },
      },
      maxTurns: 50,
      idleQuerySessionTtlMs: 300_000,
    })),
    getProjectDisplayName: vi.fn((p: string) => p.split("/").pop() ?? p),
    getDebugLogUrl: vi.fn(
      (id: string) =>
        `http://localhost:3000/api/debug-logs?conversationId=${id}`,
    ),
    safeAppendTranscriptEntry: vi.fn(async () => {}),
    safeAppendTranscriptEntryOnce: vi.fn(async () => {}),
    appendTranscriptEntryOnce: vi.fn(async () => {}),
    saveTranscriptImage: vi.fn(
      async (
        _id: string,
        index: number,
        mediaType: string,
      ): Promise<string> => {
        const ext = mediaType.split("/")[1] ?? "bin";
        return `/persisted/${index}.${ext}`;
      },
    ),
    getNextImageIndex: vi.fn(async () => 1),
    getConversationBackendFactory: vi.fn(() => factory),
    backendSupportsCheckpointFork: () => true,
    admitConfiguredModelSelection: vi.fn(async ({ modelSelection }) => ({
      ok: true as const,
      modelSelection,
    })),
    getConversationCapabilities: vi.fn(() => ({
      queue: {
        acceptsWhileRunning: true,
        deliveryTiming: "in_turn" as const,
      },
      continuationStrength: "precise_session" as const,
      fork: "native" as const,
      structuredOutput: "backend_native" as const,
      contextWindowMetrics: true,
      nativeMidTurnAskUser: true,
      externalTurns: true,
      checkpoint: false,
      checkpointFork: false,
      handoffCapture: {
        available: false as const,
        mode: null,
        reason: "Capture is unavailable",
      },
      capabilityKinds: [
        { kind: "skills" as const, applyTiming: "idle_live" as const },
        { kind: "plugins" as const, applyTiming: "idle_live" as const },
        {
          kind: "agents" as const,
          applyTiming: "next_conversation" as const,
        },
      ],
    })),
    registerBackendRuntime: vi.fn(),
    unregisterBackendRuntime: vi.fn(),
    // Defaults to the unprovisioned-server outcome, so a test that cares about
    // launch authority has to opt in and say which identity it expects.
    buildChildEnv: vi.fn(() => ({
      HOME: "/home/test",
      NODE_ENV: "test" as const,
    })),
    resolvePluginPaths: vi.fn(async () => []),
    getCodexToolPromptHint: vi.fn(() => ""),
    mutateConversation: vi.fn(async () => {}),
    getConversation: vi.fn(async () => null),
    getSessionState: vi.fn(async () => null),
    getActiveAlignmentInjection: vi.fn(async () => null),
    getActiveAlignmentVersion: vi.fn(async () => null),
    getLiveTicketBlock: vi.fn(async () => null),
    getMemoryIndexBlock: vi.fn(async () => null),
    readLiveReference: vi.fn(async () => null),
    readNotepadForInjection: vi.fn(async () => null),
    recordNotepadDeliveries: vi.fn(async () => {}),
    recordMemoryIndexDeliveries: vi.fn(async () => {}),
    resetMemoryIndexDelivery: vi.fn(async () => {}),
    prepareNotepadChangeNotice: vi.fn(async (conversationId: string) => ({
      conversationId,
      block: null,
      advances: [],
    })),
    settleNotepadChangeNotice: vi.fn(async () => {}),
    claimWorkflowResults: vi.fn(async () => []),
    settleWorkflowResults: vi.fn(async () => 0),
    releaseWorkflowResults: vi.fn(async () => 0),
    createReferenceDocument: vi.fn(async () => ({})),
    getReferenceDocuments: vi.fn(async () => []),
    readConversationMessages: vi.fn(async () => []),
    fileExists: vi.fn(() => false),
    applyMcpAtTurnStart: vi.fn(
      async (_input: {
        projectPath: string;
        sessionName: string;
        conversationId: string;
        backend: "claude" | "codex";
      }) => ({
        conversationId: "conv-1",
        backend: "claude" as const,
        disposition: "applied_now" as const,
        effectiveConfigHash: "hash-1",
      }),
    ),
    applyCapabilityAtTurnStart: vi.fn(async () => ({})),
    applyCapabilityWhenIdle: vi.fn(async () => ({})),
    composeCapabilityConfigForConversation: vi.fn(async () => undefined),
    composeCapabilityConfigForProjectConversation: vi.fn(async () => undefined),
    composePortableMcpForConversation: vi.fn<
      ActorFixtureDependencies["composePortableMcpForConversation"]
    >(async (args) => ({
      servers: [
        {
          id: "gateway-alpha",
          transport: "streamable-http" as const,
          url: `http://localhost:3000/api/projects/${args.projectName}/sessions/${args.sessionName}/mcp`,
        },
        ...(args.transientPortableMcp?.servers ?? []),
      ],
    })),
    executeAgentCall: defaultExecuteAgentCall,
    getTaskRunner: () => ({
      backend: "claude",
      async run() {
        throw new Error("Fixture task runner is not configured");
      },
    }),
    confirmQueuedDelivery: vi.fn(async () => 0),
    notifyRuntimeCleanup: vi.fn(async () => {}),
    markQueuedPending: vi.fn(async () => {}),
    markQueuedFailed: vi.fn(async () => {}),
    markQueuedUncertain: vi.fn(async () => {}),
    // Inert like every other seam: reads answer "no checkpoint" so ordinary
    // and fork turns run unchanged; only a delivery's writes need a real one.
    checkpoint: {
      async repo() {
        const unavailable = async () => {
          throw new Error("Fixture has no checkpoint repository");
        };
        return {
          getPayload: async () => null,
          getOperation: async () => null,
          getStateForAdmission: async () => ({
            active: null,
            latestAccepted: null,
          }),
          beginDelivery: unavailable,
          recordAcceptance: unavailable,
          recordOutcome: unavailable,
        };
      },
      now: () => new Date().toISOString(),
    },
    log: createCapturingLogger(),
    ...overrides,
  } satisfies ActorFixtureDependencies;
}

export type ActorFixtureDependencies = Omit<
  ConversationActorDependencies["execution"],
  "getRuntime"
> &
  Omit<ConversationActorDependencies["effects"], "getRuntime"> &
  Omit<ConversationActorDependencies["context"], "getRuntime"> &
  Omit<ConversationActorDependencies["transcript"], "getRuntime"> &
  Omit<ConversationActorDependencies["policy"], "state"> &
  Omit<ConversationActorDependencies["debug"], "getRuntime"> & {
    checkpoint: CheckpointDeliveryDependencies;
    log: Logger;
  };

export function groupActorFixtureDependencies(
  deps: ActorFixtureDependencies,
): ConversationActorDependencies {
  return {
    execution: {
      acquireConversationLock: deps.acquireConversationLock,
      acquireQuerySlot: deps.acquireQuerySlot,
      readConfig: deps.readConfig,
      getProjectDisplayName: deps.getProjectDisplayName,
      getConversationBackendFactory: deps.getConversationBackendFactory,
      backendSupportsCheckpointFork: deps.backendSupportsCheckpointFork,
      admitConfiguredModelSelection: deps.admitConfiguredModelSelection,
      getConversationCapabilities: deps.getConversationCapabilities,
      registerBackendRuntime: deps.registerBackendRuntime,
      unregisterBackendRuntime: deps.unregisterBackendRuntime,
      buildChildEnv: deps.buildChildEnv,
      resolvePluginPaths: deps.resolvePluginPaths,
      getCodexToolPromptHint: deps.getCodexToolPromptHint,
      getConversation: deps.getConversation,
      getSessionState: deps.getSessionState,
      fileExists: deps.fileExists,
      executeAgentCall: deps.executeAgentCall,
      getTaskRunner: deps.getTaskRunner,
      getRuntime: getConversationRuntime,
    },
    effects: {
      notifyRuntimeCleanup: deps.notifyRuntimeCleanup,
      mutateConversation: deps.mutateConversation,
      recordMemoryIndexDeliveries: deps.recordMemoryIndexDeliveries,
      resetMemoryIndexDelivery: deps.resetMemoryIndexDelivery,
      recordNotepadDeliveries: deps.recordNotepadDeliveries,
      settleNotepadChangeNotice: deps.settleNotepadChangeNotice,
      claimWorkflowResults: deps.claimWorkflowResults,
      settleWorkflowResults: deps.settleWorkflowResults,
      releaseWorkflowResults: deps.releaseWorkflowResults,
      createReferenceDocument: deps.createReferenceDocument,
      markQueuedUncertain: deps.markQueuedUncertain,
      confirmQueuedDelivery: deps.confirmQueuedDelivery,
      markQueuedPending: deps.markQueuedPending,
      markQueuedFailed: deps.markQueuedFailed,
    },
    context: {
      getActiveAlignmentInjection: deps.getActiveAlignmentInjection,
      getActiveAlignmentVersion: deps.getActiveAlignmentVersion,
      getLiveTicketBlock: deps.getLiveTicketBlock,
      getMemoryIndexBlock: deps.getMemoryIndexBlock,
      readLiveReference: deps.readLiveReference,
      readNotepadForInjection: deps.readNotepadForInjection,
      prepareNotepadChangeNotice: deps.prepareNotepadChangeNotice,
      getReferenceDocuments: deps.getReferenceDocuments,
    },
    transcript: {
      getTranscriptPath: deps.getTranscriptPath,
      appendTranscriptEntryOnce: deps.appendTranscriptEntryOnce,
      safeAppendTranscriptEntry: deps.safeAppendTranscriptEntry,
      safeAppendTranscriptEntryOnce: deps.safeAppendTranscriptEntryOnce,
      saveTranscriptImage: deps.saveTranscriptImage,
      getNextImageIndex: deps.getNextImageIndex,
      readConversationMessages: deps.readConversationMessages,
    },
    policy: {
      state: createConversationPolicyState({
        persistence: "durable",
        managed: new ManagedConversationRuntime("fixture"),
        effects: deps,
        getConversation: deps.getConversation,
      }),
      composePortableMcpForConversation: deps.composePortableMcpForConversation,
      applyMcpAtTurnStart: deps.applyMcpAtTurnStart,
      applyCapabilityAtTurnStart: deps.applyCapabilityAtTurnStart,
      applyCapabilityWhenIdle: deps.applyCapabilityWhenIdle,
      composeCapabilityConfigForConversation:
        deps.composeCapabilityConfigForConversation,
      composeCapabilityConfigForProjectConversation:
        deps.composeCapabilityConfigForProjectConversation,
    },
    debug: {
      getDebugLogUrl: deps.getDebugLogUrl,
    },
    checkpoint: deps.checkpoint,
    log: deps.log,
  };
}

export function createTestActorImplementations(
  deps: ActorFixtureDependencies,
): ConversationActorImplementations {
  const groups = groupActorFixtureDependencies(deps);
  function forInput(input: {
    persistence: "durable" | "ephemeral";
    projectPath: string;
    target: import("@/lib/conversations/conversation-target").ConversationTarget;
  }) {
    const identity = conversationStoreIdentity(input);
    const managed =
      getConversationRuntime(
        conversationRuntimeKey(
          input.projectPath,
          identity.sessionName,
          identity.conversationId,
        ),
      )?.managed ?? new ManagedConversationRuntime(identity.conversationId);
    return createConversationActorImplementations({
      ...groups,
      policy: {
        ...groups.policy,
        state: createConversationPolicyState({
          persistence: input.persistence,
          managed,
          effects: groups.effects,
          getConversation: deps.getConversation,
        }),
      },
      effects:
        input.persistence === "ephemeral"
          ? ephemeralConversationEffects
          : groups.effects,
    });
  }
  return {
    acquireCheckpointCaptureRuntime: (input, signal) =>
      forInput({
        ...input,
        persistence: "durable",
      }).acquireCheckpointCaptureRuntime(input, signal),
    resolveCheckpointCaptureSelection: (input) =>
      createConversationActorImplementations(
        groups,
      ).resolveCheckpointCaptureSelection(input),
    prepareTurnForMachine: (input, signal) =>
      forInput(input).prepareTurnForMachine(input, signal),
    executePromptForMachine: (input, signal) =>
      forInput(input).executePromptForMachine(input, signal),
    runTaskRunTurnForMachine: (input, signal) =>
      forInput(input).runTaskRunTurnForMachine(input, signal),
    finalizeQueuedDeliveryForMachine: (input) =>
      forInput(input).finalizeQueuedDeliveryForMachine(input),
  };
}
