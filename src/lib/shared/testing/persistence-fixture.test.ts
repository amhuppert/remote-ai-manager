import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { conversationStateSchema } from "@/lib/conversations/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "./persistence-fixture";

const PROJECT_PATH = "/p1";
const SESSION_NAME = "s1";
const CONVERSATION_ID = "c1";

function makeConversation(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return conversationStateSchema.parse({
    id: CONVERSATION_ID,
    transcriptPath: null,
    status: "new",
    promptCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    ...overrides,
  });
}

const openFixtures: PersistenceFixture[] = [];

function openFixture(): PersistenceFixture {
  const fixture = createPersistenceFixture();
  openFixtures.push(fixture);
  return fixture;
}

async function seedBaseConversation(
  fixture: PersistenceFixture,
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

afterEach(() => {
  while (openFixtures.length > 0) {
    openFixtures.pop()?.close();
  }
});

describe("createPersistenceFixture", () => {
  it("survives a real serialization round-trip through the injected seam", async () => {
    const fixture = openFixture();
    await seedBaseConversation(fixture, { summary: "before" });

    const returned = await fixture.deps.mutateConversation(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
      "test.mutate",
      (conversation) => {
        conversation.summary = "after";
        conversation.unread = true;
        return conversation.id;
      },
    );
    expect(returned).toBe(CONVERSATION_ID);

    const reloaded = await fixture.deps.getConversation(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
    );
    expect(reloaded).not.toBeNull();
    // Reloaded from SQLite, not an in-memory reference: proves real serialization.
    expect(reloaded?.summary).toBe("after");
    expect(reloaded?.unread).toBe(true);
  });

  it("isolates state between separate fixture instances", async () => {
    const a = openFixture();
    const b = openFixture();
    await seedBaseConversation(a, { summary: "a-only" });
    await seedBaseConversation(b, { summary: "b-only" });

    await a.deps.mutateConversation(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
      "test.mutate",
      (conversation) => {
        conversation.summary = "mutated-in-a";
      },
    );

    const fromB = await b.deps.getConversation(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
    );
    expect(fromB?.summary).toBe("b-only");
  });

  it("reset() empties state on the same fixture", async () => {
    const fixture = openFixture();
    await seedBaseConversation(fixture);

    fixture.reset();

    const reloaded = await fixture.deps.getConversation(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
    );
    expect(reloaded).toBeNull();
  });

  it("close() releases the database without error", async () => {
    const fixture = createPersistenceFixture();
    await seedBaseConversation(fixture);
    expect(() => fixture.close()).not.toThrow();
  });

  it("exposes a real store and db for direct inspection", async () => {
    const fixture = openFixture();
    await seedBaseConversation(fixture);

    const fromStore = await fixture.store.getConversation(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
    );
    expect(fromStore?.id).toBe(CONVERSATION_ID);

    const count = fixture.db
      .prepare("SELECT COUNT(*) AS n FROM conversations")
      .get() as { n: number };
    expect(count.n).toBe(1);
  });
});
