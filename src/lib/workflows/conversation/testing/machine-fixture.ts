import { createProvidedMachine } from "../actor-host";
import { ephemeralConversationPersistence } from "../persistence-adapter";
import { getConversationRuntime } from "../runtime-state";
import { runDebugCleanupVerification } from "@/lib/workflows/debug/cleanup-verification";
import {
  createActorDependenciesFixture,
  createTestActorImplementations,
} from "./actor-deps-fixture";

export function createConversationMachineFixture() {
  const actors = createTestActorImplementations(
    createActorDependenciesFixture(),
  );
  return createProvidedMachine(ephemeralConversationPersistence, {
    executeDebugCommand: async () => {
      throw new Error("Fixture has no semantic debug command delivery");
    },
    getRuntime: getConversationRuntime,
    loadActors: async () => actors,
    verifyDebugCleanup: runDebugCleanupVerification,
    drainQueue() {},
  }).provide({
    actions: {
      broadcastConversationStatus() {},
      broadcastAskQuestion() {},
      broadcastDebugModeStatus() {},
      dispatchPushNotification() {},
    },
  });
}
