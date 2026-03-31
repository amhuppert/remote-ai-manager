import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getErrorMessage } from "@/lib/errors";
import type { AgentAddedTask } from "@/lib/workflow-graph/runtime-edits";
import type { SharedDocumentUpsertInput } from "@/lib/workflow-graph/shared-documents";

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

export function createGraphWorkflowToolServer(
  context: GraphWorkflowToolServerContext,
): McpSdkServerConfigWithInstance {
  const completeTaskTool = tool(
    "complete_task",
    "Mark the current task as complete. You MUST call this after finishing each task — it is the only way to advance the workflow. A task left without complete_task remains open and blocks progress.",
    completeTaskSchema.shape,
    async (args) => {
      const parsed = completeTaskSchema.safeParse(args);
      if (!parsed.success) {
        return createValidationErrorResult(parsed.error.message);
      }

      try {
        await context.completeTask(parsed.data.taskSlug, parsed.data.summary);
        return createTextResult(
          `Task ${parsed.data.taskSlug} was completed and recorded for "${context.executionContextTitle}".`,
        );
      } catch (error) {
        return createToolErrorResult(getErrorMessage(error));
      }
    },
  );

  const upsertSharedDocumentTool = tool(
    "upsert_shared_document",
    "Register or update a shared document so that agents in later workflow iterations can discover and read it. Use this to pass architectural decisions, API contracts, or implementation notes forward to downstream execution contexts.",
    sharedDocumentSchema.shape,
    async (args) => {
      const parsed = sharedDocumentSchema.safeParse(args);
      if (!parsed.success) {
        return createValidationErrorResult(parsed.error.message);
      }

      try {
        await context.upsertSharedDocument(parsed.data);
        return createTextResult(
          `Shared document ${parsed.data.relativePath} is available to later workflow iterations.`,
        );
      } catch (error) {
        return createToolErrorResult(getErrorMessage(error));
      }
    },
  );

  const addTaskTool = tool(
    "add_task",
    "Append a new task to the end of this execution context. Use this when you discover necessary work not covered by the existing task list.",
    addTaskSchema.shape,
    async (args) => {
      const parsed = addTaskSchema.safeParse(args);
      if (!parsed.success) {
        return createValidationErrorResult(parsed.error.message);
      }

      try {
        await context.addTask(parsed.data);
        return createTextResult(
          `Queued a new task at the end of execution context "${context.executionContextTitle}".`,
        );
      } catch (error) {
        return createToolErrorResult(getErrorMessage(error));
      }
    },
  );

  return createSdkMcpServer({
    name: "graph-workflow",
    version: "1.0.0",
    tools: context.allowAgentTaskAdd
      ? [completeTaskTool, upsertSharedDocumentTool, addTaskTool]
      : [completeTaskTool, upsertSharedDocumentTool],
  });
}
