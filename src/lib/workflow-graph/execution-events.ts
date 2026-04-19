import path from "node:path";
import { broadcast as defaultBroadcast } from "@/lib/sse-broadcaster";
import type {
  GraphWorkflowCircuitBreakerEvent,
  GraphWorkflowExecution,
  GraphWorkflowExecutionEvent,
  GraphWorkflowExecutionSessionRef,
  GraphWorkflowSSEEvent,
  GraphWorkflowSharedDocumentsUpdatedEvent,
  GraphWorkflowStatusEvent,
  GraphWorkflowValidationResultEvent,
  GraphWorkflowValidationReviewArtifact,
  GraphWorkflowValidatorType,
  WorkflowValidatorIssue,
} from "@/types";
import type { AgentSessionRef } from "@/lib/agent-backends/types";

interface PublishExecutionUpdateInput {
  projectPath: string;
  sessionName: string;
  previousExecution: GraphWorkflowExecution | null;
  nextExecution: GraphWorkflowExecution;
}

interface PublishValidationResultInput {
  projectPath: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
  contextId: string;
  validatorType: GraphWorkflowValidatorType;
  pass: boolean;
  summary: string;
  issues?: WorkflowValidatorIssue[];
  reopenTaskIds?: string[];
  sessionRef?: AgentSessionRef | null;
  reviewArtifact?: GraphWorkflowValidationReviewArtifact | null;
}

/**
 * Convert an AgentSessionRef to a GraphWorkflowExecutionSessionRef for event persistence.
 * The lane is set to "context_validator" since validation events are the only consumer.
 */
function toExecutionSessionRef(
  ref: AgentSessionRef | null | undefined,
): GraphWorkflowExecutionSessionRef | null {
  if (!ref) return null;
  if (ref.backend === "claude") {
    return {
      engine: "claude",
      lane: "context_validator",
      conversationId: ref.sessionId,
    };
  }
  return { engine: "codex", lane: "context_validator", threadId: ref.threadId };
}

export interface GraphWorkflowPushInfo {
  kind:
    | "workflow-completed"
    | "workflow-halted"
    | "circuit-breaker"
    | "context-completed";
  projectName: string;
  sessionName: string;
  contextTitle?: string;
  completedContexts?: number;
  totalContexts?: number;
}

export interface GraphWorkflowExecutionEventPublisherDeps {
  broadcast?(event: GraphWorkflowSSEEvent): void;
  now?(): string;
  dispatchPush?(info: GraphWorkflowPushInfo): void;
}

function cloneExecution(
  execution: GraphWorkflowExecution,
): GraphWorkflowExecution {
  return structuredClone(execution);
}

function getNow(deps: GraphWorkflowExecutionEventPublisherDeps): string {
  return deps.now?.() ?? new Date().toISOString();
}

function getProjectName(projectPath: string): string {
  return path.basename(projectPath);
}

function getTaskSource(execution: GraphWorkflowExecution, taskId: string) {
  return execution.workingDefinition.tasks.find((task) => task.id === taskId)
    ?.source;
}

function appendEvents(
  execution: GraphWorkflowExecution,
  occurredAt: string,
  events: GraphWorkflowSSEEvent[],
): GraphWorkflowExecution {
  if (events.length === 0) {
    return execution;
  }

  const nextExecution = cloneExecution(execution);
  nextExecution.history.push(
    ...events.map(
      (event): GraphWorkflowExecutionEvent => ({
        occurredAt,
        event,
        preReset: false,
      }),
    ),
  );
  return nextExecution;
}

function publishEvents(
  deps: GraphWorkflowExecutionEventPublisherDeps,
  events: GraphWorkflowSSEEvent[],
): void {
  const send = deps.broadcast ?? defaultBroadcast;
  for (const event of events) {
    send(event);
  }
}

function dispatchPushNotifications(
  deps: GraphWorkflowExecutionEventPublisherDeps,
  events: GraphWorkflowSSEEvent[],
  input: PublishExecutionUpdateInput,
  nextExecution: GraphWorkflowExecution,
): void {
  if (!deps.dispatchPush) return;

  const projectName = getProjectName(input.projectPath);
  const { sessionName } = input;

  const hasCircuitBreaker = events.some(
    (e) => e.type === "graph-workflow-circuit-breaker",
  );

  for (const event of events) {
    if (event.type === "graph-workflow-status") {
      if (event.workflowStatus === "completed") {
        deps.dispatchPush({
          kind: "workflow-completed",
          projectName,
          sessionName,
        });
      } else if (event.workflowStatus === "halted" && !hasCircuitBreaker) {
        // Circuit-breaker events send their own, more specific push —
        // skip the generic halt push to avoid duplicate notifications.
        deps.dispatchPush({
          kind: "workflow-halted",
          projectName,
          sessionName,
        });
      }
    }

    if (event.type === "graph-workflow-circuit-breaker") {
      const contextDef = nextExecution.workingDefinition.executionContexts.find(
        (c) => c.id === event.contextId,
      );
      deps.dispatchPush({
        kind: "circuit-breaker",
        projectName,
        sessionName,
        contextTitle: contextDef?.title ?? event.contextId,
      });
    }

    if (
      event.type === "graph-workflow-context-status" &&
      event.status === "completed"
    ) {
      const contextDef = nextExecution.workingDefinition.executionContexts.find(
        (c) => c.id === event.contextId,
      );
      const completedContexts = Object.values(
        nextExecution.contextStates,
      ).filter((cs) => cs.status === "completed").length;
      const totalContexts =
        nextExecution.workingDefinition.executionContexts.length;

      deps.dispatchPush({
        kind: "context-completed",
        projectName,
        sessionName,
        contextTitle: contextDef?.title ?? event.contextId,
        completedContexts,
        totalContexts,
      });
    }
  }
}

export function createGraphWorkflowExecutionEventPublisher(
  deps: GraphWorkflowExecutionEventPublisherDeps = {},
) {
  function publishExecutionUpdate(
    input: PublishExecutionUpdateInput,
  ): GraphWorkflowExecution {
    const projectName = getProjectName(input.projectPath);
    const previousExecution = input.previousExecution;
    const nextExecution = input.nextExecution;
    const events: GraphWorkflowSSEEvent[] = [];

    if (
      !previousExecution ||
      previousExecution.status !== nextExecution.status ||
      previousExecution.activeContextId !== nextExecution.activeContextId ||
      JSON.stringify(previousExecution.haltReason) !==
        JSON.stringify(nextExecution.haltReason)
    ) {
      events.push({
        type: "graph-workflow-status",
        projectName,
        sessionName: input.sessionName,
        executionId: nextExecution.id,
        workflowStatus: nextExecution.status,
        activeContextId: nextExecution.activeContextId,
        haltReason: nextExecution.haltReason,
      } satisfies GraphWorkflowStatusEvent);
    }

    for (const context of nextExecution.workingDefinition.executionContexts) {
      const previousContext =
        previousExecution?.contextStates[context.id] ?? null;
      const nextContext = nextExecution.contextStates[context.id];
      if (!nextContext) {
        continue;
      }

      if (
        !previousContext ||
        previousContext.status !== nextContext.status ||
        previousContext.completedTaskCount !== nextContext.completedTaskCount ||
        previousContext.iterationCount !== nextContext.iterationCount
      ) {
        events.push({
          type: "graph-workflow-context-status",
          projectName,
          sessionName: input.sessionName,
          executionId: nextExecution.id,
          contextId: context.id,
          status: nextContext.status,
          remainingTaskCount:
            nextContext.totalTaskCount - nextContext.completedTaskCount,
          iterationCount: nextContext.iterationCount,
        });
      }
    }

    for (const task of nextExecution.workingDefinition.tasks) {
      const previousTask = previousExecution?.taskStates[task.id] ?? null;
      const nextTask = nextExecution.taskStates[task.id];
      if (!nextTask) {
        continue;
      }

      if (
        !previousTask ||
        previousTask.status !== nextTask.status ||
        previousTask.order !== nextTask.order ||
        previousTask.contextId !== nextTask.contextId ||
        previousTask.lastConversationId !== nextTask.lastConversationId ||
        previousTask.startedAt !== nextTask.startedAt ||
        previousTask.completedAt !== nextTask.completedAt ||
        previousTask.summary !== nextTask.summary ||
        previousTask.failureMessage !== nextTask.failureMessage
      ) {
        events.push({
          type: "graph-workflow-task-status",
          projectName,
          sessionName: input.sessionName,
          executionId: nextExecution.id,
          taskId: task.id,
          contextId: nextTask.contextId,
          status: nextTask.status,
          source: getTaskSource(nextExecution, task.id) ?? "user",
          order: nextTask.order,
          lastConversationId: nextTask.lastConversationId,
          startedAt: nextTask.startedAt,
          completedAt: nextTask.completedAt,
          summary: nextTask.summary,
          failureMessage: nextTask.failureMessage,
        });
      }
    }

    const haltReason = nextExecution.haltReason;
    if (haltReason?.type === "circuit_breaker") {
      const previousHaltReason = previousExecution?.haltReason;
      if (
        previousHaltReason?.type !== "circuit_breaker" ||
        previousHaltReason.contextId !== haltReason.contextId ||
        previousHaltReason.failureCount !== haltReason.failureCount
      ) {
        events.push({
          type: "graph-workflow-circuit-breaker",
          projectName,
          sessionName: input.sessionName,
          executionId: nextExecution.id,
          contextId: haltReason.contextId,
          condition: haltReason.condition,
          failureCount:
            haltReason.failureCount ??
            nextExecution.contextStates[haltReason.contextId]
              ?.consecutiveFailureCount ??
            0,
          summary: haltReason.summary ?? null,
        } satisfies GraphWorkflowCircuitBreakerEvent);
      }
    }

    if (
      !previousExecution ||
      JSON.stringify(previousExecution.sharedDocuments) !==
        JSON.stringify(nextExecution.sharedDocuments)
    ) {
      events.push({
        type: "graph-workflow-shared-documents-updated",
        projectName,
        sessionName: input.sessionName,
        executionId: nextExecution.id,
        documents: nextExecution.sharedDocuments,
      } satisfies GraphWorkflowSharedDocumentsUpdatedEvent);
    }

    const occurredAt = getNow(deps);
    publishEvents(deps, events);
    dispatchPushNotifications(deps, events, input, nextExecution);
    return appendEvents(nextExecution, occurredAt, events);
  }

  function publishValidationResult(
    input: PublishValidationResultInput,
  ): GraphWorkflowExecution {
    const event: GraphWorkflowValidationResultEvent = {
      type: "graph-workflow-validation-result",
      projectName: getProjectName(input.projectPath),
      sessionName: input.sessionName,
      executionId: input.execution.id,
      contextId: input.contextId,
      validatorType: input.validatorType,
      pass: input.pass,
      summary: input.summary,
      issues: input.issues ?? [],
      reopenTaskIds: input.reopenTaskIds ?? [],
      sessionRef: toExecutionSessionRef(input.sessionRef),
      reviewArtifact: input.reviewArtifact ?? null,
    };

    publishEvents(deps, [event]);
    return appendEvents(input.execution, getNow(deps), [event]);
  }

  return {
    publishExecutionUpdate,
    publishValidationResult,
  };
}
