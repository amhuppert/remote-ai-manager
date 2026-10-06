import { afterEach, describe, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createConversationSubscriptionWaitsRepo } from "@/lib/state-store/conversation-subscription-waits-repo";
import { createConversationSubscriptionsRepo } from "@/lib/state-store/conversation-subscriptions-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { createActiveWaitService } from "./active-wait-service";
import { createSubscriptionControlsService } from "./control-service";
import type { SourceFact } from "./schemas";
import { createSubscriptionService } from "./service";

let fixture: PersistenceFixture | undefined;
afterEach(() => fixture?.close());
const owner = { projectPath: "/project", conversationId: "owner" };
const run = (id: string) => ({ kind: "run", id }) as const;

function fact(occurrenceId: string, sourceText: string, kind = "question"): SourceFact {
  return {
    occurrenceId,
    eventKind: `run-boundary:${kind}`,
    category: kind === "succeeded" ? "outcome" : "decision",
    sourceTitle: "Fix the notice",
    summary: `Fix the notice: ${kind}.`,
    sourceText,
    occurredAt: "2026-10-06T10:00:00.000Z",
    revision: null,
    outcome: kind,
    retrievalHandle: "cctl run show run-1",
    actorConversationId: null,
  };
}

/** Real repositories and services on SQLite; only the sources are scripted. */
function harness(options: { idsDescend?: boolean } = {}) {
  fixture = createPersistenceFixture();
  const db = fixture.db;
  const facts = new Map<string, SourceFact[]>();
  const factsOf = (id: string): SourceFact[] => {
    const list = facts.get(id) ?? [];
    facts.set(id, list);
    return list;
  };
  const clock = { at: "2026-10-06T10:00:00.000Z" };
  let nextId = 0;
  const now = () => clock.at;
  const newId = () => {
    nextId++;
    return `id-${String(options.idsDescend === true ? 9000 - nextId : nextId).padStart(4, "0")}`;
  };
  const subscriptions = createConversationSubscriptionsRepo(db, createWriteQueue());
  const waitsRepo = createConversationSubscriptionWaitsRepo(db, createWriteQueue());
  const service = createSubscriptionService({
    repo: subscriptions,
    isRecipientEligible: async () => true,
    readSource: async (_recipient, source, cursor) => {
      const list = factsOf(source.id);
      return {
        cursor: String(list.length),
        facts: cursor === null ? [] : list.slice(Number(cursor)),
        missing: false,
      };
    },
    now,
    newId,
  });
  const waits = createActiveWaitService({
    repo: waitsRepo,
    subscriptions,
    isRecipientEligible: async () => true,
    readTerminalSource: async (_recipient, source) =>
      source.kind === "validation"
        ? {
            kind: "terminal",
            fact: { ...fact(`${source.id}:passed`, "Tests passed", "succeeded"), eventKind: "validation-completed" },
          }
        : { kind: "missing" },
    now,
    newId,
  });
  const controls = createSubscriptionControlsService({
    repo: subscriptions,
    waits: waitsRepo,
    activeWaits: waits,
    isRecipientEligible: async () => true,
    // The queue row of a planned or queued wake is still pending, so withdrawing it is safe.
    withdrawPendingWake: async (_batch, commit) => {
      commit();
      return true;
    },
    now,
    newId,
  });
  async function followRun(id: string, expiresAt?: string) {
    const follow = await service.autoFollow({
      recipient: owner,
      source: run(id),
      reason: "Run launched by this conversation",
      initialCursor: "0",
      wakes: true,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    });
    if (follow === null) throw new Error("not followed");
    return follow;
  }
  async function deliveryOf(occurrenceId: string) {
    const items = (await subscriptions.readInbox(owner, { includeSettled: true, limit: 200 })).items;
    const found = items.find((item) => item.fact.occurrenceId === occurrenceId);
    if (found === undefined) throw new Error(`no delivery for ${occurrenceId}`);
    return found;
  }
  return { service, waits, waitsRepo, subscriptions, controls, factsOf, clock, followRun, deliveryOf };
}

describe("follows that wake", () => {
  it("wakes the recipient with each new fact, carrying its text, instead of briefing it on the next turn", async () => {
    const h = harness();
    await h.followRun("run-1");
    h.factsOf("run-1").push(fact("q-1", "Question: Which helper? Answer: cctl run answer run-1 --question q-1"));
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
    expect((await h.deliveryOf("q-1")).state).toBe("accepted");
    expect(await h.waits.prepareBatch(owner)).toBeNull();
    expect(await h.waits.listRecipients()).toEqual([]);
  });

  it("leaves a follow without wake to the next turn's briefing", async () => {
    const h = harness();
    await h.service.autoFollow({ recipient: owner, source: run("run-1"), reason: "Following", initialCursor: "0" });
    h.factsOf("run-1").push(fact("q-1", "Question: Which helper?"));
    await h.service.reconcile(owner);

    expect(await h.waits.prepareBatch(owner)).toBeNull();
    expect((await h.service.prepareBriefing({ recipient: owner, attemptId: "turn-1" })).block).toContain(
      "Fix the notice: question.",
    );
  });

  it("delivers a notice already handed to a wake after its follow is unfollowed, so later wakes are not blocked", async () => {
    const h = harness();
    const follow = await h.followRun("run-1");
    h.factsOf("run-1").push(fact("q-1", "Question: Which helper?"));
    await h.service.reconcile(owner);
    const first = await h.waits.prepareBatch(owner);

    await h.service.unfollow(owner, follow.id);

    expect(await h.waitsRepo.isBatchDispatchable(first?.id ?? "")).toBe(true);
    await h.waits.settleBatch(first?.id ?? "", "accepted");
    await h.followRun("run-2");
    h.factsOf("run-2").push(fact("q-2", "Question: Which file?"));
    await h.service.reconcile(owner);
    const next = await h.waits.prepareBatch(owner);
    expect(next?.followDeliveryIds).toEqual([(await h.deliveryOf("q-2")).id]);
  });

  it("returns a run notice to pending when a one-time wait's control withdraws the wake they shared", async () => {
    const h = harness();
    const wait = await h.waits.register({
      recipient: owner,
      source: { kind: "validation", id: "v-1" },
      reason: "Continue after the tests",
    });
    await h.followRun("run-1");
    h.factsOf("run-1").push(fact("q-1", "Question: Which helper?"));
    await h.service.reconcile(owner);
    const shared = await h.waits.prepareBatch(owner);
    expect(shared?.waitIds).toEqual([wait.id]);
    expect(shared?.followDeliveryIds).toEqual([(await h.deliveryOf("q-1")).id]);

    await h.controls.pause(owner, wait.subscriptionId);

    expect((await h.deliveryOf("q-1")).state).toBe("pending");
    expect((await h.waits.prepareBatch(owner))?.followDeliveryIds).toEqual([(await h.deliveryOf("q-1")).id]);
  });

  it("releases a wake of notices only that ended uncertain with no queue row, so its notices wake again", async () => {
    const h = harness();
    await h.followRun("run-1");
    h.factsOf("run-1").push(fact("q-1", "Question: Which helper?"));
    await h.service.reconcile(owner);
    const lost = await h.waits.prepareBatch(owner);
    await h.waits.settleBatch(lost?.id ?? "", "uncertain", "The attempted wake has no queue row");

    await h.waits.releaseUnsentBatch(lost?.id ?? "");

    expect((await h.deliveryOf("q-1")).state).toBe("pending");
    const again = await h.waits.prepareBatch(owner);
    expect(again?.id).not.toBe(lost?.id);
    expect(again?.followDeliveryIds).toEqual([(await h.deliveryOf("q-1")).id]);
  });

  it("does not release an uncertain wake that carries a one-time wait, which keeps its explicit review", async () => {
    const h = harness();
    await h.waits.register({ recipient: owner, source: { kind: "validation", id: "v-1" }, reason: "Continue after the tests" });
    const shared = await h.waits.prepareBatch(owner);
    await h.waits.settleBatch(shared?.id ?? "", "uncertain", "The attempted wake has no queue row");

    await h.waits.releaseUnsentBatch(shared?.id ?? "");

    expect((await h.waits.getBatch(shared?.id ?? ""))?.state).toBe("uncertain");
  });

  it("refuses to retry or dismiss a notice its unresolved wake still holds", async () => {
    const h = harness();
    await h.followRun("run-1");
    h.factsOf("run-1").push(fact("q-1", "Question: Which helper?"));
    await h.service.reconcile(owner);
    const held = await h.waits.prepareBatch(owner);
    await h.waits.settleBatch(held?.id ?? "", "uncertain", "Acceptance was not confirmed");
    const delivery = await h.deliveryOf("q-1");

    expect(await h.subscriptions.reviewDelivery(owner, delivery.id, "retry", h.clock.at)).toBe(false);
    expect(await h.subscriptions.reviewDelivery(owner, delivery.id, "dismiss", h.clock.at)).toBe(false);
    expect((await h.deliveryOf("q-1")).state).toBe("uncertain");
  });

  it("does not wake for a follow that expired before its notice was handed to a wake", async () => {
    const h = harness();
    await h.followRun("run-1", "2026-10-06T11:00:00.000Z");
    h.factsOf("run-1").push(fact("q-1", "Question: Which helper?"));
    await h.service.reconcile(owner);

    h.clock.at = "2026-10-06T12:00:00.000Z";

    expect(await h.waits.listRecipients()).toEqual([]);
    expect(await h.waits.prepareBatch(owner)).toBeNull();
  });

  it("keeps a run's notices in the order the run recorded them", async () => {
    const h = harness({ idsDescend: true });
    await h.followRun("run-1");
    h.factsOf("run-1").push(fact("q-1", "First question"), fact("q-2", "Second question"));
    await h.service.reconcile(owner);

    const batch = await h.waits.prepareBatch(owner);

    expect(batch?.followDeliveryIds).toEqual([(await h.deliveryOf("q-1")).id, (await h.deliveryOf("q-2")).id]);
    expect(batch?.message.indexOf("First question")).toBeLessThan(batch?.message.indexOf("Second question") ?? 0);
  });

  it("retires a run's follow once its final notice is delivered", async () => {
    const h = harness();
    await h.followRun("run-1");
    h.factsOf("run-1").push(fact("run:succeeded", "Result: done", "succeeded"));
    await h.service.reconcile(owner);
    const last = await h.waits.prepareBatch(owner);

    await h.waits.settleBatch(last?.id ?? "", "accepted");

    expect((await h.subscriptions.findBySource(owner, run("run-1")))?.expiresAt).not.toBeNull();
    h.factsOf("run-1").push(fact("late", "Nothing follows a result"));
    await h.service.reconcile(owner);
    expect(await h.waits.prepareBatch(owner)).toBeNull();
  });
});
