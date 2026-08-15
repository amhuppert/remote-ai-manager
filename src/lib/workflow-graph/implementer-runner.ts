import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import { mintImplementerLaneCapability as defaultMintImplementerLaneCapability } from "@/lib/agent-gateway/token";
import { getConversation as defaultGetConversation } from "@/lib/conversations/service";
import {
  executePromptStream as defaultExecutePromptStream,
  type PromptStreamResult,
} from "@/lib/prompt/sdk-driver";
import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import type {
  BackgroundWaitSummary,
  WorkflowLaneIdentity,
} from "@/lib/agent-backends/conversation";
import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import type { ExecutionTarget } from "@/lib/workflow-graph/execution-target-resolver";
import type { SessionState } from "@/lib/sessions/schemas";
import type { FsWritePolicy } from "@/lib/agent-backends/task";
import type { FsWriteRestrictionSupport } from "@/lib/agent-backends/descriptor";
import { getConversationFsWriteRestrictionForBackend } from "@/lib/agent-backends/catalog";
import type { ContextPlacement } from "@/lib/workflow-graph/definition-schemas";
import {
  composeImplementerLaneWriteEnvelope,
  type ImplementerLaneWriteEnvelope,
} from "@/lib/workflow-graph/implementer-lane-write-envelope";
import { AgentTurnFailedError } from "@/lib/workflow-graph/errors";

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
      workflowContext?: WorkflowLaneIdentity;
      executionTarget?: ExecutionTarget;
      waitForBackgroundTasks?: boolean;
      waitForConversationReady?: boolean;
      askUserQuestionsEnabled?: boolean;
      fsWritePolicy?: FsWritePolicy;
    },
  ): Promise<PromptStreamResult>;
}

export interface GraphWorkflowImplementerRunnerDeps {
  executePromptStream?: ExecutePromptStreamFn;
  getConversation?: typeof defaultGetConversation;
  /**
   * Composes the turn's write envelope. Injected so a test can drive the
   * dispatch path's fail-closed behavior without staging a worktree on disk;
   * production binds the real composer.
   */
  composeWriteEnvelope?: typeof composeImplementerLaneWriteEnvelope;
  /**
   * The backend's declared conversation-facet confinement claim. Injected so a
   * test can drive the refusal without registering a fake backend; production
   * binds the catalog literal.
   */
  conversationFsWriteRestriction?(
    backend: AgentBackendId,
  ): FsWriteRestrictionSupport;
  /**
   * Mint the lane's signed expansion capability. Injected so a test can drive
   * the dispatch path without a server key; production binds the gateway's
   * capability-key minter, which returns null when no key is provisioned.
   */
  mintLaneCapability?(scope: {
    executionId: string;
    contextId: string;
    conversationId: string;
  }): string | null;
}

export interface RunIterationInput {
  projectPath: string;
  session: SessionState;
  prompt: string;
  conversationId: string;
  executionId: string;
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
  /**
   * Effective ask-user-questions availability for this implementer turn: the
   * context's resolved toggle (an implementer lane always holds a real
   * conversation, so lane-can-ask is always true here). Threaded into the
   * prompt-stream options so the session instructions advertise the tool.
   */
  askUserQuestionsEnabled?: boolean;
  /**
   * The context's authored placement (R1) — where the turn runs and what it may
   * write. The envelope is composed from it before any dispatch decision.
   *
   * Optional only because a resolved context seeded BEFORE placement existed
   * carries none, and that is exactly the case with no declared ownership to
   * confine. An authored context always has one, so no live plan can reach here
   * without it.
   */
  placement?: ContextPlacement;
}

/**
 * What the agent has to be TOLD about its envelope, because the envelope itself
 * only enforces.
 *
 * Two facts are not discoverable from inside a confined turn. The repository is
 * no longer necessarily the working directory — a sandbox that makes its cwd
 * writable by construction (Codex) has to be moved out of the worktree, so the
 * repository is reached by absolute path. And the payload directory the `cctl
 * … --file` guidance depends on is injected per context, so an agent writing
 * to the `.cc/temp` path it would otherwise guess is writing somewhere else.
 */
function renderWriteEnvelopeBriefing(
  envelope: ImplementerLaneWriteEnvelope,
): string {
  const owned =
    envelope.ownedPrefixes.length > 0
      ? envelope.ownedPrefixes.map((prefix) => `- ${prefix}`).join("\n")
      : "- (none — this context writes no repository files)";
  return [
    "# Filesystem write envelope",
    "",
    `Repository: ${envelope.worktreeRoot}`,
    `Scratch directory: ${envelope.contextScratchDir}`,
    `Payload directory (write \`--file\` JSON and scratch files here): ${envelope.payloadDir}`,
    "",
    "Shell commands run from Scratch directory, not Repository.",
    "Treat every relative repository path in the task as relative to Repository above and address it by absolute path.",
    "",
    "Writable repository paths (everything else in the repository is read-only, enforced by the OS):",
    owned,
  ].join("\n");
}

export function createGraphWorkflowImplementerRunner(
  deps: GraphWorkflowImplementerRunnerDeps = {},
) {
  const executePromptStream =
    deps.executePromptStream ?? defaultExecutePromptStream;
  const getConversation = deps.getConversation ?? defaultGetConversation;
  const mintLaneCapability =
    deps.mintLaneCapability ?? defaultMintImplementerLaneCapability;
  const composeWriteEnvelope =
    deps.composeWriteEnvelope ?? composeImplementerLaneWriteEnvelope;
  const conversationFsWriteRestriction =
    deps.conversationFsWriteRestriction ??
    getConversationFsWriteRestrictionForBackend;

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

    const laneCapability = mintLaneCapability({
      executionId: input.executionId,
      contextId: input.contextId,
      conversationId: input.conversationId,
    });

    // Composed BEFORE any dispatch decision (R6): an envelope that cannot be
    // established is an infrastructure failure, and the only alternative — a
    // turn dispatched without one — is the unrestricted run the envelope
    // exists to prevent. A `full` placement declares no surface to be disjoint
    // from and holds its lane alone, so it stays unconfined by design.
    const worktreePath =
      input.executionTarget?.worktreePath ?? input.session.worktreePath;
    let envelope: ImplementerLaneWriteEnvelope | null = null;
    if (input.placement !== undefined && input.placement.mode !== "full") {
      // Gated on the DECLARED capability before any envelope work: a backend
      // whose conversation runtime cannot natively confine writes would carry
      // this policy as a suggestion, and a suggestion is not isolation. Refused
      // as an infrastructure outcome rather than dispatched hopefully.
      const restriction = conversationFsWriteRestriction(input.backend);
      if (restriction !== "enforced") {
        const message = `Backend "${input.backend}" cannot mechanically confine conversation writes (fsWriteRestriction: ${restriction}), so context "${input.contextId}" cannot run under a write envelope`;
        logger.error("graph-workflow.implementer.write_envelope_unsupported", {
          sessionName: input.session.sessionName,
          conversationId: input.conversationId,
          contextId: input.contextId,
          backend: input.backend,
          fsWriteRestriction: restriction,
        });
        throw new AgentTurnFailedError(message, {
          contextId: input.contextId,
          engine: input.backend,
          cause: "unknown",
          originalMessage: message,
        });
      }
      try {
        envelope = composeWriteEnvelope({
          executionId: input.executionId,
          contextId: input.contextId,
          worktreePath,
          ownedPaths:
            input.placement.mode === "owned" ? input.placement.ownedPaths : [],
          payloadLocation:
            input.placement.mode === "readOnly" ? "scratch" : "worktree",
        });
      } catch (error) {
        const message = `Cannot establish the implementer write envelope for context "${input.contextId}": ${getErrorMessage(error)}`;
        logger.error("graph-workflow.implementer.write_envelope_failed", {
          sessionName: input.session.sessionName,
          conversationId: input.conversationId,
          contextId: input.contextId,
          backend: input.backend,
          worktreePath,
          error: getErrorMessage(error),
        });
        throw new AgentTurnFailedError(message, {
          contextId: input.contextId,
          engine: input.backend,
          cause: "unknown",
          originalMessage: message,
        });
      }
    }

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
      workflowContext: WorkflowLaneIdentity;
      executionTarget?: ExecutionTarget;
      waitForBackgroundTasks: boolean;
      waitForConversationReady: boolean;
      askUserQuestionsEnabled: boolean;
      fsWritePolicy?: FsWritePolicy;
    } = {
      autonomous: true,
      backend: input.backend,
      effort: input.reasoningEffort,
      tooling: {
        portableMcp: input.toolServer as PortableMcpConfig,
      },
      // Lane identity for the session env so `cctl workflow …` resolves its
      // execution/context from env inside this implementer conversation, plus
      // the signed capability that proves this conversation IS the context's
      // bound implementer (D4 R7). Minted here, at dispatch, because this is
      // where all three facts are known at once and where the binding is
      // established; the expansion route re-checks the claim against current
      // state before it lets the lane touch the graph.
      workflowContext: {
        executionId: input.executionId,
        contextId: input.contextId,
        ...(laneCapability !== null ? { laneCapability } : {}),
      },
      // Deterministically opt this implementer turn into holding open for
      // in-flight waitable background tasks. No agent involvement (Req 6.3).
      waitForBackgroundTasks: true,
      // SDK auto-continuations can briefly retain the lane conversation after
      // the preceding work turn settles. The execution loop owns this follow-up
      // and must serialize behind that continuation instead of treating the
      // transient busy state as an agent failure.
      waitForConversationReady: true,
      // Effective ask-user-questions availability drives the enabled/disabled
      // asking-questions session instructions (Req 8.1-8.4).
      askUserQuestionsEnabled: input.askUserQuestionsEnabled === true,
    };
    if (input.executionTarget !== undefined) {
      promptOptions.executionTarget = input.executionTarget;
    }
    if (envelope !== null) {
      promptOptions.fsWritePolicy = envelope.policy;
    }

    const result = await executePromptStream(
      input.projectPath,
      input.session,
      envelope === null
        ? input.prompt
        : `${renderWriteEnvelopeBriefing(envelope)}\n\n${input.prompt}`,
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
        engine: input.backend,
        cause: "sdk_error",
        originalMessage: result.error,
      });
    }

    if (result.aborted) {
      const timedOut = result.abortReason === "timeout";
      const stalled = result.abortReason === "stalled";
      const message = stalled
        ? `Prompt execution stalled: no agent activity for ${result.timeoutMs ?? 0}ms`
        : timedOut && result.timeoutMs !== undefined
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
        engine: input.backend,
        cause: stalled ? "stall" : timedOut ? "timeout" : "abort",
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
