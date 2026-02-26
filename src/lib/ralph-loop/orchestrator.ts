/**
 * Core orchestrator engine for the Ralph Loop workflow.
 *
 * Runs as a fire-and-forget async function dispatched from the workflow API.
 * For each iteration: create conversation → build prompt → acquire lock →
 * execute SDK query with MCP tools → release lock → capture git diff →
 * record results → evaluate exit conditions → continue or stop.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKSystemMessage,
  Query,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  SessionState,
  RalphLoopWorkflow,
  RalphLoopIterationMeta,
  ReportStatusInput,
  UpdateFixPlanInput,
  MessageContentBlock,
  GitIterationMetrics,
} from "@/types";
import { getSession, updateSession } from "../state";
import { acquireSessionLock } from "../lock";
import { createLogger } from "../logging";
import { createConversation } from "../conversations";
import { appendTranscriptEntry, getTranscriptPath } from "../transcript";
import type { TranscriptEntry } from "../transcript";
import { broadcast } from "../sse-broadcaster";

import { buildIterationPrompt } from "./prompt-builder";
import { createToolServer } from "./mcp-tools";
import { evaluate as evaluateExit, isSuccessfulHalt } from "./exit-detector";
import { processIteration as processCircuitBreaker } from "./circuit-breaker";
import {
  captureSnapshot,
  computeDiff,
  classifyProgress,
} from "./progress-detector";
import { applyFixPlanUpdate, getTaskProgress } from "./fix-plan-manager";
import {
  register as registerOrchestrator,
  get as getOrchestrator,
  remove as removeOrchestrator,
} from "./orchestrator-registry";
import * as workflowStream from "./workflow-stream-registry";

const logger = createLogger("ralph-loop");

// Prevent nested session detection when CSM runs inside Claude Code
delete process.env.CLAUDECODE;

// ============================================================
// Public API
// ============================================================

export interface StartOrchestratorParams {
  projectPath: string;
  session: SessionState;
  workflow: RalphLoopWorkflow;
}

/**
 * Dispatch the orchestrator loop as a fire-and-forget async function.
 * Returns immediately after registering in the orchestrator registry.
 */
export function startOrchestrator(params: StartOrchestratorParams): void {
  const { projectPath, session } = params;
  const sessionName = session.sessionName;
  const projectName = projectPath.split("/").pop() ?? projectPath;

  // Register in the orchestrator registry with a fresh AbortController
  const abortController = new AbortController();
  registerOrchestrator(projectPath, sessionName, {
    projectPath,
    sessionName,
    abortController,
    pauseRequested: false,
  });

  // Fire and forget
  void runLoop(projectPath, sessionName, projectName, abortController).catch(
    (err) => {
      logger.error("orchestrator.fatal", {
        sessionName,
        error: err instanceof Error ? err.message : String(err),
      });
    },
  );
}

// ============================================================
// Core Loop
// ============================================================

async function runLoop(
  projectPath: string,
  sessionName: string,
  projectName: string,
  abortController: AbortController,
): Promise<void> {
  try {
    // Mark workflow as running
    await updateWorkflowStatus(projectPath, sessionName, "running");
    broadcastWorkflowStatus(projectPath, projectName, sessionName);

    // Main iteration loop

    while (true) {
      // Check for pause between iterations
      const entry = getOrchestrator(projectPath, sessionName);
      if (!entry || entry.pauseRequested) {
        await updateWorkflowStatus(projectPath, sessionName, "paused");
        broadcastWorkflowStatus(projectPath, projectName, sessionName);
        break;
      }

      // Check for abort
      if (abortController.signal.aborted) {
        await handleAbort(projectPath, sessionName, projectName);
        break;
      }

      // Read fresh workflow state for this iteration
      const session = await getSession(projectPath, sessionName);
      if (!session?.workflow) {
        logger.error("orchestrator.no_workflow", { sessionName });
        break;
      }

      const workflow = session.workflow;
      const iterationNumber = workflow.iterations.length + 1;

      logger.info("orchestrator.iteration_start", {
        sessionName,
        iterationNumber,
        maxIterations: workflow.config.maxIterations,
      });

      // Run one iteration
      const iterationMeta = await runIteration({
        projectPath,
        sessionName,
        projectName,
        session,
        workflow,
        iterationNumber,
        abortController,
      });

      // Persist iteration results
      await persistIterationResults(
        projectPath,
        sessionName,
        projectName,
        iterationMeta,
      );

      // Evaluate exit conditions
      const freshSession = await getSession(projectPath, sessionName);
      if (!freshSession?.workflow) break;

      const freshWorkflow = freshSession.workflow;
      const exitDecision = evaluateExit({
        fixPlan: freshWorkflow.fixPlan,
        iterations: freshWorkflow.iterations,
        currentIteration: iterationMeta,
        circuitBreakerState: freshWorkflow.circuitBreaker.state,
        config: freshWorkflow.config,
      });

      if (exitDecision.action === "halt") {
        const terminalStatus = isSuccessfulHalt(exitDecision.reason)
          ? "completed"
          : "halted";
        await updateWorkflowHalt(
          projectPath,
          sessionName,
          terminalStatus,
          exitDecision.reason,
        );
        broadcastWorkflowStatus(projectPath, projectName, sessionName);
        workflowStream.emit(projectPath, sessionName, {
          type: "done",
          reason: exitDecision.reason.type,
        });
        workflowStream.closeAll(projectPath, sessionName);
        break;
      }
    }
  } finally {
    removeOrchestrator(projectPath, sessionName);
  }
}

// ============================================================
// Single Iteration
// ============================================================

interface RunIterationParams {
  projectPath: string;
  sessionName: string;
  projectName: string;
  session: SessionState;
  workflow: RalphLoopWorkflow;
  iterationNumber: number;
  abortController: AbortController;
}

async function runIteration(
  params: RunIterationParams,
): Promise<RalphLoopIterationMeta> {
  const {
    projectPath,
    sessionName,
    projectName,
    session,
    workflow,
    iterationNumber,
    abortController,
  } = params;

  const iterationStart = Date.now();

  // Create a managed conversation for this iteration
  const conversation = await createConversation(projectPath, sessionName, {
    role: "iteration",
  });
  const conversationId = conversation.id;

  // Set transcript path eagerly
  const transcriptPath = await getTranscriptPath(conversationId);
  await mutateConversation(projectPath, sessionName, conversationId, (c) => {
    c.transcriptPath = transcriptPath;
    c.status = "running";
  });

  // Broadcast iteration started
  workflowStream.emit(projectPath, sessionName, {
    type: "iteration-boundary",
    iterationNumber,
    status: "started",
  });

  // Capture pre-iteration git snapshot
  const preSnapshot = await captureSnapshot(session.worktreePath);

  // Build the prompt
  const previousContext = buildPreviousContext(workflow);
  const promptText = buildIterationPrompt({
    objective: workflow.objective,
    fixPlan: workflow.fixPlan,
    iterationNumber,
    maxIterations: workflow.config.maxIterations,
    previousIterationContext: previousContext,
  });

  // Set up MCP tool handlers — closures over mutable state
  let statusReport: ReportStatusInput | null = null;
  const taskMutations = {
    completedIds: [] as string[],
    skippedIds: [] as string[],
    addedIds: [] as string[],
  };

  const toolServer = createToolServer({
    projectPath,
    sessionName,
    iterationNumber,
    onStatusReport: (report: ReportStatusInput) => {
      statusReport = report;
    },
    onFixPlanUpdate: async (update: UpdateFixPlanInput) => {
      // Apply mutations to workflow state
      const freshSession = await getSession(projectPath, sessionName);
      if (!freshSession?.workflow) return;

      const result = applyFixPlanUpdate(
        freshSession.workflow.fixPlan,
        update,
        iterationNumber,
      );

      // Persist updated plan
      freshSession.workflow.fixPlan = result.plan;
      await updateSession(projectPath, freshSession);

      taskMutations.completedIds.push(...result.completedIds);
      taskMutations.skippedIds.push(...result.skippedIds);
      taskMutations.addedIds.push(...result.addedIds);

      // Broadcast fix plan update
      try {
        broadcast({
          type: "workflow-fix-plan-updated",
          projectName,
          sessionName,
          fixPlan: result.plan,
          source: "tool",
        });
      } catch {
        // fire-and-forget
      }
    },
  });

  // Track SDK result data
  let resultCostUsd = 0;
  let resultNumTurns = 0;
  let iterationStatus: RalphLoopIterationMeta["status"] = "completed";
  const errors: string[] = [];

  // Create per-iteration AbortController for timeout
  const iterationAbort = new AbortController();
  const timeoutHandle = setTimeout(() => {
    iterationAbort.abort();
  }, workflow.config.iterationTimeoutMs);

  // Link parent abort to iteration abort
  const onParentAbort = () => iterationAbort.abort();
  abortController.signal.addEventListener("abort", onParentAbort);

  let release: (() => void) | null = null;

  try {
    // Acquire session lock
    release = acquireSessionLock(projectPath, sessionName);

    // Persist the user prompt in transcript
    await appendEntry(conversationId, {
      timestamp: new Date().toISOString(),
      type: "user",
      role: "user",
      content: [{ type: "text", text: promptText }],
    });

    // Execute SDK query
    const q: Query = query({
      prompt: promptText,
      options: {
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: `<objective>${workflow.objective}</objective>`,
        },
        settingSources: ["user", "project", "local"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        cwd: session.worktreePath,
        persistSession: false,
        abortController: iterationAbort,
        env: { ...process.env, CLAUDECODE: "" },
        mcpServers: { "ralph-loop": toolServer },
        canUseTool: async (toolName: string) => {
          if (toolName === "AskUserQuestion") {
            return {
              behavior: "deny" as const,
              message:
                "Autonomous iteration — make your best judgment and proceed. Do not ask questions during workflow iterations.",
            };
          }
          return { behavior: "allow" as const, updatedInput: {} };
        },
      },
    });

    // Process SDK messages
    const contentBlocks: MessageContentBlock[] = [];

    try {
      for await (const message of q) {
        await processSDKMessage(
          message,
          conversationId,
          iterationNumber,
          projectPath,
          sessionName,
          contentBlocks,
          (cost, _duration, turns) => {
            resultCostUsd = cost;
            resultNumTurns = turns;
          },
        );
      }
    } catch (err) {
      if (iterationAbort.signal.aborted && !abortController.signal.aborted) {
        // Timeout
        iterationStatus = "timeout";
        errors.push(
          `Iteration timed out after ${workflow.config.iterationTimeoutMs}ms`,
        );
        logger.warn("orchestrator.iteration_timeout", {
          sessionName,
          iterationNumber,
        });
      } else if (abortController.signal.aborted) {
        // User abort
        iterationStatus = "aborted";
        logger.info("orchestrator.iteration_aborted", {
          sessionName,
          iterationNumber,
        });
      } else {
        // SDK error
        iterationStatus = "error";
        const errorMsg = err instanceof Error ? err.message : String(err);
        errors.push(errorMsg);
        logger.error("orchestrator.iteration_error", {
          sessionName,
          iterationNumber,
          error: errorMsg,
        });
      }
    }
  } catch (err) {
    // Lock acquisition or other pre-query failure
    iterationStatus = "error";
    const errorMsg = err instanceof Error ? err.message : String(err);
    errors.push(errorMsg);
    logger.error("orchestrator.iteration_setup_error", {
      sessionName,
      iterationNumber,
      error: errorMsg,
    });
  } finally {
    clearTimeout(timeoutHandle);
    abortController.signal.removeEventListener("abort", onParentAbort);
    if (release) release();

    // Mark conversation as awaiting
    await mutateConversation(projectPath, sessionName, conversationId, (c) => {
      c.status = "awaiting";
    }).catch(() => {});
  }

  // Capture post-iteration git diff
  const gitMetrics = await computeDiff(session.worktreePath, preSnapshot);

  // Classify progress
  const tasksCompletedCount =
    taskMutations.completedIds.length + taskMutations.skippedIds.length;
  const progressResult = classifyProgress(
    gitMetrics,
    statusReport,
    tasksCompletedCount,
  );

  // Broadcast iteration boundary
  workflowStream.emit(projectPath, sessionName, {
    type: "iteration-boundary",
    iterationNumber,
    status: "completed",
  });

  const now = new Date().toISOString();
  const iterationMeta: RalphLoopIterationMeta = {
    iterationNumber,
    conversationId,
    status: iterationStatus,
    startedAt: new Date(iterationStart).toISOString(),
    completedAt: now,
    durationMs: Date.now() - iterationStart,
    costUsd: resultCostUsd,
    turns: resultNumTurns,
    gitMetrics,
    statusReport,
    tasksCompleted: taskMutations.completedIds,
    tasksSkipped: taskMutations.skippedIds,
    tasksAdded: taskMutations.addedIds,
    progressClassification: progressResult,
  };

  return iterationMeta;
}

// ============================================================
// State Persistence
// ============================================================

async function persistIterationResults(
  projectPath: string,
  sessionName: string,
  projectName: string,
  iteration: RalphLoopIterationMeta,
): Promise<void> {
  const session = await getSession(projectPath, sessionName);
  if (!session?.workflow) return;

  const workflow = session.workflow;

  // Add iteration to history
  workflow.iterations.push(iteration);

  // Accumulate totals
  workflow.totalCostUsd += iteration.costUsd;
  workflow.totalDurationMs += iteration.durationMs;

  // Update circuit breaker
  const errorPattern =
    iteration.status === "error" || iteration.status === "timeout"
      ? iteration.status
      : undefined;
  workflow.circuitBreaker = processCircuitBreaker(
    workflow.circuitBreaker,
    {
      classification: iteration.progressClassification,
      errorPattern,
    },
    workflow.config.circuitBreaker,
  );

  session.lastActivityAt = new Date().toISOString();
  await updateSession(projectPath, session);

  // Broadcast events
  try {
    broadcast({
      type: "workflow-iteration-complete",
      projectName,
      sessionName,
      iteration,
    });
  } catch {
    // fire-and-forget
  }

  try {
    broadcast({
      type: "workflow-circuit-breaker",
      projectName,
      sessionName,
      circuitBreaker: workflow.circuitBreaker,
    });
  } catch {
    // fire-and-forget
  }
}

async function updateWorkflowStatus(
  projectPath: string,
  sessionName: string,
  status: RalphLoopWorkflow["status"],
): Promise<void> {
  const session = await getSession(projectPath, sessionName);
  if (!session?.workflow) return;

  session.workflow.status = status;
  if (status === "running" && !session.workflow.startedAt) {
    session.workflow.startedAt = new Date().toISOString();
  }
  session.lastActivityAt = new Date().toISOString();
  await updateSession(projectPath, session);
}

async function updateWorkflowHalt(
  projectPath: string,
  sessionName: string,
  status: "completed" | "halted" | "aborted",
  haltReason: RalphLoopWorkflow["haltReason"],
): Promise<void> {
  const session = await getSession(projectPath, sessionName);
  if (!session?.workflow) return;

  session.workflow.status = status;
  session.workflow.haltReason = haltReason;
  session.workflow.completedAt = new Date().toISOString();
  session.lastActivityAt = new Date().toISOString();
  await updateSession(projectPath, session);
}

async function handleAbort(
  projectPath: string,
  sessionName: string,
  projectName: string,
): Promise<void> {
  await updateWorkflowHalt(projectPath, sessionName, "aborted", {
    type: "aborted",
  });
  broadcastWorkflowStatus(projectPath, projectName, sessionName);
  workflowStream.emit(projectPath, sessionName, {
    type: "done",
    reason: "aborted",
  });
  workflowStream.closeAll(projectPath, sessionName);
}

// ============================================================
// SDK Message Processing
// ============================================================

async function processSDKMessage(
  message: SDKMessage,
  conversationId: string,
  iterationNumber: number,
  projectPath: string,
  sessionName: string,
  contentBlocks: MessageContentBlock[],
  setResultData: (cost: number, duration: number, turns: number) => void,
): Promise<void> {
  const timestamp = new Date().toISOString();

  switch (message.type) {
    case "system": {
      const sysMsg = message as SDKSystemMessage;
      await appendEntry(conversationId, {
        timestamp,
        type: "system",
        raw: { subtype: sysMsg.subtype, session_id: sysMsg.session_id },
      });
      break;
    }

    case "assistant": {
      const asstMsg = message as SDKAssistantMessage;
      const blocks: MessageContentBlock[] = [];

      for (const block of asstMsg.message.content) {
        if (block.type === "text" && "text" in block) {
          const textBlock: MessageContentBlock = {
            type: "text",
            text: block.text,
          };
          blocks.push(textBlock);
          contentBlocks.push(textBlock);
        } else if (block.type === "tool_use" && "name" in block) {
          const toolBlock: MessageContentBlock = {
            type: "tool_use",
            name: block.name,
            input: block.input as Record<string, unknown> | undefined,
          };
          blocks.push(toolBlock);
          contentBlocks.push(toolBlock);
        }
      }

      // Stream content to connected UI clients
      for (const block of blocks) {
        workflowStream.emit(projectPath, sessionName, {
          type: "content",
          iterationNumber,
          content: block,
        });
      }

      await appendEntry(conversationId, {
        timestamp,
        type: "assistant",
        role: "assistant",
        content: blocks,
      });
      break;
    }

    case "user": {
      await appendEntry(conversationId, {
        timestamp,
        type: "tool_result",
        raw: message,
      });
      break;
    }

    case "result": {
      const resultMsg = message as SDKResultSuccess | SDKResultError;
      setResultData(
        resultMsg.total_cost_usd,
        resultMsg.duration_ms,
        resultMsg.num_turns,
      );

      await appendEntry(conversationId, {
        timestamp,
        type: "result",
        raw: resultMsg,
      });
      break;
    }

    default: {
      await appendEntry(conversationId, {
        timestamp,
        type: message.type,
        raw: message,
      });
      break;
    }
  }
}

// ============================================================
// Helpers
// ============================================================

function buildPreviousContext(workflow: RalphLoopWorkflow):
  | {
      statusReport?: ReportStatusInput;
      errors?: string[];
      gitMetrics?: GitIterationMetrics;
    }
  | undefined {
  const lastIteration =
    workflow.iterations.length > 0
      ? workflow.iterations[workflow.iterations.length - 1]
      : undefined;

  if (!lastIteration) return undefined;

  const context: {
    statusReport?: ReportStatusInput;
    errors?: string[];
    gitMetrics?: GitIterationMetrics;
  } = {};

  if (lastIteration.statusReport) {
    context.statusReport = lastIteration.statusReport;
  }

  if (lastIteration.status === "error" || lastIteration.status === "timeout") {
    context.errors = [
      `Previous iteration ${lastIteration.status}: iteration ${lastIteration.iterationNumber}`,
    ];
  }

  if (lastIteration.gitMetrics.filesChanged > 0) {
    context.gitMetrics = lastIteration.gitMetrics;
  }

  return Object.keys(context).length > 0 ? context : undefined;
}

function broadcastWorkflowStatus(
  projectPath: string,
  projectName: string,
  sessionName: string,
): void {
  void (async () => {
    try {
      const session = await getSession(projectPath, sessionName);
      if (!session?.workflow) return;

      const workflow = session.workflow;
      const progress = getTaskProgress(workflow.fixPlan);

      broadcast({
        type: "workflow-status",
        projectName,
        sessionName,
        workflowStatus: workflow.status,
        iterationCount: workflow.iterations.length,
        maxIterations: workflow.config.maxIterations,
        taskProgress: {
          total: progress.total,
          completed: progress.completed,
          skipped: progress.skipped,
          pending: progress.pending,
        },
        haltReason: workflow.haltReason,
      });
    } catch {
      // fire-and-forget
    }
  })();
}

/** Append a transcript entry, logging failures but not throwing */
async function appendEntry(
  conversationId: string,
  entry: TranscriptEntry,
): Promise<void> {
  try {
    await appendTranscriptEntry(conversationId, entry);
  } catch (err) {
    logger.warn("orchestrator.transcript_write_failed", {
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Read a conversation, apply a mutation, and persist via updateSession */
async function mutateConversation(
  projectPath: string,
  sessionName: string,
  conversationId: string,
  mutate: (conversation: import("@/types").ConversationState) => void,
): Promise<void> {
  const session = await getSession(projectPath, sessionName);
  if (!session) return;

  const conversation = session.conversations.find(
    (c) => c.id === conversationId,
  );
  if (!conversation) return;

  mutate(conversation);
  conversation.lastActivityAt = new Date().toISOString();
  session.lastActivityAt = new Date().toISOString();
  await updateSession(projectPath, session);
}
