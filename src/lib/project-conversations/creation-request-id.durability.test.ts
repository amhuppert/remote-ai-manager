/**
 * The create-and-send correlation token, proved durable through the real store.
 *
 * A client whose prompt stream never delivered its conversation id identifies its
 * own conversation by the token the record carries, and it reads that record from
 * the project conversation list — a genuine read of persisted state. A JS-object
 * fake cannot show the token survives the serialization boundary, so this drives
 * the real service against a real SQLite-backed store and reloads through the
 * repository.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createProjectConversationService } from "./service";

const PROJECT_PATH = "/repo-durable";

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
    getProjectDisplayName: () => "repo-durable",
    newId: () => "plc-durable",
    now: () => "2026-01-01T00:00:00.000Z",
  });
});

afterEach(() => {
  fixture.close();
});

describe("project conversation creation-request token durability", () => {
  it("survives the round trip and is readable from the project's conversation list", async () => {
    await service.createProjectConversation(PROJECT_PATH, {
      creationRequestId: "req-durable-1",
    });

    // Reloaded through the repository, not read back from the returned object.
    const reloaded = await fixture.store.getProjectConversation(
      PROJECT_PATH,
      "plc-durable",
    );
    expect(reloaded?.creationRequestId).toBe("req-durable-1");

    // The list is the source the client actually correlates against.
    const listed = await service.listProjectConversations(PROJECT_PATH);
    expect(listed.map((c) => c.creationRequestId)).toEqual(["req-durable-1"]);
  });

  it("stays absent for a conversation created with no submission to correlate", async () => {
    await service.createProjectConversation(PROJECT_PATH);

    const reloaded = await fixture.store.getProjectConversation(
      PROJECT_PATH,
      "plc-durable",
    );
    // Absent rather than empty: a client matching on the token must never match
    // a conversation that records no creating submission.
    expect(reloaded?.creationRequestId).toBeUndefined();
  });
});
