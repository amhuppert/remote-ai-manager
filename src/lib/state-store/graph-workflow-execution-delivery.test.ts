/**
 * Post-commit event delivery on the graph-workflow execution mutation seam
 * (Design 3.2, `post-commit-delivery`). Event ROWS persist atomically with the
 * execution state inside `mutateActiveGraphWorkflowExecution`'s transaction;
 * SSE/push delivery must happen ONLY after that transaction commits.
 *
 * The seam no longer accepts or exposes any delivery callable — the reducer
 * returns inert data, the seam commits the rows and hands the committed delivery
 * back, and the graph-workflow repository (which owns the broadcaster) performs
 * delivery afterward. So these tests drive the REAL repository over a REAL
 * `:memory:` DB with a production spy broadcaster injected into the event
 * publisher, and prove the spy is UNREACHABLE when the transaction rolls back —
 * not by counting a hand-injected thunk, but by watching the actual broadcaster
 * the repository would use.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import type { PersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { createGraphWorkflowExecutionEventPublisher } from "@/lib/workflow-graph/execution-events";
import { createGraphWorkflowExecutionRepository } from "@/lib/workflow-graph/execution-repository";
import {
  createWorkflowDefinition,
  createWorkflowExecution,
  makeLaunchDocument,
} from "@/lib/workflow-graph/test-fixtures";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { createNotificationsRepo } from "@/lib/notifications/repo";
import {
  createGraphWorkflowResultDeliveryService,
  type DeliverRecordedWorkflowResultInput,
} from "@/lib/workflow-graph/result-delivery-service";
import { buildGraphWorkflowExecutionDeepLink } from "@/lib/workflow-graph/execution-deep-link";
import type { WorkflowNotification } from "@/lib/notifications/schemas";
import { createGraphWorkflowResultDeliveriesRepo } from "@/lib/state-store/graph-workflow-result-deliveries-repo";
import { createStateStore } from "@/lib/state-store/store";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import type {
  GraphWorkflowExecutionEvent,
  GraphWorkflowSSEEvent,
} from "@/lib/workflow-graph/event-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { SessionState } from "@/lib/sessions/schemas";

const PROJECT_PATH = "/p1";
const SESSION_NAME = "s1";

function runningExecution(): GraphWorkflowExecution {
  return createWorkflowExecution({ status: "running" });
}

let fixture: PersistenceFixture;

beforeEach(() => {
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  fixture.seedSession(PROJECT_PATH, SESSION_NAME);
});

afterEach(() => {
  fixture.close();
});

/**
 * A repository wired to the real `:memory:` store, with a spy broadcaster in the
 * event publisher. `mutateSeam` lets a test wrap the real store seam to force a
 * genuine SQLite rollback (poisoned event rows) between the reducer and the
 * commit — the repository still uses the same real seam and same spy.
 */
function makeRepository(options?: {
  mutateSeam?: PersistenceFixture["store"]["mutateActiveGraphWorkflowExecution"];
  deliverResultRecorded?(
    input: DeliverRecordedWorkflowResultInput,
  ): Promise<void>;
}) {
  const broadcast = vi.fn<(event: GraphWorkflowSSEEvent) => void>();
  const eventPublisher = createGraphWorkflowExecutionEventPublisher({
    broadcast,
    deliverResultRecorded: options?.deliverResultRecorded,
  });
  const repo = createGraphWorkflowExecutionRepository({
    // No git worktree in this harness; the real exclusion would shell out.
    ensureCcArtifactsExcluded: async () => {},
    async getSession() {
      return { worktreePath: "/repo/wt" } as unknown as SessionState;
    },
    getActiveGraphWorkflowExecution:
      fixture.store.getActiveGraphWorkflowExecution,
    mutateActiveGraphWorkflowExecution:
      options?.mutateSeam ?? fixture.store.mutateActiveGraphWorkflowExecution,
    reserveActiveGraphWorkflowExecution:
      fixture.store.reserveActiveGraphWorkflowExecution,
    archiveActiveGraphWorkflowExecution:
      fixture.store.archiveActiveGraphWorkflowExecution,
    async markGraphWorkflowContextEventsPreReset() {
      return 0;
    },
    eventPublisher,
  });
  return { repo, broadcast };
}

async function seedActiveExecution(
  execution: GraphWorkflowExecution,
): Promise<void> {
  // Seed the active row directly through the store seam (no events, no
  // delivery) so the subsequent `repo.update` produces a real prev→next diff.
  await fixture.store.mutateActiveGraphWorkflowExecution(
    PROJECT_PATH,
    SESSION_NAME,
    "seed",
    () => ({ execution, events: [] }),
  );
}

describe("graph-workflow execution mutation seam — post-commit delivery", () => {
  it("broadcasts the derived events exactly once, only after the row commits", async () => {
    await seedActiveExecution(runningExecution());
    const { repo, broadcast } = makeRepository();

    let rowsVisibleWhenBroadcast = -1;
    broadcast.mockImplementation(() => {
      // The broadcaster runs post-commit, so the appended row is already
      // durable and visible when the first wire event fires.
      rowsVisibleWhenBroadcast = fixture.graphWorkflowEvents.findByExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "execution-1",
      ).length;
    });

    // A status change is a real prev→next diff: running -> paused emits exactly
    // one graph-workflow-status event.
    await repo.update(PROJECT_PATH, SESSION_NAME, {
      ...runningExecution(),
      status: "paused",
    });

    const statusBroadcasts = broadcast.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "graph-workflow-status");
    expect(statusBroadcasts).toHaveLength(1);
    expect(statusBroadcasts[0]).toMatchObject({ workflowStatus: "paused" });
    expect(rowsVisibleWhenBroadcast).toBeGreaterThanOrEqual(1);

    // The committed row is durable and reloads.
    expect(
      fixture.graphWorkflowEvents.findByExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "execution-1",
      ).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("never reaches the broadcaster when the commit throws (nothing persists)", async () => {
    await seedActiveExecution(runningExecution());

    // Wrap the REAL store seam so the reducer's derived rows are replaced with a
    // malformed row (null `event`) that makes the real `appendMany` throw inside
    // the transaction — a genuine SQLite rollback, not a simulated one.
    const poisoned = {
      occurredAt: "",
      event: null,
      preReset: false,
    } as unknown as GraphWorkflowExecutionEvent;
    const poisoningSeam: PersistenceFixture["store"]["mutateActiveGraphWorkflowExecution"] =
      (projectPath, sessionName, label, mutate) =>
        fixture.store.mutateActiveGraphWorkflowExecution(
          projectPath,
          sessionName,
          label,
          (current) => {
            const result = mutate(current);
            return { ...result, events: [poisoned] };
          },
        );

    const { repo, broadcast } = makeRepository({ mutateSeam: poisoningSeam });

    await expect(
      repo.update(PROJECT_PATH, SESSION_NAME, {
        ...runningExecution(),
        status: "paused",
      }),
    ).rejects.toThrow();

    // The production spy broadcaster was never invoked — a mutation that did not
    // persist can never have told a client it did.
    expect(broadcast).not.toHaveBeenCalled();

    // The rollback left the seeded execution untouched and appended no rows.
    const active = await fixture.store.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(active?.status).toBe("running");
    expect(
      fixture.graphWorkflowEvents.findByExecution(
        PROJECT_PATH,
        SESSION_NAME,
        "execution-1",
      ),
    ).toEqual([]);
  });

  it("retains result provenance and creates one fallback notification when the origin is deleted", async () => {
    const originConversationId = "conversation-origin";
    await fixture.seedConversation(
      PROJECT_PATH,
      SESSION_NAME,
      makeConversationState({ id: originConversationId }),
    );
    const running = runningExecution();
    const launchDocument = makeLaunchDocument(createWorkflowDefinition(), {
      name: "Deleted-origin delivery",
    });
    const execution = createWorkflowExecution({
      ...running,
      ownerConversationId: originConversationId,
      launchDocument,
      contextOutputs: {
        "context-plan": {
          value: { verdict: "ready" },
          capturedAt: "2026-08-14T12:00:00.000Z",
          iteration: 1,
          parse: { source: "raw_json" },
        },
      },
    });
    await seedActiveExecution(execution);

    const notificationsRepo = createNotificationsRepo(fixture.db);
    const published: WorkflowNotification[] = [];
    const dispatchPush = vi.fn();
    const resultDeliveryService = createGraphWorkflowResultDeliveryService({
      async markOriginUnread(input) {
        return (
          (await fixture.store.getConversation(
            input.projectPath,
            input.sessionName,
            input.conversationId,
          )) !== null
        );
      },
      dispatchPush,
      commitMissingOriginFallback(input) {
        return fixture.store.commitGraphWorkflowMissingOriginFallback(
          input.projectPath,
          input.sessionName,
          input.executionId,
          input.boundarySeq,
          input.notification,
        );
      },
      publishFallbackNotification(notification) {
        published.push(notification);
      },
      settleMissingOriginResult(input) {
        return fixture.store.settleGraphWorkflowResultDeliveryFallback(
          input.projectPath,
          input.sessionName,
          input.executionId,
          input.boundarySeq,
        );
      },
      async isPostCommitEffectPending(input) {
        const row = await fixture.store.getGraphWorkflowResultDelivery(
          input.projectPath,
          input.sessionName,
          input.executionId,
          input.boundarySeq,
        );
        return row !== null && row.effectsDeliveredAt === null;
      },
      markPostCommitEffectDelivered(input) {
        return fixture.store.markGraphWorkflowResultEffectDelivered(
          input.projectPath,
          input.sessionName,
          input.executionId,
          input.boundarySeq,
        );
      },
      listPendingPostCommitEffects:
        fixture.store.listPendingGraphWorkflowResultEffects,
    });
    const { repo } = makeRepository({
      deliverResultRecorded: resultDeliveryService.deliverRecordedResult,
    });

    await repo.update(PROJECT_PATH, SESSION_NAME, {
      ...execution,
      status: "halted",
      haltReason: {
        type: "recovery_error",
        message: "Resume after operator repair.",
      },
    });

    expect(notificationsRepo.getNotifications().total).toBe(0);
    await fixture.store.mutateSession(
      PROJECT_PATH,
      SESSION_NAME,
      "test.delete-origin",
      (session) => {
        session.conversations = (session.conversations ?? []).filter(
          (conversation) => conversation.id !== originConversationId,
        );
      },
    );

    await repo.update(PROJECT_PATH, SESSION_NAME, {
      ...execution,
      status: "completed",
      haltReason: null,
    });

    const restarted = fixture.recreateStore();
    const reloaded = await restarted.getActiveGraphWorkflowExecution(
      PROJECT_PATH,
      SESSION_NAME,
    );
    expect(reloaded).toMatchObject({
      ownerConversationId: originConversationId,
      launchDocument,
      contextOutputs: execution.contextOutputs,
    });
    const events = fixture.graphWorkflowEvents.findByExecution(
      PROJECT_PATH,
      SESSION_NAME,
      execution.id,
    );
    expect(
      events.some((event) => event.event.type === "graph-workflow-boundary"),
    ).toBe(true);
    const deliveries = notificationsRepo.getNotifications().notifications;
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      source: "workflow",
      sessionName: SESSION_NAME,
      executionId: execution.id,
      originConversationId,
      deepLink: buildGraphWorkflowExecutionDeepLink({
        projectName: "p1",
        sessionName: SESSION_NAME,
        executionId: execution.id,
      }),
    });
    expect(published).toHaveLength(1);
    expect(dispatchPush).toHaveBeenCalledTimes(1);

    const resultRows = createGraphWorkflowResultDeliveriesRepo(
      fixture.db,
    ).listByExecution(PROJECT_PATH, SESSION_NAME, execution.id);
    expect(resultRows.every((row) => row.state === "delivered")).toBe(true);
    const resultRow = resultRows.find(
      (row) => row.payload.boundaryKind === "completion",
    );
    expect(resultRow).toMatchObject({
      originConversationId,
      state: "delivered",
    });

    const replayService = createGraphWorkflowResultDeliveryService({
      async markOriginUnread() {
        return false;
      },
      dispatchPush,
      commitMissingOriginFallback(input) {
        return restarted.commitGraphWorkflowMissingOriginFallback(
          input.projectPath,
          input.sessionName,
          input.executionId,
          input.boundarySeq,
          input.notification,
        );
      },
      publishFallbackNotification(notification) {
        published.push(notification);
      },
      settleMissingOriginResult(input) {
        return restarted.settleGraphWorkflowResultDeliveryFallback(
          input.projectPath,
          input.sessionName,
          input.executionId,
          input.boundarySeq,
        );
      },
      async isPostCommitEffectPending(input) {
        const row = await restarted.getGraphWorkflowResultDelivery(
          input.projectPath,
          input.sessionName,
          input.executionId,
          input.boundarySeq,
        );
        return row !== null && row.effectsDeliveredAt === null;
      },
      markPostCommitEffectDelivered(input) {
        return restarted.markGraphWorkflowResultEffectDelivered(
          input.projectPath,
          input.sessionName,
          input.executionId,
          input.boundarySeq,
        );
      },
      listPendingPostCommitEffects:
        restarted.listPendingGraphWorkflowResultEffects,
    });
    await replayService.deliverRecordedResult({
      projectPath: PROJECT_PATH,
      event: {
        type: "graph-workflow-result-recorded",
        projectName: "p1",
        sessionName: SESSION_NAME,
        executionId: execution.id,
        originConversationId,
        boundaryCursor: resultRow!.boundarySeq,
      },
      completionPush: {
        kind: "workflow-completed",
        projectName: "p1",
        sessionName: SESSION_NAME,
      },
    });

    expect(notificationsRepo.getNotifications().total).toBe(1);
    expect(published).toHaveLength(1);
    expect(dispatchPush).toHaveBeenCalledTimes(1);
  });

  it("rolls back the fallback notification when ledger settlement fails", async () => {
    const deliveries = createGraphWorkflowResultDeliveriesRepo(fixture.db);
    deliveries.record({
      executionId: "execution-atomic",
      boundarySeq: 17,
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      originConversationId: "conversation-deleted",
      payload: { boundaryKind: "completion", status: "completed" },
      recordedAt: "2026-08-14T12:00:00.000Z",
      state: "pending",
      attemptId: null,
      attemptCount: 0,
      deliveredAt: null,
      effectsDeliveredAt: null,
    });
    const notifications = createNotificationsRepo(fixture.db);
    const store = createStateStore({
      db: fixture.db,
      writeQueue: createWriteQueue(),
      repos: {
        notifications,
        graphWorkflowResultDeliveries: {
          ...deliveries,
          markExecutionFallbackDelivered() {
            throw new Error("settlement failed");
          },
        },
      },
    });

    await expect(
      store.commitGraphWorkflowMissingOriginFallback(
        PROJECT_PATH,
        SESSION_NAME,
        "execution-atomic",
        17,
        {
          type: "workflow-result-ready",
          title: "Workflow result ready",
          message: "Execution completed after its origin was deleted.",
          projectName: "p1",
          sessionName: SESSION_NAME,
          executionId: "execution-atomic",
          originConversationId: "conversation-deleted",
          deepLink: "/projects/p1/s1/workflow?execution=execution-atomic",
          dedupeKey: "graph-workflow-origin-missing:execution-atomic",
        },
      ),
    ).rejects.toThrow("settlement failed");

    expect(notifications.getNotifications().total).toBe(0);
    expect(
      deliveries.findByBoundary(
        PROJECT_PATH,
        SESSION_NAME,
        "execution-atomic",
        17,
      ),
    ).toMatchObject({ state: "pending" });
  });

  it("reconciles a committed fallback after a crash before external effects", async () => {
    const deliveries = createGraphWorkflowResultDeliveriesRepo(fixture.db);
    deliveries.record({
      executionId: "execution-reconcile",
      boundarySeq: 23,
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      originConversationId: "conversation-deleted",
      payload: { boundaryKind: "completion", status: "completed" },
      recordedAt: "2026-08-14T12:00:00.000Z",
      state: "pending",
      attemptId: null,
      attemptCount: 0,
      deliveredAt: null,
      effectsDeliveredAt: null,
    });
    const notificationInput = {
      type: "workflow-result-ready" as const,
      title: "Workflow result ready",
      message: "Execution completed after its origin was deleted.",
      projectName: "p1",
      sessionName: SESSION_NAME,
      executionId: "execution-reconcile",
      originConversationId: "conversation-deleted",
      deepLink: "/projects/p1/s1/workflow?execution=execution-reconcile",
      dedupeKey: "graph-workflow-origin-missing:execution-reconcile",
    };

    const committed =
      await fixture.store.commitGraphWorkflowMissingOriginFallback(
        PROJECT_PATH,
        SESSION_NAME,
        "execution-reconcile",
        23,
        notificationInput,
      );
    expect(committed).toMatchObject({ created: true, settled: true });

    const restarted = fixture.recreateStore();
    const dispatchPush = vi.fn();
    const publishFallbackNotification = vi.fn();
    const publishResultRecorded = vi.fn();
    const service = createGraphWorkflowResultDeliveryService({
      markOriginUnread: vi.fn(async () => false),
      dispatchPush,
      commitMissingOriginFallback(input) {
        return restarted.commitGraphWorkflowMissingOriginFallback(
          input.projectPath,
          input.sessionName,
          input.executionId,
          input.boundarySeq,
          input.notification,
        );
      },
      publishFallbackNotification,
      settleMissingOriginResult(input) {
        return restarted.settleGraphWorkflowResultDeliveryFallback(
          input.projectPath,
          input.sessionName,
          input.executionId,
          input.boundarySeq,
        );
      },
      async isPostCommitEffectPending(input) {
        const row = await restarted.getGraphWorkflowResultDelivery(
          input.projectPath,
          input.sessionName,
          input.executionId,
          input.boundarySeq,
        );
        return row !== null && row.effectsDeliveredAt === null;
      },
      markPostCommitEffectDelivered(input) {
        return restarted.markGraphWorkflowResultEffectDelivered(
          input.projectPath,
          input.sessionName,
          input.executionId,
          input.boundarySeq,
        );
      },
      listPendingPostCommitEffects:
        restarted.listPendingGraphWorkflowResultEffects,
      publishResultRecorded,
    });

    expect(
      await service.reconcilePendingResults(PROJECT_PATH, SESSION_NAME),
    ).toBe(1);
    expect(publishResultRecorded).toHaveBeenCalledOnce();
    expect(publishFallbackNotification).toHaveBeenCalledExactlyOnceWith(
      committed.notification,
    );
    expect(dispatchPush).toHaveBeenCalledExactlyOnceWith({
      kind: "workflow-completed",
      projectName: "p1",
      sessionName: SESSION_NAME,
      dedupeKey: "graph-workflow-result:execution-reconcile:23",
    });
    expect(createNotificationsRepo(fixture.db).getNotifications().total).toBe(
      1,
    );
    expect(
      await restarted.getGraphWorkflowResultDelivery(
        PROJECT_PATH,
        SESSION_NAME,
        "execution-reconcile",
        23,
      ),
    ).toMatchObject({
      state: "delivered",
      effectsDeliveredAt: expect.any(String),
    });

    expect(
      await createGraphWorkflowResultDeliveryService({
        markOriginUnread: vi.fn(async () => false),
        dispatchPush,
        commitMissingOriginFallback: vi.fn(),
        publishFallbackNotification,
        settleMissingOriginResult: vi.fn(async () => false),
        isPostCommitEffectPending: vi.fn(async () => false),
        markPostCommitEffectDelivered: vi.fn(async () => false),
        listPendingPostCommitEffects:
          restarted.listPendingGraphWorkflowResultEffects,
      }).reconcilePendingResults(PROJECT_PATH, SESSION_NAME),
    ).toBe(0);
    expect(dispatchPush).toHaveBeenCalledTimes(1);
    expect(publishFallbackNotification).toHaveBeenCalledTimes(1);
  });
});
