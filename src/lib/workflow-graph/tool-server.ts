import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { AgentAddedTask } from "@/lib/workflow-graph/runtime-edits";
import type { SharedDocumentUpsertInput } from "@/lib/workflow-graph/shared-documents";
import type {
  GraphWorkflowHaltReason,
  ResolvedCollaborationConfig,
  WorkflowCollaborationResult,
} from "@/lib/workflows/schemas";
import {
  type ExecutionLogger,
  getExecutionLogger as defaultGetExecutionLogger,
} from "./execution-logger";
import { IterationHaltedError } from "./iteration-orchestrator";
import {
  buildHaltMessage,
  wrapMcpHandlerWithHaltCheck,
  type GetPendingHaltReasonFn,
} from "./tool-dispatcher";

const logger = createLogger("graph-workflow-tools");

const completeTaskSchema = z.object({
  taskSlug: z
    .string()
    .trim()
    .min(1)
    .describe(
      "The slug of the task to complete, as shown in your iteration prompt (e.g. 'setup-auth-middleware').",
    ),
  summary: z
    .string()
    .trim()
    .min(1)
    .describe(
      "What you changed and how you verified it. Include files modified, tests added or run, and any notable decisions.",
    ),
});

const addTaskSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Kebab-case identifier for the task (e.g. 'add-error-handling'). Auto-generated from title if omitted.",
    ),
  title: z
    .string()
    .trim()
    .min(1)
    .describe("Short, descriptive name for the task."),
  instructions: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Self-contained instructions for the agent that will execute this task. Include what to change, why, which files are involved, and how to verify — the executing agent has no access to your conversation context.",
    ),
});

export const requestCollaborationSchema = z
  .object({
    brief: z
      .string()
      .trim()
      .min(1)
      .describe(
        "The question or decision you want the collaboration partner to weigh in on. State the problem clearly; do not include solution preferences.",
      ),
  })
  .strict();

const sharedDocumentSchema = z.object({
  relativePath: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Path relative to the worktree root where the document lives (e.g. '.cc/graph-workflow-docs/api-contract.md').",
    ),
  description: z
    .string()
    .trim()
    .min(1)
    .describe(
      "What this document contains — used by later agents to decide whether to read it.",
    ),
  readWhen: z
    .string()
    .trim()
    .min(1)
    .describe(
      "When a future agent should read this document (e.g. 'before implementing any API route', 'when modifying the auth module').",
    ),
});

function createValidationErrorResult(message: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Validation error: ${message}. Please correct the tool payload and retry.`,
      },
    ],
    isError: true,
  };
}

function createToolErrorResult(message: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: message,
      },
    ],
    isError: true,
  };
}

function createHaltedToolErrorResult(error: IterationHaltedError) {
  return createToolErrorResult(buildHaltMessage(error.haltReason));
}

function createTextResult(message: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: message,
      },
    ],
  };
}

export interface GraphWorkflowCollaborationContextBlock {
  parentImplementerTurnId: string;
  executionContextId: string;
  conversationId: string;
  executionId: string;
  iterationIndex: number;
  resolveCollaborationConfig(): ResolvedCollaborationConfig;
  startWorkflowCollaboration(args: {
    brief: string;
    resolvedConfig: ResolvedCollaborationConfig;
    parentImplementerTurnId: string;
    executionContextId: string;
    conversationId: string;
    executionId: string;
    iterationIndex: number;
  }): Promise<{
    result: WorkflowCollaborationResult;
    roundsConsumed: number;
  }>;
  setPendingHaltReason(reason: GraphWorkflowHaltReason): Promise<void>;
}

export interface GraphWorkflowToolServerContext {
  executionContextTitle: string;
  allowAgentTaskAdd: boolean;
  allowAgentCollaboration: boolean;
  collaboration?: GraphWorkflowCollaborationContextBlock;
  completeTask(taskId: string, summary: string): Promise<unknown>;
  addTask(task: AgentAddedTask): Promise<unknown>;
  upsertSharedDocument(document: SharedDocumentUpsertInput): Promise<unknown>;
  /**
   * Reads the workflow's persisted `pendingHaltReason`. Production wiring
   * reads from session state via the workflow manager; tests inject a
   * mutable ref. When omitted, halt-check wrapping is a no-op — used in
   * legacy tests that don't exercise the halt contract.
   */
  getPendingHaltReason?: GetPendingHaltReasonFn;
}

const COMPLETE_TASK_DESCRIPTION =
  "Mark the current task as complete. You MUST call this after finishing each task — it is the only way to advance the workflow. A task left without complete_task remains open and blocks progress.";
const UPSERT_SHARED_DOCUMENT_DESCRIPTION =
  "Register or update a shared document so that agents in later workflow iterations can discover and read it. Use this to pass architectural decisions, API contracts, or implementation notes forward to downstream execution contexts.";
const ADD_TASK_DESCRIPTION =
  "Append a new task to the end of this execution context. Use this when you discover necessary work not covered by the existing task list.";

function createCompleteTaskHandler(context: GraphWorkflowToolServerContext) {
  return async (args: unknown) => {
    const parsed = completeTaskSchema.safeParse(args);
    if (!parsed.success) {
      logger.warn("graph-workflow.tool.validation_error", {
        tool: "complete_task",
        error: parsed.error.message,
      });
      return createValidationErrorResult(parsed.error.message);
    }

    logger.info("graph-workflow.tool.complete_task", {
      taskSlug: parsed.data.taskSlug,
      summaryLength: parsed.data.summary.length,
    });

    try {
      await context.completeTask(parsed.data.taskSlug, parsed.data.summary);
      return createTextResult(
        `Task ${parsed.data.taskSlug} was completed and recorded for "${context.executionContextTitle}".`,
      );
    } catch (error) {
      if (error instanceof IterationHaltedError) {
        logger.warn("graph-workflow.tool.complete_task.halted", {
          taskSlug: parsed.data.taskSlug,
          haltReasonType: error.haltReason.type,
        });
        return createHaltedToolErrorResult(error);
      }
      logger.warn("graph-workflow.tool.complete_task.error", {
        taskSlug: parsed.data.taskSlug,
        error: getErrorMessage(error),
      });
      return createToolErrorResult(getErrorMessage(error));
    }
  };
}

function createUpsertSharedDocumentHandler(
  context: GraphWorkflowToolServerContext,
) {
  return async (args: unknown) => {
    const parsed = sharedDocumentSchema.safeParse(args);
    if (!parsed.success) {
      return createValidationErrorResult(parsed.error.message);
    }

    logger.info("graph-workflow.tool.upsert_shared_document", {
      relativePath: parsed.data.relativePath,
    });

    try {
      await context.upsertSharedDocument(parsed.data);
      return createTextResult(
        `Shared document ${parsed.data.relativePath} is available to later workflow iterations.`,
      );
    } catch (error) {
      if (error instanceof IterationHaltedError) {
        logger.warn("graph-workflow.tool.upsert_shared_document.halted", {
          relativePath: parsed.data.relativePath,
          haltReasonType: error.haltReason.type,
        });
        return createHaltedToolErrorResult(error);
      }
      return createToolErrorResult(getErrorMessage(error));
    }
  };
}

function createAddTaskHandler(context: GraphWorkflowToolServerContext) {
  return async (args: unknown) => {
    const parsed = addTaskSchema.safeParse(args);
    if (!parsed.success) {
      return createValidationErrorResult(parsed.error.message);
    }

    logger.info("graph-workflow.tool.add_task", {
      title: parsed.data.title,
      slug: parsed.data.slug,
    });

    try {
      await context.addTask(parsed.data);
      return createTextResult(
        `Queued a new task at the end of execution context "${context.executionContextTitle}".`,
      );
    } catch (error) {
      if (error instanceof IterationHaltedError) {
        logger.warn("graph-workflow.tool.add_task.halted", {
          title: parsed.data.title,
          haltReasonType: error.haltReason.type,
        });
        return createHaltedToolErrorResult(error);
      }
      logger.warn("graph-workflow.tool.add_task.error", {
        title: parsed.data.title,
        error: getErrorMessage(error),
      });
      return createToolErrorResult(getErrorMessage(error));
    }
  };
}

export interface RequestCollaborationHandlerContext {
  executionContextTitle: string;
  parentImplementerTurnId: string;
  executionContextId: string;
  conversationId: string;
  executionId: string;
  iterationIndex: number;
  resolveCollaborationConfig(): ResolvedCollaborationConfig;
  startWorkflowCollaboration(args: {
    brief: string;
    resolvedConfig: ResolvedCollaborationConfig;
    parentImplementerTurnId: string;
    executionContextId: string;
    conversationId: string;
    executionId: string;
    iterationIndex: number;
  }): Promise<{
    result: WorkflowCollaborationResult;
    roundsConsumed: number;
  }>;
  setPendingHaltReason(reason: GraphWorkflowHaltReason): Promise<void>;
}

export interface RequestCollaborationHandlerDeps {
  getExecutionLogger?(executionId: string): ExecutionLogger | null;
}

function buildCollaborationFailureSummary(
  result: WorkflowCollaborationResult,
): string {
  if (result.status === "converged") {
    return "collaboration converged";
  }
  const conflictCount = result.openConflicts.length;
  const plural = conflictCount === 1 ? "conflict" : "conflicts";
  return `collaboration ended with status=${result.status}; ${conflictCount} open ${plural}`;
}

export function createRequestCollaborationHandler(
  context: RequestCollaborationHandlerContext,
  deps?: RequestCollaborationHandlerDeps,
) {
  const getExecutionLogger =
    deps?.getExecutionLogger ?? defaultGetExecutionLogger;

  return async (args: unknown) => {
    const parsed = requestCollaborationSchema.safeParse(args);
    if (!parsed.success) {
      logger.warn("graph-workflow.tool.validation_error", {
        tool: "request_collaboration",
        error: parsed.error.message,
      });
      return createValidationErrorResult(parsed.error.message);
    }

    const { brief } = parsed.data;
    const resolvedConfig = context.resolveCollaborationConfig();
    const executionLogger = getExecutionLogger(context.executionId);

    logger.info("graph-workflow.tool.request_collaboration.invoked", {
      runId: context.executionId,
      executionContextId: context.executionContextId,
      conversationId: context.conversationId,
      parentImplementerTurnId: context.parentImplementerTurnId,
      brief,
      resolvedConfig,
    });

    executionLogger?.task(
      context.executionContextId,
      "collaboration.request_collaboration.invoked",
      {
        parentImplementerTurnId: context.parentImplementerTurnId,
        conversationId: context.conversationId,
        brief,
        resolvedConfig,
      },
    );

    let envelopeOutput: {
      result: WorkflowCollaborationResult;
      roundsConsumed: number;
    };
    try {
      envelopeOutput = await context.startWorkflowCollaboration({
        brief,
        resolvedConfig,
        parentImplementerTurnId: context.parentImplementerTurnId,
        executionContextId: context.executionContextId,
        conversationId: context.conversationId,
        executionId: context.executionId,
        iterationIndex: context.iterationIndex,
      });
    } catch (error) {
      if (error instanceof IterationHaltedError) {
        logger.warn("graph-workflow.tool.request_collaboration.halted", {
          haltReasonType: error.haltReason.type,
        });
        return createHaltedToolErrorResult(error);
      }
      logger.warn("graph-workflow.tool.request_collaboration.error", {
        error: getErrorMessage(error),
      });
      return createToolErrorResult(getErrorMessage(error));
    }

    const { result, roundsConsumed } = envelopeOutput;

    executionLogger?.task(
      context.executionContextId,
      "collaboration.request_collaboration.completed",
      {
        parentImplementerTurnId: context.parentImplementerTurnId,
        conversationId: context.conversationId,
        status: result.status,
        roundsConsumed,
        openConflictsSummary: result.openConflicts,
        resolvedConfig,
      },
    );

    logger.info("graph-workflow.tool.request_collaboration.completed", {
      runId: context.executionId,
      executionContextId: context.executionContextId,
      conversationId: context.conversationId,
      parentImplementerTurnId: context.parentImplementerTurnId,
      status: result.status,
      roundsConsumed,
      openConflictsSummary: result.openConflicts,
      resolvedConfig,
    });

    if (result.status !== "converged") {
      const summary = buildCollaborationFailureSummary(result);
      const haltReason: GraphWorkflowHaltReason = {
        type: "collaboration_failure",
        status: result.status,
        brief,
        executionContextId: context.executionContextId,
        conversationId: context.conversationId,
        summary,
      };
      await context.setPendingHaltReason(haltReason);

      executionLogger?.decision("collaboration.failure_halt", {
        executionContextId: context.executionContextId,
        conversationId: context.conversationId,
        parentImplementerTurnId: context.parentImplementerTurnId,
        status: result.status,
        brief,
        resolvedConfig,
        openConflicts: result.openConflicts,
      });
    }

    return createTextResult(JSON.stringify(result));
  };
}

const REQUEST_COLLABORATION_DESCRIPTION =
  "Request a structured second-opinion collaboration on a design decision. Provide a focused brief that describes the question or trade-off without preferring a solution. The collaboration runs synchronously on this turn and returns a structured result; if collaborators cannot converge, this iteration will halt for human review.";

/**
 * Production wiring of the Same-Turn Tool Dispatch Contract.
 *
 * Every registered tool handler is wrapped with `wrapMcpHandlerWithHaltCheck`
 * so each handler inspects `pendingHaltReason` BEFORE invoking real work.
 * The SDK MCP transport serializes sibling tool_use blocks one request at a
 * time (design §Same-Turn Tool Dispatch Contract), so per-handler
 * pre-dispatch enforcement is the runtime guarantee that R5.3 holds. The
 * `complete_task`, `upsert_shared_document`, `request_collaboration`, and
 * `add_task` registrations below are the production path the contract refers
 * to; `createTurnDispatcher` is the isolated test harness that reproduces
 * the same behavior over a synthetic tool_use[] list.
 */
export function registerGraphWorkflowExecutionTools(
  server: McpServer,
  context: GraphWorkflowToolServerContext,
): void {
  const haltCheck = context.getPendingHaltReason ?? (async () => null);

  server.registerTool(
    "complete_task",
    {
      description: COMPLETE_TASK_DESCRIPTION,
      inputSchema: completeTaskSchema.shape,
    },
    wrapMcpHandlerWithHaltCheck(haltCheck, createCompleteTaskHandler(context)),
  );

  server.registerTool(
    "upsert_shared_document",
    {
      description: UPSERT_SHARED_DOCUMENT_DESCRIPTION,
      inputSchema: sharedDocumentSchema.shape,
    },
    wrapMcpHandlerWithHaltCheck(
      haltCheck,
      createUpsertSharedDocumentHandler(context),
    ),
  );

  if (context.allowAgentCollaboration && context.collaboration) {
    const collaboration = context.collaboration;
    server.registerTool(
      "request_collaboration",
      {
        description: REQUEST_COLLABORATION_DESCRIPTION,
        inputSchema: requestCollaborationSchema.shape,
      },
      wrapMcpHandlerWithHaltCheck(
        haltCheck,
        createRequestCollaborationHandler({
          executionContextTitle: context.executionContextTitle,
          parentImplementerTurnId: collaboration.parentImplementerTurnId,
          executionContextId: collaboration.executionContextId,
          conversationId: collaboration.conversationId,
          executionId: collaboration.executionId,
          iterationIndex: collaboration.iterationIndex,
          resolveCollaborationConfig: collaboration.resolveCollaborationConfig,
          startWorkflowCollaboration: collaboration.startWorkflowCollaboration,
          setPendingHaltReason: collaboration.setPendingHaltReason,
        }),
      ),
    );
  }

  if (!context.allowAgentTaskAdd) {
    return;
  }

  server.registerTool(
    "add_task",
    {
      description: ADD_TASK_DESCRIPTION,
      inputSchema: addTaskSchema.shape,
    },
    wrapMcpHandlerWithHaltCheck(haltCheck, createAddTaskHandler(context)),
  );
}
