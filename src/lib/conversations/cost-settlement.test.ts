import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SSEEvent } from "@/lib/api/sse-events";
import type { PublishOutcome } from "@/lib/events/publication";
import type { TranscriptEntry } from "@/lib/prompt/transcript";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { makeConversationState } from "./testing/conversation-state-fixture";
import { recordConversationCostSettlement } from "./cost-settlement";

/**
 * Where a late settlement lands (ticket #120): the durable row when nothing
 * hosts the conversation, the live actor when something does, the transcript
 * once per lineage cumulative, and the SSE bus with the new total inline.
 */

const PROJECT = "/repo/demo";
const SESSION = "feature-x";
const CONVERSATION = "conv-1";

let fixture: PersistenceFixture;
let published: SSEEvent[];
let appended: Array<TranscriptEntry & { id: string }>;

beforeEach(async () => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT);
  fixture.seedSession(PROJECT, SESSION);
  await fixture.seedConversation(
    PROJECT,
    SESSION,
    makeConversationState({
      id: CONVERSATION,
      totalCostUsd: 0.5,
      promptCount: 2,
      createdAt: "2026-09-20T10:00:00.000Z",
      lastActivityAt: "2026-09-20T10:00:00.000Z",
    }),
  );
  published = [];
  appended = [];
});

afterEach(() => {
  fixture.close();
});

const publish = (event: SSEEvent): PublishOutcome => {
  published.push(event);
  return { delivered: true };
};

const identity = {
  projectPath: PROJECT,
  projectName: "demo",
  storeSessionName: SESSION,
  conversationId: CONVERSATION,
};

describe("recordConversationCostSettlement", () => {
  it("adds the delta to the persisted row when no actor hosts the conversation", async () => {
    const result = await recordConversationCostSettlement(
      identity,
      { costUsdDelta: 0.04, lineageId: "agent-1", cumulativeCostUsd: 0.04 },
      {
        mutateConversation: fixture.deps.mutateConversation,
        applyToHostedActor: () => ({ applied: false }),
        publish,
        appendTranscriptEntryOnce: async (_id, entry) => {
          appended.push(entry);
        },
      },
    );
    expect(result.totalCostUsd).toBeCloseTo(0.54, 9);
    const reloaded = await fixture
      .recreateStore()
      .getConversation(PROJECT, SESSION, CONVERSATION);
    expect(reloaded?.totalCostUsd).toBeCloseTo(0.54, 9);
    expect(published).toEqual([
      {
        type: "conversation-usage-updated",
        scope: "session",
        projectName: "demo",
        sessionName: SESSION,
        conversationId: CONVERSATION,
        totalCostUsd: result.totalCostUsd,
      },
    ]);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      id: "cost-settlement:conv-1:agent-1:40000",
      type: "cost_settlement",
      raw: {
        lineageId: "agent-1",
        cumulativeCostUsd: 0.04,
        costUsdDelta: 0.04,
      },
    });
  });

  it("leaves the row to the hosted actor's own sync and publishes the actor's total", async () => {
    const applied: number[] = [];
    const result = await recordConversationCostSettlement(
      identity,
      { costUsdDelta: 0.02, lineageId: "agent-1", cumulativeCostUsd: 0.06 },
      {
        mutateConversation: fixture.deps.mutateConversation,
        applyToHostedActor: (_identity, delta) => {
          applied.push(delta);
          return { applied: true, totalCostUsd: 0.52 };
        },
        publish,
      },
    );
    expect(applied).toEqual([0.02]);
    expect(result.totalCostUsd).toBe(0.52);
    // The row is the actor's to write; this seam must not race it.
    const row = await fixture.deps.getConversation(
      PROJECT,
      SESSION,
      CONVERSATION,
    );
    expect(row?.totalCostUsd).toBe(0.5);
    expect(published[0]).toMatchObject({ totalCostUsd: 0.52 });
  });

  it("still publishes when the transcript frame cannot be written", async () => {
    await recordConversationCostSettlement(
      identity,
      { costUsdDelta: 0.01, lineageId: "agent-1", cumulativeCostUsd: 0.01 },
      {
        mutateConversation: fixture.deps.mutateConversation,
        applyToHostedActor: () => ({ applied: false }),
        publish,
        appendTranscriptEntryOnce: async () => {
          throw new Error("disk full");
        },
      },
    );
    expect(published).toHaveLength(1);
    const row = await fixture.deps.getConversation(
      PROJECT,
      SESSION,
      CONVERSATION,
    );
    expect(row?.totalCostUsd).toBeCloseTo(0.51, 9);
  });
});
