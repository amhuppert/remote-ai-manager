import { readRuntimeInstructions } from "../runtime-instructions";
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
