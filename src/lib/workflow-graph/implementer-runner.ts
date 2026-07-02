import { createLogger } from "@/lib/logging";
import { getConversation as defaultGetConversation } from "@/lib/conversations/service";
import {
  executePromptStream as defaultExecutePromptStream,
  type PromptStreamResult,
} from "@/lib/prompt/sdk-driver";
import type {
  AgentBackendId,
  AgentSessionRef,
} from "@/lib/agent-backends/types";
import type { BackgroundWaitSummary } from "@/lib/agent-backends/conversation";
import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import type { ExecutionTarget } from "@/lib/workflow-graph/execution-target-resolver";
import type { SessionState } from "@/lib/sessions/schemas";
import { AgentTurnFailedError } from "@/lib/workflow-graph/errors";

function toAgentTurnEngine(backend: AgentBackendId): "claude" | "codex" {
  return backend === "codex" ? "codex" : "claude";
}

const logger = createLogger("graph-workflow-implementer-runner");

/**
 * The implementer turn enters the AgentCall primitive through the conversation
 * actor: `executePromptStream` ensures the conversation/actor exists and
 * dispatches a SUBMIT_PROMPT event, and the actor's `executePromptForMachine`
 * routes the underlying turn through `executeAgentCall` (Task 6.1 migration).
 *
 * Calling `executeAgentCall` from the runner directly would bypass the
 * conversation lifecycle (transcript writing, single-flight session lock,
 * machine-state transitions) that the graph workflow's UI surfaces depend
 * on. The chain is asserted via parity tests in
 * `src/lib/workflows/primitives/section-6-2-graph-debug-parity.test.ts`.
 */

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
      executionTarget?: ExecutionTarget;
      waitForBackgroundTasks?: boolean;
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
  /**
   * When supplied, the iteration runs against this resolved target's
   * worktree and branch instead of `session.worktreePath` /
   * `session.branchName`. Solo-eligible contexts (single eligible context per
   * scheduling tick) leave this undefined, preserving the pre-parallelization
   * behavior of running directly inside the session worktree.
   */
  executionTarget?: ExecutionTarget;
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
    compacted: boolean;
    sessionRef: AgentSessionRef | null;
    backgroundWait?: BackgroundWaitSummary;
  }> {
    logger.info("graph-workflow.implementer.turn_started", {
      sessionName: input.session.sessionName,
      conversationId: input.conversationId,
      contextId: input.contextId,
      backend: input.backend,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
    });

    // Intentionally free-form: no `outputFormat` passed in
    // `PromptStreamOptions`. The implementer is a tool-using coding turn that
    // produces code edits, file writes, and a natural-language summary
    // streamed to the UI as chat content. A JSON schema would suppress the
    // streaming markdown turn body the UI renders.
    const promptOptions: {
      autonomous: boolean;
      backend: AgentBackendId;
      effort: string;
      tooling: { portableMcp: PortableMcpConfig };
      executionTarget?: ExecutionTarget;
      waitForBackgroundTasks: boolean;
    } = {
      autonomous: true,
      backend: input.backend,
      effort: input.reasoningEffort,
      tooling: {
        portableMcp: input.toolServer as PortableMcpConfig,
      },
      // Deterministically opt this implementer turn into holding open for
      // in-flight waitable background tasks. No agent involvement (Req 6.3).
      waitForBackgroundTasks: true,
    };
    if (input.executionTarget !== undefined) {
      promptOptions.executionTarget = input.executionTarget;
    }

    const result = await executePromptStream(
      input.projectPath,
      input.session,
      input.prompt,
      () => {},
      input.conversationId,
      input.model,
      undefined,
      promptOptions,
    );

    if (result.error) {
      logger.error("graph-workflow.implementer.turn_failed", {
        sessionName: input.session.sessionName,
        conversationId: input.conversationId,
        contextId: input.contextId,
        backend: input.backend,
        error: result.error,
      });
      const message = `SDK error: ${result.error}`;
      throw new AgentTurnFailedError(message, {
        contextId: input.contextId,
        engine: toAgentTurnEngine(input.backend),
        cause: "sdk_error",
        originalMessage: result.error,
      });
    }

    if (result.aborted) {
      const timedOut = result.abortReason === "timeout";
      const message =
        timedOut && result.timeoutMs !== undefined
          ? `Prompt execution timed out after ${result.timeoutMs}ms`
          : "Prompt execution was aborted";
      logger.warn("graph-workflow.implementer.turn_aborted", {
        sessionName: input.session.sessionName,
        conversationId: input.conversationId,
        contextId: input.contextId,
        backend: input.backend,
        ...(result.abortReason !== undefined
          ? { abortReason: result.abortReason }
          : {}),
        ...(result.timeoutMs !== undefined
          ? { timeoutMs: result.timeoutMs }
          : {}),
      });
      throw new AgentTurnFailedError(message, {
        contextId: input.contextId,
        engine: toAgentTurnEngine(input.backend),
        cause: timedOut ? "timeout" : "abort",
        originalMessage: message,
      });
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
      compacted: result.compacted,
      sessionRef: conversation?.backendRef ?? null,
      ...(result.backgroundWait !== undefined
        ? { backgroundWait: result.backgroundWait }
        : {}),
    };
  }

  return {
    runIteration,
  };
}
