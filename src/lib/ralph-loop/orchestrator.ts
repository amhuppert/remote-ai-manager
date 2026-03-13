/**
 * Core iteration engine for the Ralph Loop workflow.
 *
 * Provides `runIteration()` (single iteration) and `persistIterationResults()`
 * (state persistence + SSE broadcasts). The XState machine in
 * `src/lib/workflows/ralph-loop/machine.ts` orchestrates the loop lifecycle,
 * invoking these functions via actor-implementations.ts.
 */

import { query as defaultQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKSystemMessage,
  Query,
} from "@anthropic-ai/claude-agent-sdk";
import { buildChildEnv as defaultBuildChildEnv } from "../child-env";
import type {
  SessionState,
  RalphLoopWorkflow,
  RalphLoopIterationMeta,
  ReportStatusInput,
  UpdateFixPlanInput,
  MessageContentBlock,
  GitIterationMetrics,
} from "@/types";
import { mutateSession as defaultMutateSession } from "../state";
import { acquireSessionLock as defaultAcquireSessionLock } from "../lock";
import { getErrorMessage } from "@/lib/errors";
import { createLogger } from "../logging";
import { createConversation as defaultCreateConversation } from "../conversations";
import {
  getTranscriptPath as defaultGetTranscriptPath,
  safeAppendTranscriptEntry as defaultSafeAppendTranscriptEntry,
} from "../transcript";
import { broadcast as defaultBroadcast } from "../sse-broadcaster";
import { TDD_INSTRUCTIONS, CC_CONTEXT } from "../prompt";

import { buildIterationPrompt as defaultBuildIterationPrompt } from "./prompt-builder";
import { createToolServer as defaultCreateToolServer } from "./mcp-tools";
import { processIteration as defaultProcessCircuitBreaker } from "./circuit-breaker";
import {
  captureSnapshot as defaultCaptureSnapshot,
  computeDiff as defaultComputeDiff,
  classifyProgress as defaultClassifyProgress,
} from "./progress-detector";
import { applyFixPlanUpdate as defaultApplyFixPlanUpdate } from "./fix-plan-manager";
import * as defaultWorkflowStream from "./workflow-stream-registry";
import { acquireQuerySlot as defaultAcquireQuerySlot } from "../query-semaphore";

const logger = createLogger("ralph-loop");

// Prevent nested session detection when CC runs inside Claude Code
import "@/lib/sdk-env";

// ============================================================
// Dependency Injection
// ============================================================

export interface OrchestratorDeps {
  query: typeof defaultQuery;
  buildChildEnv: typeof defaultBuildChildEnv;
  mutateSession: typeof defaultMutateSession;
  acquireSessionLock: typeof defaultAcquireSessionLock;
  createConversation: typeof defaultCreateConversation;
  getTranscriptPath: typeof defaultGetTranscriptPath;
  safeAppendTranscriptEntry: typeof defaultSafeAppendTranscriptEntry;
  broadcast: typeof defaultBroadcast;
  buildIterationPrompt: typeof defaultBuildIterationPrompt;
  createToolServer: typeof defaultCreateToolServer;
  processCircuitBreaker: typeof defaultProcessCircuitBreaker;
  captureSnapshot: typeof defaultCaptureSnapshot;
  computeDiff: typeof defaultComputeDiff;
  classifyProgress: typeof defaultClassifyProgress;
  applyFixPlanUpdate: typeof defaultApplyFixPlanUpdate;
  workflowStreamEmit: typeof defaultWorkflowStream.emit;
  acquireQuerySlot: typeof defaultAcquireQuerySlot;
}

const defaultDeps: OrchestratorDeps = {
  query: defaultQuery,
  buildChildEnv: defaultBuildChildEnv,
  mutateSession: defaultMutateSession,
  acquireSessionLock: defaultAcquireSessionLock,
  createConversation: defaultCreateConversation,
  getTranscriptPath: defaultGetTranscriptPath,
  safeAppendTranscriptEntry: defaultSafeAppendTranscriptEntry,
  broadcast: defaultBroadcast,
  buildIterationPrompt: defaultBuildIterationPrompt,
  createToolServer: defaultCreateToolServer,
  processCircuitBreaker: defaultProcessCircuitBreaker,
  captureSnapshot: defaultCaptureSnapshot,
  computeDiff: defaultComputeDiff,
  classifyProgress: defaultClassifyProgress,
  applyFixPlanUpdate: defaultApplyFixPlanUpdate,
  workflowStreamEmit: defaultWorkflowStream.emit,
  acquireQuerySlot: defaultAcquireQuerySlot,
};

/**
 * Create an orchestrator with injected dependencies.
 * Tests use this to inject mocks; production uses the default singleton exports.
 */
export function createOrchestrator(deps: OrchestratorDeps = defaultDeps) {
  return {
    runIteration: (params: RunIterationParams) =>
      runIterationImpl(params, deps),
    persistIterationResults: (
      projectPath: string,
      sessionName: string,
      projectName: string,
      iteration: RalphLoopIterationMeta,
    ) =>
      persistIterationResultsImpl(
        projectPath,
        sessionName,
        projectName,
        iteration,
        deps,
      ),
  };
}

const defaultOrchestrator = createOrchestrator();

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

export const runIteration = defaultOrchestrator.runIteration;
export const persistIterationResults =
  defaultOrchestrator.persistIterationResults;

async function runIterationImpl(
  params: RunIterationParams,
  deps: OrchestratorDeps,
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
  const conversation = await deps.createConversation(projectPath, sessionName, {
    role: "iteration",
  });
  const conversationId = conversation.id;

  // Set transcript path eagerly + expose conversationId on workflow for frontend
  const transcriptPath = await deps.getTranscriptPath(conversationId);
  await deps.mutateSession(
    projectPath,
    sessionName,
    "workflow.conversationSetup",
    (sess) => {
      const conv = sess.conversations.find((c) => c.id === conversationId);
      if (conv) {
        conv.transcriptPath = transcriptPath;
        conv.status = "running";
        conv.lastActivityAt = new Date().toISOString();
      }
      if (sess.workflow) {
        sess.workflow.currentIterationConversationId = conversationId;
      }
    },
  );

  // Broadcast iteration started
  deps.workflowStreamEmit(projectPath, sessionName, {
    type: "iteration-boundary",
    iterationNumber,
    status: "started",
  });

  // Capture pre-iteration git snapshot
  const preSnapshot = await deps.captureSnapshot(session.worktreePath);

  // Build the prompt
  const previousContext = buildPreviousContext(workflow);
  const promptText = deps.buildIterationPrompt({
    objective: workflow.objective,
    fixPlan: workflow.fixPlan,
    references: workflow.references ?? [],
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

  const toolServer = deps.createToolServer({
    projectPath,
    sessionName,
    iterationNumber,
    isWindingDown: () => softLimitReached,
    onStatusReport: (report: ReportStatusInput) => {
      statusReport = report;
    },
    onFixPlanUpdate: async (update: UpdateFixPlanInput) => {
      // Apply mutations inside the lock
      const updatedPlan = await deps.mutateSession(
        projectPath,
        sessionName,
        "workflow.fixPlanUpdate",
        (sess) => {
          if (!sess.workflow) return null;

          const result = deps.applyFixPlanUpdate(
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
          deps.broadcast({
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
    releaseQuerySlot = await deps.acquireQuerySlot(
      `ralph:${sessionName}:iter${iterationNumber}`,
    );

    // Acquire session lock
    release = deps.acquireSessionLock(projectPath, sessionName);

    // Persist the user prompt in transcript
    await deps.safeAppendTranscriptEntry(conversationId, {
      timestamp: new Date().toISOString(),
      type: "user",
      role: "user",
      content: [{ type: "text", text: promptText }],
    });

    // Execute SDK query
    const q: Query = deps.query({
      prompt: promptText,
      options: {
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: [
            CC_CONTEXT,
            `<objective>${workflow.objective}</objective>`,
            session.tddEnabled ? TDD_INSTRUCTIONS : null,
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
        settingSources: ["user", "project", "local"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        cwd: session.worktreePath,
        persistSession: false,
        abortController: iterationAbort,
        env: { ...deps.buildChildEnv(), CLAUDECODE: "" },
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
          deps,
        );

        // Result message is always final — exit the loop immediately.
        // The SDK async generator may not close promptly (e.g., MCP
        // server cleanup keeps it alive), so we must not wait for it.
        if (contextTokens === RESULT_SENTINEL) break;

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

    // Mark conversation as awaiting/archived + clear currentIterationConversationId
    await deps
      .mutateSession(
        projectPath,
        sessionName,
        "workflow.conversationCleanup",
        (sess) => {
          const conv = sess.conversations.find((c) => c.id === conversationId);
          if (conv) {
            conv.status = "awaiting";
            conv.archived = true;
            conv.lastActivityAt = new Date().toISOString();
          }
          if (sess.workflow) {
            sess.workflow.currentIterationConversationId = null;
          }
        },
      )
      .catch(() => {});
  }

  // Capture post-iteration git diff
  const gitMetrics = await deps.computeDiff(session.worktreePath, preSnapshot);

  // Classify progress
  const tasksCompletedCount =
    taskMutations.completedIds.length + taskMutations.skippedIds.length;
  const progressResult = deps.classifyProgress(
    gitMetrics,
    statusReport,
    tasksCompletedCount,
  );

  // Broadcast iteration boundary
  deps.workflowStreamEmit(projectPath, sessionName, {
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

async function persistIterationResultsImpl(
  projectPath: string,
  sessionName: string,
  projectName: string,
  iteration: RalphLoopIterationMeta,
  deps: OrchestratorDeps,
): Promise<void> {
  const circuitBreaker = await deps.mutateSession(
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
      workflow.circuitBreaker = deps.processCircuitBreaker(
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
    deps.broadcast({
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
      deps.broadcast({
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

/** Sentinel value returned by processSDKMessage for result messages to signal loop exit. */
const RESULT_SENTINEL = -1;

async function processSDKMessage(
  message: SDKMessage,
  conversationId: string,
  iterationNumber: number,
  projectPath: string,
  sessionName: string,
  contentBlocks: MessageContentBlock[],
  setResultData: (cost: number, duration: number, turns: number) => void,
  deps: OrchestratorDeps,
): Promise<number> {
  const timestamp = new Date().toISOString();

  switch (message.type) {
    case "system": {
      const sysMsg = message as SDKSystemMessage;
      await deps.safeAppendTranscriptEntry(conversationId, {
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
        deps.workflowStreamEmit(projectPath, sessionName, {
          type: "content",
          iterationNumber,
          content: block,
        });
      }

      await deps.safeAppendTranscriptEntry(conversationId, {
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
      await deps.safeAppendTranscriptEntry(conversationId, {
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

      await deps.safeAppendTranscriptEntry(conversationId, {
        timestamp,
        type: "result",
        raw: resultMsg,
      });
      return RESULT_SENTINEL;
    }

    default: {
      await deps.safeAppendTranscriptEntry(conversationId, {
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
