import { describe, expect, it, vi } from "vitest";
import { TESTFAKE_BACKEND_ID } from "@/lib/agent-backends/testing/testfake-backend";
import {
  type GraphWorkflowExecutionEvent,
  graphWorkflowBoundaryEventSchema,
  graphWorkflowBoundaryKindSchema,
  graphWorkflowCharterRegisteredEventSchema,
  graphWorkflowCharterUpdatedEventSchema,
  graphWorkflowExecutionEventSchema,
  graphWorkflowLiveEditAppliedEventSchema,
  graphWorkflowResultRecordedEventSchema,
} from "@/lib/workflow-graph/event-schemas";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";
import type {
  GraphWorkflowExecution,
  GraphWorkflowLoopDecisionRecord,
  GraphWorkflowRouteSettlement,
} from "@/lib/workflow-graph/schemas";
import {
  createGraphWorkflowExecutionEventPublisher,
  type GraphWorkflowEventDelivery,
} from "./execution-events";
import { createGraphWorkflowResultDeliveryService } from "./result-delivery-service";
import {
  freezeValidationCandidate,
  openValidationRound,
} from "./validation-round";

describe("closed workflow boundary vocabulary", () => {
  it("derives every durable needs-attention and terminal boundary exactly once", () => {
    const publisher = createGraphWorkflowExecutionEventPublisher({
      now: () => "2026-08-14T12:00:00.000Z",
    });
    const running = createWorkflowExecution({ status: "running" });
    const halted = createWorkflowExecution({ ...running, status: "halted" });

    const deliveries = [
      publisher.publishExecutionUpdate({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        previousExecution: null,
        nextExecution: createWorkflowExecution({
          status: "pending",
          definitionApproval: {
            requestedAt: "2026-08-14T12:00:00.000Z",
            approvedAt: null,
          },
        }),
      }),
      publisher.publishApprovalPending({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        execution: running,
        contextId: "context-plan",
        conversationId: "conversation-1",
        requestedAt: "2026-08-14T12:00:00.000Z",
      }),
      publisher.publishUserInputPending({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        execution: running,
        contextId: "context-plan",
        conversationId: "conversation-1",
        questionBatchId: "question-batch-1",
        requestedAt: "2026-08-14T12:00:00.000Z",
      }),
      ...(["paused", "halted"] as const).map((status) =>
        publisher.publishExecutionUpdate({
          projectPath: "/projects/repo",
          sessionName: "session-1",
          previousExecution: running,
          nextExecution: createWorkflowExecution({ ...running, status }),
        }),
      ),
      publisher.publishExecutionUpdate({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        previousExecution: halted,
        nextExecution: createWorkflowExecution({
          ...halted,
          abandonment: {
            abandonedAt: "2026-08-14T12:00:00.000Z",
            actor: { kind: "human" },
            reason: "No longer needed",
          },
        }),
      }),
      ...(["completed", "aborted"] as const).map((status) =>
        publisher.publishExecutionUpdate({
          projectPath: "/projects/repo",
          sessionName: "session-1",
          previousExecution: running,
          nextExecution: createWorkflowExecution({ ...running, status }),
        }),
      ),
    ];

    const boundaries = deliveries.flatMap((delivery) =>
      delivery.events
        .filter((row) => row.event.type === "graph-workflow-boundary")
        .map((row) => graphWorkflowBoundaryEventSchema.parse(row.event)),
    );

    expect(boundaries.map((boundary) => boundary.boundaryKind)).toEqual(
      graphWorkflowBoundaryKindSchema.options,
    );
  });

  it("captures boundary-time status, pending action, and declared output", () => {
    const publisher = createGraphWorkflowExecutionEventPublisher({
      now: () => "2026-08-14T12:00:00.000Z",
    });
    const previous = createWorkflowExecution({
      status: "running",
      ownerConversationId: "conversation-origin",
    });
    const workingDefinition = {
      ...previous.workingDefinition,
      executionContexts: previous.workingDefinition.executionContexts.map(
        (context) =>
          context.id === "context-plan"
            ? {
                ...context,
                outputSchema: {
                  type: "object",
                  properties: { verdict: { type: "string" } },
                },
              }
            : context,
      ),
    };
    const next = createWorkflowExecution({
      ...previous,
      workingDefinition,
      status: "halted",
      haltReason: {
        type: "execution_loop_failed",
        contextId: "context-plan",
        cause: "unknown",
        message: "The workflow needs operator attention.",
      },
      contextOutputs: {
        "context-plan": {
          capturedAt: "2026-08-14T11:59:00.000Z",
          iteration: 1,
          parse: { source: "raw_json" },
          value: { verdict: "ready" },
        },
      },
    });

    const boundary = publisher
      .publishExecutionUpdate({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        previousExecution: previous,
        nextExecution: next,
      })
      .events.map((row) => row.event)
      .find((event) => event.type === "graph-workflow-boundary");

    expect(boundary).toMatchObject({
      boundaryKind: "halt",
      workflowStatus: "halted",
      pendingActions: [{ kind: "resume" }],
      outputProjection: {
        kind: "declared_outputs",
        byContext: {
          "context-plan": { verdict: "ready" },
        },
      },
    });
  });

  it.each([
    {
      label: "a recovery-error halt",
      haltReason: {
        type: "recovery_error" as const,
        message: "The workflow cannot be recovered.",
      },
    },
    { label: "a halt with no recorded reason", haltReason: null },
  ])("does not advertise resume for $label", ({ haltReason }) => {
    const publisher = createGraphWorkflowExecutionEventPublisher({
      now: () => "2026-08-14T12:00:00.000Z",
    });
    const previous = createWorkflowExecution({ status: "running" });
    const halted = createWorkflowExecution({
      ...previous,
      status: "halted",
      haltReason,
    });

    const boundary = publisher
      .publishExecutionUpdate({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        previousExecution: previous,
        nextExecution: halted,
      })
      .events.map((row) => row.event)
      .find((event) => event.type === "graph-workflow-boundary");

    expect(boundary).toMatchObject({
      boundaryKind: "halt",
      workflowStatus: "halted",
      pendingActions: [],
    });
  });

  it("publishes one typed result-recorded invalidation only through post-commit delivery", () => {
    let committed = false;
    const broadcast = vi.fn((event) => {
      expect(committed).toBe(true);
      if (event.type === "graph-workflow-result-recorded") {
        graphWorkflowResultRecordedEventSchema.parse(event);
      }
    });
    const publisher = createGraphWorkflowExecutionEventPublisher({ broadcast });
    const running = createWorkflowExecution({
      status: "running",
      ownerConversationId: "conversation-origin",
    });
    const completed = createWorkflowExecution({
      ...running,
      status: "completed",
    });
    const delivery = publisher.publishExecutionUpdate({
      projectPath: "/projects/repo",
      sessionName: "session-1",
      previousExecution: running,
      nextExecution: completed,
    });
    const resultRecorded = graphWorkflowResultRecordedEventSchema.parse({
      type: "graph-workflow-result-recorded",
      projectName: "repo",
      sessionName: "session-1",
      executionId: completed.id,
      originConversationId: "conversation-origin",
      boundaryCursor: 17,
    });

    expect(broadcast).not.toHaveBeenCalled();
    committed = true;
    publisher.deliver({ ...delivery, publications: [resultRecorded] });

    expect(
      broadcast.mock.calls.filter(
        ([event]) => event.type === "graph-workflow-result-recorded",
      ),
    ).toEqual([[resultRecorded]]);
  });

  it("marks the origin and dispatches one deduped normal workflow push for a committed completion result", async () => {
    const markOriginUnread = vi.fn(async () => true);
    const dispatchPush = vi.fn();
    let effectPending = true;
    const resultDeliveryService = createGraphWorkflowResultDeliveryService({
      markOriginUnread,
      dispatchPush,
      commitMissingOriginFallback: vi.fn(),
      publishFallbackNotification: vi.fn(),
      settleMissingOriginResult: vi.fn(async () => false),
      isPostCommitEffectPending: vi.fn(async () => effectPending),
      markPostCommitEffectDelivered: vi.fn(async () => {
        effectPending = false;
        return true;
      }),
      listPendingPostCommitEffects: vi.fn(async () => []),
    });
    const broadcast = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      deliverResultRecorded: resultDeliveryService.deliverRecordedResult,
    });
    const running = createWorkflowExecution({
      status: "running",
      ownerConversationId: "conversation-origin",
    });
    const completed = createWorkflowExecution({
      ...running,
      status: "completed",
    });
    const delivery = publisher.publishExecutionUpdate({
      projectPath: "/projects/repo",
      sessionName: "session-1",
      previousExecution: running,
      nextExecution: completed,
    });
    const resultRecorded = graphWorkflowResultRecordedEventSchema.parse({
      type: "graph-workflow-result-recorded",
      projectName: "repo",
      sessionName: "session-1",
      executionId: completed.id,
      originConversationId: "conversation-origin",
      boundaryCursor: 17,
    });

    await publisher.deliver({
      ...delivery,
      publications: [resultRecorded],
      resultEffects: [{ projectPath: "/projects/repo", event: resultRecorded }],
    });

    expect(markOriginUnread).toHaveBeenCalledExactlyOnceWith({
      projectPath: "/projects/repo",
      projectName: "repo",
      sessionName: "session-1",
      conversationId: "conversation-origin",
    });
    expect(dispatchPush).toHaveBeenCalledExactlyOnceWith({
      kind: "workflow-completed",
      projectName: "repo",
      sessionName: "session-1",
      dedupeKey: `graph-workflow-result:${completed.id}:17`,
    });
    expect(broadcast).toHaveBeenCalledWith(resultRecorded);

    await publisher.deliver({
      ...delivery,
      publications: [resultRecorded],
      resultEffects: [{ projectPath: "/projects/repo", event: resultRecorded }],
    });

    const repeated = publisher.publishExecutionUpdate({
      projectPath: "/projects/repo",
      sessionName: "session-1",
      previousExecution: completed,
      nextExecution: completed,
    });
    await publisher.deliver(repeated);

    expect(markOriginUnread).toHaveBeenCalledTimes(1);
    expect(dispatchPush).toHaveBeenCalledTimes(1);
  });

  it("dedupes a completion replay after service restart through the durable effect receipt", async () => {
    const markOriginUnread = vi.fn(async () => true);
    const dispatchPush = vi.fn();
    let effectPending = true;
    const deps = {
      markOriginUnread,
      dispatchPush,
      commitMissingOriginFallback: vi.fn(),
      publishFallbackNotification: vi.fn(),
      settleMissingOriginResult: vi.fn(async () => false),
      isPostCommitEffectPending: vi.fn(async () => effectPending),
      markPostCommitEffectDelivered: vi.fn(async () => {
        effectPending = false;
        return true;
      }),
      listPendingPostCommitEffects: vi.fn(async () => []),
    };
    const input = {
      projectPath: "/projects/repo",
      event: graphWorkflowResultRecordedEventSchema.parse({
        type: "graph-workflow-result-recorded",
        projectName: "repo",
        sessionName: "session-1",
        executionId: "execution-1",
        originConversationId: "conversation-origin",
        boundaryCursor: 17,
      }),
      completionPush: {
        kind: "workflow-completed" as const,
        projectName: "repo",
        sessionName: "session-1",
      },
    };

    await createGraphWorkflowResultDeliveryService(deps).deliverRecordedResult(
      input,
    );
    await createGraphWorkflowResultDeliveryService(deps).deliverRecordedResult(
      input,
    );

    expect(markOriginUnread).toHaveBeenCalledTimes(1);
    expect(dispatchPush).toHaveBeenCalledTimes(1);
  });

  it("creates one session fallback and settles the boundary when the origin was deleted", async () => {
    const markOriginUnread = vi.fn(async () => false);
    const dispatchPush = vi.fn();
    const fallbackNotification = {
      id: "notification-1",
      source: "workflow" as const,
      type: "workflow-result-ready" as const,
      title: "Workflow result ready",
      message:
        'Execution "execution-1" finished after origin conversation "conversation-deleted" was deleted.',
      read: false,
      projectName: "repo",
      sessionName: "session-1",
      executionId: "execution-1",
      originConversationId: "conversation-deleted",
      deepLink: "/projects/repo/session-1/workflow?execution=execution-1",
      createdAt: "2026-08-14T12:00:00.000Z",
    };
    const commitMissingOriginFallback = vi.fn(async () => ({
      notification: fallbackNotification,
      created: true,
      settled: true,
    }));
    const publishFallbackNotification = vi.fn();
    const settleMissingOriginResult = vi.fn(async () => true);
    const resultDeliveryService = createGraphWorkflowResultDeliveryService({
      markOriginUnread,
      dispatchPush,
      commitMissingOriginFallback,
      publishFallbackNotification,
      settleMissingOriginResult,
      isPostCommitEffectPending: vi.fn(async () => true),
      markPostCommitEffectDelivered: vi.fn(async () => true),
      listPendingPostCommitEffects: vi.fn(async () => []),
    });
    const resultRecorded = graphWorkflowResultRecordedEventSchema.parse({
      type: "graph-workflow-result-recorded",
      projectName: "repo",
      sessionName: "session-1",
      executionId: "execution-1",
      originConversationId: "conversation-deleted",
      boundaryCursor: 17,
    });
    const input = {
      projectPath: "/projects/repo",
      event: resultRecorded,
      completionPush: {
        kind: "workflow-completed" as const,
        projectName: "repo",
        sessionName: "session-1",
      },
    };

    await resultDeliveryService.deliverRecordedResult(input);
    await resultDeliveryService.deliverRecordedResult(input);

    expect(commitMissingOriginFallback).toHaveBeenCalledExactlyOnceWith({
      projectPath: "/projects/repo",
      sessionName: "session-1",
      executionId: "execution-1",
      boundarySeq: 17,
      notification: {
        type: "workflow-result-ready",
        title: "Workflow result ready",
        message:
          'Execution "execution-1" finished after origin conversation "conversation-deleted" was deleted.',
        projectName: "repo",
        sessionName: "session-1",
        executionId: "execution-1",
        originConversationId: "conversation-deleted",
        deepLink: "/projects/repo/session-1/workflow?execution=execution-1",
        dedupeKey: "graph-workflow-origin-missing:execution-1",
      },
    });
    expect(publishFallbackNotification).toHaveBeenCalledExactlyOnceWith(
      fallbackNotification,
    );
    expect(settleMissingOriginResult).not.toHaveBeenCalled();
    expect(dispatchPush).toHaveBeenCalledExactlyOnceWith({
      kind: "workflow-completed",
      projectName: "repo",
      sessionName: "session-1",
      dedupeKey: "graph-workflow-result:execution-1:17",
    });
  });

  it("uses the missing-origin fallback when deletion races the unread mutation", async () => {
    const fallbackNotification = {
      id: "notification-race",
      source: "workflow" as const,
      type: "workflow-result-ready" as const,
      title: "Workflow result ready",
      message:
        'Execution "execution-race" finished after origin conversation "conversation-deleted" was deleted.',
      read: false,
      projectName: "repo",
      sessionName: "session-1",
      executionId: "execution-race",
      originConversationId: "conversation-deleted",
      deepLink: "/projects/repo/session-1/workflow?execution=execution-race",
      createdAt: "2026-08-14T12:00:00.000Z",
    };
    const commitMissingOriginFallback = vi.fn(async () => ({
      notification: fallbackNotification,
      created: true,
      settled: true,
    }));
    const originExists = vi.fn(async () => false);
    const deps = {
      markOriginUnread: vi.fn(async () => {
        throw new Error("conversation deleted during unread mutation");
      }),
      originExists,
      dispatchPush: vi.fn(),
      commitMissingOriginFallback,
      publishFallbackNotification: vi.fn(),
      settleMissingOriginResult: vi.fn(async () => false),
      isPostCommitEffectPending: vi.fn(async () => true),
      markPostCommitEffectDelivered: vi.fn(async () => true),
      listPendingPostCommitEffects: vi.fn(async () => []),
    };
    const service = createGraphWorkflowResultDeliveryService(deps);

    await service.deliverRecordedResult({
      projectPath: "/projects/repo",
      event: graphWorkflowResultRecordedEventSchema.parse({
        type: "graph-workflow-result-recorded",
        projectName: "repo",
        sessionName: "session-1",
        executionId: "execution-race",
        originConversationId: "conversation-deleted",
        boundaryCursor: 19,
      }),
      completionPush: {
        kind: "workflow-completed",
        projectName: "repo",
        sessionName: "session-1",
      },
    });

    expect(originExists).toHaveBeenCalledOnce();
    expect(commitMissingOriginFallback).toHaveBeenCalledOnce();
    expect(deps.publishFallbackNotification).toHaveBeenCalledExactlyOnceWith(
      fallbackNotification,
    );
    expect(deps.markPostCommitEffectDelivered).toHaveBeenCalledOnce();
  });

  it("settles a missing-origin non-completion boundary without a false completion notification", async () => {
    const commitMissingOriginFallback = vi.fn();
    const settleMissingOriginResult = vi.fn(async () => true);
    const markPostCommitEffectDelivered = vi.fn(async () => true);
    const resultDeliveryService = createGraphWorkflowResultDeliveryService({
      markOriginUnread: vi.fn(async () => false),
      dispatchPush: vi.fn(),
      commitMissingOriginFallback,
      publishFallbackNotification: vi.fn(),
      settleMissingOriginResult,
      isPostCommitEffectPending: vi.fn(async () => true),
      markPostCommitEffectDelivered,
      listPendingPostCommitEffects: vi.fn(async () => []),
    });

    await resultDeliveryService.deliverRecordedResult({
      projectPath: "/projects/repo",
      event: graphWorkflowResultRecordedEventSchema.parse({
        type: "graph-workflow-result-recorded",
        projectName: "repo",
        sessionName: "session-1",
        executionId: "execution-1",
        originConversationId: "conversation-deleted",
        boundaryCursor: 11,
      }),
      completionPush: null,
    });

    expect(commitMissingOriginFallback).not.toHaveBeenCalled();
    expect(settleMissingOriginResult).toHaveBeenCalledExactlyOnceWith({
      projectPath: "/projects/repo",
      sessionName: "session-1",
      executionId: "execution-1",
      boundarySeq: 11,
    });
    expect(markPostCommitEffectDelivered).toHaveBeenCalledOnce();
  });
});

/**
 * Derive events and run delivery immediately — the pre-split behavior most of
 * these isolated publisher tests assert (broadcast/push + the returned rows
 * together). Delivery now runs through the publisher's post-commit `deliver`
 * (the delivery record itself is inert data). Returns the append-only rows so
 * existing return-value assertions keep working. New split-behavior tests call
 * `publisher.deliver(delivery)` directly and assert on `.events` explicitly.
 */
function deriveDelivering(
  publisher: ReturnType<typeof createGraphWorkflowExecutionEventPublisher>,
  delivery: GraphWorkflowEventDelivery,
): GraphWorkflowExecutionEvent[] {
  publisher.deliver(delivery);
  return delivery.events;
}

describe("graph workflow execution event publisher", () => {
  it("publishes diff-based execution events and appends them to execution history", () => {
    const broadcast = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      now() {
        return "2026-03-28T10:00:00.000Z";
      },
    });

    const previousExecution = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-plan"],
      contextStates: {
        "context-plan": {
          skipReason: null,
          landingIntent: null,
          pendingApproval: null,
          pendingUserInputs: {},
          contextId: "context-plan",
          status: "running",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
          consecutiveCandidateMismatchCount: 0,
          worktreePath: null,
          branchName: null,
          isolation: "session",
          batchId: null,
          laneId: null,
          joinId: null,
          mergeStatus: "not-applicable",
          cleanupStatus: "not-applicable",
          lastMergeError: null,
        },
        "context-implement": {
          skipReason: null,
          landingIntent: null,
          pendingApproval: null,
          pendingUserInputs: {},
          contextId: "context-implement",
          status: "pending",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
          consecutiveCandidateMismatchCount: 0,
          worktreePath: null,
          branchName: null,
          isolation: "session",
          batchId: null,
          laneId: null,
          joinId: null,
          mergeStatus: "not-applicable",
          cleanupStatus: "not-applicable",
          lastMergeError: null,
        },
        "context-verify": {
          skipReason: null,
          landingIntent: null,
          pendingApproval: null,
          pendingUserInputs: {},
          contextId: "context-verify",
          status: "pending",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
          consecutiveCandidateMismatchCount: 0,
          worktreePath: null,
          branchName: null,
          isolation: "session",
          batchId: null,
          laneId: null,
          joinId: null,
          mergeStatus: "not-applicable",
          cleanupStatus: "not-applicable",
          lastMergeError: null,
        },
      },
      taskStates: {
        "task-plan-1": {
          taskId: "task-plan-1",
          contextId: "context-plan",
          order: 1,
          status: "running",
          summary: null,
          startedAt: "2026-03-28T09:58:00.000Z",
          completedAt: null,
          lastConversationId: "conversation-1",
          failureMessage: null,
          failureHistory: [],
        },
        "task-implement-1": {
          taskId: "task-implement-1",
          contextId: "context-implement",
          order: 1,
          status: "pending",
          summary: null,
          startedAt: null,
          completedAt: null,
          lastConversationId: null,
          failureMessage: null,
          failureHistory: [],
        },
        "task-verify-1": {
          taskId: "task-verify-1",
          contextId: "context-verify",
          order: 1,
          status: "pending",
          summary: null,
          startedAt: null,
          completedAt: null,
          lastConversationId: null,
          failureMessage: null,
          failureHistory: [],
        },
      },
    });

    const nextExecution = createWorkflowExecution({
      ...previousExecution,
      status: "halted",
      activeContextIds: ["context-plan"],
      haltReason: {
        type: "circuit_breaker",
        contextId: "context-plan",
        condition: "retry_exhaustion",
        failureCount: 3,
        summary: null,
      },
      contextStates: {
        ...previousExecution.contextStates,
        "context-plan": {
          ...previousExecution.contextStates["context-plan"]!,
          status: "halted",
          iterationCount: 1,
          consecutiveFailureCount: 3,
          consecutiveCandidateMismatchCount: 0,
        },
      },
      taskStates: {
        ...previousExecution.taskStates,
        "task-plan-1": {
          ...previousExecution.taskStates["task-plan-1"]!,
          status: "failed",
          failureMessage: "Validation failed",
        },
      },
      sharedDocuments: [
        {
          id: "doc-1",
          relativePath: ".cc/graph-workflow-docs/plan.md",
          description: "Updated implementation plan",
          readWhen: "Read before resuming the plan context.",
          kind: "shared",
          createdAt: "2026-03-28T09:59:00.000Z",
          updatedAt: "2026-03-28T10:00:00.000Z",
          lastUpdatedByConversationId: "conversation-1",
        },
      ],
    });

    const publishedExecution = deriveDelivering(
      publisher,
      publisher.publishExecutionUpdate({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        previousExecution,
        nextExecution,
      }),
    );

    expect(broadcast.mock.calls.map(([event]) => event.type)).toEqual([
      "graph-workflow-status",
      "graph-workflow-context-status",
      "graph-workflow-task-status",
      "graph-workflow-circuit-breaker",
      "graph-workflow-shared-documents-updated",
      "graph-workflow-boundary",
    ]);
    expect(publishedExecution.map((entry) => entry.event.type)).toEqual([
      "graph-workflow-status",
      "graph-workflow-context-status",
      "graph-workflow-task-status",
      "graph-workflow-circuit-breaker",
      "graph-workflow-shared-documents-updated",
      "graph-workflow-boundary",
    ]);
    expect(publishedExecution[0]?.occurredAt).toBe("2026-03-28T10:00:00.000Z");
  });

  it("publishes validation result events and records them in execution history", () => {
    const broadcast = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      now() {
        return "2026-03-28T10:05:00.000Z";
      },
    });

    const execution = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-plan"],
    });

    const updatedExecution = deriveDelivering(
      publisher,
      publisher.publishValidationResult({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        execution,
        contextId: "context-plan",
        validatorType: "context",
        pass: false,
        summary: "Validation failed because the fix task was incomplete.",
        issues: [
          {
            taskId: "task-plan-1",
            title: "Fix task incomplete",
            description:
              "The remediation task did not update the plan document.",
          },
        ],
        reopenTaskIds: ["task-plan-1"],
      }),
    );

    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "graph-workflow-validation-result",
        projectName: "repo",
        sessionName: "session-1",
        contextId: "context-plan",
        pass: false,
        reopenTaskIds: ["task-plan-1"],
      }),
    );
    expect(updatedExecution).toHaveLength(1);
    expect(updatedExecution[0]?.event).toEqual(
      expect.objectContaining({
        type: "graph-workflow-validation-result",
        validatorType: "context",
        reopenTaskIds: ["task-plan-1"],
      }),
    );
  });

  it("preserves the reviewed payload and revision with findings after a later round replaces runtime state", () => {
    const publisher = createGraphWorkflowExecutionEventPublisher();
    const execution = createWorkflowExecution({ status: "running" });
    const outputCandidate = {
      value: { issueIds: ["issue-1"], instructions: "Incomplete" },
      capturedAt: "2026-09-05T10:00:00.000Z",
      iteration: 1,
      parse: { source: "native" as const },
    };
    const candidate = freezeValidationCandidate({
      tree: {
        identityScope: "wholeTree",
        headSha: "head-1",
        candidateTreeHash: "tree-1",
      },
      contextId: "context-plan",
      taskStates: execution.taskStates,
      outputSchema: { type: "object" },
      outputValue: outputCandidate.value,
    });
    const round = openValidationRound({
      previousRound: null,
      candidate,
      assignments: [],
      startedAt: outputCandidate.capturedAt,
      outputCandidate,
    });
    execution.contextStates["context-plan"]!.validationRound = round;
    const delivery = publisher.publishValidationResult({
      projectPath: "/projects/repo",
      sessionName: "session-1",
      execution,
      contextId: "context-plan",
      validatorType: "context",
      pass: false,
      summary: "issue-1 is incomplete",
      round: { seq: round.seq, specialists: [] },
    });
    execution.contextStates["context-plan"]!.validationRound = null;

    const recorded = graphWorkflowExecutionEventSchema.parse(
      delivery.events[0],
    );
    expect(recorded.event).toMatchObject({
      reviewedCandidate: candidate,
      reviewedOutput: outputCandidate.value,
    });
  });

  it("publishes the validator's semantic lane reference unchanged", () => {
    const publisher = createGraphWorkflowExecutionEventPublisher();
    const execution = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-plan"],
      laneStates: {
        "context-plan": {
          context_validator: {
            lane: "context_validator",
            contextId: "context-plan",
            backend: TESTFAKE_BACKEND_ID,
            refKind: "conversation",
            workflowConversationId: "workflow-conversation-1",
            sessionRef: {
              backend: TESTFAKE_BACKEND_ID,
              ref: "testfake-validator-ref",
            },
            metrics: { rotateBeforeNextTurn: false },
            limitEvaluation: "disabled",
            lastUsedAt: "2026-03-28T10:04:00.000Z",
          },
        },
      },
    });

    const updatedExecution = deriveDelivering(
      publisher,
      publisher.publishValidationResult({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        execution,
        contextId: "context-plan",
        validatorType: "context",
        pass: true,
        summary: "Validation passed.",
        sessionRef: {
          backend: TESTFAKE_BACKEND_ID,
          ref: "workflow-conversation-1",
          lane: "context_validator",
          refKind: "conversation",
          workflowConversationId: "workflow-conversation-1",
        },
      }),
    );

    expect(updatedExecution[0]?.event).toMatchObject({
      type: "graph-workflow-validation-result",
      sessionRef: {
        backend: TESTFAKE_BACKEND_ID,
        ref: "workflow-conversation-1",
        lane: "context_validator",
        refKind: "conversation",
        workflowConversationId: "workflow-conversation-1",
      },
    });
    expect(
      graphWorkflowExecutionEventSchema.parse(updatedExecution[0]).event,
    ).toMatchObject({
      sessionRef: {
        backend: TESTFAKE_BACKEND_ID,
        workflowConversationId: "workflow-conversation-1",
      },
    });
  });

  it("publishes task status events when task conversation metadata changes", () => {
    const broadcast = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      now() {
        return "2026-03-28T10:06:00.000Z";
      },
    });

    const previousExecution = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-plan"],
      taskStates: {
        "task-plan-1": {
          taskId: "task-plan-1",
          contextId: "context-plan",
          order: 1,
          status: "pending",
          summary: null,
          startedAt: null,
          completedAt: null,
          lastConversationId: null,
          failureMessage: null,
          failureHistory: [],
        },
        "task-implement-1": {
          taskId: "task-implement-1",
          contextId: "context-implement",
          order: 1,
          status: "pending",
          summary: null,
          startedAt: null,
          completedAt: null,
          lastConversationId: null,
          failureMessage: null,
          failureHistory: [],
        },
        "task-verify-1": {
          taskId: "task-verify-1",
          contextId: "context-verify",
          order: 1,
          status: "pending",
          summary: null,
          startedAt: null,
          completedAt: null,
          lastConversationId: null,
          failureMessage: null,
          failureHistory: [],
        },
      },
    });
    const nextExecution = createWorkflowExecution({
      ...previousExecution,
      taskStates: {
        ...previousExecution.taskStates,
        "task-plan-1": {
          ...previousExecution.taskStates["task-plan-1"]!,
          startedAt: "2026-03-28T10:05:00.000Z",
          lastConversationId: "conversation-live",
          failureMessage: "Need follow-up",
        },
      },
    });

    deriveDelivering(
      publisher,
      publisher.publishExecutionUpdate({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        previousExecution,
        nextExecution,
      }),
    );

    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "graph-workflow-task-status",
        taskId: "task-plan-1",
        lastConversationId: "conversation-live",
        startedAt: "2026-03-28T10:05:00.000Z",
        failureMessage: "Need follow-up",
      }),
    );
  });

  it("dispatches push notification when workflow is halted", () => {
    const broadcast = vi.fn();
    const dispatchPush = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      dispatchPush,
      now: () => "2026-03-28T10:00:00.000Z",
    });

    const prev = createWorkflowExecution({ status: "running" });
    const next = createWorkflowExecution({ ...prev, status: "halted" });

    deriveDelivering(
      publisher,
      publisher.publishExecutionUpdate({
        projectPath: "/projects/repo",
        sessionName: "sess-1",
        previousExecution: prev,
        nextExecution: next,
      }),
    );

    expect(dispatchPush).toHaveBeenCalledWith({
      kind: "workflow-halted",
      projectName: "repo",
      sessionName: "sess-1",
    });
  });

  it("dispatches push notification when circuit breaker trips", () => {
    const broadcast = vi.fn();
    const dispatchPush = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      dispatchPush,
      now: () => "2026-03-28T10:00:00.000Z",
    });

    const prev = createWorkflowExecution({ status: "running" });
    const next = createWorkflowExecution({
      ...prev,
      status: "halted",
      haltReason: {
        type: "circuit_breaker",
        contextId: "context-plan",
        condition: "retry_exhaustion",
        failureCount: 3,
        summary: null,
      },
    });

    deriveDelivering(
      publisher,
      publisher.publishExecutionUpdate({
        projectPath: "/projects/repo",
        sessionName: "sess-1",
        previousExecution: prev,
        nextExecution: next,
      }),
    );

    const pushKinds = dispatchPush.mock.calls.map(
      (args: unknown[]) => (args[0] as { kind: string }).kind,
    );
    expect(pushKinds).toContain("circuit-breaker");
    // Circuit-breaker push is more specific — generic workflow-halted should be suppressed
    expect(pushKinds).not.toContain("workflow-halted");
  });

  it("dispatches push notification when execution context completes", () => {
    const broadcast = vi.fn();
    const dispatchPush = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      dispatchPush,
      now: () => "2026-03-28T10:00:00.000Z",
    });

    const prev = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-plan"],
      contextStates: {
        "context-plan": {
          skipReason: null,
          landingIntent: null,
          pendingApproval: null,
          pendingUserInputs: {},
          contextId: "context-plan",
          status: "running",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 1,
          consecutiveFailureCount: 0,
          consecutiveCandidateMismatchCount: 0,
          worktreePath: null,
          branchName: null,
          isolation: "session",
          batchId: null,
          laneId: null,
          joinId: null,
          mergeStatus: "not-applicable",
          cleanupStatus: "not-applicable",
          lastMergeError: null,
        },
        "context-implement": {
          skipReason: null,
          landingIntent: null,
          pendingApproval: null,
          pendingUserInputs: {},
          contextId: "context-implement",
          status: "pending",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
          consecutiveCandidateMismatchCount: 0,
          worktreePath: null,
          branchName: null,
          isolation: "session",
          batchId: null,
          laneId: null,
          joinId: null,
          mergeStatus: "not-applicable",
          cleanupStatus: "not-applicable",
          lastMergeError: null,
        },
        "context-verify": {
          skipReason: null,
          landingIntent: null,
          pendingApproval: null,
          pendingUserInputs: {},
          contextId: "context-verify",
          status: "pending",
          totalTaskCount: 1,
          completedTaskCount: 0,
          iterationCount: 0,
          consecutiveFailureCount: 0,
          consecutiveCandidateMismatchCount: 0,
          worktreePath: null,
          branchName: null,
          isolation: "session",
          batchId: null,
          laneId: null,
          joinId: null,
          mergeStatus: "not-applicable",
          cleanupStatus: "not-applicable",
          lastMergeError: null,
        },
      },
    });
    const next = createWorkflowExecution({
      ...prev,
      contextStates: {
        ...prev.contextStates,
        "context-plan": {
          ...prev.contextStates["context-plan"]!,
          status: "completed",
          completedTaskCount: 1,
        },
      },
    });

    deriveDelivering(
      publisher,
      publisher.publishExecutionUpdate({
        projectPath: "/projects/repo",
        sessionName: "sess-1",
        previousExecution: prev,
        nextExecution: next,
      }),
    );

    expect(dispatchPush).toHaveBeenCalledWith({
      kind: "context-completed",
      projectName: "repo",
      sessionName: "sess-1",
      contextTitle: "Plan",
      completedContexts: 1,
      totalContexts: 3,
    });
  });

  it("emits status, batch-scheduled, and merge-status events for two simultaneously active contexts", () => {
    const broadcast = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      now: () => "2026-03-28T10:10:00.000Z",
    });

    const previousExecution = createWorkflowExecution({
      status: "running",
      activeContextIds: [],
    });

    const nextExecution = createWorkflowExecution({
      ...previousExecution,
      activeContextIds: ["context-implement", "context-verify"],
      contextStates: {
        ...previousExecution.contextStates,
        "context-implement": {
          ...previousExecution.contextStates["context-implement"]!,
          status: "running",
          isolation: "worktree",
          worktreePath: "/repo/.worktrees/session-1.context-implement",
          branchName: "csm/session-1-context-implement",
          batchId: "batch-7",
          laneId: null,
          joinId: null,
          mergeStatus: "pending",
          cleanupStatus: "pending",
        },
        "context-verify": {
          ...previousExecution.contextStates["context-verify"]!,
          status: "running",
          isolation: "worktree",
          worktreePath: "/repo/.worktrees/session-1.context-verify",
          branchName: "csm/session-1-context-verify",
          batchId: "batch-7",
          laneId: null,
          joinId: null,
          mergeStatus: "pending",
          cleanupStatus: "pending",
        },
      },
    });

    deriveDelivering(
      publisher,
      publisher.publishExecutionUpdate({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        previousExecution,
        nextExecution,
      }),
    );

    const eventTypes = broadcast.mock.calls.map(([event]) => event.type);
    expect(eventTypes).toContain("graph-workflow-status");
    expect(eventTypes).toContain("graph-workflow-batch-scheduled");
    expect(
      eventTypes.filter((t) => t === "graph-workflow-merge-status"),
    ).toHaveLength(2);

    const statusEvent = broadcast.mock.calls.find(
      ([event]) => event.type === "graph-workflow-status",
    )?.[0];
    expect(statusEvent).toMatchObject({
      activeContextIds: ["context-implement", "context-verify"],
      activeBatchIds: ["batch-7"],
      pendingHaltReason: null,
    });

    const batchEvent = broadcast.mock.calls.find(
      ([event]) => event.type === "graph-workflow-batch-scheduled",
    )?.[0];
    expect(batchEvent).toMatchObject({
      batchId: "batch-7",
      contextIds: ["context-implement", "context-verify"],
    });

    const mergeEvents = broadcast.mock.calls
      .map(([event]) => event)
      .filter((e) => e.type === "graph-workflow-merge-status");
    expect(mergeEvents.map((e) => e.contextId)).toEqual([
      "context-implement",
      "context-verify",
    ]);
    for (const evt of mergeEvents) {
      expect(evt).toMatchObject({
        mergeStatus: "pending",
        cleanupStatus: "pending",
      });
    }
  });

  it("orders batch-scheduled contextIds and merge-status events by activeContextIds, not definition order", () => {
    const broadcast = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      now: () => "2026-03-28T10:12:00.000Z",
    });

    const previousExecution = createWorkflowExecution({
      status: "running",
      activeContextIds: [],
    });

    const nextExecution = createWorkflowExecution({
      ...previousExecution,
      activeContextIds: ["context-verify", "context-implement"],
      contextStates: {
        ...previousExecution.contextStates,
        "context-implement": {
          ...previousExecution.contextStates["context-implement"]!,
          status: "running",
          isolation: "worktree",
          worktreePath: "/repo/.worktrees/session-1.context-implement",
          branchName: "csm/session-1-context-implement",
          batchId: "batch-9",
          laneId: null,
          joinId: null,
          mergeStatus: "in-progress",
          cleanupStatus: "pending",
        },
        "context-verify": {
          ...previousExecution.contextStates["context-verify"]!,
          status: "running",
          isolation: "worktree",
          worktreePath: "/repo/.worktrees/session-1.context-verify",
          branchName: "csm/session-1-context-verify",
          batchId: "batch-9",
          laneId: null,
          joinId: null,
          mergeStatus: "pending",
          cleanupStatus: "pending",
        },
      },
    });

    deriveDelivering(
      publisher,
      publisher.publishExecutionUpdate({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        previousExecution,
        nextExecution,
      }),
    );

    const batchEvent = broadcast.mock.calls.find(
      ([event]) => event.type === "graph-workflow-batch-scheduled",
    )?.[0];
    expect(batchEvent.contextIds).toEqual([
      "context-verify",
      "context-implement",
    ]);

    const mergeContextIdsInOrder = broadcast.mock.calls
      .map(([event]) => event)
      .filter((e) => e.type === "graph-workflow-merge-status")
      .map((e) => e.contextId);
    expect(mergeContextIdsInOrder).toEqual([
      "context-verify",
      "context-implement",
    ]);
  });

  it("emits a graph-workflow-pending-halt-reason event when pendingHaltReason changes", () => {
    const broadcast = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      now: () => "2026-03-28T10:11:00.000Z",
    });

    const previousExecution = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-plan"],
      pendingHaltReason: null,
    });
    const nextExecution = createWorkflowExecution({
      ...previousExecution,
      pendingHaltReason: {
        type: "circuit_breaker",
        contextId: "context-plan",
        condition: "retry_exhaustion",
        summary: null,
      },
    });

    deriveDelivering(
      publisher,
      publisher.publishExecutionUpdate({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        previousExecution,
        nextExecution,
      }),
    );

    const pendingEvent = broadcast.mock.calls.find(
      ([event]) => event.type === "graph-workflow-pending-halt-reason",
    )?.[0];
    expect(pendingEvent).toMatchObject({
      type: "graph-workflow-pending-halt-reason",
      pendingHaltReason: {
        type: "circuit_breaker",
        contextId: "context-plan",
      },
    });
  });

  it("emits a graph-workflow-lane-status event when a lane is newly created", () => {
    const broadcast = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      now: () => "2026-04-02T08:00:00.000Z",
    });

    const previousExecution = createWorkflowExecution({
      status: "running",
      executionLanes: {},
      laneReservations: {},
    });
    const nextExecution = createWorkflowExecution({
      ...previousExecution,
      executionLanes: {
        "lane-plan": {
          laneId: "lane-plan",
          kind: "worktree",
          status: "active",
          worktreePath: "/repo/.worktrees/feature.lane-plan",
          branchName: "csm/feature-lane-plan",
          includedContextIds: [],
          lastCommittingContextId: null,
          commitSnapshots: [],
          createdAt: "2026-04-02T07:59:00.000Z",
          updatedAt: "2026-04-02T07:59:00.000Z",
        },
      },
    });

    const published = deriveDelivering(
      publisher,
      publisher.publishExecutionUpdate({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        previousExecution,
        nextExecution,
      }),
    );

    const laneEvent = broadcast.mock.calls
      .map(([event]) => event)
      .find((e) => e.type === "graph-workflow-lane-status");
    expect(laneEvent).toEqual({
      type: "graph-workflow-lane-status",
      projectName: "repo",
      sessionName: "session-1",
      executionId: nextExecution.id,
      laneId: "lane-plan",
      kind: "worktree",
      status: "active",
      branchName: "csm/feature-lane-plan",
      worktreePath: "/repo/.worktrees/feature.lane-plan",
      includedContextIds: [],
      lastCommittingContextId: null,
    });
    expect(
      published.some((h) => h.event.type === "graph-workflow-lane-status"),
    ).toBe(true);
  });

  it("emits a graph-workflow-lane-status event when an existing lane changes status or membership", () => {
    const broadcast = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      now: () => "2026-04-02T08:00:00.000Z",
    });

    const baseLane = {
      laneId: "lane-plan",
      kind: "worktree" as const,
      status: "active" as const,
      worktreePath: "/repo/.worktrees/feature.lane-plan",
      branchName: "csm/feature-lane-plan",
      includedContextIds: [],
      lastCommittingContextId: null,
      commitSnapshots: [],
      createdAt: "2026-04-02T07:59:00.000Z",
      updatedAt: "2026-04-02T07:59:00.000Z",
    };
    const previousExecution = createWorkflowExecution({
      status: "running",
      executionLanes: { "lane-plan": baseLane },
    });
    const nextExecution = createWorkflowExecution({
      ...previousExecution,
      executionLanes: {
        "lane-plan": {
          ...baseLane,
          status: "merged",
          includedContextIds: ["context-plan"],
          lastCommittingContextId: "context-plan",
          updatedAt: "2026-04-02T08:00:00.000Z",
        },
      },
    });

    deriveDelivering(
      publisher,
      publisher.publishExecutionUpdate({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        previousExecution,
        nextExecution,
      }),
    );

    const laneEvents = broadcast.mock.calls
      .map(([event]) => event)
      .filter((e) => e.type === "graph-workflow-lane-status");
    expect(laneEvents).toHaveLength(1);
    expect(laneEvents[0]).toMatchObject({
      laneId: "lane-plan",
      status: "merged",
      includedContextIds: ["context-plan"],
      lastCommittingContextId: "context-plan",
    });
  });

  it("does not emit a lane-status event when no observable lane fields change", () => {
    const broadcast = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      now: () => "2026-04-02T08:00:00.000Z",
    });

    const lane = {
      laneId: "lane-plan",
      kind: "worktree" as const,
      status: "active" as const,
      worktreePath: "/repo/.worktrees/feature.lane-plan",
      branchName: "csm/feature-lane-plan",
      includedContextIds: ["context-plan"],
      lastCommittingContextId: "context-plan",
      commitSnapshots: [],
      createdAt: "2026-04-02T07:59:00.000Z",
      updatedAt: "2026-04-02T07:59:00.000Z",
    };
    const previousExecution = createWorkflowExecution({
      status: "running",
      executionLanes: { "lane-plan": lane },
    });
    const nextExecution = createWorkflowExecution({
      ...previousExecution,
      executionLanes: {
        "lane-plan": { ...lane, updatedAt: "2026-04-02T08:00:00.000Z" },
      },
    });

    deriveDelivering(
      publisher,
      publisher.publishExecutionUpdate({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        previousExecution,
        nextExecution,
      }),
    );

    const laneEvents = broadcast.mock.calls
      .map(([event]) => event)
      .filter((e) => e.type === "graph-workflow-lane-status");
    expect(laneEvents).toEqual([]);
  });

  it("emits each appended lane commit snapshot as a context-addressable event", () => {
    const broadcast = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      now: () => "2026-07-18T13:58:00.000Z",
    });
    const lane = {
      laneId: "lane-1",
      kind: "worktree" as const,
      status: "active" as const,
      worktreePath: "/worktrees/lane-1",
      branchName: "lane-1",
      includedContextIds: ["context-plan"],
      lastCommittingContextId: "context-plan",
      commitSnapshots: [],
      createdAt: "2026-07-18T13:00:00.000Z",
      updatedAt: "2026-07-18T13:00:00.000Z",
    };
    const previousExecution = createWorkflowExecution({
      executionLanes: { "lane-1": lane },
    });
    const nextExecution = createWorkflowExecution({
      ...previousExecution,
      executionLanes: {
        "lane-1": {
          ...lane,
          commitSnapshots: [
            {
              contextId: "context-plan",
              sha: "commit-abc",
              committedAt: "2026-07-18T13:57:00.000Z",
            },
          ],
          updatedAt: "2026-07-18T13:57:00.000Z",
        },
      },
    });

    const rows = deriveDelivering(
      publisher,
      publisher.publishExecutionUpdate({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        previousExecution,
        nextExecution,
      }),
    );

    expect(rows.map((row) => row.event)).toContainEqual({
      type: "graph-workflow-lane-commit",
      projectName: "repo",
      sessionName: "session-1",
      executionId: nextExecution.id,
      contextId: "context-plan",
      laneId: "lane-1",
      sha: "commit-abc",
      committedAt: "2026-07-18T13:57:00.000Z",
    });
  });

  it("persists and publishes lane creation, two-member admission, each landing, and an ownership drift halt", () => {
    const broadcast = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      now: () => "2026-08-09T12:00:00.000Z",
    });
    const base = createWorkflowExecution({ status: "running" });
    const workingDefinition = {
      ...base.workingDefinition,
      executionContexts: base.workingDefinition.executionContexts.map(
        (context) => {
          if (context.id === "context-plan") {
            return {
              ...context,
              placement: {
                lane: "delivery",
                mode: "owned" as const,
                ownedPaths: ["src/plan"],
              },
            };
          }
          if (context.id === "context-implement") {
            return {
              ...context,
              placement: {
                lane: "delivery",
                mode: "owned" as const,
                ownedPaths: ["src/implement"],
              },
            };
          }
          return context;
        },
      ),
    };
    const initial = createWorkflowExecution({
      ...base,
      workingDefinition,
      executionLanes: {},
      laneReservations: {},
    });
    const reserved = createWorkflowExecution({
      ...initial,
      contextStates: {
        ...initial.contextStates,
        "context-plan": {
          ...initial.contextStates["context-plan"]!,
          status: "ready",
          reservedByBatchId: "batch-1",
          reservedOwnership: {
            mode: "owned",
            canonicalPrefixes: ["/repo/.worktrees/delivery/src/plan"],
          },
        },
        "context-implement": {
          ...initial.contextStates["context-implement"]!,
          status: "ready",
          reservedByBatchId: "batch-1",
          reservedOwnership: {
            mode: "owned",
            canonicalPrefixes: ["/repo/.worktrees/delivery/src/implement"],
          },
        },
      },
      laneReservations: {
        delivery: {
          laneId: "delivery",
          batchId: "batch-1",
          provisioning: true,
          members: [
            {
              contextId: "context-plan",
              ownership: {
                mode: "owned",
                canonicalPrefixes: ["/repo/.worktrees/delivery/src/plan"],
              },
            },
            {
              contextId: "context-implement",
              ownership: {
                mode: "owned",
                canonicalPrefixes: ["/repo/.worktrees/delivery/src/implement"],
              },
            },
          ],
          createdAt: "2026-08-09T11:59:00.000Z",
        },
      },
    });
    const pendingIntent = (contextId: string) => ({
      mode: "lane_commit" as const,
      attempt: 1,
      token: `landing-${contextId}`,
      laneId: "delivery",
      worktreePath: "/repo/.worktrees/delivery",
      baselineSha: "base-sha",
      headSha: null,
      joinId: null,
      state: "pending" as const,
      evidence: null,
      recordedAt: "2026-08-09T11:59:30.000Z",
      settledAt: null,
    });
    const lane = {
      laneId: "delivery",
      kind: "worktree" as const,
      status: "active" as const,
      worktreePath: "/repo/.worktrees/delivery",
      branchName: "csm/delivery",
      includedContextIds: [],
      lastCommittingContextId: null,
      commitSnapshots: [],
      createdAt: "2026-08-09T11:59:30.000Z",
      updatedAt: "2026-08-09T11:59:30.000Z",
    };
    const admitted = createWorkflowExecution({
      ...reserved,
      activeContextIds: ["context-plan", "context-implement"],
      contextStates: {
        ...reserved.contextStates,
        "context-plan": {
          ...reserved.contextStates["context-plan"]!,
          status: "running",
          reservedByBatchId: null,
          laneId: "delivery",
          batchId: "batch-1",
          isolation: "worktree",
          worktreePath: lane.worktreePath,
          branchName: lane.branchName,
          landingIntent: pendingIntent("context-plan"),
        },
        "context-implement": {
          ...reserved.contextStates["context-implement"]!,
          status: "running",
          reservedByBatchId: null,
          laneId: "delivery",
          batchId: "batch-1",
          isolation: "worktree",
          worktreePath: lane.worktreePath,
          branchName: lane.branchName,
          landingIntent: pendingIntent("context-implement"),
        },
      },
      executionLanes: { delivery: lane },
      laneReservations: {},
    });
    const firstLandedAt = "2026-08-09T12:01:00.000Z";
    const firstLanded = createWorkflowExecution({
      ...admitted,
      contextStates: {
        ...admitted.contextStates,
        "context-plan": {
          ...admitted.contextStates["context-plan"]!,
          landingIntent: {
            ...pendingIntent("context-plan"),
            state: "landed",
            evidence: "commit",
            headSha: "plan-sha",
            settledAt: firstLandedAt,
          },
        },
      },
      executionLanes: {
        delivery: {
          ...lane,
          includedContextIds: ["context-plan"],
          lastCommittingContextId: "context-plan",
          commitSnapshots: [
            {
              contextId: "context-plan",
              sha: "plan-sha",
              committedAt: firstLandedAt,
            },
          ],
          updatedAt: firstLandedAt,
        },
      },
    });
    const secondLandedAt = "2026-08-09T12:02:00.000Z";
    const secondLanded = createWorkflowExecution({
      ...firstLanded,
      contextStates: {
        ...firstLanded.contextStates,
        "context-implement": {
          ...firstLanded.contextStates["context-implement"]!,
          landingIntent: {
            ...pendingIntent("context-implement"),
            state: "landed",
            evidence: "no-changes",
            settledAt: secondLandedAt,
          },
        },
      },
      executionLanes: {
        delivery: {
          ...firstLanded.executionLanes.delivery!,
          includedContextIds: ["context-plan", "context-implement"],
          updatedAt: secondLandedAt,
        },
      },
    });
    const drifted = createWorkflowExecution({
      ...secondLanded,
      pendingHaltReason: {
        type: "ownership_violation",
        laneId: "delivery",
        contextId: "context-implement",
        unattributedPaths: ["src/unowned.ts"],
        message: "Unattributed lane write",
        summary: null,
      },
    });

    const deliveries = [
      publisher.publishExecutionUpdate({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        previousExecution: initial,
        nextExecution: reserved,
      }),
      publisher.publishExecutionUpdate({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        previousExecution: reserved,
        nextExecution: admitted,
      }),
      publisher.publishExecutionUpdate({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        previousExecution: admitted,
        nextExecution: firstLanded,
      }),
      publisher.publishExecutionUpdate({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        previousExecution: firstLanded,
        nextExecution: secondLanded,
      }),
      publisher.publishExecutionUpdate({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        previousExecution: secondLanded,
        nextExecution: drifted,
      }),
    ];
    for (const delivery of deliveries) publisher.deliver(delivery);
    const decisions = deliveries
      .flatMap((delivery) => delivery.events)
      .filter((row) =>
        [
          "graph-workflow-lane-created",
          "graph-workflow-lane-concurrent-admission",
          "graph-workflow-lane-landed",
          "graph-workflow-lane-drift-halted",
        ].includes(row.event.type),
      );

    expect(decisions.map((row) => row.event)).toEqual([
      {
        type: "graph-workflow-lane-created",
        projectName: "repo",
        sessionName: "session-1",
        executionId: admitted.id,
        laneId: "delivery",
        kind: "worktree",
        placementSource: "authored",
      },
      {
        type: "graph-workflow-lane-concurrent-admission",
        projectName: "repo",
        sessionName: "session-1",
        executionId: admitted.id,
        laneId: "delivery",
        batchId: "batch-1",
        memberContextIds: ["context-plan", "context-implement"],
        canonicalCheckResult: "passed",
      },
      {
        type: "graph-workflow-lane-landed",
        projectName: "repo",
        sessionName: "session-1",
        executionId: admitted.id,
        laneId: "delivery",
        contextId: "context-plan",
        ownedPathspec: ["src/plan"],
        commitSha: "plan-sha",
        landedAt: firstLandedAt,
      },
      {
        type: "graph-workflow-lane-landed",
        projectName: "repo",
        sessionName: "session-1",
        executionId: admitted.id,
        laneId: "delivery",
        contextId: "context-implement",
        ownedPathspec: ["src/implement"],
        commitSha: null,
        landedAt: secondLandedAt,
      },
      {
        type: "graph-workflow-lane-drift-halted",
        projectName: "repo",
        sessionName: "session-1",
        executionId: admitted.id,
        laneId: "delivery",
        contextId: "context-implement",
        unattributedPaths: ["src/unowned.ts"],
      },
    ]);
    expect(
      decisions.map((row) =>
        graphWorkflowExecutionEventSchema.parse(
          JSON.parse(JSON.stringify(row)),
        ),
      ),
    ).toEqual(decisions);
    expect(
      broadcast.mock.calls
        .map(([event]) => event.type)
        .filter((type) =>
          [
            "graph-workflow-lane-created",
            "graph-workflow-lane-concurrent-admission",
            "graph-workflow-lane-landed",
            "graph-workflow-lane-drift-halted",
          ].includes(type),
        ),
    ).toEqual(decisions.map((row) => row.event.type));

    const replay = publisher.publishExecutionUpdate({
      projectPath: "/projects/repo",
      sessionName: "session-1",
      previousExecution: drifted,
      nextExecution: createWorkflowExecution({
        ...drifted,
        pendingHaltReason: null,
        haltReason: drifted.pendingHaltReason,
      }),
    });
    expect(
      replay.events.filter(
        (row) => row.event.type === "graph-workflow-lane-drift-halted",
      ),
    ).toEqual([]);
  });

  // A plan-defect halt is the ENTIRE reaction to a refused contract — no task
  // reopens, no failure is charged, no aggregate verdict is published — so this
  // event is the only thing that announces it as it happens. It must arrive
  // exactly once: the halt is recorded as PENDING and drained to `haltReason`
  // one write later, and plan repair may then stamp its verdict onto the same
  // standing halt. Neither is a second halt to announce.
  it("announces a plan-defect halt once, across the drain and the repair verdict", () => {
    const broadcast = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      now: () => "2026-08-17T09:00:00.000Z",
    });
    const haltReason = {
      type: "plan_defect" as const,
      contextId: "context-plan",
      planDefects: [
        {
          assignmentId: "general",
          title: "The criterion names work this context does not own",
          description:
            "Criterion 2 requires the downstream publisher to change.",
          whyNotLocallyRemediable:
            "Every task here is scoped to the reader; the publisher lands later.",
          conflictingContract: "Acceptance criterion 2",
        },
      ],
      roundSeq: 3,
      summary: null,
    };
    const running = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-plan"],
    });
    const signalled = createWorkflowExecution({
      ...running,
      activeContextIds: [],
      pendingHaltReason: haltReason,
    });
    const drained = createWorkflowExecution({
      ...signalled,
      status: "halted",
      pendingHaltReason: null,
      haltReason,
    });
    const repairDeclined = createWorkflowExecution({
      ...drained,
      haltReason: { ...haltReason, summary: "Plan repair declined." },
    });

    const planDefectEvents = (delivery: GraphWorkflowEventDelivery) =>
      delivery.events.filter(
        (row) => row.event.type === "graph-workflow-plan-defect-halted",
      );

    const signalledDelivery = publisher.publishExecutionUpdate({
      projectPath: "/projects/repo",
      sessionName: "session-1",
      previousExecution: running,
      nextExecution: signalled,
    });
    publisher.deliver(signalledDelivery);

    expect(planDefectEvents(signalledDelivery).map((row) => row.event)).toEqual(
      [
        {
          type: "graph-workflow-plan-defect-halted",
          projectName: "repo",
          sessionName: "session-1",
          executionId: signalled.id,
          contextId: "context-plan",
          roundSeq: 3,
          defects: [
            {
              assignmentId: "general",
              title: "The criterion names work this context does not own",
              conflictingContract: "Acceptance criterion 2",
            },
          ],
        },
      ],
    );
    // Registered in the SSE envelope: a strict union that did not know this
    // type would drop the event silently on the way to every consumer.
    expect(
      planDefectEvents(signalledDelivery).map((row) =>
        graphWorkflowExecutionEventSchema.parse(
          JSON.parse(JSON.stringify(row)),
        ),
      ),
    ).toEqual(planDefectEvents(signalledDelivery));
    expect(
      broadcast.mock.calls
        .map(([event]) => event.type)
        .filter((type) => type === "graph-workflow-plan-defect-halted"),
    ).toEqual(["graph-workflow-plan-defect-halted"]);

    expect(
      planDefectEvents(
        publisher.publishExecutionUpdate({
          projectPath: "/projects/repo",
          sessionName: "session-1",
          previousExecution: signalled,
          nextExecution: drained,
        }),
      ),
    ).toEqual([]);
    expect(
      planDefectEvents(
        publisher.publishExecutionUpdate({
          projectPath: "/projects/repo",
          sessionName: "session-1",
          previousExecution: drained,
          nextExecution: repairDeclined,
        }),
      ),
    ).toEqual([]);
  });

  // Plan repair may stamp its verdict onto a standing lane-drift halt. The
  // drift's identity is the lane, the reporting member, and the paths — never
  // the verdict — so the stamped halt is the SAME drift, and re-announcing it
  // would put a second incident in the ledger for one unattributed write.
  it("announces a lane-drift halt once, across the drain and the repair verdict", () => {
    const broadcast = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      now: () => "2026-08-18T09:00:00.000Z",
    });
    const haltReason = {
      type: "ownership_violation" as const,
      laneId: "delivery",
      contextId: "context-implement",
      unattributedPaths: ["src/unowned.ts"],
      message: "Unattributed lane write",
      summary: null,
    };
    const running = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-implement"],
    });
    const signalled = createWorkflowExecution({
      ...running,
      activeContextIds: [],
      pendingHaltReason: haltReason,
    });
    const drained = createWorkflowExecution({
      ...signalled,
      status: "halted",
      pendingHaltReason: null,
      haltReason,
    });
    const repairDeclined = createWorkflowExecution({
      ...drained,
      haltReason: {
        ...haltReason,
        summary: "Plan repair declined: no member may own a generated file.",
      },
    });

    const driftEvents = (delivery: GraphWorkflowEventDelivery) =>
      delivery.events.filter(
        (row) => row.event.type === "graph-workflow-lane-drift-halted",
      );

    const signalledDelivery = publisher.publishExecutionUpdate({
      projectPath: "/projects/repo",
      sessionName: "session-1",
      previousExecution: running,
      nextExecution: signalled,
    });
    publisher.deliver(signalledDelivery);

    expect(driftEvents(signalledDelivery).map((row) => row.event)).toEqual([
      {
        type: "graph-workflow-lane-drift-halted",
        projectName: "repo",
        sessionName: "session-1",
        executionId: signalled.id,
        laneId: "delivery",
        contextId: "context-implement",
        unattributedPaths: ["src/unowned.ts"],
      },
    ]);
    expect(
      driftEvents(
        publisher.publishExecutionUpdate({
          projectPath: "/projects/repo",
          sessionName: "session-1",
          previousExecution: signalled,
          nextExecution: drained,
        }),
      ),
    ).toEqual([]);
    expect(
      driftEvents(
        publisher.publishExecutionUpdate({
          projectPath: "/projects/repo",
          sessionName: "session-1",
          previousExecution: drained,
          nextExecution: repairDeclined,
        }),
      ),
    ).toEqual([]);
  });

  it("emits a graph-workflow-join-status event when a join is newly created (pending)", () => {
    const broadcast = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      now: () => "2026-04-02T08:00:00.000Z",
    });

    const previousExecution = createWorkflowExecution({
      status: "running",
      joins: {},
    });
    const nextExecution = createWorkflowExecution({
      ...previousExecution,
      joins: {
        "join-1": {
          joinId: "join-1",
          kind: "context_merge",
          contextId: "context-verify",
          targetLaneId: "lane-target",
          sourceLaneIds: ["lane-a", "lane-b"],
          mergedSourceLaneIds: [],
          validationDebtSourceLaneIds: [],
          status: "pending",
          errorMessage: null,
          conflicts: null,
          conflictGuidance: null,
          createdAt: "2026-04-02T08:00:00.000Z",
          updatedAt: "2026-04-02T08:00:00.000Z",
          completedAt: null,
        },
      },
    });

    const published = deriveDelivering(
      publisher,
      publisher.publishExecutionUpdate({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        previousExecution,
        nextExecution,
      }),
    );

    const joinEvent = broadcast.mock.calls
      .map(([event]) => event)
      .find((e) => e.type === "graph-workflow-join-status");
    expect(joinEvent).toEqual({
      type: "graph-workflow-join-status",
      projectName: "repo",
      sessionName: "session-1",
      executionId: nextExecution.id,
      joinId: "join-1",
      kind: "context_merge",
      contextId: "context-verify",
      status: "pending",
      sourceLaneIds: ["lane-a", "lane-b"],
      mergedSourceLaneIds: [],
      targetLaneId: "lane-target",
      errorMessage: null,
      conflicts: null,
    });
    expect(
      published.some((h) => h.event.type === "graph-workflow-join-status"),
    ).toBe(true);
  });

  it("emits a graph-workflow-join-status event when join progresses (status or mergedSourceLaneIds changes)", () => {
    const broadcast = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      now: () => "2026-04-02T08:00:00.000Z",
    });

    const baseJoin = {
      joinId: "join-1",
      kind: "context_merge" as const,
      contextId: null,
      targetLaneId: "lane-target",
      sourceLaneIds: ["lane-a", "lane-b"],
      mergedSourceLaneIds: [],
      validationDebtSourceLaneIds: [],
      status: "pending" as const,
      errorMessage: null,
      conflicts: null,
      conflictGuidance: null,
      createdAt: "2026-04-02T07:59:00.000Z",
      updatedAt: "2026-04-02T07:59:00.000Z",
      completedAt: null,
    };
    const previousExecution = createWorkflowExecution({
      status: "running",
      joins: { "join-1": baseJoin },
    });
    const nextExecution = createWorkflowExecution({
      ...previousExecution,
      joins: {
        "join-1": {
          ...baseJoin,
          status: "running",
          mergedSourceLaneIds: ["lane-a"],
          updatedAt: "2026-04-02T08:00:00.000Z",
        },
      },
    });

    deriveDelivering(
      publisher,
      publisher.publishExecutionUpdate({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        previousExecution,
        nextExecution,
      }),
    );

    const joinEvents = broadcast.mock.calls
      .map(([event]) => event)
      .filter((e) => e.type === "graph-workflow-join-status");
    expect(joinEvents).toHaveLength(1);
    expect(joinEvents[0]).toMatchObject({
      joinId: "join-1",
      status: "running",
      mergedSourceLaneIds: ["lane-a"],
    });
  });

  it("emits a graph-workflow-join-status event when join fails with conflicts", () => {
    const broadcast = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      now: () => "2026-04-02T08:00:00.000Z",
    });

    const baseJoin = {
      joinId: "join-1",
      kind: "final_publish" as const,
      contextId: null,
      targetLaneId: "__session__",
      sourceLaneIds: ["lane-plan"],
      mergedSourceLaneIds: [],
      validationDebtSourceLaneIds: [],
      status: "running" as const,
      errorMessage: null,
      conflicts: null,
      conflictGuidance: null,
      createdAt: "2026-04-02T07:59:00.000Z",
      updatedAt: "2026-04-02T07:59:00.000Z",
      completedAt: null,
    };
    const previousExecution = createWorkflowExecution({
      status: "running",
      joins: { "join-1": baseJoin },
    });
    const nextExecution = createWorkflowExecution({
      ...previousExecution,
      joins: {
        "join-1": {
          ...baseJoin,
          status: "conflicts",
          errorMessage: "merge conflicts",
          conflicts: {
            files: ["src/foo.ts"],
            message: "merge conflicts",
            analysis: null,
          },
          updatedAt: "2026-04-02T08:00:00.000Z",
          completedAt: "2026-04-02T08:00:00.000Z",
        },
      },
    });

    deriveDelivering(
      publisher,
      publisher.publishExecutionUpdate({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        previousExecution,
        nextExecution,
      }),
    );

    const joinEvents = broadcast.mock.calls
      .map(([event]) => event)
      .filter((e) => e.type === "graph-workflow-join-status");
    expect(joinEvents).toHaveLength(1);
    expect(joinEvents[0]).toMatchObject({
      joinId: "join-1",
      kind: "final_publish",
      status: "conflicts",
      errorMessage: "merge conflicts",
      conflicts: { files: ["src/foo.ts"], message: "merge conflicts" },
    });
  });

  it("does not emit a join-status event when nothing observable changes on a join", () => {
    const broadcast = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      now: () => "2026-04-02T08:00:00.000Z",
    });

    const join = {
      joinId: "join-1",
      kind: "context_merge" as const,
      contextId: null,
      targetLaneId: "lane-target",
      sourceLaneIds: ["lane-a", "lane-b"],
      mergedSourceLaneIds: ["lane-a"],
      validationDebtSourceLaneIds: [],
      status: "running" as const,
      errorMessage: null,
      conflicts: null,
      conflictGuidance: null,
      createdAt: "2026-04-02T07:59:00.000Z",
      updatedAt: "2026-04-02T07:59:00.000Z",
      completedAt: null,
    };
    const previousExecution = createWorkflowExecution({
      status: "running",
      joins: { "join-1": join },
    });
    const nextExecution = createWorkflowExecution({
      ...previousExecution,
      joins: { "join-1": { ...join, updatedAt: "2026-04-02T08:00:00.000Z" } },
    });

    deriveDelivering(
      publisher,
      publisher.publishExecutionUpdate({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        previousExecution,
        nextExecution,
      }),
    );

    const joinEvents = broadcast.mock.calls
      .map(([event]) => event)
      .filter((e) => e.type === "graph-workflow-join-status");
    expect(joinEvents).toEqual([]);
  });

  it("publishes approval-pending with history append, broadcast, and a waiting-for-input push", () => {
    const broadcast = vi.fn();
    const dispatchPush = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      dispatchPush,
      now: () => "2026-06-10T09:00:00.000Z",
    });

    const execution = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-plan"],
    });

    const updatedExecution = deriveDelivering(
      publisher,
      publisher.publishApprovalPending({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        execution,
        contextId: "context-plan",
        conversationId: "conversation-9",
        requestedAt: "2026-06-10T08:59:00.000Z",
      }),
    );

    expect(broadcast).toHaveBeenNthCalledWith(1, {
      type: "graph-workflow-approval-pending",
      projectName: "repo",
      sessionName: "session-1",
      executionId: execution.id,
      contextId: "context-plan",
      contextTitle: "Plan",
      conversationId: "conversation-9",
      requestedAt: "2026-06-10T08:59:00.000Z",
    });
    expect(broadcast).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "graph-workflow-boundary",
        boundaryKind: "context_approval",
      }),
    );
    expect(updatedExecution).toHaveLength(2);
    expect(updatedExecution[0]?.occurredAt).toBe("2026-06-10T09:00:00.000Z");
    expect(updatedExecution[0]?.event).toMatchObject({
      type: "graph-workflow-approval-pending",
      contextId: "context-plan",
      conversationId: "conversation-9",
    });
    expect(dispatchPush).toHaveBeenCalledExactlyOnceWith({
      kind: "approval-pending",
      projectName: "repo",
      sessionName: "session-1",
      contextTitle: "Plan",
    });
  });

  it("publishes approval-resolved (approved) with history append and broadcast but no push", () => {
    const broadcast = vi.fn();
    const dispatchPush = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      dispatchPush,
      now: () => "2026-06-10T09:30:00.000Z",
    });

    const execution = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-plan"],
    });

    const updatedExecution = deriveDelivering(
      publisher,
      publisher.publishApprovalResolved({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        execution,
        contextId: "context-plan",
        conversationId: "conversation-9",
        decision: "approved",
        message: null,
        decidedAt: "2026-06-10T09:29:00.000Z",
      }),
    );

    expect(broadcast).toHaveBeenNthCalledWith(1, {
      type: "graph-workflow-approval-resolved",
      projectName: "repo",
      sessionName: "session-1",
      executionId: execution.id,
      contextId: "context-plan",
      conversationId: "conversation-9",
      decision: "approved",
      message: null,
      decidedAt: "2026-06-10T09:29:00.000Z",
    });
    expect(updatedExecution).toHaveLength(1);
    expect(updatedExecution[0]?.occurredAt).toBe("2026-06-10T09:30:00.000Z");
    expect(updatedExecution[0]?.event).toMatchObject({
      type: "graph-workflow-approval-resolved",
      decision: "approved",
    });
    expect(dispatchPush).not.toHaveBeenCalled();
  });

  it("publishes approval-resolved (rejected) with the rejection message in broadcast and history", () => {
    const broadcast = vi.fn();
    const dispatchPush = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      dispatchPush,
      now: () => "2026-06-10T09:45:00.000Z",
    });

    const execution = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-plan"],
    });

    const updatedExecution = deriveDelivering(
      publisher,
      publisher.publishApprovalResolved({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        execution,
        contextId: "context-plan",
        conversationId: "conversation-9",
        decision: "rejected",
        message: "The plan misses the migration step.",
        decidedAt: "2026-06-10T09:44:00.000Z",
      }),
    );

    expect(broadcast).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: "graph-workflow-approval-resolved",
        decision: "rejected",
        message: "The plan misses the migration step.",
      }),
    );
    expect(updatedExecution[0]?.event).toMatchObject({
      type: "graph-workflow-approval-resolved",
      decision: "rejected",
      message: "The plan misses the migration step.",
    });
    expect(dispatchPush).not.toHaveBeenCalled();
  });

  it("publishes user-input-pending carrying execution/context/conversation/batch identity and a schema-valid event-log row (no push)", () => {
    const broadcast = vi.fn();
    const dispatchPush = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      dispatchPush,
      now: () => "2026-06-11T09:00:00.000Z",
    });

    const execution = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-plan"],
    });

    const eventLog = deriveDelivering(
      publisher,
      publisher.publishUserInputPending({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        execution,
        contextId: "context-plan",
        conversationId: "conversation-9",
        questionBatchId: "batch-42",
        requestedAt: "2026-06-11T08:59:00.000Z",
      }),
    );

    expect(broadcast).toHaveBeenNthCalledWith(1, {
      type: "graph-workflow-user-input-pending",
      projectName: "repo",
      sessionName: "session-1",
      executionId: execution.id,
      contextId: "context-plan",
      contextTitle: "Plan",
      conversationId: "conversation-9",
      questionBatchId: "batch-42",
      requestedAt: "2026-06-11T08:59:00.000Z",
    });
    expect(broadcast).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "graph-workflow-boundary",
        boundaryKind: "lane_question",
      }),
    );
    expect(eventLog).toHaveLength(2);
    expect(eventLog[0]?.occurredAt).toBe("2026-06-11T09:00:00.000Z");
    expect(eventLog[0]?.event).toMatchObject({
      type: "graph-workflow-user-input-pending",
      contextId: "context-plan",
      conversationId: "conversation-9",
      questionBatchId: "batch-42",
    });
    // The event-log row must satisfy the persisted event schema so the events
    // repo accepts it (proves the SSE discriminated union was widened).
    expect(() =>
      graphWorkflowExecutionEventSchema.parse(eventLog[0]),
    ).not.toThrow();
    // The existing conversation ask-registration flow already notifies the
    // operator; the workflow publisher must not double-notify with a push.
    expect(dispatchPush).not.toHaveBeenCalled();
  });

  it("publishes user-input-resolved (answered) with broadcast and a schema-valid event-log row but no push", () => {
    const broadcast = vi.fn();
    const dispatchPush = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      dispatchPush,
      now: () => "2026-06-11T09:30:00.000Z",
    });

    const execution = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-plan"],
    });

    const eventLog = deriveDelivering(
      publisher,
      publisher.publishUserInputResolved({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        execution,
        contextId: "context-plan",
        conversationId: "conversation-9",
        questionBatchId: "batch-42",
        resolution: "answered",
        resolvedAt: "2026-06-11T09:29:00.000Z",
      }),
    );

    expect(broadcast).toHaveBeenCalledExactlyOnceWith({
      type: "graph-workflow-user-input-resolved",
      projectName: "repo",
      sessionName: "session-1",
      executionId: execution.id,
      contextId: "context-plan",
      conversationId: "conversation-9",
      questionBatchId: "batch-42",
      resolution: "answered",
      resolvedAt: "2026-06-11T09:29:00.000Z",
    });
    expect(eventLog).toHaveLength(1);
    expect(eventLog[0]?.occurredAt).toBe("2026-06-11T09:30:00.000Z");
    expect(eventLog[0]?.event).toMatchObject({
      type: "graph-workflow-user-input-resolved",
      resolution: "answered",
      questionBatchId: "batch-42",
    });
    expect(() =>
      graphWorkflowExecutionEventSchema.parse(eventLog[0]),
    ).not.toThrow();
    expect(dispatchPush).not.toHaveBeenCalled();
  });

  it("publishes user-input-resolved (withdrawn) distinguishing it from answered", () => {
    const broadcast = vi.fn();
    const dispatchPush = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      dispatchPush,
      now: () => "2026-06-11T09:45:00.000Z",
    });

    const execution = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-plan"],
    });

    const eventLog = deriveDelivering(
      publisher,
      publisher.publishUserInputResolved({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        execution,
        contextId: "context-plan",
        conversationId: "conversation-9",
        questionBatchId: "batch-42",
        resolution: "withdrawn",
        resolvedAt: "2026-06-11T09:44:00.000Z",
      }),
    );

    expect(broadcast).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: "graph-workflow-user-input-resolved",
        resolution: "withdrawn",
        questionBatchId: "batch-42",
      }),
    );
    expect(eventLog[0]?.event).toMatchObject({
      type: "graph-workflow-user-input-resolved",
      resolution: "withdrawn",
    });
    expect(dispatchPush).not.toHaveBeenCalled();
  });

  it("includes derived activeJoinIds in graph-workflow-status events so consumers can render wait state", () => {
    const broadcast = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      now: () => "2026-04-02T08:00:00.000Z",
    });

    const previousExecution = createWorkflowExecution({
      status: "running",
      activeContextIds: [],
      joins: {},
    });
    const nextExecution = createWorkflowExecution({
      ...previousExecution,
      activeContextIds: [],
      joins: {
        "join-running": {
          joinId: "join-running",
          kind: "context_merge",
          contextId: null,
          targetLaneId: "lane-target",
          sourceLaneIds: ["lane-a", "lane-b"],
          mergedSourceLaneIds: ["lane-a"],
          validationDebtSourceLaneIds: [],
          status: "running",
          errorMessage: null,
          conflicts: null,
          conflictGuidance: null,
          createdAt: "2026-04-02T07:59:00.000Z",
          updatedAt: "2026-04-02T08:00:00.000Z",
          completedAt: null,
        },
        "join-pending": {
          joinId: "join-pending",
          kind: "final_publish",
          contextId: null,
          targetLaneId: "__session__",
          sourceLaneIds: ["lane-c"],
          mergedSourceLaneIds: [],
          validationDebtSourceLaneIds: [],
          status: "pending",
          errorMessage: null,
          conflicts: null,
          conflictGuidance: null,
          createdAt: "2026-04-02T07:59:00.000Z",
          updatedAt: "2026-04-02T08:00:00.000Z",
          completedAt: null,
        },
        "join-done": {
          joinId: "join-done",
          kind: "context_merge",
          contextId: null,
          targetLaneId: "lane-x",
          sourceLaneIds: ["lane-y"],
          mergedSourceLaneIds: ["lane-y"],
          validationDebtSourceLaneIds: [],
          status: "succeeded",
          errorMessage: null,
          conflicts: null,
          conflictGuidance: null,
          createdAt: "2026-04-02T07:59:00.000Z",
          updatedAt: "2026-04-02T08:00:00.000Z",
          completedAt: "2026-04-02T08:00:00.000Z",
        },
      },
    });

    deriveDelivering(
      publisher,
      publisher.publishExecutionUpdate({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        previousExecution,
        nextExecution,
      }),
    );

    const statusEvent = broadcast.mock.calls
      .map(([event]) => event)
      .find((e) => e.type === "graph-workflow-status");
    expect(statusEvent).toBeDefined();
    expect(statusEvent!.activeJoinIds.sort()).toEqual(
      ["join-pending", "join-running"].sort(),
    );
  });

  it("broadcasts a charter-registered event and appends it to execution history", () => {
    const broadcast = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      now: () => "2026-06-14T10:00:00.000Z",
    });

    const execution = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-plan"],
    });

    const updatedExecution = deriveDelivering(
      publisher,
      publisher.publishCharterRegistered({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        execution,
        definitionId: "workflow-1",
        definitionRevision: 3,
        charterHash: "sha256:abc123",
      }),
    );

    expect(broadcast).toHaveBeenCalledExactlyOnceWith({
      type: "graph-workflow-charter-registered",
      projectName: "repo",
      sessionName: "session-1",
      executionId: execution.id,
      definitionId: "workflow-1",
      definitionRevision: 3,
      charterHash: "sha256:abc123",
    });

    const [broadcastEvent] = broadcast.mock.calls[0] ?? [];
    expect(
      graphWorkflowCharterRegisteredEventSchema.parse(broadcastEvent),
    ).toMatchObject({
      executionId: execution.id,
      definitionId: "workflow-1",
      definitionRevision: 3,
      charterHash: "sha256:abc123",
    });

    expect(updatedExecution).toHaveLength(1);
    expect(updatedExecution[0]?.occurredAt).toBe("2026-06-14T10:00:00.000Z");
    expect(updatedExecution[0]?.event).toMatchObject({
      type: "graph-workflow-charter-registered",
      executionId: execution.id,
      definitionId: "workflow-1",
      definitionRevision: 3,
      charterHash: "sha256:abc123",
    });
  });

  it("broadcasts a charter-updated event with the active execution id and appends it to history", () => {
    const broadcast = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      now: () => "2026-06-14T11:00:00.000Z",
    });

    const execution = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-plan"],
    });

    const updatedEvents = deriveDelivering(
      publisher,
      publisher.publishCharterUpdated({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        execution,
        definitionId: "workflow-1",
        definitionRevision: 4,
        charterHash: "sha256:def456",
      }),
    );

    expect(broadcast).toHaveBeenCalledExactlyOnceWith({
      type: "graph-workflow-charter-updated",
      projectName: "repo",
      sessionName: "session-1",
      executionId: execution.id,
      definitionId: "workflow-1",
      definitionRevision: 4,
      charterHash: "sha256:def456",
    });
    expect(updatedEvents).toHaveLength(1);
    expect(updatedEvents[0]?.event).toMatchObject({
      type: "graph-workflow-charter-updated",
      executionId: execution.id,
    });
  });

  it("broadcasts a charter-updated event with a null execution id when no execution is active", () => {
    const broadcast = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      now: () => "2026-06-14T12:00:00.000Z",
    });

    const updatedEvents = deriveDelivering(
      publisher,
      publisher.publishCharterUpdated({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        definitionId: "workflow-1",
        definitionRevision: 5,
        charterHash: "sha256:ghi789",
      }),
    );

    const [broadcastEvent] = broadcast.mock.calls[0] ?? [];
    expect(
      graphWorkflowCharterUpdatedEventSchema.parse(broadcastEvent),
    ).toMatchObject({
      executionId: null,
      definitionId: "workflow-1",
      definitionRevision: 5,
      charterHash: "sha256:ghi789",
    });
    // With no active execution there is no execution_id to key events under, so
    // the returned charter-updated event carries a null executionId (the caller
    // does not persist it).
    expect(updatedEvents).toHaveLength(1);
    expect(updatedEvents[0]?.event.type).toBe("graph-workflow-charter-updated");
  });

  it("broadcasts a live-edit-applied event and returns it as an appendable row", () => {
    const broadcast = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      now: () => "2026-04-02T09:00:00.000Z",
    });

    const rows = deriveDelivering(
      publisher,
      publisher.publishLiveEditApplied({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        executionId: "execution-7",
        liveRevision: 5,
        operationCount: 3,
        affectedContextIds: ["verify", "docs"],
        source: "cli",
      }),
    );

    const [broadcastEvent] = broadcast.mock.calls[0] ?? [];
    expect(
      graphWorkflowLiveEditAppliedEventSchema.parse(broadcastEvent),
    ).toEqual({
      type: "graph-workflow-live-edit-applied",
      projectName: "repo",
      sessionName: "session-1",
      executionId: "execution-7",
      liveRevision: 5,
      operationCount: 3,
      affectedContextIds: ["verify", "docs"],
      source: "cli",
    });
    // The rows are returned (not persisted here) so the caller can append them
    // to graph_workflow_events in the same mutation that bumped liveRevision.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.occurredAt).toBe("2026-04-02T09:00:00.000Z");
    expect(rows[0]?.event.type).toBe("graph-workflow-live-edit-applied");
  });

  it("derives a plan-repair round event with an outcome push", () => {
    const publisher = createGraphWorkflowExecutionEventPublisher({
      now: () => "2026-07-30T09:00:00.000Z",
    });

    const delivery = publisher.publishPlanRepairRound({
      projectPath: "/projects/repo",
      sessionName: "session-1",
      executionId: "execution-7",
      contextId: "implement",
      haltType: "circuit_breaker",
      loopGroupId: null,
      attempt: 1,
      outcome: "repaired",
      planningDefect: true,
      diagnosis: "AC referenced a removed endpoint",
      operationCount: 2,
      resumed: true,
      conversationId: "conv-repair-1",
    });

    expect(delivery.events).toHaveLength(1);
    expect(delivery.events[0]?.event).toMatchObject({
      type: "graph-workflow-plan-repair",
      projectName: "repo",
      executionId: "execution-7",
      contextId: "implement",
      outcome: "repaired",
      attempt: 1,
      operationCount: 2,
      resumed: true,
    });
    expect(delivery.pushes).toEqual([
      expect.objectContaining({
        kind: "plan-repair",
        planRepairOutcome: "repaired",
        planRepairAttempt: 1,
      }),
    ]);
  });

  it("suppresses the push for a superseded plan-repair round (audit-only)", () => {
    const publisher = createGraphWorkflowExecutionEventPublisher({
      now: () => "2026-07-30T09:00:00.000Z",
    });

    const delivery = publisher.publishPlanRepairRound({
      projectPath: "/projects/repo",
      sessionName: "session-1",
      executionId: "execution-7",
      contextId: "implement",
      haltType: "max_iterations",
      loopGroupId: null,
      attempt: 1,
      outcome: "superseded",
      planningDefect: true,
      diagnosis: "user resumed underneath the repair",
      operationCount: 0,
      resumed: false,
      conversationId: null,
    });

    expect(delivery.events).toHaveLength(1);
    expect(delivery.events[0]?.event.type).toBe("graph-workflow-plan-repair");
    expect(delivery.pushes).toEqual([]);
  });
});

/**
 * D4 R4.3: a skip is a routing DECISION, so the record of it has to carry the
 * verdicts that produced it. The generic context-status event says only that
 * the context reached `skipped`; the dedicated event is what makes the decision
 * reconstructible from durable events alone.
 */
describe("context-skipped events (D4 R4.3)", () => {
  function skippedExecution(): {
    previousExecution: GraphWorkflowExecution;
    nextExecution: GraphWorkflowExecution;
  } {
    const previousExecution = createWorkflowExecution({ status: "running" });
    const nextExecution = createWorkflowExecution({
      ...previousExecution,
      contextStates: {
        ...previousExecution.contextStates,
        "context-implement": {
          ...previousExecution.contextStates["context-implement"]!,
          status: "skipped",
          skipReason: {
            edgeEvaluations: [
              { edgeId: "edge-plan-implement", verdict: "inactive" },
              { edgeId: "edge-design-implement", verdict: "omitted" },
            ],
            at: "2026-03-28T10:00:00.000Z",
          },
        },
      },
    });
    return { previousExecution, nextExecution };
  }

  it("emits a context-skipped event carrying the evaluated guard verdicts", () => {
    const broadcast = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      now: () => "2026-03-28T10:00:00.000Z",
    });
    const { previousExecution, nextExecution } = skippedExecution();

    const rows = deriveDelivering(
      publisher,
      publisher.publishExecutionUpdate({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        previousExecution,
        nextExecution,
      }),
    );

    const skipped = rows.find(
      (row) => row.event.type === "graph-workflow-context-skipped",
    );
    expect(skipped?.event).toMatchObject({
      type: "graph-workflow-context-skipped",
      projectName: "repo",
      sessionName: "session-1",
      executionId: nextExecution.id,
      contextId: "context-implement",
      edgeEvaluations: [
        { edgeId: "edge-plan-implement", verdict: "inactive" },
        { edgeId: "edge-design-implement", verdict: "omitted" },
      ],
      skippedAt: "2026-03-28T10:00:00.000Z",
    });
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "graph-workflow-context-skipped" }),
    );
  });

  it("emits it once — a later commit that touches the settled context does not re-fire it", () => {
    const publisher = createGraphWorkflowExecutionEventPublisher({
      now: () => "2026-03-28T10:00:00.000Z",
    });
    const { previousExecution, nextExecution } = skippedExecution();

    publisher.publishExecutionUpdate({
      projectPath: "/projects/repo",
      sessionName: "session-1",
      previousExecution,
      nextExecution,
    });

    const followUp = publisher.publishExecutionUpdate({
      projectPath: "/projects/repo",
      sessionName: "session-1",
      previousExecution: nextExecution,
      nextExecution: createWorkflowExecution({
        ...nextExecution,
        status: "completed",
      }),
    });

    expect(
      followUp.events.filter(
        (row) => row.event.type === "graph-workflow-context-skipped",
      ),
    ).toEqual([]);
  });
});

describe("route-resolved events (D4 decision D4)", () => {
  const SETTLEMENT: GraphWorkflowRouteSettlement = {
    sourceContextId: "context-plan",
    effectiveSourceContextId: "context-plan",
    edgeEvaluations: [
      { edgeId: "edge-plan-implement", verdict: "active" },
      { edgeId: "edge-plan-verify", verdict: "inactive" },
    ],
    captureIteration: 1,
    routeControlRevision: 0,
    activatedEdgeIds: ["edge-plan-implement"],
    inactiveEdgeIds: ["edge-plan-verify"],
    omittedEdgeIds: [],
    settledAt: "2026-03-28T10:00:00.000Z",
  };

  function settledExecution(
    overrides: Partial<GraphWorkflowRouteSettlement> = {},
  ): GraphWorkflowExecution {
    return createWorkflowExecution({
      status: "running",
      routeSettlements: {
        "context-plan": { ...SETTLEMENT, ...overrides },
      },
    });
  }

  it("derives the ledger entry from the settlement marker", () => {
    const publisher = createGraphWorkflowExecutionEventPublisher({
      now: () => "2026-03-28T10:00:00.000Z",
    });

    const delivery = publisher.publishExecutionUpdate({
      projectPath: "/projects/repo",
      sessionName: "session-1",
      previousExecution: createWorkflowExecution({ status: "running" }),
      nextExecution: settledExecution(),
    });

    expect(
      delivery.events.find(
        (row) => row.event.type === "graph-workflow-route-resolved",
      )?.event,
    ).toMatchObject({
      type: "graph-workflow-route-resolved",
      projectName: "repo",
      sessionName: "session-1",
      sourceContextId: "context-plan",
      captureIteration: 1,
      routeControlRevision: 0,
      activatedEdgeIds: ["edge-plan-implement"],
      inactiveEdgeIds: ["edge-plan-verify"],
    });
  });

  it("does not re-fire while the dedup key is unchanged", () => {
    const publisher = createGraphWorkflowExecutionEventPublisher({
      now: () => "2026-03-28T10:00:00.000Z",
    });
    const settled = settledExecution();

    const followUp = publisher.publishExecutionUpdate({
      projectPath: "/projects/repo",
      sessionName: "session-1",
      previousExecution: settled,
      // A later commit touching the same execution, settlement untouched.
      nextExecution: createWorkflowExecution({
        ...settled,
        activeContextIds: ["context-implement"],
      }),
    });

    expect(
      followUp.events.filter(
        (row) => row.event.type === "graph-workflow-route-resolved",
      ),
    ).toEqual([]);
  });

  it("fires again when the same capture is re-decided under a bumped route-control revision", () => {
    const publisher = createGraphWorkflowExecutionEventPublisher({
      now: () => "2026-03-28T10:00:00.000Z",
    });

    // The blob keeps ONE marker per source, so the amended re-decision would be
    // invisible if the ledger did not live in the event stream.
    const followUp = publisher.publishExecutionUpdate({
      projectPath: "/projects/repo",
      sessionName: "session-1",
      previousExecution: settledExecution(),
      nextExecution: settledExecution({
        routeControlRevision: 1,
        activatedEdgeIds: ["edge-plan-verify"],
        inactiveEdgeIds: ["edge-plan-implement"],
      }),
    });

    expect(
      followUp.events.find(
        (row) => row.event.type === "graph-workflow-route-resolved",
      )?.event,
    ).toMatchObject({
      routeControlRevision: 1,
      activatedEdgeIds: ["edge-plan-verify"],
    });
  });
});

describe("loop-decision events (D4 R16.2, decision D9)", () => {
  const DECISION: GraphWorkflowLoopDecisionRecord = {
    loopGroupId: "refine",
    pass: 1,
    loopControlRevision: 0,
    templateVersion: 1,
    exitContextId: "refine__p1__judge",
    exitCaptureIteration: 1,
    verdict: "unsatisfied",
    outcome: "materialized",
    nextPass: 2,
    decidedAt: "2026-03-28T10:00:00.000Z",
  };

  function decidedExecution(
    ...decisions: GraphWorkflowLoopDecisionRecord[]
  ): GraphWorkflowExecution {
    return createWorkflowExecution({
      status: "running",
      loopStates: {
        refine: {
          loopGroupId: "refine",
          activation: "running",
          loopControlRevision:
            decisions[decisions.length - 1]?.loopControlRevision ?? 0,
          passCount: decisions.length + 1,
          slotLedger: [],
          boundaryInputs: null,
          decisions: Object.fromEntries(
            decisions.map((decision) => [String(decision.pass), decision]),
          ),
          passTemplateVersions: {},
          concludingExitContextId: null,
          activatedAt: "2026-03-28T10:00:00.000Z",
          settledAt: "2026-03-28T10:00:00.000Z",
        },
      },
    });
  }

  it("derives the ledger entry from the loop's decision marker", () => {
    const publisher = createGraphWorkflowExecutionEventPublisher({
      now: () => "2026-03-28T10:00:00.000Z",
    });

    const delivery = publisher.publishExecutionUpdate({
      projectPath: "/projects/repo",
      sessionName: "session-1",
      previousExecution: createWorkflowExecution({ status: "running" }),
      nextExecution: decidedExecution(DECISION),
    });

    expect(
      delivery.events.find(
        (row) => row.event.type === "graph-workflow-loop-decision",
      )?.event,
    ).toMatchObject({
      type: "graph-workflow-loop-decision",
      projectName: "repo",
      sessionName: "session-1",
      loopGroupId: "refine",
      pass: 1,
      loopControlRevision: 0,
      templateVersion: 1,
      exitContextId: "refine__p1__judge",
      exitCaptureIteration: 1,
      verdict: "unsatisfied",
      outcome: "materialized",
      nextPass: 2,
    });
  });

  it("does not re-fire while the decision's dedup key is unchanged", () => {
    const publisher = createGraphWorkflowExecutionEventPublisher({
      now: () => "2026-03-28T10:00:00.000Z",
    });
    const decided = decidedExecution(DECISION);

    const followUp = publisher.publishExecutionUpdate({
      projectPath: "/projects/repo",
      sessionName: "session-1",
      previousExecution: decided,
      nextExecution: createWorkflowExecution({
        ...decided,
        activeContextIds: ["refine__p2__worker"],
      }),
    });

    expect(
      followUp.events.filter(
        (row) => row.event.type === "graph-workflow-loop-decision",
      ),
    ).toEqual([]);
  });

  it("fires again when a pass is re-decided under a bumped loop-control revision", () => {
    const publisher = createGraphWorkflowExecutionEventPublisher({
      now: () => "2026-03-28T11:00:00.000Z",
    });

    // The blob keeps ONE record per pass, so an amended re-decision of pass 1
    // would be invisible if the ledger did not live in the event stream.
    const followUp = publisher.publishExecutionUpdate({
      projectPath: "/projects/repo",
      sessionName: "session-1",
      previousExecution: decidedExecution(DECISION),
      nextExecution: decidedExecution({
        ...DECISION,
        loopControlRevision: 1,
        verdict: "satisfied",
        outcome: "concluded",
        nextPass: null,
      }),
    });

    expect(
      followUp.events.filter(
        (row) => row.event.type === "graph-workflow-loop-decision",
      ),
    ).toHaveLength(1);
    expect(
      followUp.events.find(
        (row) => row.event.type === "graph-workflow-loop-decision",
      )?.event,
    ).toMatchObject({
      pass: 1,
      loopControlRevision: 1,
      verdict: "satisfied",
      outcome: "concluded",
    });
  });

  it("emits one row per newly decided pass, in pass order", () => {
    const publisher = createGraphWorkflowExecutionEventPublisher({
      now: () => "2026-03-28T12:00:00.000Z",
    });

    const followUp = publisher.publishExecutionUpdate({
      projectPath: "/projects/repo",
      sessionName: "session-1",
      previousExecution: decidedExecution(DECISION),
      nextExecution: decidedExecution(DECISION, {
        ...DECISION,
        pass: 2,
        exitContextId: "refine__p2__judge",
        verdict: "satisfied",
        outcome: "concluded",
        nextPass: null,
      }),
    });

    expect(
      followUp.events
        .filter((row) => row.event.type === "graph-workflow-loop-decision")
        .map((row) =>
          row.event.type === "graph-workflow-loop-decision"
            ? row.event.pass
            : null,
        ),
    ).toEqual([2]);
  });
});

describe("event derivation is pure — delivery is deferred to deliver()", () => {
  it("publishExecutionUpdate derives rows but broadcasts and dispatches push only on deliver()", () => {
    const broadcast = vi.fn();
    const dispatchPush = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      dispatchPush,
      now: () => "2026-07-20T00:00:00.000Z",
    });

    const previousExecution = createWorkflowExecution({ status: "running" });
    const nextExecution = createWorkflowExecution({
      ...previousExecution,
      status: "completed",
    });

    const delivery = publisher.publishExecutionUpdate({
      projectPath: "/projects/repo",
      sessionName: "session-1",
      previousExecution,
      nextExecution,
    });

    // Derivation produced the rows without any external side effect: no client
    // has been told the mutation happened, because the transaction has not yet
    // committed (Design 3.2, post-commit-delivery).
    expect(delivery.events.length).toBeGreaterThan(0);
    expect(broadcast).not.toHaveBeenCalled();
    expect(dispatchPush).not.toHaveBeenCalled();

    publisher.deliver(delivery);

    // deliver() is the ONLY thing that broadcasts + dispatches, and it emits
    // exactly the derived events once.
    expect(broadcast.mock.calls.map(([event]) => event.type)).toEqual(
      delivery.events.map((row) => row.event.type),
    );
    expect(dispatchPush).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "workflow-completed" }),
    );
  });

  it("publishApprovalPending defers both its broadcast and its push to deliver()", () => {
    const broadcast = vi.fn();
    const dispatchPush = vi.fn();
    const publisher = createGraphWorkflowExecutionEventPublisher({
      broadcast,
      dispatchPush,
      now: () => "2026-07-20T00:00:00.000Z",
    });

    const execution = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-plan"],
    });

    const delivery = publisher.publishApprovalPending({
      projectPath: "/projects/repo",
      sessionName: "session-1",
      execution,
      contextId: "context-plan",
      conversationId: "conversation-1",
      requestedAt: "2026-07-20T00:00:00.000Z",
    });

    expect(delivery.events).toHaveLength(2);
    expect(broadcast).not.toHaveBeenCalled();
    expect(dispatchPush).not.toHaveBeenCalled();

    publisher.deliver(delivery);

    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(dispatchPush).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "approval-pending" }),
    );
  });

  describe("delivery-gate halt presentation dedup", () => {
    // The status-event equality contract is "no observable presentation
    // change is suppressed": halt surfaces render refusalCode and the spec
    // block, so a change in either must re-fire even when unmet/instruction
    // are unchanged (a mid-run spec rename must reach the card).
    const baseReason = {
      type: "delivery_gate_failed" as const,
      unmet: [],
      instruction: "Approve delivery in Spec Studio, then resume the merge.",
      refusalCode: "approval_required" as const,
      spec: {
        specSlug: "audit-log",
        specName: "Audit Log",
        projectName: "command-center",
      },
    };

    function statusEventsBetween(
      previousReason:
        | typeof baseReason
        | Omit<typeof baseReason, "refusalCode" | "spec">,
      nextReason:
        | typeof baseReason
        | Omit<typeof baseReason, "refusalCode" | "spec">,
    ) {
      const publisher = createGraphWorkflowExecutionEventPublisher({
        broadcast: vi.fn(),
        now: () => "2026-07-20T00:00:00.000Z",
      });
      const previousExecution = createWorkflowExecution({
        status: "halted",
        haltReason: previousReason,
      });
      const nextExecution = createWorkflowExecution({
        ...previousExecution,
        haltReason: nextReason,
      });
      const delivery = publisher.publishExecutionUpdate({
        projectPath: "/projects/repo",
        sessionName: "session-1",
        previousExecution,
        nextExecution,
      });
      return delivery.events.filter(
        (entry) => entry.event.type === "graph-workflow-status",
      );
    }

    it("suppresses the status event when the full halt presentation is unchanged", () => {
      expect(statusEventsBetween(baseReason, { ...baseReason })).toHaveLength(
        0,
      );
    });

    it("re-fires when refusalCode appears even though unmet and instruction are unchanged", () => {
      const {
        refusalCode: _refusalCode,
        spec: _spec,
        ...withoutPresentation
      } = baseReason;
      expect(statusEventsBetween(withoutPresentation, baseReason)).toHaveLength(
        1,
      );
    });

    it("re-fires when the spec presentation changes, e.g. a mid-run rename", () => {
      expect(
        statusEventsBetween(baseReason, {
          ...baseReason,
          spec: { ...baseReason.spec, specName: "Audit Log v2" },
        }),
      ).toHaveLength(1);
    });
  });
});
