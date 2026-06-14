import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getErrorMessage } from "@/lib/shared/errors";
import { createLogger } from "@/lib/logging";
import {
  askQuestionItemSchema,
  type AskQuestionItem,
  type AskQuestionAnswer,
} from "@/lib/conversations/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import {
  conversationRuntimeKey,
  type ConversationRuntimeState,
} from "@/lib/workflows/conversation/runtime-state";

const logger = createLogger("ask-user-question-tool");

const AUTONOMOUS_DENIAL_MESSAGE =
  "Autonomous optimistic mode — make your best judgment and proceed without asking questions.";

export interface AskUserQuestionToolContext {
  projectPath: string;
  sessionName: string;
  conversationId: string;
}

export interface AskUserQuestionToolDeps {
  getRuntime(key: string): ConversationRuntimeState | undefined;
  mutateConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    label: string,
    mutate: (conversation: ConversationState) => void,
  ): Promise<void>;
}

const askUserQuestionInputSchema = {
  questions: z
    .array(askQuestionItemSchema)
    .describe(
      "List of questions to ask the user. Each question has options the user can choose from.",
    ),
};

function textResult(text: string, isError = false) {
  return {
    content: [{ type: "text" as const, text }],
    ...(isError ? { isError: true as const } : {}),
  };
}

async function persistWaitingForInput(
  deps: AskUserQuestionToolDeps,
  context: AskUserQuestionToolContext,
  questionId: string,
  questions: AskQuestionItem[],
): Promise<void> {
  await deps
    .mutateConversation(
      context.projectPath,
      context.sessionName,
      context.conversationId,
      "prompt.setWaitingForInput",
      (c) => {
        c.status = "waiting_for_input";
        c.pendingQuestionId = questionId;
        c.pendingQuestions = questions as typeof c.pendingQuestions;
      },
    )
    .catch((err: unknown) => {
      logger.warn("persist.waiting_for_input.failed", {
        conversationId: context.conversationId,
        error: getErrorMessage(err),
      });
    });
}

async function persistResumeRunning(
  deps: AskUserQuestionToolDeps,
  context: AskUserQuestionToolContext,
): Promise<void> {
  await deps
    .mutateConversation(
      context.projectPath,
      context.sessionName,
      context.conversationId,
      "prompt.resumeRunning",
      (c) => {
        c.status = "running";
        c.pendingQuestionId = null;
        c.pendingQuestions = null;
      },
    )
    .catch((err: unknown) => {
      logger.warn("persist.resume_running.failed", {
        conversationId: context.conversationId,
        error: getErrorMessage(err),
      });
    });
}

function createAskUserQuestionHandler(
  context: AskUserQuestionToolContext,
  deps: AskUserQuestionToolDeps,
) {
  return async (args: { questions: AskQuestionItem[] }) => {
    if (args.questions.length === 0) {
      return textResult(
        "AskUserQuestion requires at least one question.",
        true,
      );
    }

    const key = conversationRuntimeKey(
      context.projectPath,
      context.sessionName,
      context.conversationId,
    );
    const runtime = deps.getRuntime(key);
    if (!runtime) {
      logger.warn("tool.no_runtime", {
        conversationId: context.conversationId,
      });
      return textResult(
        "AskUserQuestion: no active conversation runtime; cannot ask the user.",
        true,
      );
    }

    if (runtime.currentTurnAutonomous === true) {
      return textResult(AUTONOMOUS_DENIAL_MESSAGE, true);
    }

    // Fill a stable id where the agent omitted one, so answers, navigation, and
    // the status rail key off it instead of question text.
    const questions: AskQuestionItem[] = args.questions.map((q, i) => ({
      ...q,
      id: q.id ?? String(i),
    }));

    const questionId = randomUUID();

    runtime.sendToMachine?.({
      type: "ASK_QUESTION",
      questionId,
      questions,
    });

    await persistWaitingForInput(deps, context, questionId, questions);

    runtime.streamEmit?.("ask-question", {
      questionId,
      questions,
    });

    try {
      const answers = await new Promise<Record<string, AskQuestionAnswer>>(
        (resolve, reject) => {
          runtime.activeQuestionResolver = { resolve, reject };
        },
      );
      await persistResumeRunning(deps, context);
      logger.info("tool.answered", {
        conversationId: context.conversationId,
        questionId,
      });
      return textResult(JSON.stringify(answers));
    } catch (err) {
      await persistResumeRunning(deps, context);
      logger.warn("tool.rejected", {
        conversationId: context.conversationId,
        questionId,
        error: getErrorMessage(err),
      });
      return textResult(
        `AskUserQuestion was cancelled: ${getErrorMessage(err)}`,
        true,
      );
    } finally {
      runtime.activeQuestionResolver = undefined;
    }
  };
}

export function registerAskUserQuestionTool(
  server: McpServer,
  context: AskUserQuestionToolContext,
  deps: AskUserQuestionToolDeps,
): void {
  server.registerTool(
    "AskUserQuestion",
    {
      description:
        "Ask the user one or more multiple-choice questions and wait for their answer. Use only when you genuinely need clarification that cannot be inferred. Each question may declare an optional context note (implications & trade-offs), whether it is required, whether a free-text note is allowed, and per-option recommended/tradeoff hints. Returns a JSON object keyed by question id; each value is { selected: string[], note: string | null, skipped: boolean, question?: string }.",
      inputSchema: askUserQuestionInputSchema,
    },
    createAskUserQuestionHandler(context, deps),
  );
}
