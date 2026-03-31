import type {
  ClaudeModel,
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowSharedDocumentEntry,
  GraphWorkflowTaskDefinition,
} from "@/types";
import {
  buildIterationPrompt,
  buildFollowUpPrompt,
  isContextExhausted,
} from "./iteration-prompt";
import {
  createGraphWorkflowValidationService,
  type GraphWorkflowValidationService,
} from "@/lib/workflow-graph/execution-validation";
import { createGraphWorkflowExecutionEventPublisher } from "@/lib/workflow-graph/execution-events";
import {
  emit as defaultEmitStreamFrame,
  type GraphWorkflowStreamFrame,
} from "@/lib/workflow-graph/stream-registry";
import type { GraphWorkflowLifecycleSnapshot } from "./workflow-manager";

export interface GraphWorkflowIterationExecutionRepository {
  getActive(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution | null>;
  update(
    projectPath: string,
    sessionName: string,
    execution: GraphWorkflowExecution,
  ): Promise<void>;
}

export interface GraphWorkflowIterationConversation {
  id: string;
}

export interface GraphWorkflowIterationToolServer {
  server: unknown;
  close?(): Promise<void> | void;
}

export interface GraphWorkflowIterationToolServerInput {
  projectPath: string;
  projectName: string;
  sessionName: string;
  executionId: string;
  conversationId: string;
  contextId: string;
  contextTitle: string;
  allowAgentTaskAdd: boolean;
  sharedDocuments: GraphWorkflowSharedDocumentEntry[];
  completeTask(
    taskId: string,
    summary: string,
  ): Promise<GraphWorkflowExecution>;
}

export interface GraphWorkflowRunAgentIterationInput {
  projectPath: string;
  projectName: string;
  sessionName: string;
  executionId: string;
  conversationId: string;
  contextId: string;
  prompt: string;
  model: ClaudeModel;
  reasoningEffort: GraphWorkflowExecutionContextDefinition["agent"]["reasoningEffort"];
  toolServer: unknown;
  emitStreamFrame?(frame: GraphWorkflowStreamFrame): void;
}

export interface GraphWorkflowAgentIterationResult {
  contextTokens: number | null;
  contextWindowMax: number | null;
}

export interface GraphWorkflowIterationOrchestratorDeps {
  executionRepository: GraphWorkflowIterationExecutionRepository;
  createConversation(
    projectPath: string,
    sessionName: string,
    opts: { role: "iteration" },
  ): Promise<GraphWorkflowIterationConversation>;
  createToolServer(
    input: GraphWorkflowIterationToolServerInput,
  ): GraphWorkflowIterationToolServer;
  runAgentIteration(
    input: GraphWorkflowRunAgentIterationInput,
  ): Promise<GraphWorkflowAgentIterationResult>;
  validationService?: GraphWorkflowValidationService;
  now?(): string;
  emitStreamFrame?(
    projectPath: string,
    sessionName: string,
    frame: GraphWorkflowStreamFrame,
  ): void;
  eventPublisher?: ReturnType<
    typeof createGraphWorkflowExecutionEventPublisher
  >;
}

export interface GraphWorkflowIterationInput {
  projectPath: string;
  projectName: string;
  sessionName: string;
  contextId: string;
}

export interface GraphWorkflowIterationResult {
  conversationId: string;
  execution: GraphWorkflowExecution;
  shouldContinueInContext: boolean;
  shouldValidateContext: boolean;
}

function cloneExecution(
  execution: GraphWorkflowExecution,
): GraphWorkflowExecution {
  return structuredClone(execution);
}

function getNow(deps: GraphWorkflowIterationOrchestratorDeps): string {
  return deps.now?.() ?? new Date().toISOString();
}

function buildMachineSnapshot(
  execution: GraphWorkflowExecution,
  hasLiveIteration: boolean,
): GraphWorkflowLifecycleSnapshot {
  return {
    schemaVersion: 1,
    lifecycleStatus: execution.status,
    activeContextId: execution.activeContextId,
    recoveryMode: "none",
    hasLiveIteration,
  };
}

function getContextDefinition(
  execution: GraphWorkflowExecution,
  contextId: string,
): GraphWorkflowExecutionContextDefinition {
  const context = execution.workingDefinition.executionContexts.find(
    (entry) => entry.id === contextId,
  );
  if (!context) {
    throw new Error(`Execution context "${contextId}" was not found`);
  }

  return context;
}

function getContextTasks(
  execution: GraphWorkflowExecution,
  contextId: string,
): GraphWorkflowTaskDefinition[] {
  return execution.workingDefinition.tasks
    .filter((task) => task.contextId === contextId)
    .sort((left, right) => left.order - right.order);
}

function getIncompleteTasks(
  execution: GraphWorkflowExecution,
  contextId: string,
): GraphWorkflowTaskDefinition[] {
  return getContextTasks(execution, contextId).filter(
    (task) => execution.taskStates[task.id]?.status !== "completed",
  );
}

function countCompletedTasks(
  execution: GraphWorkflowExecution,
  contextId: string,
): number {
  return getContextTasks(execution, contextId).filter(
    (task) => execution.taskStates[task.id]?.status === "completed",
  ).length;
}

function countRemainingTasks(
  execution: GraphWorkflowExecution,
  contextId: string,
): number {
  return getIncompleteTasks(execution, contextId).length;
}

export function createGraphWorkflowIterationOrchestrator(
  deps: GraphWorkflowIterationOrchestratorDeps,
) {
  const validationService =
    deps.validationService ?? createGraphWorkflowValidationService();
  const eventPublisher =
    deps.eventPublisher ?? createGraphWorkflowExecutionEventPublisher();

  function emitStreamFrame(
    projectPath: string,
    sessionName: string,
    frame: GraphWorkflowStreamFrame,
  ): void {
    (deps.emitStreamFrame ?? defaultEmitStreamFrame)(
      projectPath,
      sessionName,
      frame,
    );
  }

  async function requireExecution(
    projectPath: string,
    sessionName: string,
  ): Promise<GraphWorkflowExecution> {
    const execution = await deps.executionRepository.getActive(
      projectPath,
      sessionName,
    );
    if (!execution) {
      throw new Error(
        "Session does not have an active graph workflow execution",
      );
    }

    if (execution.status !== "running") {
      throw new Error(
        "Only running graph workflow executions can run iterations",
      );
    }

    return execution;
  }

  async function persistExecution(
    projectPath: string,
    sessionName: string,
    execution: GraphWorkflowExecution,
  ): Promise<GraphWorkflowExecution> {
    await deps.executionRepository.update(projectPath, sessionName, execution);
    return execution;
  }

  async function markTaskCompleted(input: {
    projectPath: string;
    sessionName: string;
    execution: GraphWorkflowExecution;
    contextId: string;
    taskId: string;
    summary: string;
    conversationId: string;
    completedAt: string;
  }): Promise<GraphWorkflowExecution> {
    const nextExecution = cloneExecution(input.execution);
    const taskState = nextExecution.taskStates[input.taskId];
    if (!taskState) {
      throw new Error(`Task "${input.taskId}" does not exist in runtime state`);
    }

    if (taskState.contextId !== input.contextId) {
      throw new Error(
        `Task "${input.taskId}" does not belong to context "${input.contextId}"`,
      );
    }

    if (taskState.status === "completed") {
      throw new Error(`Task "${input.taskId}" is already completed`);
    }

    const contextState = nextExecution.contextStates[taskState.contextId];
    if (!contextState) {
      throw new Error(
        `Execution context "${taskState.contextId}" does not exist in runtime state`,
      );
    }

    taskState.status = "completed";
    taskState.summary = input.summary;
    taskState.completedAt = input.completedAt;
    taskState.lastConversationId = input.conversationId;
    taskState.failureMessage = null;
    contextState.completedTaskCount = countCompletedTasks(
      nextExecution,
      taskState.contextId,
    );
    nextExecution.machineSnapshot = buildMachineSnapshot(nextExecution, true);

    return persistExecution(
      input.projectPath,
      input.sessionName,
      nextExecution,
    );
  }

  async function markTaskValidationFailed(input: {
    projectPath: string;
    sessionName: string;
    execution: GraphWorkflowExecution;
    contextId: string;
    taskId: string;
    conversationId: string;
    failureMessage: string;
  }): Promise<GraphWorkflowExecution> {
    const nextExecution = cloneExecution(input.execution);
    const taskState = nextExecution.taskStates[input.taskId];
    if (!taskState) {
      throw new Error(`Task "${input.taskId}" does not exist in runtime state`);
    }

    if (taskState.contextId !== input.contextId) {
      throw new Error(
        `Task "${input.taskId}" does not belong to context "${input.contextId}"`,
      );
    }

    taskState.lastConversationId = input.conversationId;
    taskState.failureMessage = input.failureMessage;
    nextExecution.machineSnapshot = buildMachineSnapshot(nextExecution, true);

    return persistExecution(
      input.projectPath,
      input.sessionName,
      nextExecution,
    );
  }

  async function runIteration(
    input: GraphWorkflowIterationInput,
  ): Promise<GraphWorkflowIterationResult> {
    const initialExecution = await requireExecution(
      input.projectPath,
      input.sessionName,
    );
    const context = getContextDefinition(initialExecution, input.contextId);
    const incompleteTasks = getIncompleteTasks(
      initialExecution,
      input.contextId,
    );
    if (incompleteTasks.length === 0) {
      throw new Error(
        `Execution context "${input.contextId}" has no remaining tasks`,
      );
    }

    const conversation = await deps.createConversation(
      input.projectPath,
      input.sessionName,
      { role: "iteration" },
    );

    const seededExecution = cloneExecution(initialExecution);
    const seededContextState = seededExecution.contextStates[input.contextId];
    if (!seededContextState) {
      throw new Error(
        `Execution context "${input.contextId}" does not exist in runtime state`,
      );
    }

    seededExecution.activeContextId = input.contextId;
    seededExecution.completedAt = null;
    seededExecution.haltReason = null;
    seededContextState.status = "running";
    seededContextState.iterationCount += 1;
    seededExecution.machineSnapshot = buildMachineSnapshot(
      seededExecution,
      true,
    );

    await persistExecution(
      input.projectPath,
      input.sessionName,
      seededExecution,
    );

    const toolServer = deps.createToolServer({
      projectPath: input.projectPath,
      projectName: input.projectName,
      sessionName: input.sessionName,
      executionId: seededExecution.id,
      conversationId: conversation.id,
      contextId: input.contextId,
      contextTitle: context.title,
      allowAgentTaskAdd: context.mutability.allowAgentTaskAdd,
      sharedDocuments: seededExecution.sharedDocuments,
      completeTask: async (taskId: string, summary: string) => {
        const currentExecution = await requireExecution(
          input.projectPath,
          input.sessionName,
        );
        const validation = await validationService.validateTaskCompletion({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          execution: currentExecution,
          contextId: input.contextId,
          taskId,
          conversationId: conversation.id,
          summary,
        });

        if (!validation.pass) {
          const failedExecution = await markTaskValidationFailed({
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            execution: currentExecution,
            contextId: input.contextId,
            taskId,
            conversationId: conversation.id,
            failureMessage: validation.feedback,
          });
          const executionWithValidationEvent =
            eventPublisher.publishValidationResult({
              projectPath: input.projectPath,
              sessionName: input.sessionName,
              execution: failedExecution,
              contextId: input.contextId,
              validatorType: "task",
              pass: false,
              summary: validation.feedback,
            });
          await persistExecution(
            input.projectPath,
            input.sessionName,
            executionWithValidationEvent,
          );
          throw new Error(validation.feedback);
        }

        return markTaskCompleted({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          execution: currentExecution,
          contextId: input.contextId,
          taskId,
          summary,
          conversationId: conversation.id,
          completedAt: getNow(deps),
        });
      },
    });

    const MAX_FOLLOW_UPS = 2;

    try {
      emitStreamFrame(input.projectPath, input.sessionName, {
        type: "iteration-boundary",
        conversationId: conversation.id,
        contextId: input.contextId,
        status: "started",
      });

      const agentCallBase = {
        projectPath: input.projectPath,
        projectName: input.projectName,
        sessionName: input.sessionName,
        executionId: seededExecution.id,
        conversationId: conversation.id,
        contextId: input.contextId,
        model: context.agent.model,
        reasoningEffort: context.agent.reasoningEffort,
        toolServer: toolServer.server,
        emitStreamFrame: (frame: GraphWorkflowStreamFrame) =>
          emitStreamFrame(input.projectPath, input.sessionName, frame),
      } as const;

      // Initial agent call with full iteration prompt
      let agentResult = await deps.runAgentIteration({
        ...agentCallBase,
        prompt: buildIterationPrompt({
          context,
          tasks: getIncompleteTasks(seededExecution, input.contextId),
          taskStates: seededExecution.taskStates,
          sharedDocuments: seededExecution.sharedDocuments,
          allowAgentTaskAdd: context.mutability.allowAgentTaskAdd,
        }),
      });

      // Follow-up loop: re-message if there are still incomplete tasks and context has room
      for (let attempt = 1; attempt <= MAX_FOLLOW_UPS; attempt++) {
        const midExecution = await requireExecution(
          input.projectPath,
          input.sessionName,
        );

        const remaining = getIncompleteTasks(midExecution, input.contextId);
        if (remaining.length === 0) break;
        if (isContextExhausted(agentResult)) break;

        agentResult = await deps.runAgentIteration({
          ...agentCallBase,
          prompt: buildFollowUpPrompt({
            remainingTaskIds: remaining.map((t) => t.id),
            attemptNumber: attempt,
            maxAttempts: MAX_FOLLOW_UPS,
          }),
        });
      }

      emitStreamFrame(input.projectPath, input.sessionName, {
        type: "iteration-boundary",
        conversationId: conversation.id,
        contextId: input.contextId,
        status: "completed",
      });
    } finally {
      await toolServer.close?.();
    }

    const currentExecution = await requireExecution(
      input.projectPath,
      input.sessionName,
    );
    const finalizedExecution = cloneExecution(currentExecution);
    const finalizedContextState =
      finalizedExecution.contextStates[input.contextId];
    if (!finalizedContextState) {
      throw new Error(
        `Execution context "${input.contextId}" does not exist in runtime state`,
      );
    }

    finalizedContextState.completedTaskCount = countCompletedTasks(
      finalizedExecution,
      input.contextId,
    );

    const remainingTaskCount = countRemainingTasks(
      finalizedExecution,
      input.contextId,
    );
    const shouldValidateContext = remainingTaskCount === 0;
    const shouldContinueInContext = remainingTaskCount > 0;

    finalizedContextState.status = shouldValidateContext
      ? "validating"
      : "running";
    finalizedExecution.activeContextId = input.contextId;
    finalizedExecution.machineSnapshot = buildMachineSnapshot(
      finalizedExecution,
      false,
    );

    const persistedExecution = await persistExecution(
      input.projectPath,
      input.sessionName,
      finalizedExecution,
    );

    return {
      conversationId: conversation.id,
      execution: persistedExecution,
      shouldContinueInContext,
      shouldValidateContext,
    };
  }

  return { runIteration };
}
