import { afterEach, describe, expect, it, vi } from "vitest";
import { storeSessionNameFromScopeRef } from "@/lib/conversations/conversation-target";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { createMessageQueueService } from "@/lib/conversations/message-queue-service";
import { createProjectConversationNotificationService } from "@/lib/notifications/project-conversation-service";
import { createNotificationsRepo } from "@/lib/notifications/repo";
import {
  _resetProjectConversationStatusNotificationDepsForTesting,
  setProjectConversationStatusNotificationDepsForTesting,
} from "@/lib/project-conversations/status-notifications";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import type {
  ConversationIdentity,
  TurnSettlement,
} from "./conversation-record";
import {
  createProductionConversationQuestions,
  createProductionConversationRecords,
} from "./production-records";

const PROJECT = "/work/repo";
const SESSION = "feature";
const PROJECT_KEY = storeSessionNameFromScopeRef({ scope: "project" });
const question = {
  question: "Which database?",
  options: [],
  multiSelect: false,
  required: true,
  allowNote: true,
};

let fixture: PersistenceFixture;
afterEach(() => {
  _resetProjectConversationStatusNotificationDepsForTesting();
  fixture.close();
});

function setUp(): PersistenceFixture {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT);
  return fixture;
}

/** The production records over the fixture's store and database. */
function rowStore() {
  return {
    db: () => fixture.db,
    getConversation: fixture.store.getConversation,
    mutateConversation: fixture.store.mutateConversation,
    queue: createMessageQueueService({
      mutateConversation: fixture.store.mutateConversation,
      getConversation: fixture.store.getConversation,
      getProjectDisplayName: () => "repo",
      broadcast: () => {},
      now: () => "2026-10-03T10:00:00.000Z",
      newId: () => "queued-1",
    }),
  };
}

const projectIdentity = (conversationId: string): ConversationIdentity => ({
  projectPath: PROJECT,
  storeSessionName: PROJECT_KEY,
  conversationId,
});

/** Project notifications the real policy and service write to the fixture's database. */
function persistedNotifications() {
  return createNotificationsRepo(fixture.db).getNotifications().notifications;
}

function recordNotifications(): void {
  setProjectConversationStatusNotificationDepsForTesting({
    getProjectConversation: fixture.store.getProjectConversation,
    notificationService: createProjectConversationNotificationService({
      createProjectConversationNotification: (input) =>
        createNotificationsRepo(
          fixture.db,
        ).createProjectConversationNotification(input).notification,
    }),
  });
}

const settled = (overrides: Partial<TurnSettlement> = {}): TurnSettlement => ({
  counted: true,
  continuity: { kind: "keep" },
  costUsd: null,
  durationMs: null,
  numTurns: 3,
  contextTokens: null,
  contextWindowMax: null,
  failure: null,
  debugOutcome: { error: null },
  ...overrides,
});

describe("conversation rows of a project conversation the core runs", () => {
  it("finds a project conversation's pending question, so a stop withdraws it", async () => {
    setUp();
    await fixture.seedProjectConversation(
      PROJECT,
      makeConversationState({
        id: "conv-p",
        scope: "project",
        status: "waiting_for_input",
        pendingQuestionId: "q-1",
        pendingQuestions: [question],
      }),
    );
    const records = createProductionConversationRecords(rowStore());

    expect(records.hasPendingQuestion(projectIdentity("conv-p"))).toBe(true);
    expect(await records.withdrawQuestion(projectIdentity("conv-p"))).toBe(
      true,
    );

    const reloaded = await fixture
      .recreateStore()
      .getConversation(PROJECT, PROJECT_KEY, "conv-p");
    expect(reloaded).toMatchObject({
      pendingQuestionId: null,
      status: "awaiting",
    });
    expect(records.hasPendingQuestion(projectIdentity("conv-p"))).toBe(false);
  });

  it("tells the person a restart interrupted a project conversation's turn as a failure, not as ready", async () => {
    setUp();
    recordNotifications();
    await fixture.seedProjectConversation(
      PROJECT,
      makeConversationState({
        id: "conv-cut",
        scope: "project",
        name: "Chat conv-cut",
        status: "running",
        activeTurnSource: "user",
      }),
    );
    await createProductionConversationRecords(rowStore()).recordInterrupted(
      projectIdentity("conv-cut"),
    );
    await vi.waitFor(() => expect(persistedNotifications()).toHaveLength(1));
    expect(persistedNotifications()).toEqual([
      expect.objectContaining({
        type: "project-conversation-failed",
        conversationId: "conv-cut",
        errorMessage:
          "The server restarted while this turn was running, so it was interrupted.",
      }),
    ]);
  });

  it("leaves a row its turn already settled as it is, when a restart recovers that turn's attempt", async () => {
    setUp();
    recordNotifications();
    await fixture.seedProjectConversation(
      PROJECT,
      makeConversationState({
        id: "conv-done",
        scope: "project",
        name: "Chat conv-done",
        status: "awaiting",
        activeTurnSource: null,
      }),
    );
    await createProductionConversationRecords(rowStore()).recordInterrupted(
      projectIdentity("conv-done"),
    );

    const reloaded = await fixture
      .recreateStore()
      .getConversation(PROJECT, PROJECT_KEY, "conv-done");
    expect(reloaded).toMatchObject({
      status: "awaiting",
      activeTurnSource: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(persistedNotifications()).toEqual([]);
  });

  it("tells the person when a project conversation's turn hands control back, ready or failed", async () => {
    setUp();
    recordNotifications();
    for (const id of ["conv-ready", "conv-failed"]) {
      await fixture.seedProjectConversation(
        PROJECT,
        makeConversationState({
          id,
          scope: "project",
          name: `Chat ${id}`,
          status: "running",
          activeTurnSource: "user",
        }),
      );
    }
    const records = createProductionConversationRecords(rowStore());

    await records.settleTurn(projectIdentity("conv-ready"), settled(), "user");
    await records.settleTurn(
      projectIdentity("conv-failed"),
      settled({ failure: { message: "SDK transport closed", recorded: true } }),
      "user",
    );

    await vi.waitFor(() => expect(persistedNotifications()).toHaveLength(2));
    expect(persistedNotifications()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "project-conversation-ready",
          projectName: "repo",
          conversationId: "conv-ready",
          conversationName: "Chat conv-ready",
        }),
        expect.objectContaining({
          type: "project-conversation-failed",
          conversationId: "conv-failed",
          errorMessage: "SDK transport closed",
        }),
      ]),
    );
  });

  it("tells the person once that a project conversation's agent is asking them something", async () => {
    setUp();
    recordNotifications();
    for (const id of ["conv-ask", "conv-later"]) {
      await fixture.seedProjectConversation(
        PROJECT,
        makeConversationState({
          id,
          scope: "project",
          status: "running",
          activeTurnSource: "user",
        }),
      );
    }

    const asked = await createProductionConversationQuestions(rowStore()).ask(
      projectIdentity("conv-ask"),
      {
        questionId: "q-7",
        questions: [question],
      },
    );

    expect(asked).toBe(true);
    await vi.waitFor(() =>
      expect(persistedNotifications()).toEqual([
        expect.objectContaining({
          type: "project-conversation-input-needed",
          conversationId: "conv-ask",
        }),
      ]),
    );

    // The turn ends with the question still open: the ask already told the person.
    const records = createProductionConversationRecords(rowStore());
    await records.settleTurn(projectIdentity("conv-ask"), settled(), "user");
    const reloaded = await fixture
      .recreateStore()
      .getConversation(PROJECT, PROJECT_KEY, "conv-ask");
    expect(reloaded).toMatchObject({
      status: "waiting_for_input",
      pendingQuestionId: "q-7",
      promptCount: 1,
    });
    // A later conversation's notification arrives after anything the settle would have sent.
    await records.settleTurn(projectIdentity("conv-later"), settled(), "user");
    await vi.waitFor(() =>
      expect(persistedNotifications()).toContainEqual(
        expect.objectContaining({ conversationId: "conv-later" }),
      ),
    );
    expect(
      persistedNotifications().filter(
        (n) => n.type === "project-conversation-input-needed",
      ),
    ).toHaveLength(1);
  });

  it("leaves a session conversation's settled turn to the session's own notices", async () => {
    setUp();
    recordNotifications();
    fixture.seedSession(PROJECT, SESSION);
    await fixture.seedConversation(
      PROJECT,
      SESSION,
      makeConversationState({
        id: "conv-s",
        status: "running",
        activeTurnSource: "user",
      }),
    );

    await createProductionConversationRecords(rowStore()).settleTurn(
      {
        projectPath: PROJECT,
        storeSessionName: SESSION,
        conversationId: "conv-s",
      },
      settled(),
      "user",
    );

    const reloaded = await fixture
      .recreateStore()
      .getConversation(PROJECT, SESSION, "conv-s");
    expect(reloaded).toMatchObject({ status: "awaiting", promptCount: 1 });
    expect(persistedNotifications()).toEqual([]);
  });

  it("gives a withdrawn message back for review with its reason, and the backend a fresh conversation's first message chose", async () => {
    setUp();
    fixture.seedSession(PROJECT, SESSION);
    await fixture.seedConversation(
      PROJECT,
      SESSION,
      makeConversationState({
        id: "conv-s",
        agentBackend: "claude",
        promptCount: 0,
        backendRef: null,
      }),
    );
    const records = createProductionConversationRecords(rowStore());
    await records.recordWithdrawn(
      {
        projectPath: PROJECT,
        storeSessionName: SESSION,
        conversationId: "conv-s",
      },
      {
        cause: "user:conv-s:1",
        request: {
          kind: "user_message",
          text: "Hello",
          backend: "codex",
          inputOrigin: "user",
        },
        reason: "Review queued deliveries before sending another prompt.",
      },
    );

    // The queue row carries no backend: a retry runs on the row's, so the choice is taken now.
    const row = await fixture.store.getConversation(PROJECT, SESSION, "conv-s");
    expect(row?.agentBackend).toBe("codex");
    expect(row?.pendingQueue).toEqual([
      expect.objectContaining({
        status: "failed",
        error: "Review queued deliveries before sending another prompt.",
        content: [{ type: "text", text: "Hello" }],
      }),
    ]);
  });
});
