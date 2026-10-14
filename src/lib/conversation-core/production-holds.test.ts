import { afterEach, describe, expect, it } from "vitest";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createProductionConversationHold } from "./production-holds";

let fixture: PersistenceFixture;
afterEach(() => fixture.close());

const awaitingReview = {
  id: "q-1",
  content: [{ type: "text" as const, text: "Earlier" }],
  status: "uncertain" as const,
  enqueuedAt: "2026-10-04T10:00:00.000Z",
  updatedAt: "2026-10-04T10:00:00.000Z",
  deliveryStartedAt: "2026-10-04T10:00:01.000Z",
  deliveredAt: null,
  cancelledAt: null,
  failedAt: null,
  deliveryAttemptId: "att-1",
  attemptCount: 1,
  error: null,
};

describe("the conversation row's holds in production", () => {
  it("reads a session conversation's row", async () => {
    fixture = createPersistenceFixture();
    fixture.seedProject("/repo");
    fixture.seedSession("/repo", "session");
    await fixture.seedConversation(
      "/repo",
      "session",
      makeConversationState({ id: "chat-s", pendingQueue: [awaitingReview] }),
    );

    const holds = createProductionConversationHold(() => fixture.db);
    expect(await holds.refusal("chat-s", "message")).toMatchObject({
      code: "queue_review",
    });
  });

  it("reads a project conversation's row too", async () => {
    fixture = createPersistenceFixture();
    fixture.seedProject("/repo");
    await fixture.seedProjectConversation(
      "/repo",
      makeConversationState({ id: "chat-p", pendingQueue: [awaitingReview] }),
    );

    const holds = createProductionConversationHold(() => fixture.db);
    expect(await holds.refusal("chat-p", "message")).toMatchObject({
      code: "queue_review",
    });
    expect(await holds.refusal("chat-p", "command")).toMatchObject({
      code: "queue_review",
    });
    expect(await holds.refusal("unknown", "message")).toBeNull();
  });
});
