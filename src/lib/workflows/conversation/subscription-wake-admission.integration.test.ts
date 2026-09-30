import { afterEach, expect, it } from "vitest";
import { appendFile, mkdir, mkdtemp, open, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { ConversationBackendTurnResult } from "@/lib/agent-backends/conversation";
import { createTranscriptEntryIdIndex } from "@/lib/prompt/transcript";
import { createSubscriptionWakeAdmissionReader } from "@/lib/conversations/message-queue-subscription-admission";
import { drainConversationQueue } from "@/lib/conversations/message-queue-drain";
import { createMockBackendRuntime } from "./testing/actor-deps-fixture";
import { createLifecycleFixture } from "./testing/lifecycle-fixture";

let fixture: Awaited<ReturnType<typeof createLifecycleFixture>> | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

const wakeTurn = {
  promptText: "Source update",
  inputOrigin: "generated" as const,
  queuedDelivery: {
    messageIds: ["wake"],
    deliveryAttemptId: "attempt",
    subscriptionBatchId: "batch",
  },
};

const completedResult: ConversationBackendTurnResult = {
  backendRef: null,
  costUsd: 0.01,
  durationMs: 1,
  numTurns: 1,
  contextTokens: 1,
  contextWindowMax: 200000,
  contentBlocks: [],
  aborted: false,
  compacted: false,
  failure: null,
  continuationDisposition: "retain",
};

it("keeps an unhosted pending question parked when only subscription wakes are nudged", async () => {
  fixture = await createLifecycleFixture({
    conversation: { pendingQuestionId: "question", pendingQuestions: [] },
  });
  await fixture.queue.enqueue({
    ...fixture.identity,
    id: "batch",
    inputOrigin: "generated",
    metadata: { kind: "subscription_update", batchId: "batch" },
    content: [{ type: "text", text: "Source update" }],
  });
  await fixture.manager.ensureConversationActorAndDrain(
    fixture.identity.projectPath,
    fixture.identity.sessionName,
    fixture.identity.conversationId,
  );
  expect(
    Boolean(
      fixture.actor(
        fixture.identity.projectPath,
        fixture.identity.sessionName,
        fixture.identity.conversationId,
      ),
    ),
  ).toBe(false);
  expect(
    (
      await fixture.persistence
        .recreateStore()
        .getConversation(
          fixture.identity.projectPath,
          fixture.identity.sessionName,
          fixture.identity.conversationId,
        )
    )?.pendingQuestionId,
  ).toBe("question");
});

it("rechecks archival that occurs during profile admission before dispatching a wake", async () => {
  fixture = await createLifecycleFixture({
    beforeProfileAdmission: async () => {
      if (!fixture) throw new Error("Fixture missing");
      await fixture.persistence.store.mutateConversation(
        fixture.identity.projectPath,
        fixture.identity.sessionName,
        fixture.identity.conversationId,
        "archive during admission",
        (row) => {
          row.archived = true;
        },
      );
    },
  });
  await fixture.manager.ensureConversationLifecycle(fixture.binding);
  const admission = await fixture.manager.submitConversationTurn({
    binding: fixture.binding,
    turn: wakeTurn,
  });
  expect(admission).toMatchObject({ kind: "refused", code: "busy" });
  expect(
    fixture
      .actor(
        fixture.identity.projectPath,
        fixture.identity.sessionName,
        fixture.identity.conversationId,
      )
      ?.getSnapshot().value,
  ).toBe("idle");
});

it("rechecks an approval hold that appears during the final fork admission await", async () => {
  let held = false;
  fixture = await createLifecycleFixture({
    subscriptionWakeHold: async () => (held ? "Pending approval" : null),
    beforeForkAdmission: async () => {
      held = true;
    },
  });
  await fixture.manager.ensureConversationLifecycle(fixture.binding);
  expect(
    await fixture.manager.submitConversationTurn({
      binding: fixture.binding,
      turn: wakeTurn,
    }),
  ).toMatchObject({ kind: "refused", code: "busy" });
});

it("does not redeliver a reviewed retry whose input acceptance was archived before its queue acknowledgement failed", async () => {
  const tempRoot = path.join(process.cwd(), ".cc", "temp");
  await mkdir(tempRoot, { recursive: true });
  const directory = await mkdtemp(path.join(tempRoot, "wake-receipt-"));
  const transcriptPath = path.join(directory, "transcript.jsonl");
  const index = createTranscriptEntryIdIndex({
    stat,
    openRange: (filePath) => open(filePath, "r"),
  });
  let dispatches = 0;
  try {
    fixture = await createLifecycleFixture({
      subscriptionWakeHold: createSubscriptionWakeAdmissionReader({
        hasAcceptedInput: (_conversationId, batchId) =>
          index.has(transcriptPath, batchId),
        readHold: async () => null,
      }),
      actorDeps: {
        getConversationBackendFactory: () => ({
          backend: "claude",
          validateModelSelection() {},
          createRuntime: async () =>
            createMockBackendRuntime({
              sendTurn: async (input) => {
                dispatches++;
                await input.onEvent({ type: "input_accepted" });
                return completedResult;
              },
            }),
        }),
        appendTranscriptEntryOnce: async (_conversationId, entry) => {
          if (!(await index.has(transcriptPath, entry.id)))
            await appendFile(transcriptPath, JSON.stringify(entry) + "\n");
        },
        confirmQueuedDelivery: async () => {
          throw new Error("Queue receipt unavailable");
        },
      },
    });
    await fixture.manager.ensureConversationLifecycle(fixture.binding);
    const entry = await fixture.queue.enqueue({
      ...fixture.identity,
      id: "initial-queue-id",
      inputOrigin: "generated",
      metadata: { kind: "subscription_update", batchId: "batch" },
      content: [{ type: "text", text: "Source update" }],
    });
    const claim = await fixture.queue.claimNextTurnBatch(fixture.identity);
    if (!claim) throw new Error("Missing claim");
    const admission = await fixture.manager.submitConversationTurn({
      binding: fixture.binding,
      turn: { ...wakeTurn, queuedDelivery: claim },
    });
    if (admission.kind !== "accepted") throw new Error(admission.message);
    await admission.turn.completed;
    expect(await index.has(transcriptPath, "batch")).toBe(true);
    expect(await index.has(transcriptPath, entry.id)).toBe(false);
    expect((await fixture.queue.listActive(fixture.identity))[0]?.status).toBe(
      "uncertain",
    );
    await fixture.queue.resolveDelivery({
      ...fixture.identity,
      id: entry.id,
      action: "retry",
    });
    await drainConversationQueue(fixture.binding.address, {
      ...fixture.queue,
      submitTurn: fixture.manager.submitConversationTurn,
      runConversationCommand: async () => {
        throw new Error("Not a command");
      },
    });
    expect(dispatches).toBe(1);
    expect(
      await fixture.queue.confirmSubscriptionWakeAccepted({
        ...fixture.identity,
        batchId: "batch",
      }),
    ).toBe(1);
    expect(await fixture.queue.claimNextTurnBatch(fixture.identity)).toBeNull();
  } finally {
    await fixture?.close();
    fixture = undefined;
    await rm(directory, { recursive: true, force: true });
  }
});
