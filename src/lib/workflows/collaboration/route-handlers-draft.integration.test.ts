import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createStateStore, type StateStore } from "@/lib/state-store/store";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import { createCollaborationRouteHandlers } from "./route-handlers";
import type { CollaborationManager } from "./manager";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/projects/example";
const SESSION_NAME = "sess-1";
const CONVERSATION_ID = "conv-1";
const SUBMITTED_DRAFT = "/collab investigate the regression";

let db: Db;
let store: StateStore;

beforeEach(async () => {
  db = _createTestDb({ inMemory: true });
  store = createStateStore({ db, writeQueue: createWriteQueue() });
  await store.getOrCreateProject(PROJECT_PATH);
  await store.mutateState("seed", (state) => {
    state.projects[PROJECT_PATH]!.sessions[SESSION_NAME] =
      sessionStateSchema.parse({
        sessionName: SESSION_NAME,
        worktreePath: "/tmp/sess-1",
        branchName: "cc/sess-1",
        createdAt: "2026-07-13T12:00:00.000Z",
        lastActivityAt: "2026-07-13T12:00:00.000Z",
        conversations: [
          {
            id: CONVERSATION_ID,
            transcriptPath: null,
            status: "new",
            promptCount: 0,
            createdAt: "2026-07-13T12:00:00.000Z",
            lastActivityAt: "2026-07-13T12:00:00.000Z",
            pendingPromptText: SUBMITTED_DRAFT,
          },
        ],
      });
  });
});

afterEach(() => {
  db.close();
});

function makeManager(onStart?: () => Promise<void>): CollaborationManager {
  return {
    start: vi.fn(async () => {
      await onStart?.();
      return { workflowId: "wf-1", status: "started" };
    }),
    resume: vi.fn(),
    stop: vi.fn(),
    getEnvelope: vi.fn(),
    listActive: vi.fn(),
    listAll: vi.fn(),
  } as unknown as CollaborationManager;
}

function startRequest(): Request {
  return new Request("http://test/collaboration", {
    method: "POST",
    body: JSON.stringify({
      brief: "investigate the regression",
      submittedPendingPromptText: SUBMITTED_DRAFT,
      negotiationRounds: 3,
      autonomousResolutionThreshold: "major",
      conversationId: CONVERSATION_ID,
    }),
  });
}

function context() {
  return {
    params: Promise.resolve({ name: "example", session: SESSION_NAME }),
  };
}

describe("dedicated collaboration route draft ownership", () => {
  it("clears the exact submitted draft after the start is accepted", async () => {
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => PROJECT_PATH,
      manager: makeManager(),
      getSession: store.getSession,
      clearConversationPendingPromptTextIfMatches:
        store.clearConversationPendingPromptTextIfMatches,
    });

    const response = await handlers.START(startRequest(), context());

    expect(response.status).toBe(202);
    expect(
      (await store.getConversation(PROJECT_PATH, SESSION_NAME, CONVERSATION_ID))
        ?.pendingPromptText,
    ).toBeNull();
  });

  it("preserves a newer draft written while the collaboration start is in flight", async () => {
    const handlers = createCollaborationRouteHandlers({
      resolveProjectPath: async () => PROJECT_PATH,
      manager: makeManager(() =>
        store.setConversationPendingPromptText(
          PROJECT_PATH,
          SESSION_NAME,
          CONVERSATION_ID,
          "newer draft from another client",
        ),
      ),
      getSession: store.getSession,
      clearConversationPendingPromptTextIfMatches:
        store.clearConversationPendingPromptTextIfMatches,
    });

    const response = await handlers.START(startRequest(), context());

    expect(response.status).toBe(202);
    expect(
      (await store.getConversation(PROJECT_PATH, SESSION_NAME, CONVERSATION_ID))
        ?.pendingPromptText,
    ).toBe("newer draft from another client");
  });
});
