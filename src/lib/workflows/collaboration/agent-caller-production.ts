/**
 * Production composition of `AsymmetricCollaborationSliceDeps.callAgent`.
 *
 * Wires the slice's lane-aware `callAgent` to real Claude / Codex backends:
 *
 *  1. `task_run` requests resolve a registered `AgentTaskRunner` from the
 *     agent-backends registry and execute via `executeAgentCall`. The
 *     working directory is the session worktree path so artifacts and
 *     subprocess writes stay scoped to the session per the worktree
 *     isolation rule in CLAUDE.md.
 *  2. `conversation_turn` requests construct a Claude
 *     `ConversationBackendRuntime` for the lane's active session. Fresh
 *     lanes start without a persisted ref; later turns resume the backend
 *     session returned by the SDK and recorded on lane state.
 *  3. The composition runs through `WorkflowAgentCaller` so the lane
 *     service tracks backend continuity, rotation flags, and post-turn
 *     usage on the lane (`LaneOutcome`). A no-op inner `LaneScheduler` is
 *     supplied because the slice already serializes write-capable lanes at
 *     the round level on the same `sessionKey`; a second scheduler with
 *     the same key would deadlock against the outer one.
 *
 * Splitting this out from `deps-factory.ts` keeps the deps factory's
 * concerns focused on lane / envelope / artifact / status wiring while
 * isolating backend-resolution concerns (registry lookups, runtime
 * lifecycle, continuity context) here.
 */

import path from "node:path";
import { createLogger } from "@/lib/logging";
import {
  getConversationBackendFactory as defaultGetConversationBackendFactory,
  getTaskRunner as defaultGetTaskRunner,
} from "@/lib/agent-backends/registry";
import type { ConversationBackendFactory } from "@/lib/agent-backends/conversation";
import type { AgentTaskRunner } from "@/lib/agent-backends/task";
import type { AgentBackendId } from "@/lib/agent-backends/types";
import {
  executeAgentCall,
  type AgentCallFacadeDeps,
} from "@/lib/workflows/primitives/agent-call-facade";
import { capabilityViewForBackend } from "@/lib/workflows/primitives/backend-capabilities";
import {
  createWorkflowAgentCaller,
  markStaleBackendRefError,
  type WorkflowAgentCallContinuity,
  type WorkflowAgentCaller,
} from "@/lib/workflows/primitives/workflow-agent-caller";
import type {
  AgentCallRequest,
  AgentCallResult,
} from "@/lib/workflows/primitives/agent-call-vocabulary";
import type { LaneScheduler } from "@/lib/workflows/primitives/lane-scheduler";
import type { LaneService } from "@/lib/workflows/primitives/lane-service";
import type { AsymmetricCollaborationSliceDeps } from "./envelope";

const logger = createLogger("workflows.collaboration.agent-caller-production");

const NOOP_LANE_SCHEDULER: LaneScheduler = {
  async schedule(_request, fn) {
    return fn();
  },
};

export interface CollaborationProductionAgentCallerInput {
  workflowId: string;
  projectPath: string;
  sessionName: string;
  worktreePath: string;
  /** Identifier passed to WorkflowAgentCaller as the lane scheduler key. */
  sessionKey: string;
  /**
   * Conversation that initiated the collaboration. Each Claude lane gets
   * its own synthetic SDK session ID, but the session MCP server has to
   * resolve to a conversation that exists in CC state — that's this one.
   */
  originatingConversationId: string;
  /**
   * The slice's lane service. Reused so post-turn outcomes recorded by the
   * WorkflowAgentCaller land on the same `LaneState` the slice operates on.
   */
  laneService: LaneService;
  /** Optional override for testing. Defaults to module-level `executeAgentCall`. */
  executeAgentCallImpl?: (
    request: AgentCallRequest,
    deps: AgentCallFacadeDeps,
  ) => Promise<AgentCallResult>;
  /**
   * Optional override for the task-runner registry lookup. Defaults to
   * `getTaskRunner` from the agent-backends registry. Tests use this to
   * inject programmable runners without needing global registration.
   */
  getTaskRunner?: (backend: AgentBackendId) => AgentTaskRunner;
  /**
   * Optional override for the conversation-backend factory registry lookup.
   * Defaults to `getConversationBackendFactory` from the agent-backends
   * registry. Tests use this to inject programmable factories.
   */
  getConversationBackendFactory?: (
    backend: AgentBackendId,
  ) => ConversationBackendFactory;
  /** Optional clock override. Forwarded to WorkflowAgentCaller. */
  now?: () => string;
  newId?: () => string;
}

type InnerCallAgent = (
  request: AgentCallRequest,
  continuity: WorkflowAgentCallContinuity,
) => Promise<AgentCallResult>;

function buildInnerCallAgent(
  input: CollaborationProductionAgentCallerInput,
): InnerCallAgent {
  const projectName = path.basename(input.projectPath);
  const newId = input.newId ?? (() => crypto.randomUUID().slice(0, 8));
  const exec = input.executeAgentCallImpl ?? executeAgentCall;
  const resolveTaskRunner = input.getTaskRunner ?? defaultGetTaskRunner;
  const resolveConversationFactory =
    input.getConversationBackendFactory ?? defaultGetConversationBackendFactory;

  return async (
    request: AgentCallRequest,
    continuity: WorkflowAgentCallContinuity,
  ): Promise<AgentCallResult> => {
    if (request.kind === "task_run") {
      const runner = resolveTaskRunner(request.backend);
      const codexResumeRef =
        continuity.laneAction === "reuse" &&
        continuity.resumeRef &&
        continuity.resumeRef.backend === "codex"
          ? continuity.resumeRef
          : null;
      const codexHardenedSettings =
        request.backend === "codex"
          ? {
              sandboxMode: "danger-full-access" as const,
              approvalPolicy: "never" as const,
              webSearchMode: "disabled" as const,
              skipGitRepoCheck: true,
              networkAccessEnabled: true,
            }
          : {};
      const result = await exec(request, {
        resolveTaskRunner: () => ({
          runner,
          capabilityView: capabilityViewForBackend(request.backend),
          workingDirectory: input.worktreePath,
          autonomous: true,
          ...(request.modelId !== undefined
            ? { modelId: request.modelId }
            : {}),
          ...(request.reasoningEffort !== undefined
            ? { reasoningEffort: request.reasoningEffort }
            : {}),
          ...(codexResumeRef !== null ? { resumeRef: codexResumeRef } : {}),
          ...codexHardenedSettings,
        }),
      });
      const staleResumeMessage = codexResumeRef
        ? getLikelyStaleResumeFailureMessage(result)
        : null;
      if (staleResumeMessage) {
        throw markStaleBackendRefError(new Error(staleResumeMessage));
      }
      return result;
    }

    if (request.kind !== "conversation_turn") {
      throw new Error(
        `collaboration production callAgent: unsupported request kind`,
      );
    }

    const backend = request.backend ?? "claude";
    const claudeResumeRef =
      continuity.laneAction === "reuse" &&
      continuity.resumeRef &&
      continuity.resumeRef.backend === "claude"
        ? continuity.resumeRef
        : null;
    const factory = resolveConversationFactory(backend);
    const conversationId =
      claudeResumeRef?.sessionId ?? `collab-${input.workflowId}-${newId()}`;
    const outputFormat = request.outputSchema
      ? { type: "json_schema" as const, schema: request.outputSchema }
      : undefined;
    const runtime = await factory.createRuntime({
      conversationId,
      mcpScopeConversationId: input.originatingConversationId,
      projectPath: input.projectPath,
      projectName,
      sessionName: input.sessionName,
      worktreePath: input.worktreePath,
      persistedRef: claudeResumeRef,
      ...(outputFormat !== undefined ? { outputFormat } : {}),
      sessionInstructions: [],
      tooling: {},
    });
    const abort = new AbortController();
    try {
      const result = await exec(request, {
        resolveConversationRuntime: () => ({
          runtime,
          capabilityView: capabilityViewForBackend(backend),
          signal: abort.signal,
          autonomous: true,
          ...(request.modelId !== undefined
            ? { modelId: request.modelId }
            : {}),
          ...(request.reasoningEffort !== undefined
            ? { reasoningEffort: request.reasoningEffort }
            : {}),
          sessionInstructions: [],
        }),
      });
      const staleResumeMessage = claudeResumeRef
        ? getLikelyStaleResumeFailureMessage(result)
        : null;
      if (staleResumeMessage) {
        throw markStaleBackendRefError(new Error(staleResumeMessage));
      }
      return result;
    } finally {
      runtime.close();
    }
  };
}

function getLikelyStaleResumeFailureMessage(
  result: AgentCallResult,
): string | null {
  if (result.outcome.kind !== "failed") return null;
  if (result.outcome.error.failureKind !== "backend_error") return null;
  const message = result.outcome.error.message.toLowerCase();
  const mentionsResume =
    message.includes("resume") ||
    message.includes("session") ||
    message.includes("thread");
  const mentionsMissing =
    message.includes("not found") ||
    message.includes("does not exist") ||
    message.includes("no rollout") ||
    message.includes("expired");
  return mentionsResume && mentionsMissing
    ? result.outcome.error.message
    : null;
}

export function createCollaborationProductionAgentCaller(
  input: CollaborationProductionAgentCallerInput,
): WorkflowAgentCaller {
  const newId = input.newId ?? (() => crypto.randomUUID().slice(0, 8));
  const innerCallAgent = buildInnerCallAgent(input);

  const callerDeps: Parameters<typeof createWorkflowAgentCaller>[0] = {
    callAgent: innerCallAgent,
    laneService: input.laneService,
    laneScheduler: NOOP_LANE_SCHEDULER,
    createClaudeConversation: async () => ({
      conversationId: `collab-${input.workflowId}-${newId()}`,
    }),
    validateClaudeConversation: async () => true,
    startCodexThread: async () => ({
      threadId: `collab-codex-${input.workflowId}-${newId()}`,
    }),
    resumeCodexThread: async ({ threadId }) => ({ threadId }),
  };
  if (input.now) {
    callerDeps.now = input.now;
  }

  logger.debug("collaboration.agent-caller.created", {
    workflowId: input.workflowId,
    sessionKey: input.sessionKey,
  });

  return createWorkflowAgentCaller(callerDeps);
}

/**
 * Adapts a `WorkflowAgentCaller` into the `(request) => Promise<AgentCallResult>`
 * signature the slice's `callAgent` dep expects.
 *
 * Lane-aware requests (every artifact-producing call in the asymmetric
 * negotiation flow carries a `laneRef`) flow through the WorkflowAgentCaller
 * so post-turn outcomes are recorded on the lane. Lane-less requests fall
 * back to a direct inner backend call under a synthetic per-workflow lane
 * key as a defensive path; the asymmetric slice itself always sets
 * `laneRef`, so this branch is not exercised in production.
 */
export function createCollaborationProductionCallAgent(
  input: CollaborationProductionAgentCallerInput,
): AsymmetricCollaborationSliceDeps["callAgent"] {
  const caller = createCollaborationProductionAgentCaller(input);
  const innerCallAgent = buildInnerCallAgent(input);
  return async (request) => {
    if (!request.laneRef) {
      const scribeLaneRef = {
        workflowId: input.workflowId,
        laneId: `scribe-${input.workflowId}`,
      };
      return innerCallAgent(request, {
        laneRef: scribeLaneRef,
        resumeRef: null,
        laneAction: "create",
      });
    }
    return caller.call({
      laneRef: request.laneRef,
      sessionKey: input.sessionKey,
      ...(request.writeCapability !== undefined
        ? { writeCapability: request.writeCapability }
        : {}),
      agentCallRequest: request,
    });
  };
}
