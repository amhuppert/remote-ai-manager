/**
 * Regression: queue rows returned from `mutateConversation` for broadcast must
 * not alias a revoked Immer draft.
 *
 * The real store mutates through `createDraft`/`finishDraft`. A terminal row
 * that is PRUNED from the queue (markDelivered / markFailed / cancel) is never
 * re-inserted into the finalized tree, so Immer revokes the draft proxies it
 * still references — notably the nested `content` array. The service then
 * broadcasts that row via `toQueuedMessageView`, and the first read of
 * `message.content` (SSE serialization in production) throws
 * "Cannot perform 'get' on a proxy that has been revoked".
 *
 * These tests run the REAL store via `createPersistenceFixture()`. A JS-object
 * fake `mutateConversation` (no Immer draft) cannot reproduce the revocation,
 * which is exactly why the bug escaped the existing suite.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: () => {},
    debug: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

import { conversationStateSchema } from "./schemas";
import type { MessageContentBlock } from "./message-content-schemas";
import type { SSEEvent } from "@/lib/api/sse-events";
import {
  createMessageQueueService,
  type MessageQueueServiceDeps,
} from "./message-queue-service";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";

const PROJECT_PATH = "/proj";
const SESSION_NAME = "sess";
const CONVERSATION_ID = "conv-1";
const NOW = "2026-06-22T12:00:00.000Z";

const KEY = {
  projectPath: PROJECT_PATH,
  sessionName: SESSION_NAME,
  conversationId: CONVERSATION_ID,
} as const;

function textBlock(text: string): MessageContentBlock {
  return { type: "text", text };
}

let fixture: PersistenceFixture;

async function seedRunningConversation(): Promise<void> {
  fixture.seedProject(PROJECT_PATH);
  fixture.seedSession(PROJECT_PATH, SESSION_NAME);
  await fixture.seedConversation(
    PROJECT_PATH,
    SESSION_NAME,
    conversationStateSchema.parse({
      id: CONVERSATION_ID,
      transcriptPath: null,
      status: "running",
      role: null,
      agentBackend: "codex",
      promptCount: 0,
      createdAt: NOW,
      lastActivityAt: NOW,
    }),
  );
}

function makeService(): {
  service: ReturnType<typeof createMessageQueueService>;
  broadcasts: SSEEvent[];
} {
  const broadcasts: SSEEvent[] = [];
  let idCounter = 0;
  const deps: MessageQueueServiceDeps = {
    mutateConversation: fixture.deps.mutateConversation,
    getConversation: fixture.deps.getConversation,
    getProjectDisplayName: () => "proj-display",
    broadcast: (event) => {
      broadcasts.push(event);
    },
    now: () => NOW,
    newId: () => {
      idCounter += 1;
      return `id-${idCounter}`;
    },
  };
  return { service: createMessageQueueService(deps), broadcasts };
}

/** All `message-queue-updated` views for a given row id, in broadcast order. */
function updatesFor(broadcasts: SSEEvent[], id: string) {
  return broadcasts
    .filter(
      (e): e is Extract<SSEEvent, { type: "message-queue-updated" }> =>
        e.type === "message-queue-updated",
    )
    .map((e) => e.message)
    .filter((m) => m.id === id);
}

beforeEach(() => {
  fixture = createPersistenceFixture();
});

afterEach(() => {
  fixture.close();
});

describe("queue broadcast rows survive Immer draft finalization", () => {
  it("markDelivered broadcasts a delivered row whose content is readable", async () => {
    await seedRunningConversation();
    const { service, broadcasts } = makeService();

    const entry = await service.enqueue({ ...KEY, content: [textBlock("hi")] });
    const batch = await service.claimNextTurnBatch(KEY);
    expect(batch?.messageIds).toEqual([entry.id]);
    if (!batch) throw new Error("expected a claimed batch");

    await service.markDelivered({
      ...KEY,
      ids: batch.messageIds,
      deliveryAttemptId: batch.deliveryAttemptId,
    });

    // Production serializes the broadcast to SSE; reading the revoked-proxy
    // `content` throws there. Assert every captured event is serializable.
    expect(() => JSON.stringify(broadcasts)).not.toThrow();

    const delivered = updatesFor(broadcasts, entry.id).find(
      (m) => m.status === "delivered",
    );
    expect(delivered).toBeDefined();
    expect(delivered?.content).toEqual([textBlock("hi")]);
  });

  it("cancel broadcasts a cancelled row whose content is readable", async () => {
    await seedRunningConversation();
    const { service, broadcasts } = makeService();

    const entry = await service.enqueue({
      ...KEY,
      content: [textBlock("scrap")],
    });
    expect(await service.cancel({ ...KEY, id: entry.id })).toBe("cancelled");

    expect(() => JSON.stringify(broadcasts)).not.toThrow();

    const cancelled = updatesFor(broadcasts, entry.id).find(
      (m) => m.status === "cancelled",
    );
    expect(cancelled).toBeDefined();
    expect(cancelled?.content).toEqual([textBlock("scrap")]);
  });
});
