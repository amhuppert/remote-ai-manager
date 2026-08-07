/**
 * Tests for markUnreadOnFinish / markReadOnUserTurnStart — the action bodies
 * that run when a conversation transitions running → awaiting (turn end) or a
 * user-initiated turn starts.
 *
 * Persistence-dependent behavior (does `unread` actually change in the store?)
 * is verified by RELOADING the conversation through the real conversation seam
 * (`createPersistenceFixture().deps`) rather than by inspecting an in-memory
 * fake. If `unread` ever stops serializing, the reload-based assertions fail.
 * `publishSessionStatus` is still a local capture: SSE delivery does not depend
 * on persistence.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  markUnreadOnFinish,
  markReadOnUserTurnStart,
  type MarkUnreadOnFinishDeps,
} from "./mark-unread";
import type { ConversationState, ConversationRole } from "./schemas";
import { makeConversationState } from "./testing/conversation-state-fixture";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";

const PROJECT_PATH = "/proj";
const PROJECT_NAME = "proj-display";
const SESSION_NAME = "sess";
const CONVERSATION_ID = "conv-1";

function makeConversation(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return makeConversationState({
    id: CONVERSATION_ID,
    promptCount: 1,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:01:00Z",
    ...overrides,
  });
}

let fixture: PersistenceFixture;

async function seedConversation(
  overrides: Partial<ConversationState> = {},
): Promise<void> {
  fixture.seedProject(PROJECT_PATH);
  fixture.seedSession(PROJECT_PATH, SESSION_NAME);
  await fixture.seedConversation(
    PROJECT_PATH,
    SESSION_NAME,
    makeConversation(overrides),
  );
}

async function reloadUnread(): Promise<boolean | undefined> {
  const reloaded = await fixture.deps.getConversation(
    PROJECT_PATH,
    SESSION_NAME,
    CONVERSATION_ID,
  );
  return reloaded?.unread;
}

function makeDeps(): {
  deps: MarkUnreadOnFinishDeps;
  publishedEvents: Array<
    Parameters<MarkUnreadOnFinishDeps["publishSessionStatus"]>[0]
  >;
} {
  const publishedEvents: Array<
    Parameters<MarkUnreadOnFinishDeps["publishSessionStatus"]>[0]
  > = [];

  const deps: MarkUnreadOnFinishDeps = {
    mutateConversation: fixture.deps.mutateConversation,
    publishSessionStatus(event) {
      publishedEvents.push(event);
      return { delivered: true };
    },
  };

  return { deps, publishedEvents };
}

function makeCtx(role: ConversationRole) {
  return {
    projectPath: PROJECT_PATH,
    projectName: PROJECT_NAME,
    sessionName: SESSION_NAME,
    conversationId: CONVERSATION_ID,
    role,
  };
}

beforeEach(() => {
  fixture = createPersistenceFixture();
});

afterEach(() => {
  fixture.close();
});

describe("markUnreadOnFinish", () => {
  it("persists unread=true and publishes a conversation-unread SSE event for a regular conversation", async () => {
    await seedConversation({ unread: false });
    const { deps, publishedEvents } = makeDeps();

    await markUnreadOnFinish(makeCtx(null), deps);

    expect(await reloadUnread()).toBe(true);

    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0]).toMatchObject({
      type: "conversation-unread",
      projectName: PROJECT_NAME,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      unread: true,
    });
  });

  it("persists unread=true for the planner role (planner is a user-facing role)", async () => {
    await seedConversation({ unread: false });
    const { deps, publishedEvents } = makeDeps();

    await markUnreadOnFinish(makeCtx("planner"), deps);

    expect(await reloadUnread()).toBe(true);
    expect(publishedEvents).toHaveLength(1);
  });

  it("persists unread=true for the initialization role", async () => {
    await seedConversation({ unread: false });
    const { deps, publishedEvents } = makeDeps();

    await markUnreadOnFinish(makeCtx("initialization"), deps);

    expect(await reloadUnread()).toBe(true);
    expect(publishedEvents).toHaveLength(1);
  });

  it("does NOT persist unread or publish for iteration role (workflow-managed)", async () => {
    await seedConversation({ unread: false });
    const { deps, publishedEvents } = makeDeps();

    await markUnreadOnFinish(makeCtx("iteration"), deps);

    expect(await reloadUnread()).toBe(false);
    expect(publishedEvents).toHaveLength(0);
  });

  it("does NOT persist unread or publish for validator role (workflow-managed)", async () => {
    await seedConversation({ unread: false });
    const { deps, publishedEvents } = makeDeps();

    await markUnreadOnFinish(makeCtx("validator"), deps);

    expect(await reloadUnread()).toBe(false);
    expect(publishedEvents).toHaveLength(0);
  });

  it("does not publish when mutateConversation rejects (UI stays consistent with DB)", async () => {
    const publishedEvents: unknown[] = [];
    const deps: MarkUnreadOnFinishDeps = {
      mutateConversation: vi.fn(async () => {
        throw new Error("conversation not found");
      }),
      publishSessionStatus: (event) => {
        publishedEvents.push(event);
        return { delivered: true };
      },
    };

    await expect(markUnreadOnFinish(makeCtx(null), deps)).rejects.toThrow(
      /conversation not found/,
    );
    expect(publishedEvents).toHaveLength(0);
  });
});

describe("markReadOnUserTurnStart", () => {
  it("persists unread=false and publishes conversation-unread (unread=false) for a regular conversation", async () => {
    await seedConversation({ unread: true });
    const { deps, publishedEvents } = makeDeps();

    await markReadOnUserTurnStart(makeCtx(null), deps);

    expect(await reloadUnread()).toBe(false);

    expect(publishedEvents).toHaveLength(1);
    expect(publishedEvents[0]).toMatchObject({
      type: "conversation-unread",
      projectName: PROJECT_NAME,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      unread: false,
    });
  });

  it("persists unread=false for the planner role", async () => {
    await seedConversation({ unread: true });
    const { deps, publishedEvents } = makeDeps();

    await markReadOnUserTurnStart(makeCtx("planner"), deps);

    expect(await reloadUnread()).toBe(false);
    expect(publishedEvents).toHaveLength(1);
  });

  it("does NOT persist unread or publish for iteration role (workflow-managed, never unread)", async () => {
    await seedConversation({ unread: true });
    const { deps, publishedEvents } = makeDeps();

    await markReadOnUserTurnStart(makeCtx("iteration"), deps);

    expect(await reloadUnread()).toBe(true);
    expect(publishedEvents).toHaveLength(0);
  });

  it("does NOT persist unread or publish for validator role", async () => {
    await seedConversation({ unread: true });
    const { deps, publishedEvents } = makeDeps();

    await markReadOnUserTurnStart(makeCtx("validator"), deps);

    expect(await reloadUnread()).toBe(true);
    expect(publishedEvents).toHaveLength(0);
  });
});
