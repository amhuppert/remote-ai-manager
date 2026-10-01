import { createSubscriptionRuntime } from "@/lib/subscriptions/service-factory";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { createGraphWorkflowResultDeliveriesRepo } from "../graph-workflow-result-deliveries-repo";
import { createConversationSubscriptionsRepo } from "../conversation-subscriptions-repo";
import { createWriteQueue } from "../write-queue";
import {
  conversationSubscriptionSchema,
  subscriptionDeliverySchema,
} from "@/lib/subscriptions/schemas";
import { graphWorkflowResultDeliverySchema } from "@/lib/workflow-graph/schemas";
import { projectRecordedWorkflowSourceFact } from "@/lib/subscriptions/workflow-source";
import { workflowResultInbox } from "./0063-workflow-result-inbox";
import { createConversationSubscriptionWaitsRepo } from "../conversation-subscription-waits-repo";
import { createConversationSubscriptionPreferencesRepo } from "../conversation-subscription-preferences-repo";
import { createActiveWaitService } from "@/lib/subscriptions/active-wait-service";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import { createGraphWorkflowBoundaryEvent } from "@/lib/workflow-graph/boundary-event-projection";

const projectPath = "/repo/workflow-migration";
const sessionName = "session";
const at = "2026-10-01T04:00:00.000Z";
const acceptedAt = "2026-10-01T04:01:00.000Z";
const recipient = { projectPath, conversationId: "origin" };
const source = { kind: "workflow", id: "execution" } as const;
let fixture: PersistenceFixture;
beforeEach(async () => {
  fixture = createPersistenceFixture();
  fixture.seedProject(projectPath);
  fixture.seedSession(projectPath, sessionName);
  await fixture.seedConversation(
    projectPath,
    sessionName,
    makeConversationState({ id: recipient.conversationId }),
  );
});
afterEach(() => fixture.close());
const migrate = () =>
  workflowResultInbox.up({
    name: workflowResultInbox.name,
    context: { db: fixture.db, configDir: null },
  });
function result(boundarySeq: number, extra: Record<string, unknown> = {}) {
  const row = graphWorkflowResultDeliverySchema.parse({
    projectPath,
    sessionName,
    executionId: source.id,
    boundarySeq,
    originConversationId: recipient.conversationId,
    payload: {
      boundaryKind: "halt",
      status: "halted",
      name: "Frozen result",
      outputs: { boundarySeq },
      pendingActions: [{ kind: "resume" }],
    },
    recordedAt: at,
    state: "pending",
    attemptId: null,
    attemptCount: 0,
    deliveredAt: null,
    effectsDeliveredAt: acceptedAt,
    ...extra,
  });
  createGraphWorkflowResultDeliveriesRepo(fixture.db).record(row);
  return row;
}
function subscription(extra: Record<string, unknown> = {}) {
  return conversationSubscriptionSchema.parse({
    id: "subscription",
    recipient,
    source,
    reason: "Follow workflow",
    mode: "passive",
    eventKinds: null,
    expiresAt: null,
    status: "following",
    cursor: "0",
    createdAt: at,
    updatedAt: at,
    unfollowedAt: null,
    pausedAt: null,
    missingAt: null,
    lastError: null,
    ...extra,
  });
}
async function legacyActive(state: "accepted" | "uncertain", occurredAt = at) {
  const queue = createWriteQueue();
  const subscriptions = createConversationSubscriptionsRepo(fixture.db, queue);
  const waits = createConversationSubscriptionWaitsRepo(fixture.db, queue);
  const service = createActiveWaitService({
    repo: waits,
    subscriptions,
    isRecipientEligible: async () => true,
    now: () => acceptedAt,
    readTerminalSource: async () => ({
      kind: "terminal",
      fact: {
        occurrenceId: `one-time-terminal:workflow:${source.id}`,
        eventKind: "graph-workflow-terminal",
        category: "outcome",
        sourceTitle: "Old workflow result",
        summary: "Workflow halted.",
        occurredAt,
        revision: null,
        outcome: "halted",
        retrievalHandle: "cctl workflow wait execution",
        actorConversationId: null,
      },
    }),
  });
  const wait = await service.register({
    recipient,
    source,
    reason: "Wait for workflow",
  });
  const batch = await service.prepareBatch(recipient);
  if (!batch) throw Error("Expected legacy wake batch");
  await service.markBatchQueued(batch.id);
  await service.settleBatch(batch.id, state);
  const saved = await waits.get(recipient, wait.subscriptionId);
  if (!saved?.deliveryId) throw Error("Expected legacy active delivery");
  const delivery = await subscriptions.getDelivery(recipient, saved.deliveryId);
  if (!delivery) throw Error("Expected saved legacy active delivery");
  await createConversationSubscriptionPreferencesRepo(
    fixture.db,
    queue,
  ).markDeliveryRead(recipient, delivery.id, true, acceptedAt);
  return { subscriptions, waits, wait: saved, batch, delivery };
}
it("imports actual origin receipts into canonical inbox identities and preserves controls and full evidence", async () => {
  const pending = result(101);
  result(102, {
    state: "delivering",
    attemptId: "old-uncertain-attempt",
    attemptCount: 2,
  });
  const accepted = result(103, {
    state: "delivered",
    attemptId: "old-accepted-attempt",
    attemptCount: 3,
    deliveredAt: acceptedAt,
  });
  const repo = createConversationSubscriptionsRepo(
    fixture.db,
    createWriteQueue(),
  );
  const sub = subscription({
    status: "unfollowed",
    pausedAt: at,
    unfollowedAt: at,
    cursor: "103",
  });
  await repo.createIfAbsent(sub);
  const fact = projectRecordedWorkflowSourceFact(accepted);
  await repo.recordDelivery(
    subscriptionDeliverySchema.parse({
      id: "existing-canonical",
      subscriptionId: sub.id,
      recipient,
      source,
      fact: { ...fact, sourceText: undefined },
      recordedAt: at,
      state: "pending",
      attemptId: null,
      attemptCount: 0,
      queuedAt: null,
      acceptedAt: null,
      finishedAt: null,
      lastError: null,
    }),
  );
  await migrate();
  await migrate();
  const reloaded = createConversationSubscriptionsRepo(
    fixture.db,
    createWriteQueue(),
  );
  const deliveries = await reloaded.listDeliveriesForOverview(recipient);
  expect(deliveries).toHaveLength(3);
  expect(
    deliveries.find((row) => row.fact.occurrenceId === "101"),
  ).toMatchObject({
    state: "pending",
    fact: projectRecordedWorkflowSourceFact(pending),
  });
  expect(
    deliveries.find((row) => row.fact.occurrenceId === "102"),
  ).toMatchObject({
    state: "uncertain",
    attemptId: "old-uncertain-attempt",
    attemptCount: 2,
  });
  expect(
    deliveries.find((row) => row.fact.occurrenceId === "103"),
  ).toMatchObject({
    id: "existing-canonical",
    state: "accepted",
    attemptId: "old-accepted-attempt",
    attemptCount: 3,
    acceptedAt,
    fact,
  });
  expect(await reloaded.get(recipient, sub.id)).toMatchObject({
    status: "unfollowed",
    pausedAt: at,
    unfollowedAt: at,
    cursor: "103",
  });
  expect(
    createGraphWorkflowResultDeliveriesRepo(fixture.db).findByBoundary(
      projectPath,
      sessionName,
      source.id,
      103,
    )?.effectsDeliveredAt,
  ).toBe(acceptedAt);
});
it("retains missing-origin fallback evidence without manufacturing backend acceptance", async () => {
  result(101, {
    originConversationId: "deleted",
    state: "delivered",
    deliveredAt: acceptedAt,
  });
  result(102, { state: "delivered", deliveredAt: acceptedAt });
  await migrate();
  const rows = await createConversationSubscriptionsRepo(
    fixture.db,
    createWriteQueue(),
  ).listDeliveriesForOverview();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    recipient,
    state: "uncertain",
    acceptedAt: null,
    lastError: expect.stringContaining("fallback"),
  });
});
it.each(["accepted", "uncertain"] as const)(
  "joins a legacy active %s receipt to its canonical boundary and redirects durable links",
  async (state) => {
    const frozen = result(101);
    const h = await legacyActive(state);
    const canonical = subscriptionDeliverySchema.parse({
      ...h.delivery,
      id: "canonical-passive-row",
      fact: projectRecordedWorkflowSourceFact(frozen),
      state: "pending",
      attemptId: null,
      attemptCount: 0,
      queuedAt: null,
      acceptedAt: null,
      finishedAt: null,
      lastError: null,
    });
    await h.subscriptions.recordDelivery(canonical);
    await migrate();
    await migrate();
    const reloaded = createConversationSubscriptionsRepo(
      fixture.db,
      createWriteQueue(),
    );
    const rows = await reloaded.listDeliveriesForOverview(recipient);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: canonical.id,
      state,
      fact: projectRecordedWorkflowSourceFact(frozen),
      attemptId: h.delivery.attemptId,
    });
    const waits = createConversationSubscriptionWaitsRepo(
      fixture.db,
      createWriteQueue(),
    );
    expect(await waits.get(recipient, h.wait.subscriptionId)).toMatchObject({
      deliveryId: canonical.id,
      batchId: h.batch.id,
    });
    expect(await waits.getBatch(h.batch.id)).toMatchObject({
      deliveryIds: [canonical.id],
      state,
      message: h.batch.message,
    });
    const preferences = createConversationSubscriptionPreferencesRepo(
      fixture.db,
      createWriteQueue(),
    );
    expect(await preferences.getReadAt(recipient, canonical.id)).toBe(
      acceptedAt,
    );
    expect(await preferences.getReadAt(recipient, h.delivery.id)).toBeNull();
  },
);
it("keeps an ambiguous legacy terminal receipt and prevents automatic replay of candidate boundaries", async () => {
  result(101, { recordedAt: "2026-10-01T03:58:00.000Z" });
  result(102, { recordedAt: "2026-10-01T03:59:00.000Z" });
  const h = await legacyActive("accepted", at);
  await migrate();
  const rows = await createConversationSubscriptionsRepo(
    fixture.db,
    createWriteQueue(),
  ).listDeliveriesForOverview(recipient);
  expect(rows).toHaveLength(3);
  expect(rows.find((row) => row.id === h.delivery.id)).toMatchObject({
    state: "accepted",
    fact: { occurrenceId: h.delivery.fact.occurrenceId },
  });
  for (const occurrenceId of ["101", "102"])
    expect(
      rows.find((row) => row.fact.occurrenceId === occurrenceId),
    ).toMatchObject({
      state: "uncertain",
      acceptedAt: null,
      lastError: expect.stringContaining("ambiguous"),
    });
});
it("identifies a legacy ownerless terminal boundary from its exact event without inventing a missing snapshot", async () => {
  const execution = createWorkflowExecution({
    id: source.id,
    status: "halted",
    ownerConversationId: null,
  });
  const event = createGraphWorkflowBoundaryEvent({
    projectPath,
    sessionName,
    execution,
    boundaryKind: "halt",
  });
  event.outputProjection = {
    kind: "declared_outputs",
    byContext: { planning: { result: "exact legacy event output" } },
  };
  const boundary = fixture.graphWorkflowEvents.append(
    projectPath,
    sessionName,
    source.id,
    at,
    { event, occurredAt: at, preReset: false },
  );
  const h = await legacyActive("accepted");
  await migrate();
  const rows = await createConversationSubscriptionsRepo(
    fixture.db,
    createWriteQueue(),
  ).listDeliveriesForOverview(recipient);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: h.delivery.id,
    state: "accepted",
    fact: { occurrenceId: String(boundary.id) },
  });
  expect(JSON.parse(rows[0]?.fact.sourceText ?? "null")).toMatchObject({
    evidence: "legacy-boundary-event",
    boundaryEvent: event,
  });
  expect(
    createGraphWorkflowResultDeliveriesRepo(fixture.db).findByBoundary(
      projectPath,
      sessionName,
      source.id,
      boundary.id,
    ),
  ).toBeNull();
});
it("rolls back receipt merges and redirected links when a later boundary import fails", async () => {
  const frozen = result(101);
  result(102, { payload: { boundaryKind: "completion", status: "completed" } });
  const h = await legacyActive("accepted");
  const canonical = subscriptionDeliverySchema.parse({
    ...h.delivery,
    id: "canonical-before-failure",
    fact: projectRecordedWorkflowSourceFact(frozen),
    state: "pending",
    attemptId: null,
    attemptCount: 0,
    queuedAt: null,
    acceptedAt: null,
    finishedAt: null,
    lastError: null,
  });
  await h.subscriptions.recordDelivery(canonical);
  fixture.db.exec(
    "CREATE TRIGGER reject_workflow_import BEFORE INSERT ON conversation_subscription_deliveries WHEN NEW.occurrence_id='102' BEGIN SELECT RAISE(FAIL,'workflow import rejected'); END",
  );
  await expect(migrate()).rejects.toThrow("workflow import rejected");
  const rows = await createConversationSubscriptionsRepo(
    fixture.db,
    createWriteQueue(),
  ).listDeliveriesForOverview(recipient);
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.id === canonical.id)).toMatchObject({
    state: "pending",
    acceptedAt: null,
  });
  expect(rows.find((row) => row.id === h.delivery.id)).toMatchObject({
    state: "accepted",
    fact: { occurrenceId: h.delivery.fact.occurrenceId },
  });
  const waits = createConversationSubscriptionWaitsRepo(
    fixture.db,
    createWriteQueue(),
  );
  expect(await waits.get(recipient, h.wait.subscriptionId)).toMatchObject({
    deliveryId: h.delivery.id,
  });
  expect(await waits.getBatch(h.batch.id)).toMatchObject({
    deliveryIds: [h.delivery.id],
  });
  expect(
    await createConversationSubscriptionPreferencesRepo(
      fixture.db,
      createWriteQueue(),
    ).getReadAt(recipient, h.delivery.id),
  ).toBe(acceptedAt);
});
it("retains a terminal receipt with no recorded boundary as explicitly limited historical evidence", async () => {
  const h = await legacyActive("accepted");
  await migrate();
  const rows = await createConversationSubscriptionsRepo(
    fixture.db,
    createWriteQueue(),
  ).listDeliveriesForOverview(recipient);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: h.delivery.id,
    state: "accepted",
    fact: { occurrenceId: h.delivery.fact.occurrenceId },
  });
  expect(JSON.parse(rows[0]?.fact.sourceText ?? "null")).toMatchObject({
    evidence: "legacy-terminal-receipt",
    limitations: expect.stringContaining(
      "No exact historical terminal boundary",
    ),
  });
});
it.each(["absent", "summary", "frozen"] as const)(
  "preserves populated terminal evidence when normalizing against an %s canonical row",
  async (incumbent) => {
    const frozen = result(101);
    const h = await legacyActive("accepted");
    const normalizedFact = {
      ...h.delivery.fact,
      occurrenceId: "101",
      sourceText: JSON.stringify({
        outputs: "already captured terminal evidence",
      }),
    };
    fixture.db
      .prepare(
        "UPDATE conversation_subscription_deliveries SET fact_json=? WHERE id=?",
      )
      .run(
        JSON.stringify({
          ...normalizedFact,
          occurrenceId: h.delivery.fact.occurrenceId,
        }),
        h.delivery.id,
      );
    const canonicalFact = projectRecordedWorkflowSourceFact(frozen);
    if (incumbent !== "absent")
      await h.subscriptions.recordDelivery(
        subscriptionDeliverySchema.parse({
          ...h.delivery,
          id: "existing-canonical-evidence",
          fact:
            incumbent === "frozen"
              ? canonicalFact
              : { ...canonicalFact, sourceText: undefined },
          state: "pending",
          attemptId: null,
          attemptCount: 0,
          queuedAt: null,
          acceptedAt: null,
          finishedAt: null,
          lastError: null,
        }),
      );
    await migrate();
    await migrate();
    const rows = await createConversationSubscriptionsRepo(
      fixture.db,
      createWriteQueue(),
    ).listDeliveriesForOverview(recipient);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id:
        incumbent === "absent" ? h.delivery.id : "existing-canonical-evidence",
      state: "accepted",
      attemptId: h.delivery.attemptId,
      fact: incumbent === "frozen" ? canonicalFact : normalizedFact,
    });
  },
);

it("keeps real pending inbox evidence retryable when a legacy fallback has no runtime admission attempt", async () => {
  const fallback = result(101, {
    state: "delivered",
    attemptId: null,
    attemptCount: 0,
    deliveredAt: acceptedAt,
  });
  const repo = createConversationSubscriptionsRepo(
    fixture.db,
    createWriteQueue(),
  );
  const follow = subscription();
  await repo.createIfAbsent(follow);
  const canonical = subscriptionDeliverySchema.parse({
    id: "real-pending",
    subscriptionId: follow.id,
    recipient,
    source,
    fact: projectRecordedWorkflowSourceFact(fallback),
    recordedAt: at,
    state: "pending",
    attemptId: null,
    attemptCount: 0,
    queuedAt: null,
    acceptedAt: null,
    finishedAt: null,
    lastError: null,
  });
  await repo.recordDelivery(canonical);
  await migrate();
  await migrate();
  expect(
    await createConversationSubscriptionsRepo(
      fixture.db,
      createWriteQueue(),
    ).getDelivery(recipient, canonical.id),
  ).toEqual(canonical);
});

it.each(["inbox", "boundary"] as const)(
  "identifies an unreadable historical %s row and preserves it on failed import",
  async (kind) => {
    const boundary = result(101);
    const repo = createConversationSubscriptionsRepo(
      fixture.db,
      createWriteQueue(),
    );
    const follow = subscription();
    await repo.createIfAbsent(follow);
    await repo.recordDelivery(
      subscriptionDeliverySchema.parse({
        id: "corrupt-delivery",
        subscriptionId: follow.id,
        recipient,
        source,
        fact: projectRecordedWorkflowSourceFact(boundary),
        recordedAt: at,
        state: "pending",
        attemptId: null,
        attemptCount: 0,
        queuedAt: null,
        acceptedAt: null,
        finishedAt: null,
        lastError: null,
      }),
    );
    const corrupt = '{"bad":true}';
    if (kind === "inbox")
      fixture.db
        .prepare(
          "UPDATE conversation_subscription_deliveries SET fact_json=? WHERE id='corrupt-delivery'",
        )
        .run(corrupt);
    else
      fixture.db
        .prepare(
          "UPDATE graph_workflow_result_deliveries SET payload_json=? WHERE execution_id=? AND boundary_seq=101",
        )
        .run("[", source.id);
    await expect(migrate()).rejects.toThrow(
      kind === "inbox"
        ? "historical workflow inbox delivery corrupt-delivery"
        : "historical workflow boundary execution:101",
    );
    expect(
      fixture.db
        .prepare(
          "SELECT state,attempt_id FROM conversation_subscription_deliveries WHERE id='corrupt-delivery'",
        )
        .get(),
    ).toEqual({ state: "pending", attempt_id: null });
    expect(
      fixture.db
        .prepare("SELECT version FROM schema_migrations WHERE version=27")
        .get(),
    ).toBeUndefined();
    expect(
      fixture.db
        .prepare(
          "SELECT COUNT(*) AS count FROM conversation_subscription_deliveries",
        )
        .get(),
    ).toEqual({ count: 1 });
  },
);

it.each([false, true])(
  "baselines a new migration follow at the known event head while directly importing outstanding=%s obligations",
  async (outstanding) => {
    const old = createWorkflowExecution({
      id: source.id,
      ownerConversationId: recipient.conversationId,
      status: "halted",
    });
    const oldAt = "2026-09-01T04:00:00.000Z";
    const oldBoundary = fixture.graphWorkflowEvents.append(
      projectPath,
      sessionName,
      source.id,
      oldAt,
      {
        event: createGraphWorkflowBoundaryEvent({
          projectPath,
          sessionName,
          execution: old,
          boundaryKind: "halt",
        }),
        occurredAt: oldAt,
        preReset: false,
      },
    );
    const current = createWorkflowExecution({
      id: source.id,
      ownerConversationId: recipient.conversationId,
      status: "completed",
    });
    fixture.graphWorkflowExecutions.setActive(
      projectPath,
      sessionName,
      current,
      at,
    );
    const completed = fixture.graphWorkflowEvents.append(
      projectPath,
      sessionName,
      source.id,
      at,
      {
        event: createGraphWorkflowBoundaryEvent({
          projectPath,
          sessionName,
          execution: current,
          boundaryKind: "completion",
        }),
        occurredAt: at,
        preReset: false,
      },
    );
    if (outstanding) result(oldBoundary.id, { recordedAt: oldAt });
    result(completed.id, {
      state: "delivered",
      attemptId: "accepted-runtime",
      attemptCount: 1,
      deliveredAt: acceptedAt,
      payload: {
        boundaryKind: "completion",
        status: "completed",
        name: "Already accepted",
      },
    });
    await migrate();
    await migrate();
    const runtime = createSubscriptionRuntime(fixture.db, createWriteQueue());
    expect((await runtime.repo.findBySource(recipient, source))?.cursor).toBe(
      String(completed.id),
    );
    await runtime.service.reconcile(recipient);
    expect(
      (await runtime.repo.listDeliveriesForOverview(recipient))
        .map((delivery) => ({
          id: delivery.fact.occurrenceId,
          state: delivery.state,
        }))
        .sort((left, right) => Number(left.id) - Number(right.id)),
    ).toEqual([
      ...(outstanding
        ? [{ id: String(oldBoundary.id), state: "pending" }]
        : []),
      { id: String(completed.id), state: "accepted" },
    ]);
  },
);
