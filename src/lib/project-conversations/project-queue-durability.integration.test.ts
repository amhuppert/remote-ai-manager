import { checkpointForkOriginFixture } from "@/lib/conversation-checkpoints/testing/fork-origin-fixture";
import { CheckpointForkError } from "@/lib/conversation-checkpoints/fork-service";
import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { createQueueAdmissionFixture } from "@/lib/workflows/conversation/testing/queue-admission-fixture";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { createMessageQueueService } from "@/lib/conversations/message-queue-service";
import {
  drainConversationQueue,
  type ConversationQueueDeps,
} from "@/lib/conversations/message-queue-drain";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import {
  setConversationProfileAdmissionDeps,
  _resetConversationProfileAdmissionDepsForTesting,
} from "@/lib/conversations/profile-admission";
import { queueMessage, type QueueMessageDeps } from "@/lib/prompt/queue";
import { queueCapabilityForBackend } from "@/lib/agent-backends/catalog";
import type { StateStore } from "@/lib/state-store/store";
import type { ConversationEvent } from "@/lib/workflows/conversation/types";
import { createProjectQueueRouteHandlers } from "./queue-route-handlers";

/**
 * Durability of a project conversation's message queue (R6.3, and the durable
 * halves of R6.2 / R6.4).
 *
 * The handler unit tests prove the route's guards over a JS-object fake, which
 * cannot prove the sentinel-aware store path works: a project conversation lives
 * in its own table and every queue write is keyed by the sentinel. So this drives
 * the real project queue route through the real `queueMessage` and the real
 * queue service over real SQLite, then RELOADS through a store built fresh over
 * the same database — the state a restarted server comes up with — before
 * asserting. Nothing the original store held in memory is available to the
 * assertion, which is the point.
 */

const PROJECT_PATH = "/repos/cc";
const CONVERSATION_ID = "conv-1";
const OTHER_CONVERSATION_ID = "conv-2";
const ts = "2026-01-01T00:00:00.000Z";

function runningProjectConversation(id: string) {
  return conversationStateSchema.parse({
    id,
    scope: "project",
    name: id,
    status: "running",
    transcriptPath: null,
    promptCount: 1,
    createdAt: ts,
    lastActivityAt: ts,
    agentBackend: "claude",
  });
}

describe("project message queue durability", () => {
  let fixture: ReturnType<typeof createPersistenceFixture>;
  let rowCounter = 0;

  beforeEach(async () => {
    fixture = createPersistenceFixture();
    rowCounter = 0;
    fixture.seedProject(PROJECT_PATH);
    await fixture.seedProjectConversation(
      PROJECT_PATH,
      runningProjectConversation(CONVERSATION_ID),
    );
    await fixture.seedProjectConversation(
      PROJECT_PATH,
      runningProjectConversation(OTHER_CONVERSATION_ID),
    );
  });

  afterEach(() => {
    _resetConversationProfileAdmissionDepsForTesting();
    fixture.close();
  });

  /** The real queue service over the given store — no fakes below this line. */
  function queueService(store: StateStore) {
    return createMessageQueueService({
      mutateConversation: store.mutateConversation,
      getConversation: store.getConversation,
      getProjectDisplayName: () => "cc",
      broadcast: () => {},
      now: () => ts,
      newId: () => `row-${++rowCounter}`,
    });
  }

  /**
   * `queueMessage`'s live-delivery deps, with the durable enqueue REAL and the
   * backend runtime absent — no live turn owns this conversation, so the row
   * stays `pending` for the next-turn drain, which is the state R6.3 is about.
   */
  function queueMessageDeps(store: StateStore): Partial<QueueMessageDeps> {
    const svc = queueService(store);
    return {
      enqueue: (input) => svc.enqueue(input),
      claimLiveDelivery: (input) => svc.claimLiveDelivery(input),
      markDelivered: (input) => svc.markDelivered(input),
      markPending: (input) => svc.markPending(input),
      getRuntime: () => undefined,
      appendTranscriptEntry: async () => {},
      getProjectDisplayName: () => "cc",
    };
  }

  /** The real project queue route, wired to the given store. */
  function handlers(store: StateStore, refuseFork = false) {
    const svc = queueService(store);
    return createProjectQueueRouteHandlers({
      admitCheckpointForkSelection: async ({ modelSelection }) => {
        if (refuseFork)
          throw new CheckpointForkError(
            "backend_unsupported",
            "Uncertified checkpoint backend",
            422,
          );
        return modelSelection ?? { modelId: "claude-opus-5", parameters: {} };
      },
      checkpointAcceptsQueuedInput: () => false,
      admitModelSelection: async ({ modelSelection }) => ({
        ok: true,
        modelSelection: modelSelection ?? {
          modelId: "sonnet",
          parameters: { effort: "medium" },
        },
      }),
      async resolveProjectPath() {
        return PROJECT_PATH;
      },
      getProjectDisplayName: () => "cc",
      getProjectConversation: (projectPath, id) =>
        store.getProjectConversation(projectPath, id),
      queueMessage: (params) =>
        queueMessage({ ...params, deps: queueMessageDeps(store) }),
      // The real capability table: whether a project conversation may queue at
      // all is backend policy, not something this test gets to assume.
      queueCapabilityForBackend,
      toQueuedMessageView: (entry) => ({
        id: entry.id,
        content: entry.content,
        status: entry.status,
        enqueuedAt: entry.enqueuedAt,
        updatedAt: entry.updatedAt,
        deliveredAt: entry.deliveredAt,
        cancelledAt: entry.cancelledAt,
        failedAt: entry.failedAt,
        error: entry.error,
        metadata: entry.metadata,
      }),
      clearConversationPendingPromptTextIfMatches: async () => false,
      // No live actor owns this conversation: the enqueue-time drain is the
      // production no-op it is while nothing is running, and the next-turn drain
      // below is driven explicitly so the reload is observable between them.
      ensureConversationActorAndDrain: async () => {},
      resolveDelivery: async () => "not_found",
      cancel: (input) => svc.cancel(input),
    });
  }

  it("keeps a fork editable and its queue empty when omitted-model checkpoint admission is refused", async () => {
    await fixture.store.mutateProjectConversation(
      PROJECT_PATH,
      CONVERSATION_ID,
      "seed-fork",
      (row) => {
        row.promptCount = 0;
        row.checkpointFork = checkpointForkOriginFixture();
      },
    );
    const response = await handlers(fixture.store, true).POST(
      postRequest({ text: "queued first task" }),
      {
        params: Promise.resolve({
          name: "cc",
          conversationId: CONVERSATION_ID,
        }),
      },
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: "backend_unsupported",
    });
    const row = await fixture
      .recreateStore()
      .getProjectConversation(PROJECT_PATH, CONVERSATION_ID);
    expect(row?.pendingQueue).toEqual([]);
    expect(row?.checkpointFork?.submission).toBeUndefined();
  });

  function postRequest(body: unknown): Request {
    return new Request("http://127.0.0.1/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function ctx(params: Record<string, string>) {
    return { params: Promise.resolve(params) };
  }

  async function enqueue(
    store: StateStore,
    conversationId: string,
    text: string,
  ): Promise<Response> {
    return handlers(store).POST(
      postRequest({ text }),
      ctx({ name: "cc", conversationId }),
    );
  }

  /**
   * Read the conversation back through a store built fresh over the same
   * database. A reload the original store could satisfy from memory would prove
   * nothing about what SQLite actually holds.
   */
  async function reloadThroughRepository(conversationId = CONVERSATION_ID) {
    return fixture
      .recreateStore()
      .getProjectConversation(PROJECT_PATH, conversationId);
  }

  it("persists a queued follow-up that survives a reload as pending (R6.3)", async () => {
    const res = await enqueue(fixture.store, CONVERSATION_ID, "also add tests");
    expect(res.status).toBe(200);

    const reloaded = await reloadThroughRepository();
    expect(reloaded?.pendingQueue).toHaveLength(1);
    // Claude accepts input mid-turn, so `queueMessage` attempted live delivery,
    // found no runtime, and returned the row to `pending` with its claim
    // released — exactly the state the next-turn drain must be able to pick up.
    expect(reloaded?.pendingQueue[0]).toMatchObject({
      status: "pending",
      content: [{ type: "text", text: "also add tests" }],
      deliveryAttemptId: null,
      deliveryStartedAt: null,
    });
  });

  it("drains the reloaded row on the next idle entry (R6.3)", async () => {
    await enqueue(fixture.store, CONVERSATION_ID, "also add tests");

    // A restarted server: a brand-new store over the same database, holding
    // nothing in memory from the enqueue.
    const restarted = fixture.recreateStore();
    // The drain settles the profile before it sends, so that seam follows the
    // restarted store like the queue service does.
    setConversationProfileAdmissionDeps({
      mutateConversation: restarted.mutateConversation,
    });
    const svc = queueService(restarted);
    const dispatched: ConversationEvent[] = [];

    const deps: ConversationQueueDeps = {
      submitTurn: createQueueAdmissionFixture((input) => {
        if (input.turn.kind === "task_run")
          throw new Error("Expected queued conversation turn");
        dispatched.push({
          ...input.turn,
          type: "SUBMIT_PROMPT",
          streamId: input.transport?.streamId ?? null,
        });
      }),
      claimNextTurnBatch: (input) => svc.claimNextTurnBatch(input),
      markPending: (input) => svc.markPending(input),
      markDelivered: (input) => svc.markDelivered(input),
      markFailed: (input) => svc.markFailed(input),
      recoverAbandonedDeliveries: (input) =>
        svc.recoverAbandonedDeliveries(input),
      runConversationCommand: async () => {
        throw new Error("no queued command expected");
      },
    };

    await drainConversationQueue(
      {
        projectPath: PROJECT_PATH,
        target: targetFromStoreSessionName(
          "cc",
          PROJECT_CONVERSATION_SESSION_SENTINEL,
          CONVERSATION_ID,
        ),

        // The session-keyed storage name: the sentinel routes the drain to the
        // project-conversations table.

        transient: false,
      },
      deps,
    );

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: "SUBMIT_PROMPT",
      promptText: "also add tests",
    });

    // The claim is durable too: the row is `delivering` under an attempt id, so
    // a second drain cannot re-deliver the same message.
    const claimed = await reloadThroughRepository();
    expect(claimed?.pendingQueue).toHaveLength(1);
    expect(claimed?.pendingQueue[0]?.status).toBe("delivering");
    expect(claimed?.pendingQueue[0]?.deliveryAttemptId).not.toBeNull();

    const submitted = dispatched[0];
    if (submitted?.type !== "SUBMIT_PROMPT" || !submitted.queuedDelivery) {
      throw new Error("drain dispatched no queued delivery");
    }
    await svc.markDelivered({
      projectPath: PROJECT_PATH,
      sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
      conversationId: CONVERSATION_ID,
      ids: submitted.queuedDelivery.messageIds,
      deliveryAttemptId: submitted.queuedDelivery.deliveryAttemptId,
    });
    expect((await reloadThroughRepository())?.pendingQueue).toEqual([]);
  });

  it("durably removes a cancelled row before delivery (R6.2)", async () => {
    await enqueue(fixture.store, CONVERSATION_ID, "never mind");
    const queued = await reloadThroughRepository();
    const messageId = queued?.pendingQueue[0]?.id;
    expect(messageId).toBeDefined();

    const res = await handlers(fixture.store).DELETE(
      new Request("http://127.0.0.1/", { method: "DELETE" }),
      ctx({
        name: "cc",
        conversationId: CONVERSATION_ID,
        messageId: messageId ?? "",
      }),
    );
    expect(res.status).toBe(200);

    expect((await reloadThroughRepository())?.pendingQueue).toEqual([]);
  });

  it("serializes follow-ups within one conversation and leaves siblings alone (R6.4)", async () => {
    await enqueue(fixture.store, CONVERSATION_ID, "first follow-up");
    await enqueue(fixture.store, CONVERSATION_ID, "second follow-up");
    await enqueue(fixture.store, OTHER_CONVERSATION_ID, "other conversation");

    // Within the conversation: both rows are queued, in submission order, so the
    // second follow-up cannot overtake the first.
    const reloaded = await reloadThroughRepository();
    expect(
      reloaded?.pendingQueue.map((row) =>
        row.content.flatMap((b) => (b.type === "text" ? [b.text] : [])),
      ),
    ).toEqual([["first follow-up"], ["second follow-up"]]);

    // Across conversations: the sibling holds only its own row. A queue that
    // serialized project-wide would have collected all three here.
    const sibling = await reloadThroughRepository(OTHER_CONVERSATION_ID);
    expect(
      sibling?.pendingQueue.map((row) =>
        row.content.flatMap((b) => (b.type === "text" ? [b.text] : [])),
      ),
    ).toEqual([["other conversation"]]);
  });
});
