import { afterEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import { createConversationCheckpointsRepo } from "@/lib/conversation-checkpoints/repo";
import type { PendingQueuedMessage } from "@/lib/conversations/message-queue-schemas";
import { createConversationCoreRepo } from "./conversation-core-repo";
import { createWriteQueue } from "./write-queue";

let fixture: PersistenceFixture | undefined;
afterEach(() => fixture?.close());

const at = "2026-10-11T12:00:00.000Z";

/** A plain session conversation, an old graph engine lane, a run's seat and a plain project conversation. */
async function seeded() {
  const store = createPersistenceFixture();
  fixture = store;
  store.seedProject("/repo");
  store.seedSession("/repo", "session");
  await store.seedConversation(
    "/repo",
    "session",
    makeConversationState({ id: "plain", role: null }),
  );
  await store.seedConversation(
    "/repo",
    "session",
    makeConversationState({ id: "graph-lane", role: "iteration" }),
  );
  await store.seedConversation(
    "/repo",
    "session",
    makeConversationState({ id: "seat", role: "validator" }),
  );
  await store.seedProjectConversation(
    "/repo",
    makeConversationState({ id: "project-plain", role: null }),
  );
  const repo = createConversationCoreRepo(store.db);
  repo.insertSeat({
    conversationId: "seat",
    contextId: "ctx-1",
    assignmentId: "reviewer-a",
    replacement: 0,
    role: "reviewer",
    projectPath: "/repo",
    sessionName: "session",
    backend: "claude",
    createdAt: at,
    updatedAt: at,
  });
  return { repo, store };
}

describe("which engine runs a conversation, read from its row", () => {
  it("the core runs every conversation without a role and every run seat; another role stays with the conversation actor", async () => {
    const { repo } = await seeded();

    expect(repo.ownsConversation("plain")).toBe(true);
    expect(repo.ownsConversation("project-plain")).toBe(true);
    expect(repo.ownsConversation("seat")).toBe(true);
    expect(repo.ownsConversation("graph-lane")).toBe(false);
    expect(repo.ownsConversation("missing")).toBe(false);
  });

  it("locates an interactive conversation from its row, a project one under the project's storage key", async () => {
    const { repo } = await seeded();

    expect(repo.getInteractive("plain")).toEqual({
      conversationId: "plain",
      projectPath: "/repo",
      sessionName: "session",
    });
    expect(repo.getInteractive("project-plain")).toEqual({
      conversationId: "project-plain",
      projectPath: "/repo",
      sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
    });
    expect(repo.getInteractive("seat")).toBeNull();
    expect(repo.getInteractive("graph-lane")).toBeNull();
    expect(repo.getInteractive("missing")).toBeNull();
  });
});

function queued(status: PendingQueuedMessage["status"]): PendingQueuedMessage {
  return {
    id: `m-${status}`,
    content: [{ type: "text", text: "Next" }],
    status,
    enqueuedAt: at,
    updatedAt: at,
    deliveryStartedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    failedAt: null,
    deliveryAttemptId: null,
    attemptCount: 0,
    error: null,
    metadata: null,
  };
}

describe("the conversations a restart left something to recover in", () => {
  it("are the core's conversations left running, holding a dead in-turn question, with active queue rows, or mid-checkpoint", async () => {
    const { repo, store } = await seeded();
    const seed = (
      id: string,
      overrides: Parameters<typeof makeConversationState>[0],
    ) =>
      store.seedConversation(
        "/repo",
        "session",
        makeConversationState({ id, role: null, ...overrides }),
      );
    await seed("left-running", { status: "running" });
    await seed("dead-question", {
      status: "waiting_for_input",
      pendingQuestionId: "cc-in-turn-1",
    });
    await seed("durable-question", {
      status: "waiting_for_input",
      pendingQuestionId: "q-1",
    });
    await seed("queued", { pendingQueue: [queued("pending")] });
    await seed("archived-queued", {
      archived: true,
      pendingQueue: [queued("pending")],
    });
    await seed("only-history", { pendingQueue: [queued("delivered")] });
    await seed("checkpointing", {});
    await store.seedConversation(
      "/repo",
      "session",
      makeConversationState({
        id: "graph-running",
        role: "iteration",
        status: "running",
      }),
    );
    await store.seedProjectConversation(
      "/repo",
      makeConversationState({
        id: "project-running",
        role: null,
        status: "running",
      }),
    );
    const checkpoints = createConversationCheckpointsRepo(
      store.db,
      createWriteQueue(),
      {
        insert() {
          throw new Error("no forks here");
        },
        exists: () => true,
        find: () => null,
        clearBackendRef: () => true,
      },
    );
    const admitted = await checkpoints.admitOperation({
      key: {
        scope: "session",
        projectPath: "/repo",
        sessionName: "session",
        conversationId: "checkpointing",
      },
      requestId: "req-1",
      sourceBasis: { capturedThroughSeq: 1, sourceHash: "sha256:a" },
      priorBackendRef: null,
      requestedAt: at,
    });
    expect(admitted.ok).toBe(true);

    expect(
      repo
        .listRecoverable()
        .map((conversation) => conversation.conversationId)
        .sort(),
    ).toEqual([
      "archived-queued",
      "checkpointing",
      "dead-question",
      "left-running",
      "project-running",
      "queued",
    ]);
    const recoverable = new Map(
      repo
        .listRecoverable()
        .map((conversation) => [conversation.conversationId, conversation]),
    );
    expect(recoverable.get("project-running")).toEqual({
      conversationId: "project-running",
      projectPath: "/repo",
      sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
      showsTurn: true,
      queued: false,
      archived: false,
    });
    expect(
      [...recoverable.values()]
        .filter((conversation) => conversation.queued)
        .map((conversation) => conversation.conversationId)
        .sort(),
    ).toEqual(["archived-queued", "queued"]);
    // Only a row still showing a turn has one to settle; the rest only recover.
    expect(
      [...recoverable.values()]
        .filter((conversation) => conversation.showsTurn)
        .map((conversation) => conversation.conversationId)
        .sort(),
    ).toEqual(["dead-question", "left-running", "project-running"]);
    expect(recoverable.get("archived-queued")?.archived).toBe(true);
  });
});
