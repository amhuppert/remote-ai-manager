/**
 * Name-origin transitions for project conversations, proved through the real
 * store. A "manual" origin is the write-time guard that stops automatic naming
 * from overwriting a user-chosen name, so the transition must hold in the
 * PERSISTED record — these tests drive the production service against a real
 * SQLite-backed store and assert on the reloaded state, never the in-memory
 * return value alone.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createProjectConversationService } from "./service";

const PROJECT_PATH = "/repo-name-origin-plc";

let fixture: PersistenceFixture;
let service: ReturnType<typeof createProjectConversationService>;

beforeEach(() => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  service = createProjectConversationService({
    createProjectConversationRecord: fixture.store.createProjectConversation,
    getProjectConversation: fixture.store.getProjectConversation,
    getProjectConversations: fixture.store.getProjectConversations,
    mutateProjectConversation: fixture.store.mutateProjectConversation,
    setProjectConversationArchived:
      fixture.store.setProjectConversationArchived,
    setProjectConversationOpen: fixture.store.setProjectConversationOpen,
    readConfig: async () => ({ defaultAgentBackend: "claude" as const }),
    getProjectDisplayName: () => "repo-name-origin-plc",
    newId: () => "plc-origin",
    now: () => "2026-01-01T00:00:00.000Z",
  });
});

afterEach(() => {
  fixture.close();
});

describe("project conversation name-origin transitions", () => {
  it('rename sets nameOrigin "manual" in the persisted record', async () => {
    await service.createProjectConversation(PROJECT_PATH);

    await service.renameProjectConversation(
      PROJECT_PATH,
      "plc-origin",
      "Chosen By Hand",
    );

    const reloaded = await fixture.store.getProjectConversation(
      PROJECT_PATH,
      "plc-origin",
    );
    expect(reloaded?.name).toBe("Chosen By Hand");
    expect(reloaded?.nameOrigin).toBe("manual");
  });

  it('a caller-supplied name at creation yields nameOrigin "manual"', async () => {
    await service.createProjectConversation(PROJECT_PATH, {
      name: "Named Up Front",
    });

    const reloaded = await fixture.store.getProjectConversation(
      PROJECT_PATH,
      "plc-origin",
    );
    expect(reloaded?.name).toBe("Named Up Front");
    expect(reloaded?.nameOrigin).toBe("manual");
  });

  it('creation without a caller-supplied name yields nameOrigin "default"', async () => {
    await service.createProjectConversation(PROJECT_PATH);

    const reloaded = await fixture.store.getProjectConversation(
      PROJECT_PATH,
      "plc-origin",
    );
    expect(reloaded?.name).toBe("repo-name-origin-plc chat 1");
    expect(reloaded?.nameOrigin).toBe("default");
  });
});
