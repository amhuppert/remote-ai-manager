import { afterEach, expect, it } from "vitest";
import { createActor, fromPromise, waitFor } from "xstate";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { createMessageQueueService } from "@/lib/conversations/message-queue-service";
import { createActorImplementationDepsFixture } from "./testing/actor-deps-fixture";
import {
  setActorDeps,
  _resetActorDepsForTesting,
} from "./actor-implementations";
import { conversationMachine } from "./machine";
import {
  registerConversationRuntime,
  conversationRuntimeKey,
  _resetForTesting,
} from "./runtime-state";
import type {
  ConversationInput,
  ExecutePromptInput,
  PromptActorResult,
} from "./types";

afterEach(() => {
  _resetActorDepsForTesting();
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
    setActorDeps(
      createActorImplementationDepsFixture({
        markQueuedUncertain: queue.markUncertain,
      }),
    );
    registerConversationRuntime(
      conversationRuntimeKey(
        key.projectPath,
        key.sessionName,
        key.conversationId,
      ),
      { abortController: new AbortController() },
    );
    const machine = conversationMachine.provide({
      actors: {
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
      ...key,
      projectName: "queue-finalize",
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
