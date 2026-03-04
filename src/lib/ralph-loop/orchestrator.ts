/**
 * Core iteration engine for the Ralph Loop workflow.
 *
 * Provides `runIteration()` (single iteration) and `persistIterationResults()`
 * (state persistence + SSE broadcasts). The XState machine in
 * `src/lib/workflows/ralph-loop/machine.ts` orchestrates the loop lifecycle,
 * invoking these functions via actor-implementations.ts.
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
import { buildChildEnv } from "../child-env";
import type {
  SessionState,
  RalphLoopWorkflow,
  RalphLoopIterationMeta,
  ReportStatusInput,
  UpdateFixPlanInput,
  MessageContentBlock,
  GitIterationMetrics,
} from "@/types";
import { mutateSession, mutateConversation } from "../state";
import { acquireSessionLock } from "../lock";
import { getErrorMessage } from "@/lib/errors";
import { createLogger } from "../logging";
import { createConversation } from "../conversations";
import { getTranscriptPath } from "../transcript";
import { broadcast } from "../sse-broadcaster";

import { buildIterationPrompt } from "./prompt-builder";
import { createToolServer } from "./mcp-tools";
import { processIteration as processCircuitBreaker } from "./circuit-breaker";
import {
  captureSnapshot,
  computeDiff,
  classifyProgress,
} from "./progress-detector";
import { applyFixPlanUpdate } from "./fix-plan-manager";
import * as workflowStream from "./workflow-stream-registry";
import { acquireQuerySlot } from "../query-semaphore";
import { safeAppendTranscriptEntry } from "../transcript";

const logger = createLogger("ralph-loop");

// Prevent nested session detection when CC runs inside Claude Code
import "@/lib/sdk-env";

// ============================================================
// Single Iteration
// ============================================================

export interface RunIterationParams {
  projectPath: string;
  sessionName: string;
  projectName: string;
  session: SessionState;
  workflow: RalphLoopWorkflow;
  iterationNumber: number;
  abortController: AbortController;
}

export async function runIteration(
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
  await mutateConversation(
    projectPath,
    sessionName,
    conversationId,
    "workflow.conversationSetup",
    (c) => {
      c.transcriptPath = transcriptPath;
      c.status = "running";
    },
  );

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
  let peakContextTokens = 0;
  let softLimitReached = false;
  const taskMutations = {
    completedIds: [] as string[],
    skippedIds: [] as string[],
    addedIds: [] as string[],
  };

  const toolServer = createToolServer({
    projectPath,
    sessionName,
    iterationNumber,
    isWindingDown: () => softLimitReached,
    onStatusReport: (report: ReportStatusInput) => {
      statusReport = report;
    },
    onFixPlanUpdate: async (update: UpdateFixPlanInput) => {
      // Apply mutations inside the lock
      const updatedPlan = await mutateSession(
        projectPath,
        sessionName,
        "workflow.fixPlanUpdate",
        (sess) => {
          if (!sess.workflow) return null;

          const result = applyFixPlanUpdate(
            sess.workflow.fixPlan,
            update,
            iterationNumber,
          );

          sess.workflow.fixPlan = result.plan;

          taskMutations.completedIds.push(...result.completedIds);
          taskMutations.skippedIds.push(...result.skippedIds);
          taskMutations.addedIds.push(...result.addedIds);

          return result.plan;
        },
      );

      // Broadcast fix plan update
      if (updatedPlan) {
        try {
          broadcast({
            type: "workflow-fix-plan-updated",
            projectName,
            sessionName,
            fixPlan: updatedPlan,
            source: "tool",
          });
        } catch {
          // fire-and-forget
        }
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
  let releaseQuerySlot: (() => void) | null = null;

  try {
    // Acquire concurrency slot (waits if at capacity)
    releaseQuerySlot = await acquireQuerySlot(
      `ralph:${sessionName}:iter${iterationNumber}`,
    );

    // Acquire session lock
    release = acquireSessionLock(projectPath, sessionName);

    // Persist the user prompt in transcript
    await safeAppendTranscriptEntry(conversationId, {
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
        env: { ...buildChildEnv(), CLAUDECODE: "" },
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
        const contextTokens = await processSDKMessage(
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

        // Track context token usage from assistant messages
        if (contextTokens > 0) {
          peakContextTokens = Math.max(peakContextTokens, contextTokens);

          // Soft limit — trigger wrap-up warnings in tool responses
          if (
            peakContextTokens >= workflow.config.contextSoftLimitTokens &&
            !softLimitReached
          ) {
            softLimitReached = true;
            logger.info("orchestrator.soft_limit_reached", {
              sessionName,
              iterationNumber,
              peakContextTokens,
              softLimit: workflow.config.contextSoftLimitTokens,
            });
          }

          // Hard limit — force-end the iteration
          if (peakContextTokens >= workflow.config.contextHardLimitTokens) {
            iterationStatus = "context_limit";
            iterationAbort.abort();
            logger.warn("orchestrator.hard_limit_reached", {
              sessionName,
              iterationNumber,
              peakContextTokens,
              hardLimit: workflow.config.contextHardLimitTokens,
            });
          }
        }
      }
    } catch (err) {
      if (iterationAbort.signal.aborted && !abortController.signal.aborted) {
        if (iterationStatus === "context_limit") {
          // Already set by hard limit — keep it
          errors.push(
            `Iteration ended at context limit (${peakContextTokens} tokens)`,
          );
        } else {
          // Timeout
          iterationStatus = "timeout";
          errors.push(
            `Iteration timed out after ${workflow.config.iterationTimeoutMs}ms`,
          );
          logger.warn("orchestrator.iteration_timeout", {
            sessionName,
            iterationNumber,
          });
        }
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
        const errorMsg = getErrorMessage(err);
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
    const errorMsg = getErrorMessage(err);
    errors.push(errorMsg);
    logger.error("orchestrator.iteration_setup_error", {
      sessionName,
      iterationNumber,
      error: errorMsg,
    });
  } finally {
    clearTimeout(timeoutHandle);
    abortController.signal.removeEventListener("abort", onParentAbort);
    if (releaseQuerySlot) releaseQuerySlot();
    if (release) release();

    // Mark conversation as awaiting and archive it so iteration
    // conversations don't clutter the active conversations panel.
    await mutateConversation(
      projectPath,
      sessionName,
      conversationId,
      "workflow.conversationCleanup",
      (c) => {
        c.status = "awaiting";
        c.archived = true;
      },
    ).catch(() => {});
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
    peakContextTokens,
  };

  return iterationMeta;
}

// ============================================================
// State Persistence
// ============================================================

export async function persistIterationResults(
  projectPath: string,
  sessionName: string,
  projectName: string,
  iteration: RalphLoopIterationMeta,
): Promise<void> {
  const circuitBreaker = await mutateSession(
    projectPath,
    sessionName,
    "workflow.iterationComplete",
    (sess) => {
      if (!sess.workflow) return null;

      const workflow = sess.workflow;

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

      return workflow.circuitBreaker;
    },
  );

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

  if (circuitBreaker) {
    try {
      broadcast({
        type: "workflow-circuit-breaker",
        projectName,
        sessionName,
        circuitBreaker,
      });
    } catch {
      // fire-and-forget
    }
  }
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
): Promise<number> {
  const timestamp = new Date().toISOString();

  switch (message.type) {
    case "system": {
      const sysMsg = message as SDKSystemMessage;
      await safeAppendTranscriptEntry(conversationId, {
        timestamp,
        type: "system",
        raw: { subtype: sysMsg.subtype, session_id: sysMsg.session_id },
      });
      return 0;
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

      await safeAppendTranscriptEntry(conversationId, {
        timestamp,
        type: "assistant",
        role: "assistant",
        content: blocks,
      });

      // Extract context token usage for iteration boundary tracking
      const usage = asstMsg.message.usage;
      const contextTokens =
        (usage?.input_tokens ?? 0) +
        (usage?.cache_read_input_tokens ?? 0) +
        (usage?.cache_creation_input_tokens ?? 0);
      return contextTokens;
    }

    case "user": {
      await safeAppendTranscriptEntry(conversationId, {
        timestamp,
        type: "tool_result",
        raw: message,
      });
      return 0;
    }

    case "result": {
      const resultMsg = message as SDKResultSuccess | SDKResultError;
      setResultData(
        resultMsg.total_cost_usd,
        resultMsg.duration_ms,
        resultMsg.num_turns,
      );

      await safeAppendTranscriptEntry(conversationId, {
        timestamp,
        type: "result",
        raw: resultMsg,
      });
      return 0;
    }

    default: {
      await safeAppendTranscriptEntry(conversationId, {
        timestamp,
        type: message.type,
        raw: message,
      });
      return 0;
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
