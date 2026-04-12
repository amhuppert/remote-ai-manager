import { graphWorkflowExecutionSchema } from "@/lib/schemas";
import { createGraphWorkflowExecutionEventPublisher } from "./execution-events";
import { assertNoLegacyWorkflowFields } from "./schema-cutover-guard";
import type {
  GraphWorkflowExecution,
  SessionState,
  WorkflowSemanticDefinition,
} from "@/types";

export interface GraphWorkflowExecutionSeed {
  definition: WorkflowSemanticDefinition;
  definitionId: string;
  definitionRevision: number;
  executionId: string;
  startedAt: string;
}

export interface GraphWorkflowExecutionRepositoryDeps {
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  mutateSession<T = void>(
    projectPath: string,
    sessionName: string,
    label: string,
    mutate: (session: SessionState) => T | Promise<T>,
  ): Promise<T>;
  eventPublisher?: ReturnType<
    typeof createGraphWorkflowExecutionEventPublisher
  >;
}

function createExecutionFromSeed(
  seed: GraphWorkflowExecutionSeed,
): GraphWorkflowExecution {
  assertNoLegacyWorkflowFields(
    seed.definition,
    "Workflow definition (execution start)",
  );
  const contextStates: GraphWorkflowExecution["contextStates"] = {};
  const taskStates: GraphWorkflowExecution["taskStates"] = {};
  const retryState: GraphWorkflowExecution["retryState"] = {};

  for (const context of seed.definition.executionContexts) {
    const totalTaskCount = seed.definition.tasks.filter(
      (task) => task.contextId === context.id,
    ).length;

    contextStates[context.id] = {
      contextId: context.id,
      status: "pending",
      totalTaskCount,
      completedTaskCount: 0,
      iterationCount: 0,
      consecutiveFailureCount: 0,
      lastValidationAt: null,
      lastValidationPass: null,
    };
  }

  for (const task of seed.definition.tasks) {
    taskStates[task.id] = {
      taskId: task.id,
      contextId: task.contextId,
      order: task.order,
      status: "pending",
      summary: null,
      startedAt: null,
      completedAt: null,
      lastConversationId: null,
      reopenedCount: 0,
      lastReopenedAt: null,
      failureMessage: null,
      failureHistory: [],
    };
  }

  return graphWorkflowExecutionSchema.parse({
    id: seed.executionId,
    seedDefinitionId: seed.definitionId,
    seedDefinitionRevision: seed.definitionRevision,
    workingDefinition: seed.definition,
    status: "pending",
    activeContextId: null,
    activeTaskId: null,
    contextStates,
    taskStates,
    retryState,
    sharedDocuments: [],
    machineSnapshot: null,
    history: [],
    startedAt: seed.startedAt,
    completedAt: null,
    haltReason: null,
  });
}

export function createGraphWorkflowExecutionRepository(
  deps: GraphWorkflowExecutionRepositoryDeps,
) {
  const eventPublisher =
    deps.eventPublisher ?? createGraphWorkflowExecutionEventPublisher();

  async function getActive(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null> {
    const session = await deps.getSession(projectPath, sessionName);
    return session?.graphWorkflowExecution ?? null;
  }

  async function create(
    projectPath: string,
    sessionName: string,
    seed: GraphWorkflowExecutionSeed,
  ): Promise<GraphWorkflowExecution> {
    const execution = createExecutionFromSeed(seed);
    let storedExecution = execution;

    await deps.mutateSession(
      projectPath,
      sessionName,
      "graphWorkflowExecution.create",
      (session) => {
        storedExecution = eventPublisher.publishExecutionUpdate({
          projectPath,
          sessionName,
          previousExecution: null,
          nextExecution: execution,
        });
        session.graphWorkflowExecution = storedExecution;
        session.lastActivityAt = seed.startedAt;
      },
    );

    return storedExecution;
  }

  async function update(
    projectPath: string,
    sessionName: string,
    execution: GraphWorkflowExecution,
  ): Promise<void> {
    const parsed = graphWorkflowExecutionSchema.parse(execution);

    await deps.mutateSession(
      projectPath,
      sessionName,
      "graphWorkflowExecution.update",
      (session) => {
        if (!session.graphWorkflowExecution) {
          throw new Error("No active graph workflow execution");
        }

        session.graphWorkflowExecution = eventPublisher.publishExecutionUpdate({
          projectPath,
          sessionName,
          previousExecution: session.graphWorkflowExecution,
          nextExecution: parsed,
        });
        session.lastActivityAt = new Date().toISOString();
      },
    );
  }

  async function archiveActive(
    projectPath: string,
    sessionName: string,
  ): Promise<void> {
    await deps.mutateSession(
      projectPath,
      sessionName,
      "graphWorkflowExecution.archive",
      (session) => {
        if (!session.graphWorkflowExecution) {
          return;
        }

        session.graphWorkflowExecutionHistory.push(
          session.graphWorkflowExecution,
        );
        session.graphWorkflowExecution = null;
        session.lastActivityAt = new Date().toISOString();
      },
    );
  }

  return {
    getActive,
    create,
    update,
    archiveActive,
  };
}
