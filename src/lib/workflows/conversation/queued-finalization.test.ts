import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { createConversationActors } from "./actors";
import { ephemeralConversationPersistence } from "./persistence-adapter";
import { createTestActorImplementations } from "@/lib/workflows/conversation/testing/actor-deps-fixture";
let conversationActors: ReturnType<typeof createTestActorImplementations>;
import { createManagedRuntimeFixture } from "@/lib/workflows/conversation/testing/runtime-binding-fixture";
import { afterEach, expect, it } from "vitest";
import { createActor, fromPromise, waitFor } from "xstate";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { createMessageQueueService } from "@/lib/conversations/message-queue-service";
import { createActorDependenciesFixture } from "./testing/actor-deps-fixture";

import { conversationMachine } from "./machine";
import {
  registerConversationRuntime,
  getConversationRuntime,
  conversationRuntimeKey,
  _resetForTesting,
} from "./runtime-state";
import type {
  ConversationInput,
  ExecutePromptInput,
  PromptActorResult,
} from "./types";

afterEach(() => {
  _resetForTesting();
});

it.each(["prepare", "execute"])(
  "retains a claim when %s fails before input acceptance",
  async (phase) => {
    const fixture = createPersistenceFixture();
    const key = {
      projectPath: "/queue-finalize",
      sessionName: "s",
      conversationId: "c",
    };
    fixture.seedProject(key.projectPath);
    fixture.seedSession(key.projectPath, key.sessionName);
    const conversation = makeConversationState({
      id: key.conversationId,
      agentBackend: "cursor",
    });
    await fixture.seedConversation(
      key.projectPath,
      key.sessionName,
      conversation,
    );
    const queue = createMessageQueueService({
      ...fixture.deps,
      getProjectDisplayName: () => "queue-finalize",
      broadcast: () => {},
      now: () => new Date().toISOString(),
      newId: () => crypto.randomUUID(),
    });
    const entry = await queue.enqueue({
      ...key,
      content: [{ type: "text", text: "retain after failure" }],
    });
    const claim = await queue.claimNextTurnBatch(key);
    if (!claim) throw new Error("missing claim");
    conversationActors = createTestActorImplementations(
      createActorDependenciesFixture({
        markQueuedUncertain: queue.markUncertain,
      }),
    );
    registerConversationRuntime(
      conversationRuntimeKey(
        key.projectPath,
        key.sessionName,
        key.conversationId,
      ),
      {
        managed: createManagedRuntimeFixture(
          conversationRuntimeKey(
            key.projectPath,
            key.sessionName,
            key.conversationId,
          ),
        ),
        abortController: new AbortController(),
      },
    );
    const execution = createConversationActors(
      {
        executeDebugCommand: async () => {
          throw new Error("Fixture has no semantic debug command delivery");
        },
        verifyDebugCleanup: async () => {
          throw new Error("No debug verification in queued finalization");
        },
        getRuntime: getConversationRuntime,
        loadActors: async () => conversationActors,
        drainQueue() {},
      },
      ephemeralConversationPersistence,
    );
    const machine = conversationMachine.provide({
      actors: {
        settleTurn: execution.actors.settleTurn,
        prepareTurn: fromPromise(async () => {
          if (phase === "prepare") throw new Error("no slot");
          return { transcriptPath: "/t" };
        }),
        executePrompt: fromPromise<PromptActorResult, ExecutePromptInput>(
          async () => {
            throw new Error("config read failed");
          },
        ),
      },
      actions: {
        persistSnapshot: () => {},
        syncDerivedFields: () => {},
        broadcastConversationStatus: () => {},
        releaseResources: () => {},
        drainPendingQueue: () => {},
      },
    });
    const input: ConversationInput = {
      lastActivityAt: conversation.createdAt,
      totalCostUsd: null,
      totalDurationMs: null,
      totalTurns: null,
      contextTokens: null,
      contextWindowMax: null,
      projectPath: key.projectPath,
      target: targetFromStoreSessionName(
        "queue-finalize",
        key.sessionName,
        key.conversationId,
      ),
      worktreePath: key.projectPath,
      createdAt: conversation.createdAt,
      forkedFrom: null,
      role: null,
      transcriptPath: null,
      agentBackend: "cursor",
      backendRef: null,
      promptCount: 0,
      persistence: "durable",
    };
    const actor = createActor(machine, { input });
    try {
      actor.start();
      actor.send({
        type: "SUBMIT_PROMPT",
        streamId: "queue-test",
        promptText: "retain after failure",
        queuedDelivery: claim,
      });
      await waitFor(
        actor,
        (snapshot) =>
          snapshot.matches("idle") && snapshot.context.promptCount === 1,
        { timeout: 2000 },
      );
      const reloaded = await fixture
        .recreateStore()
        .getConversation(key.projectPath, key.sessionName, key.conversationId);
      expect(reloaded?.pendingQueue).toMatchObject([
        { id: entry.id, status: "uncertain" },
      ]);
      expect(await queue.claimNextTurnBatch(key)).toBeNull();
    } finally {
      actor.stop();
      fixture.close();
    }
  },
);
