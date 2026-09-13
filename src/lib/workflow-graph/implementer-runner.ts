import { createLogger, type Logger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import { mintImplementerLaneCapability as defaultMintImplementerLaneCapability } from "@/lib/agent-gateway/token";
import { getConversation as defaultGetConversation } from "@/lib/conversations/service";
import { executeConversationTurn as defaultExecuteConversationTurn } from "@/lib/workflows/conversation/manager";
import { getProjectDisplayName as defaultGetProjectDisplayName } from "@/lib/projects/resolver";
import { sessionConversationTarget } from "@/lib/conversations/conversation-target";
import {
  adaptGraphConversationTurn,
  ConversationTurnNotStartedError,
} from "./conversation-turn-result";
import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import type { BackgroundWaitSummary } from "@/lib/agent-backends/conversation";

import type { ExecutionTarget } from "@/lib/workflow-graph/execution-target-resolver";
import type { SessionState } from "@/lib/sessions/schemas";

import type { FsWriteRestrictionSupport } from "@/lib/agent-backends/descriptor";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import { getConversationFsWriteRestrictionForBackend } from "@/lib/agent-backends/catalog";
import type { ContextPlacement } from "@/lib/workflow-graph/definition-schemas";
import {
  composeImplementerLaneWriteEnvelope,
  type ImplementerLaneWriteEnvelope,
} from "@/lib/workflow-graph/implementer-lane-write-envelope";
import {
  AgentTurnFailedError,
  ConversationTurnSettlementError,
} from "@/lib/workflow-graph/errors";

const defaultLogger = createLogger("graph-workflow-implementer-runner");

/** The hosted turn owns transcripts, the conversation lock, and lifecycle settlement. */
export interface GraphWorkflowImplementerRunnerDeps {
  executeConversationTurn?: typeof defaultExecuteConversationTurn;
  getProjectDisplayName?(projectPath: string): string;
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
  /** Injected so a test can observe the emitted turn-failure classification. */
  logger?: Logger;
}

/**
 * Structured cause fields for the turn-failure warning. Settlement failures
 * carry their code and attempt so a reader can correlate the halt with the
 * conversation's retained work; the retained provider result never enters the
 * log.
 */
function classifyTurnFailureForLog(error: unknown) {
  if (error instanceof AgentTurnFailedError) return { cause: error.cause };
  if (error instanceof ConversationTurnSettlementError)
    return {
      cause: "settlement_failed" as const,
      settlementCode: error.outcome.code,
      attemptId: error.attemptId,
    };
  if (error instanceof ConversationTurnNotStartedError)
    return { cause: "not_started" as const };
  return { cause: "unknown" as const };
}

export interface RunIterationInput {
  projectPath: string;
  session: SessionState;
  prompt: string;
  conversationId: string;
  executionId: string;
  contextId: string;
  backend: AgentBackendId;
  modelSelection: BackendModelSelection;
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
   * turn options so the session instructions advertise the tool.
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
  const executeConversationTurn =
    deps.executeConversationTurn ?? defaultExecuteConversationTurn;
  const getProjectDisplayName =
    deps.getProjectDisplayName ?? defaultGetProjectDisplayName;
  const getConversation = deps.getConversation ?? defaultGetConversation;
  const mintLaneCapability =
    deps.mintLaneCapability ?? defaultMintImplementerLaneCapability;
  const composeWriteEnvelope =
    deps.composeWriteEnvelope ?? composeImplementerLaneWriteEnvelope;
  const conversationFsWriteRestriction =
    deps.conversationFsWriteRestriction ??
    getConversationFsWriteRestrictionForBackend;
  const logger = deps.logger ?? defaultLogger;

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
      modelId: input.modelSelection.modelId,
      parameterIds: Object.keys(input.modelSelection.parameters).sort(),
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
      const restriction = conversationFsWriteRestriction(input.backend);
      if (restriction === "unsupported") {
        const message = `Backend "${input.backend}" cannot apply conversation write limits (fsWriteRestriction: ${restriction}), so context "${input.contextId}" cannot run under a write envelope`;
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
      if (restriction === "instruction-only") {
        logger.warn(
          "graph-workflow.implementer.write_envelope_instruction_only",
          {
            sessionName: input.session.sessionName,
            conversationId: input.conversationId,
            contextId: input.contextId,
            backend: input.backend,
            placementMode: input.placement.mode,
          },
        );
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
    // the conversation turn. The implementer is a tool-using coding turn that
    // produces code edits, file writes, and a natural-language summary
    // streamed to the UI as chat content. A JSON schema would suppress the
    // streaming markdown turn body the UI renders.
    const turn = {
      kind: "conversation_turn" as const,
      promptText:
        envelope === null
          ? input.prompt
          : `${renderWriteEnvelopeBriefing(envelope)}\n\n${input.prompt}`,
      modelSelection: input.modelSelection,
      autonomous: true,
      backend: input.backend,
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

      // Effective ask-user-questions availability drives the enabled/disabled
      // asking-questions session instructions (Req 8.1-8.4).
      askUserQuestionsEnabled: input.askUserQuestionsEnabled === true,
    };
    const { workflowContext, ...spec } = turn;
    const execution = await executeConversationTurn({
      binding: {
        kind: "durable",
        address: {
          projectPath: input.projectPath,
          target: sessionConversationTarget(
            getProjectDisplayName(input.projectPath),
            input.session.sessionName,
            input.conversationId,
          ),
        },
        worktreePath:
          input.executionTarget?.worktreePath ?? input.session.worktreePath,
      },
      turn: {
        ...spec,
        ...(envelope !== null ? { fsWritePolicy: envelope.policy } : {}),
      },
      executionContext: { workflowContext },
      // SDK auto-continuations can briefly retain the lane conversation after
      // the preceding work turn settles. The execution loop owns this follow-up
      // and must serialize behind that continuation instead of treating the
      // transient busy state as an agent failure.
      waitUntilReady: true,
    });
    let result: ReturnType<typeof adaptGraphConversationTurn>;
    try {
      result = adaptGraphConversationTurn(execution, {
        contextId: input.contextId,
        backend: input.backend,
      });
    } catch (error) {
      logger.warn("graph-workflow.implementer.turn_failed", {
        sessionName: input.session.sessionName,
        conversationId: input.conversationId,
        contextId: input.contextId,
        backend: input.backend,
        error: getErrorMessage(error),
        ...classifyTurnFailureForLog(error),
      });
      throw error;
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
      input.conversationId,
    );

    return {
      conversationId: input.conversationId,
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
