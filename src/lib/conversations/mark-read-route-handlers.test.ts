/**
 * Tests for POST /conversations/[id]/mark-read.
 *
 * Verifies behavioral contract: 404 chains for missing project/session/conv,
 * 200 + unread=false mutation + conversation-unread broadcast on success.
 *
 * The success path writes through the REAL store
 * (`createPersistenceFixture().store.markConversationRead`) and asserts the new
 * `unread` value and the unchanged activity timestamps by RELOADING from the
 * store, so the test fails if `unread` stops serializing or reading restamps
 * activity. Project resolution, session lookup, and SSE broadcast do
 * not depend on persistence and remain injected stubs. No vi.mock on internal
 * modules.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  createMarkReadRouteHandlers,
  type MarkReadRouteDeps,
} from "./mark-read-route-handlers";
import { conversationUnreadEventSchema } from "@/lib/conversations/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import type { SSEEvent } from "@/lib/api/sse-events";
import type { ConversationState } from "@/lib/conversations/schemas";
import { sessionStateSchema, type SessionState } from "@/lib/sessions/schemas";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";

const PROJECT_PATH = "/repos/demo";
const PROJECT_NAME = "demo";
const SESSION_NAME = "s1";
const CONVERSATION_ID = "conv-1";

function makeConversation(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return makeConversationState({
    id: CONVERSATION_ID,
    promptCount: 1,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:01:00Z",
    unread: true,
    ...overrides,
  });
}

function makeSession(conversations: ConversationState[] = []): SessionState {
  return sessionStateSchema.parse({
    sessionName: SESSION_NAME,
    worktreePath: "/tmp/worktree",
    branchName: `csm/${SESSION_NAME}`,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    conversations,
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

async function reloadLastActivity(): Promise<{
  conversation: string | undefined;
  session: string | undefined;
}> {
  const conversation = await fixture.deps.getConversation(
    PROJECT_PATH,
    SESSION_NAME,
    CONVERSATION_ID,
  );
  const session = await fixture.store.getSession(PROJECT_PATH, SESSION_NAME);
  return {
    conversation: conversation?.lastActivityAt,
    session: session?.lastActivityAt,
  };
}

function makeDeps(overrides: Partial<MarkReadRouteDeps> = {}): {
  deps: MarkReadRouteDeps;
  broadcastedEvents: SSEEvent[];
} {
  const session = makeSession([makeConversation()]);
  const broadcastedEvents: SSEEvent[] = [];

  const deps: MarkReadRouteDeps = {
    resolveProjectPath: vi.fn(async () => PROJECT_PATH),
    getProjectDisplayName: vi.fn(() => PROJECT_NAME),
    getSession: vi.fn(async () => session),
    markConversationRead: fixture.store.markConversationRead,
    broadcast: vi.fn((event: SSEEvent) => {
      broadcastedEvents.push(event);
      return { delivered: true as const };
    }),
    ...overrides,
  };
  return { deps, broadcastedEvents };
}

function context(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function plainRequest(): Request {
  return new Request("http://cc.test/mark-read", { method: "POST" });
}

beforeEach(() => {
  fixture = createPersistenceFixture();
});

afterEach(() => {
  fixture.close();
});

describe("POST /conversations/[id]/mark-read", () => {
  it("returns 200, persists unread=false, broadcasts conversation-unread event with unread=false", async () => {
    await seedConversation({ unread: true });
    const { deps, broadcastedEvents } = makeDeps();
    const { POST } = createMarkReadRouteHandlers(deps);

    const response = await POST(
      plainRequest(),
      context({
        name: PROJECT_NAME,
        session: SESSION_NAME,
        conversationId: CONVERSATION_ID,
      }),
    );

    expect(response.status).toBe(200);
    expect(await reloadUnread()).toBe(false);
    expect(broadcastedEvents).toHaveLength(1);
    const parsed = conversationUnreadEventSchema.safeParse(
      broadcastedEvents[0],
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({
        type: "conversation-unread",
        scope: "session",
        projectName: PROJECT_NAME,
        sessionName: SESSION_NAME,
        conversationId: CONVERSATION_ID,
        unread: false,
      });
    }
  });

  it("leaves the conversation's and its session's last activity unchanged", async () => {
    await seedConversation({ unread: true });
    const before = await reloadLastActivity();
    const { deps } = makeDeps();
    const { POST } = createMarkReadRouteHandlers(deps);

    const response = await POST(
      plainRequest(),
      context({
        name: PROJECT_NAME,
        session: SESSION_NAME,
        conversationId: CONVERSATION_ID,
      }),
    );

    expect(response.status).toBe(200);
    expect(await reloadUnread()).toBe(false);
    expect(await reloadLastActivity()).toEqual(before);
  });

  it("returns 404 when the project does not resolve", async () => {
    await seedConversation({ unread: true });
    const { deps, broadcastedEvents } = makeDeps({
      resolveProjectPath: vi.fn(async () => null),
    });
    const { POST } = createMarkReadRouteHandlers(deps);

    const response = await POST(
      plainRequest(),
      context({
        name: "unknown",
        session: SESSION_NAME,
        conversationId: CONVERSATION_ID,
      }),
    );
    expect(response.status).toBe(404);
    expect(broadcastedEvents).toHaveLength(0);
    // No mutation reached: the persisted conversation stays unread.
    expect(await reloadUnread()).toBe(true);
  });

  it("returns 404 when the session does not exist", async () => {
    await seedConversation({ unread: true });
    const { deps, broadcastedEvents } = makeDeps({
      getSession: vi.fn(async () => null),
    });
    const { POST } = createMarkReadRouteHandlers(deps);

    const response = await POST(
      plainRequest(),
      context({
        name: PROJECT_NAME,
        session: "missing",
        conversationId: CONVERSATION_ID,
      }),
    );
    expect(response.status).toBe(404);
    expect(broadcastedEvents).toHaveLength(0);
    expect(await reloadUnread()).toBe(true);
  });

  it("returns 404 when the conversation does not exist in the session", async () => {
    await seedConversation({ unread: true });
    const { deps, broadcastedEvents } = makeDeps({
      getSession: vi.fn(async () => makeSession([makeConversation()])),
    });
    const { POST } = createMarkReadRouteHandlers(deps);

    const response = await POST(
      plainRequest(),
      context({
        name: PROJECT_NAME,
        session: SESSION_NAME,
        conversationId: "does-not-exist",
      }),
    );
    expect(response.status).toBe(404);
    expect(broadcastedEvents).toHaveLength(0);
    expect(await reloadUnread()).toBe(true);
  });
});
