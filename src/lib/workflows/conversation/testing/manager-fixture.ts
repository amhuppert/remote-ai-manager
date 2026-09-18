import { readRuntimeInstructions } from "../runtime-instructions";
import { generateCheckpoint } from "@/lib/conversation-checkpoints/generation";
import { createConversationActors } from "../actors";
import { createWorkflowTaskRunExecutor } from "../execute-workflow-task-run";
import {
  createConversationManager,
  type ConversationManager,
  type ConversationManagerDependencies,
} from "../manager";
import {
  createConversationActorHost,
  createProvidedMachine,
  type ConversationActorHost,
  type ConversationMachineDependencies,
} from "../actor-host";
import type { ConversationActorRef } from "../machine";
import type { ConversationPersistenceAdapter } from "../persistence-adapter";
import {
  resolveConversationPersistenceAdapter,
  forgetConversationPersistence,
} from "../persistence-adapter";
import {
  conversationRuntimeKey,
  getConversationRuntime,
  registerConversationRuntime,
  cleanupConversationRuntime,
} from "../runtime-state";
import {
  registerAbortController,
  unregisterAbortController,
} from "@/lib/conversations/abort-registry";
import {
  createActorDependenciesFixture,
  createTestActorImplementations,
} from "./actor-deps-fixture";

/** Test infrastructure surrounding the same required application and host constructors. */
export function createConversationManagerFixture(
  options: {
    dependencies?: Partial<Omit<ConversationManagerDependencies, "createHost">>;
    loadActors?: ConversationMachineDependencies["loadActors"];
    verifyDebugCleanup?: ConversationMachineDependencies["verifyDebugCleanup"];
    machine?(
      adapter: ConversationPersistenceAdapter,
      dependencies: ConversationMachineDependencies,
    ): ReturnType<typeof createProvidedMachine>;
  } = {},
) {
  const registry = new Map<string, ConversationActorRef>();
  let host!: ConversationActorHost;
  let machineDependencies!: ConversationMachineDependencies;
  const actors = createTestActorImplementations(
    createActorDependenciesFixture(),
  );
  const manager: ConversationManager = createConversationManager({
    async readRuntimeInstructions(input) {
      const fixture = createActorDependenciesFixture();
      return readRuntimeInstructions(
        { execution: fixture, context: fixture },
        input,
        undefined,
      );
    },
    getRuntime: getConversationRuntime,
    async loadActorInput() {
      throw new Error("Fixture has no stored conversation loader");
    },
    async readAdmissionState() {
      return { found: true, requiresQueueReview: false };
    },
    async admitCheckpointForkForTurn() {
      return null;
    },
    async admitProfileForTurn() {
      return { instructionBlock: null, snapshot: null, lockedAt: null };
    },
    async rehydrate() {
      return 0;
    },
    persistence: resolveConversationPersistenceAdapter,
    forgetPersistence: forgetConversationPersistence,
    abortIndex: {
      register: registerAbortController,
      unregister: unregisterAbortController,
    },
    queue: {
      submitTurn: (input) => manager.submitConversationTurn(input),
      async claimNextTurnBatch() {
        return null;
      },
      async markPending() {},
      async markDelivered() {},
      async markFailed() {},
      async recoverAbandonedDeliveries() {
        return 0;
      },
      async runConversationCommand() {
        throw new Error("Fixture has no conversation command runner");
      },
    },
    checkpoint: {
      // Inert reads — no checkpoint holds or was ever accepted — so ordinary
      // admission and settlement run unchanged; a write means a test reached
      // checkpoint delivery without injecting a real repository.
      async repo() {
        const unavailable = async () => {
          throw new Error("Fixture has no checkpoint repository");
        };
        return {
          createFork: async () => {
            throw new Error("fork creation is outside this fixture");
          },
          beginCapture: unavailable,
          settleCapture: unavailable,
          admitOperation: unavailable,
          admitRecovery: unavailable,
          freezePayload: unavailable,
          commitReady: unavailable,
          beginDelivery: unavailable,
          recordAcceptance: unavailable,
          recordOutcome: unavailable,
          async getStateForAdmission() {
            return { active: null, latestAccepted: null };
          },
          async getOperation() {
            return null;
          },
          async getReceipt() {
            return null;
          },
          async getPayload() {
            return null;
          },
          async listReceipts() {
            return { receipts: [], nextBefore: null };
          },
        };
      },
      async readConversation() {
        return null;
      },
      async readEntries() {
        return { entries: [], maxSeq: -1 };
      },
      async findArtifact() {
        return null;
      },
      async resolveConfig() {
        throw new Error("Fixture has no compaction configuration");
      },
      async executeTaskRun() {
        throw new Error("Fixture has no checkpoint generation lane");
      },
      backendSupportsCheckpoint: () => false,
      acquireCaptureRuntime: async () => undefined,
      appendCaptureEntryOnce: async () => {},
      captureAvailability: () => ({
        available: false,
        mode: null,
        reason: "fixture",
      }),
      resolveCaptureModel: async () => ({ modelId: "opus", parameters: {} }),
      async appendUserEntryOnce() {},
      async confirmQueuedDelivery() {
        return 0;
      },
      getBackgroundActivity: () => null,
      getBackgroundActivityEpoch: () => 0,
      generate: generateCheckpoint,
      now: () => new Date().toISOString(),
    },
    ...options.dependencies,
    createHost(callbacks) {
      machineDependencies = {
        executeDebugCommand: callbacks.executeDebugCommand,
        verifyDebugCleanup:
          options.verifyDebugCleanup ??
          (async () => {
            throw new Error("Fixture has no debug verifier");
          }),
        getRuntime: getConversationRuntime,
        drainQueue: callbacks.drainQueue,
        loadActors: options.loadActors ?? (async () => actors),
      };
      host = createConversationActorHost({
        registry,
        registerRuntime: registerConversationRuntime,
        getRuntime: getConversationRuntime,
        removeRuntime: cleanupConversationRuntime,
        persistence:
          options.dependencies?.persistence ??
          resolveConversationPersistenceAdapter,
        machine: (adapter) => {
          const execution = createConversationActors(
            machineDependencies,
            adapter,
          );
          const machine = options.machine
            ? options.machine(adapter, machineDependencies)
            : createProvidedMachine(adapter, machineDependencies);
          return machine.provide({
            actors: { settleTurn: execution.actors.settleTurn },
            actions: {
              completeTurn: ({ context }) => execution.completeTurn(context),
            },
          });
        },
      });
      return host;
    },
  });
  return {
    manager,
    providedMachine: (adapter: ConversationPersistenceAdapter) =>
      createProvidedMachine(adapter, machineDependencies),
    executeWorkflowTaskRun: createWorkflowTaskRunExecutor(manager),
    host,
    registry,
    actor(projectPath: string, sessionName: string, conversationId: string) {
      return host.get(
        conversationRuntimeKey(projectPath, sessionName, conversationId),
      );
    },
    dispose() {
      for (const [key, actor] of host.entries()) {
        actor.stop();
        host.remove(key, actor);
      }
    },
  };
}
