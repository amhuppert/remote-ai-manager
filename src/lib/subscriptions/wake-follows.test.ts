import { afterEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createConversationSubscriptionWaitsRepo } from "@/lib/state-store/conversation-subscription-waits-repo";
import { createConversationSubscriptionsRepo } from "@/lib/state-store/conversation-subscriptions-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { createActiveWaitService } from "./active-wait-service";
import type { SourceFact } from "./schemas";
import { createSubscriptionService } from "./service";

let fixture: PersistenceFixture | undefined;
afterEach(() => fixture?.close());
const owner = { projectPath: "/project", conversationId: "owner" };
const run = { kind: "run", id: "run-1" } as const;

function fact(occurrenceId: string, sourceText: string): SourceFact {
  return {
    occurrenceId,
    eventKind: "run-boundary:question",
    category: "decision",
    sourceTitle: "Fix the notice",
    summary: "Fix the notice: a question.",
    sourceText,
    occurredAt: "2026-10-06T10:00:00.000Z",
    revision: null,
    outcome: "question",
    retrievalHandle: "cctl run show run-1",
    actorConversationId: null,
  };
}

function harness() {
  fixture = createPersistenceFixture();
  const db = fixture.db;
  const facts: SourceFact[] = [];
  let nextId = 0;
  const now = () => "2026-10-06T10:00:00.000Z";
  const newId = () => `id-${++nextId}`;
  const subscriptions = createConversationSubscriptionsRepo(db, createWriteQueue());
  const waitsRepo = createConversationSubscriptionWaitsRepo(db, createWriteQueue());
  const service = createSubscriptionService({
    repo: subscriptions,
    isRecipientEligible: async () => true,
    readSource: async (_recipient, _source, cursor) => ({
      cursor: String(facts.length),
      facts: cursor === null ? [] : facts.slice(Number(cursor)),
      missing: false,
    }),
    now,
    newId,
  });
  const waits = createActiveWaitService({
    repo: waitsRepo,
    subscriptions,
    isRecipientEligible: async () => true,
    readTerminalSource: async () => ({ kind: "missing" }),
    now,
    newId,
  });
  return { service, waits, waitsRepo, subscriptions, facts };
}

describe("follows that wake", () => {
  it("wakes the recipient with each new fact, carrying its text, instead of briefing it on the next turn", async () => {
    const h = harness();
    await h.service.autoFollow({
      recipient: owner,
      source: run,
      reason: "Run launched by this conversation",
      initialCursor: "0",
      wakes: true,
    });
    h.facts.push(fact("ctx:question:q-1", "Question: Which helper? Answer: cctl run answer run-1 --question q-1"));
    await h.service.reconcile(owner);

    expect(await h.waits.listRecipients()).toEqual([owner]);
    expect((await h.service.prepareBriefing({ recipient: owner, attemptId: "turn-1" })).block).toBeNull();

    const batch = await h.waits.prepareBatch(owner);
    expect(batch).toMatchObject({ waitIds: [], deliveryIds: [] });
    expect(batch?.followDeliveryIds).toHaveLength(1);
    expect(batch?.message).toContain("Run launched by this conversation");
    expect(batch?.message).toContain("cctl run answer run-1 --question q-1");
    expect(await h.waitsRepo.isBatchDispatchable(batch?.id ?? "")).toBe(true);

    await h.waits.settleBatch(batch?.id ?? "", "accepted");
    const [delivery] = (await h.subscriptions.readInbox(owner, { includeSettled: true })).items;
    expect(delivery?.state).toBe("accepted");
    expect(await h.waits.prepareBatch(owner)).toBeNull();
    expect(await h.waits.listRecipients()).toEqual([]);
  });

  it("leaves a follow without wake to the next turn's briefing", async () => {
    const h = harness();
    await h.service.autoFollow({ recipient: owner, source: run, reason: "Following", initialCursor: "0" });
    h.facts.push(fact("ctx:question:q-1", "Question: Which helper?"));
    await h.service.reconcile(owner);

    expect(await h.waits.prepareBatch(owner)).toBeNull();
    expect((await h.service.prepareBriefing({ recipient: owner, attemptId: "turn-1" })).block).toContain(
      "Fix the notice: a question.",
    );
  });

  it("stops waking once the recipient unfollows, before its wake is sent", async () => {
    const h = harness();
    const follow = await h.service.autoFollow({
      recipient: owner,
      source: run,
      reason: "Run launched by this conversation",
      initialCursor: "0",
      wakes: true,
    });
    h.facts.push(fact("ctx:question:q-1", "Question: Which helper?"));
    await h.service.reconcile(owner);
    const batch = await h.waits.prepareBatch(owner);
    expect(await h.waitsRepo.isBatchDispatchable(batch?.id ?? "")).toBe(true);

    await h.service.unfollow(owner, follow?.id ?? "");

    expect(await h.waitsRepo.isBatchDispatchable(batch?.id ?? "")).toBe(false);
  });
});
