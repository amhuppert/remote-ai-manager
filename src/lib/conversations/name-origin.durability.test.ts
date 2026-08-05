/**
 * Name-origin provenance, proved durable through the real store.
 *
 * Automatic naming must never overwrite a manually chosen name, and the guard
 * is enforced at write time against the PERSISTED `nameOrigin` — so a manual
 * rename that survives a server restart only as `name` (with its origin
 * dropped or reset to "default") would silently re-open the conversation to
 * auto-renaming. A JS-object fake cannot show the origin survives the
 * serialization boundary, so this drives the real rename service against a
 * real SQLite-backed store, restarts the store, and reloads through the
 * repository.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createConversationService } from "./service";
import { buildConversation } from "./build-conversation";

const PROJECT_PATH = "/repo-name-origin";
const SESSION_NAME = "session-durable";
const CONVERSATION_ID = "conv-name-origin";

let fixture: PersistenceFixture;
let service: ReturnType<typeof createConversationService>;

beforeEach(async () => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  fixture.seedSession(PROJECT_PATH, SESSION_NAME);
  await fixture.seedConversation(
    PROJECT_PATH,
    SESSION_NAME,
    buildConversation({
      id: CONVERSATION_ID,
      scope: "session",
      name: `${SESSION_NAME} 1`,
      createdAt: "2026-01-01T00:00:00.000Z",
      agentBackend: "claude",
    }),
  );
  service = createConversationService({
    mutateSession: fixture.store.mutateSession,
    createSessionConversation: fixture.store.createSessionConversation,
    getSession: fixture.store.getSession,
    getConversation: fixture.store.getConversation,
    getSessionConversations: fixture.store.getSessionConversations,
    setConversationPendingPromptText:
      fixture.store.setConversationPendingPromptText,
  });
});

afterEach(() => {
  fixture.close();
});

describe("conversation name-origin durability", () => {
  it('persists nameOrigin "manual" across a store restart after a rename', async () => {
    await service.renameConversation(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
      "Chosen By Hand",
    );

    // A brand-new store over the same database — the state a restarted server
    // comes up with — reloaded through the repository, not the returned object.
    const restarted = fixture.recreateStore();
    const reloaded = await restarted.getConversation(
      PROJECT_PATH,
      SESSION_NAME,
      CONVERSATION_ID,
    );

    expect(reloaded?.name).toBe("Chosen By Hand");
    expect(reloaded?.nameOrigin).toBe("manual");
  });

  it('persists nameOrigin "default" for a conversation created through the normal path', async () => {
    const created = await service.createConversation(
      PROJECT_PATH,
      SESSION_NAME,
    );

    const restarted = fixture.recreateStore();
    const reloaded = await restarted.getConversation(
      PROJECT_PATH,
      SESSION_NAME,
      created.id,
    );

    expect(reloaded?.nameOrigin).toBe("default");
  });
});
