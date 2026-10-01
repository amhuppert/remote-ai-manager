import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { createSubscriptionRuntime } from "@/lib/subscriptions/service-factory";
import { createWriteQueue } from "../write-queue";
import { createGraphWorkflowResultDeliveriesRepo } from "../graph-workflow-result-deliveries-repo";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import { createGraphWorkflowBoundaryEvent } from "@/lib/workflow-graph/boundary-event-projection";
import { conversationSubscriptionSchema } from "@/lib/subscriptions/schemas";
import { createConversationSubscriptionsRepo } from "../conversation-subscriptions-repo";
import { runMigrations } from "../migrator";
import { conversationNoticeInbox } from "./0061-conversation-notice-inbox";
import { workflowResultInbox } from "./0063-workflow-result-inbox";
import { repairImportedNoticeHistory } from "./0066-repair-imported-notice-history";

const projectPath = "/repo/repair",
  sessionName = "s",
  conversationId = "owner";
const recipient = { projectPath, conversationId };
const at = "2026-10-01T04:00:00.000Z";
const loss =
  "Your previous agent session ended (runtime_closed) while 1 background task(s) were still running: watcher (Watch validation). Those processes were terminated with the session — their completion notifications will never arrive. Do not wait for them; check any output files on disk and re-run whatever is still needed.";
let fixture: PersistenceFixture;
beforeEach(async () => {
  fixture = createPersistenceFixture();
  fixture.seedProject(projectPath);
  fixture.seedSession(projectPath, sessionName);
  await fixture.seedConversation(
    projectPath,
    sessionName,
    makeConversationState({ id: conversationId, role: "iteration" }),
  );
});
afterEach(() => fixture.close());
function markOriginalMigrationsApplied() {
  for (const name of [conversationNoticeInbox.name, workflowResultInbox.name])
    fixture.db
      .prepare("INSERT OR IGNORE INTO applied_migrations(name) VALUES (?)")
      .run(name);
}
const repair = () =>
  runMigrations({ db: fixture.db, configDir: null }, [
    conversationNoticeInbox,
    workflowResultInbox,
    repairImportedNoticeHistory,
  ]);

it("repairs already-imported operational text without changing identities, source evidence, controls or receipt history", async () => {
  fixture.db
    .prepare("UPDATE conversations SET pending_agent_notices=? WHERE id=?")
    .run(
      JSON.stringify([
        loss,
        loss,
        loss,
        "Review mentions terminated background tasks",
      ]),
      conversationId,
    );
  await conversationNoticeInbox.up({
    name: conversationNoticeInbox.name,
    context: { db: fixture.db, configDir: null },
  });
  const runtime = createSubscriptionRuntime(fixture.db, createWriteQueue());
  const rows = await runtime.repo.listDeliveriesForOverview(recipient);
  const losses = rows.filter((delivery) => delivery.fact.sourceText === loss);
  for (const [index, delivery] of losses.entries()) {
    fixture.db
      .prepare(
        "UPDATE conversation_subscription_deliveries SET fact_json=?,state=?,attempt_id=?,attempt_count=?,accepted_at=? WHERE id=?",
      )
      .run(
        JSON.stringify({
          ...delivery.fact,
          eventKind: "legacy-pending-agent-notice",
          category: "activity",
          outcome: null,
          sourceTitle: "Pending agent notice",
        }),
        index === 0 ? "pending" : index === 1 ? "uncertain" : "accepted",
        index === 0 ? null : `attempt-${index}`,
        index,
        index === 2 ? at : null,
        delivery.id,
      );
  }
  const sub = (await runtime.repo.list(recipient))[0];
  if (!sub) throw Error("Expected imported follow");
  await runtime.repo.updateControls(
    recipient,
    sub.id,
    { ...sub, status: "unfollowed", pausedAt: at },
    at,
  );
  markOriginalMigrationsApplied();
  const before = await runtime.repo.listDeliveriesForOverview(recipient);
  const control = await runtime.repo.get(recipient, sub.id);
  const versions = fixture.db
    .prepare("SELECT * FROM schema_migrations ORDER BY version")
    .all();
  expect(await repair()).toEqual([repairImportedNoticeHistory.name]);
  expect(await repair()).toEqual([]);
  await repairImportedNoticeHistory.up({
    name: repairImportedNoticeHistory.name,
    context: { db: fixture.db, configDir: null },
  });
  const after = await runtime.repo.listDeliveriesForOverview(recipient);
  expect(
    after.map(({ fact, ...delivery }) => ({
      ...delivery,
      sourceText: fact.sourceText,
    })),
  ).toEqual(
    before.map(({ fact, ...delivery }) => ({
      ...delivery,
      sourceText: fact.sourceText,
    })),
  );
  expect(
    after.filter((delivery) => delivery.fact.sourceText === loss),
  ).toHaveLength(3);
  expect(
    after
      .filter((delivery) => delivery.fact.sourceText === loss)
      .every(
        (delivery) =>
          delivery.fact.eventKind === "background-tasks-lost" &&
          delivery.fact.category === "outcome" &&
          delivery.fact.outcome === "terminated",
      ),
  ).toBe(true);
  expect(
    after.find((delivery) => delivery.fact.sourceText !== loss)?.fact.eventKind,
  ).toBe("legacy-pending-agent-notice");
  expect(await runtime.repo.get(recipient, sub.id)).toEqual(control);
  expect(
    fixture.db
      .prepare("SELECT * FROM schema_migrations ORDER BY version")
      .all(),
  ).toEqual(versions);
  const recovery = await runtime.service.prepareRuntimeLossNotice({
    recipient,
    attemptId: "generated-lane",
  });
  expect(recovery.block).toContain("watcher");
  await recovery.onInputAccepted();
  expect(
    (await runtime.repo.listDeliveriesForOverview(recipient)).filter(
      (delivery) => delivery.state === "accepted",
    ),
  ).toHaveLength(2);
});

async function historicalWorkflow() {
  const source = { kind: "workflow", id: "execution" } as const;
  const oldAt = "2026-09-01T00:00:00.000Z";
  const old = createWorkflowExecution({
    id: source.id,
    ownerConversationId: conversationId,
    status: "halted",
  });
  const halt = fixture.graphWorkflowEvents.append(
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
  const completedExecution = createWorkflowExecution({
    id: source.id,
    ownerConversationId: conversationId,
    status: "completed",
  });
  fixture.graphWorkflowExecutions.setActive(
    projectPath,
    sessionName,
    completedExecution,
    at,
  );
  const completion = fixture.graphWorkflowEvents.append(
    projectPath,
    sessionName,
    source.id,
    at,
    {
      event: createGraphWorkflowBoundaryEvent({
        projectPath,
        sessionName,
        execution: completedExecution,
        boundaryKind: "completion",
      }),
      occurredAt: at,
      preReset: false,
    },
  );
  createGraphWorkflowResultDeliveriesRepo(fixture.db).record({
    projectPath,
    sessionName,
    executionId: source.id,
    boundarySeq: completion.id,
    originConversationId: conversationId,
    payload: {
      boundaryKind: "completion",
      status: "completed",
      name: "Accepted completion",
    },
    recordedAt: at,
    state: "delivered",
    attemptId: "real-acceptance",
    attemptCount: 1,
    deliveredAt: at,
    effectsDeliveredAt: at,
  });
  return { source, halt, completion, execution: old };
}
it("repairs only the provable imported baseline and retains boundaries created after cutover", async () => {
  await fixture.store.mutateConversation(
    projectPath,
    sessionName,
    conversationId,
    "ordinary",
    (conversation) => {
      conversation.role = null;
    },
  );
  const h = await historicalWorkflow();
  await workflowResultInbox.up({
    name: workflowResultInbox.name,
    context: { db: fixture.db, configDir: null },
  });
  const runtime = createSubscriptionRuntime(fixture.db, createWriteQueue());
  const sub = await runtime.repo.findBySource(recipient, h.source);
  if (!sub) throw Error("Missing imported follow");
  fixture.db
    .prepare("UPDATE conversation_subscriptions SET cursor='0' WHERE id=?")
    .run(sub.id);
  const laterAt = "2026-10-02T00:00:00.000Z";
  const later = fixture.graphWorkflowEvents.append(
    projectPath,
    sessionName,
    h.source.id,
    laterAt,
    {
      event: createGraphWorkflowBoundaryEvent({
        projectPath,
        sessionName,
        execution: h.execution,
        boundaryKind: "halt",
      }),
      occurredAt: laterAt,
      preReset: false,
    },
  );
  const evidence = await runtime.repo.listDeliveriesForOverview(recipient);
  markOriginalMigrationsApplied();
  await repair();
  await repair();
  expect((await runtime.repo.get(recipient, sub.id))?.cursor).toBe(
    String(h.completion.id),
  );
  expect(await runtime.repo.listDeliveriesForOverview(recipient)).toEqual(
    evidence,
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
    { id: String(h.completion.id), state: "accepted" },
    { id: String(later.id), state: "pending" },
  ]);
});
it.each(["explicit", "cursor", "controls"] as const)(
  "preserves a %s follow rather than guessing a migration baseline",
  async (change) => {
    const h = await historicalWorkflow();
    const repo = createConversationSubscriptionsRepo(
      fixture.db,
      createWriteQueue(),
    );
    if (change === "explicit")
      await repo.createIfAbsent(
        conversationSubscriptionSchema.parse({
          id: "explicit-follow",
          recipient,
          source: h.source,
          reason: "Workflow result evidence",
          mode: "passive",
          eventKinds: null,
          expiresAt: null,
          status: "following",
          cursor: "0",
          createdAt: at,
          updatedAt: at,
          pausedAt: null,
          unfollowedAt: null,
          missingAt: null,
          lastError: null,
        }),
      );
    await workflowResultInbox.up({
      name: workflowResultInbox.name,
      context: { db: fixture.db, configDir: null },
    });
    const sub = await repo.findBySource(recipient, h.source);
    if (!sub) throw Error("Missing follow");
    if (change === "cursor")
      fixture.db
        .prepare("UPDATE conversation_subscriptions SET cursor='1' WHERE id=?")
        .run(sub.id);
    if (change === "controls")
      await repo.updateControls(
        recipient,
        sub.id,
        { ...sub, pausedAt: at, reason: "Human feedback choice" },
        "2026-10-02T00:00:00.000Z",
      );
    const before = await repo.get(recipient, sub.id);
    markOriginalMigrationsApplied();
    await repair();
    expect(await repo.get(recipient, sub.id)).toEqual(before);
  },
);

it("rolls back both data repairs and leaves the migration unledgered when saved workflow evidence is malformed", async () => {
  fixture.db
    .prepare("UPDATE conversations SET pending_agent_notices=? WHERE id=?")
    .run(JSON.stringify([loss]), conversationId);
  await conversationNoticeInbox.up({
    name: conversationNoticeInbox.name,
    context: { db: fixture.db, configDir: null },
  });
  const runtime = createSubscriptionRuntime(fixture.db, createWriteQueue());
  const legacy = (await runtime.repo.listDeliveriesForOverview(recipient))[0];
  if (!legacy) throw Error("Missing legacy evidence");
  const oldFactJson = JSON.stringify({
    ...legacy.fact,
    eventKind: "legacy-pending-agent-notice",
    category: "activity",
    outcome: null,
    sourceTitle: "Pending agent notice",
  });
  fixture.db
    .prepare(
      "UPDATE conversation_subscription_deliveries SET fact_json=? WHERE id=?",
    )
    .run(oldFactJson, legacy.id);
  await historicalWorkflow();
  await workflowResultInbox.up({
    name: workflowResultInbox.name,
    context: { db: fixture.db, configDir: null },
  });
  const workflow = (
    await runtime.repo.listDeliveriesForOverview(recipient)
  ).find((delivery) => delivery.source.kind === "workflow");
  if (!workflow) throw Error("Missing workflow evidence");
  fixture.db
    .prepare(
      "UPDATE conversation_subscription_deliveries SET fact_json='not-json' WHERE id=?",
    )
    .run(workflow.id);
  markOriginalMigrationsApplied();
  await expect(repair()).rejects.toThrow("invalid saved fact or receipt");
  expect(
    fixture.db
      .prepare(
        "SELECT fact_json FROM conversation_subscription_deliveries WHERE id=?",
      )
      .get(legacy.id),
  ).toEqual({ fact_json: oldFactJson });
  expect(
    fixture.db
      .prepare("SELECT name FROM applied_migrations WHERE name=?")
      .get(repairImportedNoticeHistory.name),
  ).toBeUndefined();
});
