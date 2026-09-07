import { readRuntimeInstructions } from "../runtime-instructions";
import { conversationTargetStoreSessionName } from "@/lib/conversations/conversation-target";
import type { ConversationAddress } from "../turn-spec";
import type { ConversationState } from "@/lib/conversations/schemas";
import { createTestActorImplementations } from "@/lib/workflows/conversation/testing/actor-deps-fixture";
import type { ActorFixtureDependencies } from "@/lib/workflows/conversation/testing/actor-deps-fixture";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { admitConversationProfile } from "@/lib/conversations/profile-admission";
import { createConversationManagerFixture } from "./manager-fixture";
import { createMessageQueueService } from "@/lib/conversations/message-queue-service";
import { loadActorInput } from "../actor-input-loader";
import { createActorDependenciesFixture } from "./actor-deps-fixture";

import { _resetForTesting as resetRuntime } from "../runtime-state";
import {
  setConversationPersistenceAdapterDeps,
  _resetConversationPersistenceAdapterDepsForTesting,
} from "../persistence-adapter";
import {
  setPersistenceDeps,
  _resetForTesting as resetPersistence,
} from "../persistence";
import type { ConversationBinding } from "../turn-spec";

/** Composes the production lifecycle over an isolated store and provider seams. */
export async function createLifecycleFixture(
  options: {
    beforeProfileAdmission?(): Promise<void>;
    verifyDebugCleanup?: import("../actor-host").ConversationMachineDependencies["verifyDebugCleanup"];
    address?: ConversationAddress;
    binding?: ConversationBinding;
    conversation?: Partial<ConversationState>;
    actorDeps?: Partial<ActorFixtureDependencies>;
  } = {},
) {
  resetRuntime();
  const persistence = createPersistenceFixture();
  const address = options.binding?.address ??
    options.address ?? {
      projectPath: "/lifecycle-fixture",
      target: {
        scope: "session",
        projectName: "lifecycle-fixture",
        sessionName: "s",
        conversationId: "c",
      },
    };
  const identity = {
    projectPath: address.projectPath,
    sessionName: conversationTargetStoreSessionName(address.target),
    conversationId: address.target.conversationId,
  };
  const projectName = address.target.projectName;
  persistence.seedProject(identity.projectPath);
  const binding: ConversationBinding = options.binding ?? {
    kind: "durable",
    address,
  };
  if (address.target.scope === "session")
    persistence.seedSession(identity.projectPath, identity.sessionName);
  if (binding.kind === "durable") {
    const conversation = makeConversationState({
      ...options.conversation,
      id: identity.conversationId,
    });
    if (address.target.scope === "project")
      await persistence.seedProjectConversation(
        identity.projectPath,
        conversation,
      );
    else
      await persistence.seedConversation(
        identity.projectPath,
        identity.sessionName,
        conversation,
      );
  }
  const queue = createMessageQueueService({
    ...persistence.deps,
    getProjectDisplayName: () => projectName,
    broadcast: () => {},
    now: () => new Date().toISOString(),
    newId: () => crypto.randomUUID(),
  });
  setPersistenceDeps({
    getConversationMachineSnapshot:
      persistence.store.getConversationMachineSnapshot,
    upsertConversationMachineSnapshot:
      persistence.store.upsertConversationMachineSnapshot,
    deleteConversationMachineSnapshot:
      persistence.store.deleteConversationMachineSnapshot,
  });
  setConversationPersistenceAdapterDeps({
    mutateConversation: persistence.store.mutateConversation,
    publishSessionStatus: () => ({ delivered: true }),
    queueAutoName: () => {},
  });
  const actorDependencies = createActorDependenciesFixture({
    ...persistence.deps,
    markQueuedDelivered: queue.markDelivered,
    markQueuedUncertain: queue.markUncertain,
    markQueuedPending: queue.markPending,
    markQueuedFailed: queue.markFailed,
    getTaskRunner: () => ({
      backend: "claude",
      async run() {
        return {
          text: "completed",
          usage: null,
          error: null,
          timedOut: false,
          failure: null,
          continuationDisposition: "retain",
        };
      },
    }),
    ...options.actorDeps,
  });
  const conversationActors = createTestActorImplementations(actorDependencies);
  const core: ReturnType<typeof createConversationManagerFixture> =
    createConversationManagerFixture({
      verifyDebugCleanup: options.verifyDebugCleanup,
      loadActors: async () => conversationActors,
      dependencies: {
        readRuntimeInstructions: (input) =>
          readRuntimeInstructions(
            { execution: actorDependencies, context: actorDependencies },
            input,
            undefined,
          ),
        loadActorInput: (projectPath, sessionName, conversationId) =>
          loadActorInput(
            {
              getSession: persistence.store.getSession,
              getProjectConversation: persistence.store.getProjectConversation,
              getProjectDisplayName: () => projectName,
            },
            projectPath,
            sessionName,
            conversationId,
          ),
        async readAdmissionState(key) {
          const row = await persistence.store.getConversation(
            key.projectPath,
            key.sessionName,
            key.conversationId,
          );
          return {
            found: row !== null,
            requiresQueueReview:
              row?.pendingQueue.some((item) => item.status === "uncertain") ??
              false,
          };
        },
        admitProfileForTurn: (key) =>
          admitConversationProfile(
            {
              async mutateConversation(p, s, c, label, mutate) {
                await options.beforeProfileAdmission?.();
                return persistence.store.mutateConversation(
                  p,
                  s,
                  c,
                  label,
                  mutate,
                );
              },
            },
            key,
          ),
        queue: {
          ...queue,
          submitTurn: (input) => core.manager.submitConversationTurn(input),
          async runConversationCommand() {
            throw new Error("No command expected");
          },
        },
      },
    });

  return {
    ...core,
    persistence,
    queue,
    identity,
    projectName,
    binding,
    async close() {
      await core.manager.stopConversationActor(
        identity.projectPath,
        identity.sessionName,
        identity.conversationId,
        "fixture_cleanup",
      );
      resetRuntime();
      resetPersistence();
      _resetConversationPersistenceAdapterDepsForTesting();
      persistence.close();
    },
  };
}
