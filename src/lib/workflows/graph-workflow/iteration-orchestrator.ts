import { createLogger } from "@/lib/logging";
import { getExecutionLogger } from "@/lib/workflow-graph/execution-logger";
import type {
  ClaudeModel,
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowSharedDocumentEntry,
  GraphWorkflowTaskDefinition,
} from "@/types";
import type {
  ResolveImplementerCallInput,
  ResolvedImplementerCall,
  RecordClaudeLaneTurnInput,
} from "./workflow-continuity-service";
import { buildIterationPrompt, buildFollowUpPrompt } from "./iteration-prompt";
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

export interface IterationOrchestratorContinuityService {
  resolveImplementerCall(
    input: ResolveImplementerCallInput,
  ): Promise<ResolvedImplementerCall>;
  recordClaudeTurnOutcome(
    input: RecordClaudeLaneTurnInput,
  ): GraphWorkflowExecution;
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
  continuityService?: IterationOrchestratorContinuityService;
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
}

export class TaskValidationFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskValidationFailedError";
  }
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

const logger = createLogger("graph-workflow-iteration");

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
    contextState.consecutiveFailureCount = 0;
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
    taskState.failureHistory = [
      ...(taskState.failureHistory ?? []),
      {
        message: input.failureMessage,
        timestamp: getNow(deps),
      },
    ];

    const contextState = nextExecution.contextStates[input.contextId];
    if (contextState) {
      contextState.consecutiveFailureCount =
        (contextState.consecutiveFailureCount ?? 0) + 1;
    }

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

    const execLogger = getExecutionLogger(initialExecution.id);
    execLogger?.iteration(input.contextId, "iteration.started", {
      iterationNumber:
        (initialExecution.contextStates[input.contextId]?.iterationCount ?? 0) +
        1,
      incompleteTaskCount: incompleteTasks.length,
      incompleteTaskIds: incompleteTasks.map((t) => t.id),
      model: context.agent.model,
      reasoningEffort: context.agent.reasoningEffort,
    });
    logger.info("graph-workflow.iteration.started", {
      executionId: initialExecution.id,
      contextId: input.contextId,
      incompleteTaskCount: incompleteTasks.length,
    });

    // Resolve the implementer conversation — continuity service decides reuse vs fresh
    let conversationId: string;
    let executionWithLaneState: GraphWorkflowExecution;
    let promptMode: "iteration_seed" | "follow_up" = "iteration_seed";
    if (deps.continuityService) {
      const resolved = await deps.continuityService.resolveImplementerCall({
        execution: initialExecution,
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        contextId: input.contextId,
      });
      conversationId = resolved.conversationId;
      executionWithLaneState = resolved.execution;
      promptMode = resolved.promptMode;
    } else {
      const conversation = await deps.createConversation(
        input.projectPath,
        input.sessionName,
        { role: "iteration" },
      );
      conversationId = conversation.id;
      executionWithLaneState = initialExecution;
    }

    execLogger?.iteration(input.contextId, "iteration.conversation_resolved", {
      conversationId,
      promptMode,
      sessionAction: deps.continuityService ? "continuity_managed" : "fresh",
    });

    const conversation = { id: conversationId };
    const seededExecution = cloneExecution(executionWithLaneState);
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
        execLogger?.task(input.contextId, "task.completion_attempted", {
          taskId,
          summaryLength: summary.length,
          summaryPreview: summary.slice(0, 200),
        });
        const preValidationExecution = await requireExecution(
          input.projectPath,
          input.sessionName,
        );
        const validation = await validationService.validateTaskCompletion({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          execution: preValidationExecution,
          contextId: input.contextId,
          taskId,
          conversationId: conversation.id,
          summary,
        });

        // Reload after validation to capture any lane state updates the validator runner persisted
        const postValidationExecution = await requireExecution(
          input.projectPath,
          input.sessionName,
        );

        if (!validation.pass) {
          execLogger?.task(input.contextId, "task.validation_failed", {
            taskId,
            feedback: validation.feedback,
            issueCount: validation.issues.length,
          });
          logger.info("graph-workflow.task.validation_failed", {
            executionId: preValidationExecution.id,
            contextId: input.contextId,
            taskId,
          });
          const failedExecution = await markTaskValidationFailed({
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            execution: postValidationExecution,
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
              issues: validation.issues,
              sessionRef: validation.sessionRef,
              reviewArtifact: validation.reviewArtifact,
            });
          await persistExecution(
            input.projectPath,
            input.sessionName,
            executionWithValidationEvent,
          );
          throw new TaskValidationFailedError(validation.feedback);
        }

        execLogger?.task(input.contextId, "task.validation_passed", {
          taskId,
          summary: validation.summary,
        });

        // Publish the passing validation event before marking the task complete so
        // session refs written to execution state remain visible in the history
        const executionWithValidationEvent =
          eventPublisher.publishValidationResult({
            projectPath: input.projectPath,
            sessionName: input.sessionName,
            execution: postValidationExecution,
            contextId: input.contextId,
            validatorType: "task",
            pass: true,
            summary: validation.summary,
            sessionRef: validation.sessionRef,
            reviewArtifact: validation.reviewArtifact,
          });
        await persistExecution(
          input.projectPath,
          input.sessionName,
          executionWithValidationEvent,
        );

        return markTaskCompleted({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          execution: executionWithValidationEvent,
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

      async function recordTurnOutcome(
        agentResult: GraphWorkflowAgentIterationResult,
      ): Promise<void> {
        if (!deps.continuityService) return;
        const current = await requireExecution(
          input.projectPath,
          input.sessionName,
        );
        const updated = deps.continuityService.recordClaudeTurnOutcome({
          execution: current,
          lane: "implementer",
          contextTokens: agentResult.contextTokens,
          contextWindowMax: agentResult.contextWindowMax,
          contextLimitTokens:
            context.iterationPolicy.continuity.contextLimitTokens,
        });
        await persistExecution(input.projectPath, input.sessionName, updated);
      }

      // Initial agent call — seed prompt for fresh sessions, follow-up for resumed sessions
      const initialTasks = getIncompleteTasks(seededExecution, input.contextId);
      const initialPrompt =
        promptMode === "follow_up"
          ? buildFollowUpPrompt({
              remainingTasks: initialTasks,
              taskStates: seededExecution.taskStates,
              attemptNumber: 1,
              maxAttempts: MAX_FOLLOW_UPS,
            })
          : buildIterationPrompt({
              context,
              tasks: initialTasks,
              taskStates: seededExecution.taskStates,
              sharedDocuments: seededExecution.sharedDocuments,
              allowAgentTaskAdd: context.mutability.allowAgentTaskAdd,
              taskValidationInstructions: context.taskValidation?.enabled
                ? context.taskValidation.instructions
                : undefined,
            });

      // Log the prompt sent to the agent
      const iterationNum = seededContextState.iterationCount;
      execLogger?.writePrompt(
        input.contextId,
        promptMode === "follow_up"
          ? `iteration-${iterationNum}-followup-0.md`
          : `iteration-${iterationNum}.md`,
        initialPrompt,
      );
      execLogger?.iteration(input.contextId, "iteration.prompt_sent", {
        promptMode,
        promptLength: initialPrompt.length,
        model: context.agent.model,
        reasoningEffort: context.agent.reasoningEffort,
      });

      let agentResult = await deps.runAgentIteration({
        ...agentCallBase,
        prompt: initialPrompt,
      });
      await recordTurnOutcome(agentResult);

      execLogger?.iteration(input.contextId, "iteration.agent_turn_completed", {
        turnNumber: 0,
        contextTokens: agentResult.contextTokens,
        contextWindowMax: agentResult.contextWindowMax,
      });

      // Follow-up loop: re-message if there are still incomplete tasks
      for (let attempt = 1; attempt <= MAX_FOLLOW_UPS; attempt++) {
        const midExecution = await requireExecution(
          input.projectPath,
          input.sessionName,
        );

        const remaining = getIncompleteTasks(midExecution, input.contextId);
        if (remaining.length === 0) {
          execLogger?.iteration(
            input.contextId,
            "iteration.follow_up_skipped",
            {
              reason: "all_tasks_completed",
              attempt,
            },
          );
          break;
        }

        // Stop if the continuity service has scheduled a rotation due to context limit
        if (deps.continuityService) {
          const laneState = midExecution.laneStates["implementer"];
          if (
            laneState?.engine === "claude" &&
            laneState.rotateBeforeNextTurn
          ) {
            execLogger?.iteration(
              input.contextId,
              "iteration.follow_up_skipped",
              {
                reason: "context_rotation_scheduled",
                attempt,
                remainingTaskCount: remaining.length,
              },
            );
            execLogger?.decision("rotation.caused_follow_up_skip", {
              contextId: input.contextId,
              lane: "implementer",
              remainingTaskCount: remaining.length,
            });
            break;
          }
        }

        const followUpPrompt = buildFollowUpPrompt({
          remainingTasks: remaining,
          taskStates: midExecution.taskStates,
          attemptNumber: attempt,
          maxAttempts: MAX_FOLLOW_UPS,
        });
        execLogger?.writePrompt(
          input.contextId,
          `iteration-${iterationNum}-followup-${attempt}.md`,
          followUpPrompt,
        );
        execLogger?.iteration(input.contextId, "iteration.follow_up_sent", {
          attempt,
          maxAttempts: MAX_FOLLOW_UPS,
          remainingTaskIds: remaining.map((t) => t.id),
        });

        agentResult = await deps.runAgentIteration({
          ...agentCallBase,
          prompt: followUpPrompt,
        });
        await recordTurnOutcome(agentResult);

        execLogger?.iteration(
          input.contextId,
          "iteration.agent_turn_completed",
          {
            turnNumber: attempt,
            contextTokens: agentResult.contextTokens,
            contextWindowMax: agentResult.contextWindowMax,
          },
        );
      }

      emitStreamFrame(input.projectPath, input.sessionName, {
        type: "iteration-boundary",
        conversationId: conversation.id,
        contextId: input.contextId,
        status: "completed",
      });
    } catch (error) {
      if (!(error instanceof TaskValidationFailedError)) {
        throw error;
      }
      execLogger?.iteration(
        input.contextId,
        "iteration.validation_failure_caught",
        { error: error.message },
      );
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
    const completedTaskCount = finalizedContextState.completedTaskCount;
    const shouldContinueInContext = remainingTaskCount > 0;

    execLogger?.iteration(input.contextId, "iteration.completed", {
      conversationId: conversation.id,
      iterationNumber: finalizedContextState.iterationCount,
      completedTaskCount,
      remainingTaskCount,
      shouldContinueInContext,
    });
    logger.info("graph-workflow.iteration.completed", {
      executionId: finalizedExecution.id,
      contextId: input.contextId,
      completedTaskCount,
      remainingTaskCount,
    });

    finalizedContextState.status = shouldContinueInContext
      ? "running"
      : "completed";
    finalizedExecution.activeContextId = shouldContinueInContext
      ? input.contextId
      : null;
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
    };
  }

  return { runIteration };
}
