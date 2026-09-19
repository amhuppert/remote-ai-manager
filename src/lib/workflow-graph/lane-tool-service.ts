/**
 * Lane tool service logic (schemas, context types, collaboration handler) shared by the graph-workflow lane HTTP
 * endpoints in `lane-route-handlers.ts`.
 */

import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { AgentAddedTask } from "@/lib/workflow-graph/runtime-edits";
import type { SharedDocumentUpsertInput } from "@/lib/workflow-graph/shared-documents";
import type { GraphWorkflowHaltReason } from "@/lib/workflow-graph/schemas";
import type { ResolvedCollaborationConfig } from "@/lib/workflow-graph/collaboration-schemas";
import {
  type ExecutionLogger,
  getExecutionLogger as defaultGetExecutionLogger,
} from "./execution-logger";
import type { CompleteTaskResult } from "./execution-tool-context";
import { IterationHaltedError } from "@/lib/workflow-graph/context-outcome";
import {
  buildHaltMessage,
  type GetPendingToolBlockFn,
  type GetPendingHaltReasonFn,
} from "./tool-dispatcher";

const logger = createLogger("graph-workflow-tools");

export const addTaskSchema = z.object({
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
  triggerWorkflowCollaboration(args: {
    brief: string;
    resolvedConfig: ResolvedCollaborationConfig;
    parentImplementerTurnId: string;
    executionContextId: string;
    conversationId: string;
    executionId: string;
    iterationIndex: number;
  }): Promise<{ workflowId: string }>;
  setPendingHaltReason(reason: GraphWorkflowHaltReason): Promise<void>;
}

export interface GraphWorkflowToolServerContext {
  executionContextTitle: string;
  allowAgentTaskAdd: boolean;
  allowAgentCollaboration: boolean;
  collaboration?: GraphWorkflowCollaborationContextBlock;
  completeTask(taskId: string, summary: string): Promise<CompleteTaskResult>;
  addTask(task: AgentAddedTask): Promise<unknown>;
  upsertSharedDocument(document: SharedDocumentUpsertInput): Promise<unknown>;
  /**
   * Reads the workflow's persisted `pendingHaltReason`. Production wiring
   * reads from session state via the workflow manager; tests inject a
   * mutable ref. When omitted, halt-check wrapping is a no-op — used in
   * legacy tests that don't exercise the halt contract.
   */
  getPendingHaltReason?: GetPendingHaltReasonFn;
  getPendingToolBlock?: GetPendingToolBlockFn;
}

export interface RequestCollaborationHandlerContext {
  executionContextTitle: string;
  parentImplementerTurnId: string;
  executionContextId: string;
  conversationId: string;
  executionId: string;
  iterationIndex: number;
  resolveCollaborationConfig(): ResolvedCollaborationConfig;
  triggerWorkflowCollaboration(args: {
    brief: string;
    resolvedConfig: ResolvedCollaborationConfig;
    parentImplementerTurnId: string;
    executionContextId: string;
    conversationId: string;
    executionId: string;
    iterationIndex: number;
  }): Promise<{ workflowId: string }>;
  setPendingHaltReason(reason: GraphWorkflowHaltReason): Promise<void>;
}

export interface RequestCollaborationHandlerDeps {
  getExecutionLogger?(executionId: string): ExecutionLogger | null;
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

    let triggerOutput: { workflowId: string };
    try {
      triggerOutput = await context.triggerWorkflowCollaboration({
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

    const { workflowId } = triggerOutput;

    executionLogger?.task(
      context.executionContextId,
      "collaboration.request_collaboration.started",
      {
        parentImplementerTurnId: context.parentImplementerTurnId,
        conversationId: context.conversationId,
        workflowId,
        brief,
        resolvedConfig,
      },
    );

    logger.info("graph-workflow.tool.request_collaboration.started", {
      runId: context.executionId,
      executionContextId: context.executionContextId,
      conversationId: context.conversationId,
      parentImplementerTurnId: context.parentImplementerTurnId,
      workflowId,
      resolvedConfig,
    });

    return createTextResult(JSON.stringify({ status: "started", workflowId }));
  };
}
