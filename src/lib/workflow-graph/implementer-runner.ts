import { createLogger } from "@/lib/logging";
import { getConversation as defaultGetConversation } from "@/lib/conversations";
import {
  executePromptStream as defaultExecutePromptStream,
  type PromptStreamResult,
} from "@/lib/prompt";
import type {
  AgentBackendId,
  AgentSessionRef,
} from "@/lib/agent-backends/types";
import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
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
      backend?: AgentBackendId;
      tooling?: { portableMcp?: PortableMcpConfig };
    },
  ): Promise<PromptStreamResult>;
}

export interface GraphWorkflowImplementerRunnerDeps {
  executePromptStream?: ExecutePromptStreamFn;
  getConversation?: typeof defaultGetConversation;
}

export interface RunIterationInput {
  projectPath: string;
  session: SessionState;
  prompt: string;
  conversationId: string;
  contextId: string;
  backend: AgentBackendId;
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
  const getConversation = deps.getConversation ?? defaultGetConversation;

  async function runIteration(input: RunIterationInput): Promise<{
    conversationId: string;
    contextTokens: number | null;
    contextWindowMax: number | null;
    sessionRef: AgentSessionRef | null;
  }> {
    logger.info("graph-workflow.implementer.turn_started", {
      sessionName: input.session.sessionName,
      conversationId: input.conversationId,
      contextId: input.contextId,
      backend: input.backend,
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
        backend: input.backend,
        effort: input.reasoningEffort,
        tooling: {
          portableMcp: input.toolServer as PortableMcpConfig,
        },
      },
    );

    if (result.error) {
      logger.error("graph-workflow.implementer.turn_failed", {
        sessionName: input.session.sessionName,
        conversationId: input.conversationId,
        contextId: input.contextId,
        backend: input.backend,
        error: result.error,
      });
      throw new Error(`SDK error: ${result.error}`);
    }

    if (result.aborted) {
      logger.warn("graph-workflow.implementer.turn_aborted", {
        sessionName: input.session.sessionName,
        conversationId: input.conversationId,
        contextId: input.contextId,
        backend: input.backend,
      });
      throw new Error("Prompt execution was aborted");
    }

    logger.info("graph-workflow.implementer.turn_completed", {
      sessionName: input.session.sessionName,
      conversationId: input.conversationId,
      contextId: input.contextId,
      contextTokens: result.contextTokens,
      contextWindowMax: result.contextWindowMax,
    });

    const conversation = await getConversation(
      input.projectPath,
      input.session.sessionName,
      result.conversationId,
    );

    return {
      conversationId: result.conversationId,
      contextTokens: result.contextTokens,
      contextWindowMax: result.contextWindowMax,
      sessionRef: conversation?.backendRef ?? null,
    };
  }

  return {
    runIteration,
  };
}
