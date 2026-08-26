import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { _createTestDb } from "@/lib/state-store/state-db";
import { createStateStore, type StateStore } from "@/lib/state-store/store";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import { seedWholeState } from "@/lib/shared/testing/whole-state-fixture";
import type { CollaborationManager } from "@/lib/workflows/collaboration/manager";
import {
  createPromptRouteHandlers,
  type PromptRouteDeps,
} from "./route-handlers";
import { ModelSelectionValidationError } from "./sdk-driver";

type Db = InstanceType<typeof Database>;

const PROJECT_PATH = "/projects/example";
const SESSION_NAME = "sess-1";
const CONVERSATION_ID = "conv-1";
const SUBMITTED_DRAFT = "  prompt with exact whitespace  ";

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
                status: "awaiting",
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

function makeManager(): CollaborationManager {
  return {
    start: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    getEnvelope: vi.fn(),
    listActive: vi.fn(),
    listAll: vi.fn(),
  } as unknown as CollaborationManager;
}

function createHandlers(
  executePromptStream: PromptRouteDeps["executePromptStream"],
) {
  return createPromptRouteHandlers({
    resolveProjectPath: async () => PROJECT_PATH,
    getSession: store.getSession,
    getConversation: store.getConversation,
    getActiveGraphWorkflowExecution: async () => null,
    isConversationBusy: () => false,
    admitConversationTurn: async () => ({
      kind: "admit" as const,
      turnGeneration: 1,
    }),
    executePromptStream,
    getCollaborationManager: makeManager,
    setConversationPendingPromptText: store.setConversationPendingPromptText,
    clearConversationPendingPromptTextIfMatches:
      store.clearConversationPendingPromptTextIfMatches,
  });
}

function request(): Request {
  return new Request("http://test/prompt", {
    method: "POST",
    body: JSON.stringify({
      prompt: SUBMITTED_DRAFT.trim(),
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

async function pendingDraft(): Promise<string | null | undefined> {
  return (
    await store.getConversation(PROJECT_PATH, SESSION_NAME, CONVERSATION_ID)
  )?.pendingPromptText;
}

describe("normal prompt route pending-draft ownership", () => {
  it("clears the exact raw submitted draft after SUBMIT_PROMPT is accepted", async () => {
    const handlers = createHandlers(async (...args) => {
      await args[7]?.onAccepted?.();
      return {
        conversationId: CONVERSATION_ID,
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });

    const response = await handlers.conversationPOST(request(), context());
    await response.text();

    expect(response.status).toBe(200);
    expect(await pendingDraft()).toBeNull();
  });

  it("preserves a newer draft written before SUBMIT_PROMPT is accepted", async () => {
    const handlers = createHandlers(async (...args) => {
      await store.setConversationPendingPromptText(
        PROJECT_PATH,
        SESSION_NAME,
        CONVERSATION_ID,
        "newer draft from another client",
      );
      await args[7]?.onAccepted?.();
      return {
        conversationId: CONVERSATION_ID,
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    });

    const response = await handlers.conversationPOST(request(), context());
    await response.text();

    expect(response.status).toBe(200);
    expect(await pendingDraft()).toBe("newer draft from another client");
  });

  it.each([
    [
      "model validation",
      new ModelSelectionValidationError({
        code: "unknown_model",
        message: "invalid model",
        modelId: "invalid-model",
      }),
    ],
    ["actor setup", new Error("actor creation failed")],
  ])("preserves the submitted draft when %s fails", async (_phase, error) => {
    const handlers = createHandlers(async () => {
      throw error;
    });

    const response = await handlers.conversationPOST(request(), context());
    await response.text();

    expect(response.status).toBe(200);
    expect(await pendingDraft()).toBe(SUBMITTED_DRAFT);
  });

  it("preserves the submitted draft when SUBMIT_PROMPT is rejected", async () => {
    const handlers = createHandlers(async () => ({
      conversationId: CONVERSATION_ID,
      contextTokens: null,
      contextWindowMax: null,
      compacted: false,
      error: "Conversation is not ready to accept a new prompt",
    }));

    const response = await handlers.conversationPOST(request(), context());
    await response.text();

    expect(response.status).toBe(200);
    expect(await pendingDraft()).toBe(SUBMITTED_DRAFT);
  });
});
