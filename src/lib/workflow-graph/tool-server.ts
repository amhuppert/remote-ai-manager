import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { AgentAddedTask } from "@/lib/workflow-graph/runtime-edits";
import type { SharedDocumentUpsertInput } from "@/lib/workflow-graph/shared-documents";
import { IterationHaltedError } from "./iteration-orchestrator";

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
  const reasonType = error.haltReason.type;
  return createToolErrorResult(
    `Iteration halted (${reasonType}): no further tool calls will be accepted in this iteration.`,
  );
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

export interface GraphWorkflowToolServerContext {
  executionContextTitle: string;
  allowAgentTaskAdd: boolean;
  completeTask(taskId: string, summary: string): Promise<unknown>;
  addTask(task: AgentAddedTask): Promise<unknown>;
  upsertSharedDocument(document: SharedDocumentUpsertInput): Promise<unknown>;
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

export function registerGraphWorkflowExecutionTools(
  server: McpServer,
  context: GraphWorkflowToolServerContext,
): void {
  server.registerTool(
    "complete_task",
    {
      description: COMPLETE_TASK_DESCRIPTION,
      inputSchema: completeTaskSchema.shape,
    },
    createCompleteTaskHandler(context),
  );

  server.registerTool(
    "upsert_shared_document",
    {
      description: UPSERT_SHARED_DOCUMENT_DESCRIPTION,
      inputSchema: sharedDocumentSchema.shape,
    },
    createUpsertSharedDocumentHandler(context),
  );

  if (!context.allowAgentTaskAdd) {
    return;
  }

  server.registerTool(
    "add_task",
    {
      description: ADD_TASK_DESCRIPTION,
      inputSchema: addTaskSchema.shape,
    },
    createAddTaskHandler(context),
  );
}
