import path from "node:path";
import { broadcast as defaultBroadcast } from "@/lib/sse-broadcaster";
import type {
  GraphWorkflowCircuitBreakerEvent,
  GraphWorkflowExecution,
  GraphWorkflowExecutionEvent,
  GraphWorkflowSSEEvent,
  GraphWorkflowSharedDocumentsUpdatedEvent,
  GraphWorkflowStatusEvent,
  GraphWorkflowValidationResultEvent,
  GraphWorkflowValidatorType,
  WorkflowValidatorIssue,
} from "@/types";

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
}

export interface GraphWorkflowExecutionEventPublisherDeps {
  broadcast?(event: GraphWorkflowSSEEvent): void;
  now?(): string;
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
        previousContext.iterationCount !== nextContext.iterationCount ||
        previousContext.lastValidationAt !== nextContext.lastValidationAt ||
        previousContext.lastValidationPass !== nextContext.lastValidationPass
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
        previousTask.contextId !== nextTask.contextId
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
        });
      }
    }

    for (const context of nextExecution.workingDefinition.executionContexts) {
      const previousRetry = previousExecution?.retryState[context.id] ?? null;
      const nextRetry = nextExecution.retryState[context.id];
      if (!nextRetry) {
        continue;
      }

      if (
        nextRetry.attempt > 0 &&
        (!previousRetry || previousRetry.attempt !== nextRetry.attempt)
      ) {
        events.push({
          type: "graph-workflow-retry",
          projectName,
          sessionName: input.sessionName,
          executionId: nextExecution.id,
          contextId: context.id,
          attempt: nextRetry.attempt,
          maxAttempts: nextRetry.maxAttempts,
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
    };

    publishEvents(deps, [event]);
    return appendEvents(input.execution, getNow(deps), [event]);
  }

  return {
    publishExecutionUpdate,
    publishValidationResult,
  };
}
