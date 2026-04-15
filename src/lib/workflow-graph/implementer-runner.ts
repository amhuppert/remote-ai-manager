import { createLogger } from "@/lib/logging";
import {
  executePromptStream as defaultExecutePromptStream,
  type PromptStreamResult,
} from "@/lib/prompt";
import type { GraphWorkflowStreamFrame } from "@/lib/workflow-graph/stream-registry";
import type { MessageContentBlock, SessionState } from "@/types";

const logger = createLogger("graph-workflow-implementer-runner");

interface ExecutePromptStreamFn {
  (
    projectPath: string,
    session: SessionState,
    promptText: string,
    emit: (event: string, data: unknown) => void,
    conversationId?: string,
    modelId?: string,
    images?: never[],
    options?: {
      autonomous?: boolean;
      effort?: string;
      backend?: "claude";
      tooling?: { claudeSdkServers?: Record<string, unknown> };
    },
  ): Promise<PromptStreamResult>;
}

export interface GraphWorkflowImplementerRunnerDeps {
  executePromptStream?: ExecutePromptStreamFn;
}

export interface RunClaudeIterationInput {
  projectPath: string;
  session: SessionState;
  prompt: string;
  conversationId: string;
  contextId: string;
  model: string;
  reasoningEffort: string;
  toolServer: unknown;
  emitStreamFrame?(frame: GraphWorkflowStreamFrame): void;
}

function isMessageContentBlock(value: unknown): value is MessageContentBlock {
  return typeof value === "object" && value !== null && "type" in value;
}

export function createGraphWorkflowImplementerRunner(
  deps: GraphWorkflowImplementerRunnerDeps = {},
) {
  const executePromptStream =
    deps.executePromptStream ?? defaultExecutePromptStream;

  async function runClaudeIteration(input: RunClaudeIterationInput): Promise<{
    contextTokens: number | null;
    contextWindowMax: number | null;
  }> {
    logger.info("graph-workflow.implementer.turn_started", {
      sessionName: input.session.sessionName,
      conversationId: input.conversationId,
      contextId: input.contextId,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
    });

    const result = await executePromptStream(
      input.projectPath,
      input.session,
      input.prompt,
      (event, data) => {
        if (event !== "content" || !isMessageContentBlock(data)) {
          return;
        }

        input.emitStreamFrame?.({
          type: "content",
          conversationId: input.conversationId,
          contextId: input.contextId,
          content: data,
        });
      },
      input.conversationId,
      input.model,
      undefined,
      {
        autonomous: true,
        backend: "claude",
        effort: input.reasoningEffort,
        tooling: {
          claudeSdkServers: {
            "graph-workflow": input.toolServer,
          },
        },
      },
    );

    logger.info("graph-workflow.implementer.turn_completed", {
      sessionName: input.session.sessionName,
      conversationId: input.conversationId,
      contextId: input.contextId,
      contextTokens: result.contextTokens,
      contextWindowMax: result.contextWindowMax,
    });

    return {
      contextTokens: result.contextTokens,
      contextWindowMax: result.contextWindowMax,
    };
  }

  return {
    runClaudeIteration,
  };
}
