import { afterEach, describe, expect, it } from "vitest";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { createCoreLiveQueueHarness } from "@/lib/prompt/testing/core-live-queue-fixture";
import { InputDeliveryUncertainError } from "@/lib/agent-backends/errors";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import { subscriptionWakeBatchSchema } from "./active-wait-schemas";
import { deliverSubscriptionWake } from "./active-wait-delivery";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(scope: "session" | "project") {
  const fixture = createPersistenceFixture();
  const key = {
    projectPath: "/repo",
    sessionName:
      scope === "project" ? PROJECT_CONVERSATION_SESSION_SENTINEL : "work",
    conversationId: `wake-${scope}`,
  };
  fixture.seedProject(key.projectPath);
  const conversation = makeConversationState({ id: key.conversationId, scope });
  if (scope === "project")
    await fixture.seedProjectConversation(key.projectPath, conversation);
  else {
    fixture.seedSession(key.projectPath, key.sessionName);
    await fixture.seedConversation(
      key.projectPath,
      key.sessionName,
      conversation,
    );
  }
  const h = createCoreLiveQueueHarness(fixture, key);
  const turn = await h.startTurn();
  cleanups.push(async () => {
    h.endTurn();
    await turn.ended;
    fixture.close();
  });
  const batch = subscriptionWakeBatchSchema.parse({
    id: "review-finished",
    recipient: {
      projectPath: key.projectPath,
      conversationId: key.conversationId,
    },
    waitIds: [],
    deliveryIds: [],
    followDeliveryIds: ["review"],
    state: "queued",
    queueMessageId: "review-finished",
    message: "Reviewer finished: inspect the result",
    causationBatchIds: [],
    createdAt: "2026-10-15T12:00:00Z",
    updatedAt: "2026-10-15T12:00:00Z",
    finishedAt: null,
    lastError: null,
  });
  await h.service.enqueue({
    ...key,
    id: batch.queueMessageId,
    inputOrigin: "generated",
    content: [{ type: "text", text: batch.message }],
    metadata: { kind: "subscription_update", batchId: batch.id },
  });
  let current = true;
  let drains = 0;
  const abort = new AbortController();
  const deliver = () =>
    deliverSubscriptionWake(batch, abort.signal, {
      isBatchDispatchable: async () => current,
      readConversation: async () => {
        const row = await h.reload();
        return row
          ? {
              projectPath: key.projectPath,
              sessionName: scope === "project" ? null : key.sessionName,
              sessionArchived: false,
              conversation: row,
            }
          : null;
      },
      drainConversation: async () => {
        drains++;
      },
      queueDeps: h.deps,
    });
  return {
    h,
    batch,
    abort,
    deliver,
    turn,
    drains: () => drains,
    retire: () => {
      current = false;
    },
  };
}

describe.each(["session", "project"] as const)(
  "subscription delivery (%s)",
  (scope) => {
    it("notifies the running agent and records one accepted input without starting another turn", async () => {
      const s = await setup(scope);
      await s.deliver();
      expect(s.h.sent).toEqual([s.batch.message]);
      expect(s.drains()).toBe(0);
      expect((await s.h.reload())?.pendingQueue).toEqual([]);
      expect(s.h.archive[0]).toMatchObject({
        id: s.batch.id,
        origin: {
          source: "subscription_update",
          subscriptionUpdate: { batchId: s.batch.id },
        },
      });
      await s.deliver();
      expect(s.h.sent).toHaveLength(1);
    });

    it("leaves a definite refusal pending for the next-turn drain", async () => {
      const s = await setup(scope);
      let attempts = 0;
      s.h.runtime.queueUserInput = async () => {
        attempts++;
        throw new Error("This turn cannot take steering");
      };
      for (let i = 0; i < 6; i++) await s.deliver();
      expect(attempts).toBe(1);
      expect(s.drains()).toBe(6);
      expect((await s.h.reload())?.pendingQueue[0]?.status).toBe("pending");
    });

    it("holds live input during checkpoint maintenance", async () => {
      const s = await setup(scope);
      s.h.deps.checkpointAcceptsQueuedInput = () => true;
      await s.deliver();
      expect(s.h.sent).toEqual([]);
      expect((await s.h.reload())?.pendingQueue[0]?.status).toBe("pending");
    });

    it("uses the next-turn drain when the recipient is idle", async () => {
      const s = await setup(scope);
      s.h.endTurn();
      await s.turn.ended;
      await s.deliver();
      expect(s.h.sent).toEqual([]);
      expect(s.drains()).toBe(1);
      expect((await s.h.reload())?.pendingQueue[0]?.status).toBe("pending");
    });

    it("does not nudge a new turn when shutdown happens during a refused live delivery", async () => {
      const s = await setup(scope);
      s.h.runtime.queueUserInput = async () => {
        s.abort.abort();
        throw new Error("Turn stopped");
      };
      await s.deliver();
      expect(s.drains()).toBe(0);
      expect((await s.h.reload())?.pendingQueue[0]?.status).toBe("pending");
    });

    it("holds uncertain delivery for review without automatically replaying", async () => {
      const s = await setup(scope);
      let sends = 0;
      s.h.runtime.queueUserInput = async () => {
        sends++;
        throw new InputDeliveryUncertainError("Lost acknowledgement");
      };
      await s.deliver();
      await s.deliver();
      expect(sends).toBe(1);
      expect(s.drains()).toBe(0);
      expect((await s.h.reload())?.pendingQueue[0]?.status).toBe("uncertain");
    });

    it.each(["cancelled", "shutdown"] as const)(
      "does not dispatch after %s",
      async (reason) => {
        const s = await setup(scope);
        if (reason === "cancelled") s.retire();
        else s.abort.abort();
        await s.deliver();
        expect(s.h.sent).toEqual([]);
        expect(s.drains()).toBe(0);
      },
    );
  },
);
