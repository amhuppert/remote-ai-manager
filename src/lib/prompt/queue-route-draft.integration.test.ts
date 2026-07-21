import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createStateStore, type StateStore } from "@/lib/state-store/store";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import { seedWholeState } from "@/lib/shared/testing/whole-state-fixture";
import { createQueueRouteHandlers } from "./queue-route-handlers";
import type { PendingQueuedMessage } from "@/lib/conversations/message-queue-schemas";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/projects/example";
const SESSION_NAME = "sess-1";
const CONVERSATION_ID = "conv-1";
const SUBMITTED_DRAFT = "  queued follow up  ";

let db: Db;
let store: StateStore;

beforeEach(async () => {
  db = _createTestDb({ inMemory: true });
  store = createStateStore({ db, writeQueue: createWriteQueue() });
  seedWholeState(db, {
    projects: {
      [PROJECT_PATH]: {
        rootPath: PROJECT_PATH,
        sessions: {
          [SESSION_NAME]: sessionStateSchema.parse({
            sessionName: SESSION_NAME,
            worktreePath: "/tmp/sess-1",
            branchName: "cc/sess-1",
            createdAt: "2026-07-13T12:00:00.000Z",
            lastActivityAt: "2026-07-13T12:00:00.000Z",
            conversations: [
              {
                id: CONVERSATION_ID,
                transcriptPath: null,
                status: "running",
                promptCount: 1,
                createdAt: "2026-07-13T12:00:00.000Z",
                lastActivityAt: "2026-07-13T12:00:00.000Z",
                pendingPromptText: SUBMITTED_DRAFT,
                agentBackend: "claude",
              },
            ],
          }),
        },
      },
    },
    archivedProjects: [],
    pinnedProjects: [],
  });
});

afterEach(() => db.close());

const entry: PendingQueuedMessage = {
  id: "queue-1",
  content: [{ type: "text", text: "queued follow up" }],
  status: "pending",
  enqueuedAt: "2026-07-13T13:00:00.000Z",
  updatedAt: "2026-07-13T13:00:00.000Z",
  deliveryStartedAt: null,
  deliveredAt: null,
  cancelledAt: null,
  failedAt: null,
  deliveryAttemptId: null,
  attemptCount: 0,
  error: null,
  metadata: null,
};

function request(): Request {
  return new Request("http://test/queue", {
    method: "POST",
    body: JSON.stringify({
      text: "queued follow up",
      submittedPendingPromptText: SUBMITTED_DRAFT,
    }),
  });
}

function context() {
  return {
    params: Promise.resolve({
      name: "example",
      session: SESSION_NAME,
      conversationId: CONVERSATION_ID,
    }),
  };
}

function handlers(onQueue?: () => Promise<void>) {
  return createQueueRouteHandlers({
    resolveProjectPath: async () => PROJECT_PATH,
    getSession: store.getSession,
    getConversation: store.getConversation,
    getProjectDisplayName: () => "example",
    queueMessage: vi.fn(async () => {
      await onQueue?.();
      return { entry, deliveryTiming: "in_turn" as const };
    }),
    queueCapabilityForBackend: () => ({
      acceptsWhileRunning: true,
      deliveryTiming: "in_turn",
    }),
    toQueuedMessageView: (queued) => ({
      id: queued.id,
      content: queued.content,
      status: queued.status,
      enqueuedAt: queued.enqueuedAt,
      updatedAt: queued.updatedAt,
      deliveredAt: queued.deliveredAt,
      cancelledAt: queued.cancelledAt,
      failedAt: queued.failedAt,
      error: queued.error,
      metadata: queued.metadata,
    }),
    clearConversationPendingPromptTextIfMatches:
      store.clearConversationPendingPromptTextIfMatches,
    hasLiveConversationActor: () => true,
    ensureConversationActorAndDrain: async () => {},
    recoverAbandonedDeliveries: async () => 0,
    cancel: async () => "not_found",
  });
}

describe("queue route pending-draft ownership", () => {
  it("clears the exact submitted draft after the queue entry commits", async () => {
    const response = await handlers().POST(request(), context());

    expect(response.status).toBe(200);
    expect(
      (await store.getConversation(PROJECT_PATH, SESSION_NAME, CONVERSATION_ID))
        ?.pendingPromptText,
    ).toBeNull();
  });

  it("preserves a newer draft written while the queue entry commits", async () => {
    const response = await handlers(() =>
      store.setConversationPendingPromptText(
        PROJECT_PATH,
        SESSION_NAME,
        CONVERSATION_ID,
        "newer draft from another client",
      ),
    ).POST(request(), context());

    expect(response.status).toBe(200);
    expect(
      (await store.getConversation(PROJECT_PATH, SESSION_NAME, CONVERSATION_ID))
        ?.pendingPromptText,
    ).toBe("newer draft from another client");
  });
});
