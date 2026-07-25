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
 *     usage on the lane (`LaneOutcome`). The `WorkflowAgentCaller` is also
 *     the ONE place the `LaneScheduler` is acquired (D16): write-capable
 *     lanes sharing a session serialize here, and nothing above this seam
 *     schedules again. The default scheduler instance is module-shared so
 *     concurrent collaboration runs in the same session serialize against
 *     each other.
 *
 * Splitting this out from `deps-factory.ts` keeps the deps factory's
 * concerns focused on lane / envelope / artifact / status wiring while
 * isolating backend-resolution concerns (registry lookups, runtime
 * lifecycle, continuity context) here.
 */

import path from "node:path";
import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { createLogger } from "@/lib/logging";
import {
  getBackendDescriptor,
  getConversationBackendFactory as defaultGetConversationBackendFactory,
  getTaskRunner as defaultGetTaskRunner,
} from "@/lib/agent-backends/registry";
import {
  assertRefOwnedBy,
  type BackendContinuityAdapter,
} from "@/lib/agent-backends/continuity";
import type { ConversationBackendFactory } from "@/lib/agent-backends/conversation";
import type { AgentTaskRunner } from "@/lib/agent-backends/task";
import { createStallWatchdog } from "@/lib/agent-backends/stall-watchdog";
import type { AgentBackendId } from "@/lib/shared/schemas";
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
import {
  createLaneScheduler,
  type LaneScheduler,
} from "@/lib/workflows/primitives/lane-scheduler";
import type { LaneService } from "@/lib/workflows/primitives/lane-service";
import type { AsymmetricCollaborationSliceDeps } from "./envelope";
import {
  COLLABORATION_FORMAT_TURN_INSTRUCTION,
  COLLABORATION_PROSE_TURN_INSTRUCTION,
  COLLABORATION_STRUCTURED_OUTPUT_REMINDER,
} from "./prompt-builders";

const logger = createLogger("workflows.collaboration.agent-caller-production");

/**
 * Shared production scheduler: one instance across every collaboration entry
 * point (user envelope + graph workflow collab) so write-capable lane work in
 * the same session serializes regardless of which flow scheduled it.
 */
const sharedCollaborationLaneScheduler = createLaneScheduler();

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
  /**
   * Lane scheduler acquired by the WorkflowAgentCaller — the single
   * acquisition point for lane scheduling (D16). Defaults to the shared
   * production scheduler; tests inject an instrumented instance.
   */
  laneScheduler?: LaneScheduler;
  /**
   * Model the Codex lane runs with. The asymmetric slice builds Codex requests
   * without a per-call model, so without this the Codex SDK falls back to its
   * own built-in default — rejected for ChatGPT-account auth. Resolved from the
   * global config cascade by the manager. A per-call `request.modelId` (if a
   * future caller sets one) still takes precedence.
   */
  codexModel?: string;
  /** Reasoning effort the Codex lane runs with, resolved alongside `codexModel`. */
  codexReasoningEffort?: string;
  /** Whole-turn safety bound from the Codex backend profile; zero disables it. */
  codexTimeoutMs?: number;
  /** Inactivity bound from the Codex backend profile; zero disables it. */
  codexStallTimeoutMs?: number;
  /**
   * Model the Claude lane runs with. The asymmetric slice builds Claude
   * `conversation_turn` requests without a per-call model, so without this the
   * Claude SDK falls back to its CLI default model — which is rejected for
   * accounts without access to it, surfacing as a misleading structured-output
   * validation failure. Resolved from the global config cascade by the manager.
   * A per-call `request.modelId` (if a caller sets one) still takes precedence.
   */
  claudeModel?: string;
  /** Reasoning effort the Claude lane runs with, resolved alongside `claudeModel`. */
  claudeReasoningEffort?: string;
  /** Whole-turn safety bound from the Claude backend profile; zero disables it. */
  claudeTimeoutMs?: number;
  /** Inactivity bound from the Claude backend profile; zero disables it. */
  claudeStallTimeoutMs?: number;
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

interface CollaborationLaneDefaults {
  model?: string;
  reasoningEffort?: string;
  timeoutMs?: number;
  stallTimeoutMs?: number;
}

function resolveLaneDefaults(
  input: CollaborationProductionAgentCallerInput,
  backend: AgentBackendId,
): CollaborationLaneDefaults {
  if (backend === "codex") {
    return {
      ...(input.codexModel !== undefined ? { model: input.codexModel } : {}),
      ...(input.codexReasoningEffort !== undefined
        ? { reasoningEffort: input.codexReasoningEffort }
        : {}),
      ...(input.codexTimeoutMs !== undefined
        ? { timeoutMs: input.codexTimeoutMs }
        : {}),
      ...(input.codexStallTimeoutMs !== undefined
        ? { stallTimeoutMs: input.codexStallTimeoutMs }
        : {}),
    };
  }

  return {
    ...(input.claudeModel !== undefined ? { model: input.claudeModel } : {}),
    ...(input.claudeReasoningEffort !== undefined
      ? { reasoningEffort: input.claudeReasoningEffort }
      : {}),
    ...(input.claudeTimeoutMs !== undefined
      ? { timeoutMs: input.claudeTimeoutMs }
      : {}),
    ...(input.claudeStallTimeoutMs !== undefined
      ? { stallTimeoutMs: input.claudeStallTimeoutMs }
      : {}),
  };
}

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
      const isCodex = request.backend === "codex";
      const laneDefaults = resolveLaneDefaults(input, request.backend);
      const codexResumeRef =
        continuity.laneAction === "reuse" &&
        continuity.resumeRef &&
        continuity.resumeRef.backend === "codex"
          ? continuity.resumeRef
          : null;
      const codexHardenedSettings = isCodex
        ? {
            sandboxMode: "danger-full-access" as const,
            approvalPolicy: "never" as const,
            webSearchMode: "disabled" as const,
            skipGitRepoCheck: true,
            networkAccessEnabled: true,
          }
        : {};
      // The slice omits per-call settings, so fall back to the lane's complete
      // backend profile rather than independent SDK defaults.
      const effectiveModelId = request.modelId ?? laneDefaults.model;
      const effectiveReasoningEffort =
        request.reasoningEffort ?? laneDefaults.reasoningEffort;
      const result = await exec(request, {
        resolveTaskRunner: () => ({
          runner,
          capabilityView: capabilityViewForBackend(request.backend),
          workingDirectory: input.worktreePath,
          autonomous: true,
          ...(effectiveModelId !== undefined
            ? { modelId: effectiveModelId }
            : {}),
          ...(effectiveReasoningEffort !== undefined
            ? { reasoningEffort: effectiveReasoningEffort }
            : {}),
          ...(laneDefaults.timeoutMs !== undefined
            ? { defaultTimeoutMs: laneDefaults.timeoutMs }
            : {}),
          ...(laneDefaults.stallTimeoutMs !== undefined
            ? { stallTimeoutMs: laneDefaults.stallTimeoutMs }
            : {}),
          ...(codexResumeRef !== null ? { resumeRef: codexResumeRef } : {}),
          ...codexHardenedSettings,
        }),
      });
      const staleResumeMessage = codexResumeRef
        ? getStaleResumeFailureMessage(request.backend, result)
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
    const laneDefaults = resolveLaneDefaults(input, backend);
    const claudeResumeRef =
      continuity.laneAction === "reuse" &&
      continuity.resumeRef &&
      continuity.resumeRef.backend === "claude"
        ? continuity.resumeRef
        : null;
    const factory = resolveConversationFactory(backend);
    const conversationId =
      claudeResumeRef?.ref ?? `collab-${input.workflowId}-${newId()}`;
    const outputFormat = request.outputSchema
      ? { type: "json_schema" as const, schema: request.outputSchema }
      : undefined;
    // The slice omits a per-call model, so fall back to the lane's configured
    // Claude model rather than the SDK's built-in CLI default. The Claude
    // conversation runtime fixes the model at creation time, so it must be set
    // here (the per-turn modelId on the dispatch resolution is ignored).
    const effectiveModelId = request.modelId ?? laneDefaults.model;
    const effectiveReasoningEffort =
      request.reasoningEffort ?? laneDefaults.reasoningEffort;
    const runtime = await factory.createRuntime({
      conversationId,
      mcpScopeConversationId: input.originatingConversationId,
      projectPath: input.projectPath,
      projectName,
      // The lane's session key lifted into the public scope vocabulary at this
      // boundary, so a sentinel-keyed origin can never reach the agent env as a
      // session identity.
      conversationTarget: targetFromStoreSessionName(
        projectName,
        input.sessionName,
        conversationId,
      ),
      worktreePath: input.worktreePath,
      persistedRef: claudeResumeRef,
      ...(effectiveModelId !== undefined ? { modelId: effectiveModelId } : {}),
      ...(effectiveReasoningEffort !== undefined
        ? { reasoningEffort: effectiveReasoningEffort }
        : {}),
      ...(outputFormat !== undefined ? { outputFormat } : {}),
      sessionInstructions: [],
      tooling: {},
    });
    const abort = new AbortController();
    const timeoutMs = request.timeoutMs ?? laneDefaults.timeoutMs ?? 0;
    const stallTimeoutMs = laneDefaults.stallTimeoutMs ?? 0;
    let timeoutFired = false;
    let runtimeClosed = false;
    const closeRuntime = (): void => {
      if (runtimeClosed) return;
      runtimeClosed = true;
      runtime.close();
    };
    logger.debug("collaboration.agent_call.timeout_resolved", {
      workflowId: input.workflowId,
      laneId: request.laneRef?.laneId,
      backend,
      timeoutMs,
      timeoutEnabled: timeoutMs > 0,
      stallTimeoutMs,
      stallTimeoutEnabled: stallTimeoutMs > 0,
    });
    const timeoutHandle =
      timeoutMs > 0
        ? setTimeout(() => {
            timeoutFired = true;
            logger.warn("collaboration.agent_call.timeout", {
              workflowId: input.workflowId,
              laneId: request.laneRef?.laneId,
              backend,
              timeoutMs,
            });
            abort.abort();
            closeRuntime();
          }, timeoutMs)
        : null;
    const stallWatchdog = createStallWatchdog({
      stallTimeoutMs,
      onStall: () => {
        logger.warn("collaboration.agent_call.stalled", {
          workflowId: input.workflowId,
          laneId: request.laneRef?.laneId,
          backend,
          stallTimeoutMs,
        });
        abort.abort();
        closeRuntime();
      },
    });
    try {
      const result = await exec(request, {
        resolveConversationRuntime: () => ({
          runtime,
          capabilityView: capabilityViewForBackend(backend),
          signal: abort.signal,
          autonomous: true,
          onEvent: () => stallWatchdog.touch(),
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
        ? getStaleResumeFailureMessage(backend, result)
        : null;
      if (staleResumeMessage) {
        throw markStaleBackendRefError(new Error(staleResumeMessage));
      }
      if (
        result.outcome.kind === "failed" &&
        (timeoutFired || stallWatchdog.fired())
      ) {
        const message = stallWatchdog.fired()
          ? `conversation stalled: no backend activity for ${stallTimeoutMs}ms`
          : `conversation timed out after ${timeoutMs}ms`;
        return {
          ...result,
          outcome: {
            ...result.outcome,
            error: {
              ...result.outcome.error,
              failureKind: "timeout",
              message,
            },
          },
        };
      }
      return result;
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      stallWatchdog.cancel();
      closeRuntime();
    }
  };
}

/**
 * Detect a failed resumed-lane call whose failure is a stale continuation
 * ref, so the caller can mark it for the WorkflowAgentCaller fresh-retry
 * path. The normalized `stale_resume_ref` kind is consumed directly; a
 * `backend_error` message is re-classified through the backend's own
 * classifier for adapters that report failures as bare messages. Richer
 * kinds (timeout, abort, schema) already carry their own meaning.
 */
function getStaleResumeFailureMessage(
  backend: AgentBackendId,
  result: AgentCallResult,
): string | null {
  if (result.outcome.kind !== "failed") return null;
  const { failureKind, message } = result.outcome.error;
  if (failureKind === "stale_resume_ref") return message;
  if (failureKind !== "backend_error") return null;
  const classification = getBackendDescriptor(backend).errors.classify(message);
  return classification.kind === "stale_resume_ref" ? message : null;
}

/**
 * Continuity adapter over collaboration's synthetic lane handles. A lane's
 * handle is minted locally (`collab-…`) rather than by the backend: Claude
 * lanes run against per-lane synthetic SDK session ids and Codex lanes learn
 * their real thread id only after the first turn, so handles are always
 * treated as valid and resume-as-is; staleness surfaces at call time through
 * the WorkflowAgentCaller's stale-ref retry. Fork has no collaboration
 * meaning.
 */
function makeSyntheticContinuityAdapter(
  backend: AgentBackendId,
  mintRef: () => string,
): BackendContinuityAdapter {
  return {
    backend,
    async start() {
      return { backend, ref: mintRef() };
    },
    async validate(ref) {
      assertRefOwnedBy(backend, ref);
      return { status: "valid" };
    },
    async resumeOrRecover(ref) {
      assertRefOwnedBy(backend, ref);
      return { ref, recovered: false };
    },
    async fork() {
      return { kind: "unsupported" };
    },
  };
}

export function createCollaborationProductionAgentCaller(
  input: CollaborationProductionAgentCallerInput,
): WorkflowAgentCaller {
  const newId = input.newId ?? (() => crypto.randomUUID().slice(0, 8));
  const innerCallAgent = buildInnerCallAgent(input);

  const syntheticAdapters: Partial<
    Record<AgentBackendId, BackendContinuityAdapter>
  > = {
    claude: makeSyntheticContinuityAdapter(
      "claude",
      () => `collab-${input.workflowId}-${newId()}`,
    ),
    codex: makeSyntheticContinuityAdapter(
      "codex",
      () => `collab-codex-${input.workflowId}-${newId()}`,
    ),
  };

  const callerDeps: Parameters<typeof createWorkflowAgentCaller>[0] = {
    callAgent: innerCallAgent,
    laneService: input.laneService,
    laneScheduler: input.laneScheduler ?? sharedCollaborationLaneScheduler,
    continuityContext: {
      projectPath: input.projectPath,
      sessionName: input.sessionName,
    },
    continuityAdapter(backend) {
      const adapter = syntheticAdapters[backend];
      if (!adapter) {
        throw new Error(
          `collaboration agent caller: no synthetic continuity adapter for backend "${backend}"`,
        );
      }
      return adapter;
    },
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
 * Every artifact-producing call in the asymmetric negotiation flow carries a
 * `laneRef`, so a missing one is a programming error — the boundary rejects it
 * loudly rather than falling back to an unscheduled direct backend call, which
 * would bypass the single scheduler acquisition point (D16).
 *
 * A schema-bearing request becomes ONE two-turn caller request (prose work
 * turn + format follow-up), so the whole prose→format repair is a single
 * serialized semantic operation: the scheduler is acquired exactly once around
 * both underlying backend turns and no competing same-session writer can
 * interleave between them.
 */
export function createCollaborationProductionCallAgent(
  input: CollaborationProductionAgentCallerInput,
): AsymmetricCollaborationSliceDeps["callAgent"] {
  const caller = createCollaborationProductionAgentCaller(input);
  return async (request) => {
    if (!request.laneRef) {
      throw new Error(
        "collaboration production callAgent requires a laneRef; every artifact-producing collaboration call is lane-scoped and scheduled through the WorkflowAgentCaller",
      );
    }
    const laneRef = request.laneRef;

    // A request without a structured-output schema is a single turn.
    if (request.outputSchema === undefined) {
      return caller.call({
        laneRef,
        sessionKey: input.sessionKey,
        ...(request.writeCapability !== undefined
          ? { writeCapability: request.writeCapability }
          : {}),
        agentCallRequest: request,
      });
    }

    // Two-step structured output. The work turn answers in prose (schema
    // stripped, the JSON reminder swapped for a prose directive); the format
    // follow-up restates that answer as schema-conforming JSON through the
    // backend transport and shared gate. Both turns run inside ONE scheduled
    // critical section: the format turn resumes the work turn's session via the
    // lane's continuity
    // ref, so the model formats an answer it has already produced instead of
    // reasoning and conforming to the schema in a single pass (which fails when
    // the task is large enough that the agent is still mid-reasoning at
    // enforcement time).
    const workTurn: AgentCallRequest = {
      ...request,
      outputSchema: undefined,
      prompt: request.prompt.replace(
        COLLABORATION_STRUCTURED_OUTPUT_REMINDER,
        COLLABORATION_PROSE_TURN_INSTRUCTION,
      ),
    };
    const formatTurn: AgentCallRequest = {
      ...request,
      imageRefs: undefined,
      prompt: COLLABORATION_FORMAT_TURN_INSTRUCTION,
    };
    return caller.call({
      laneRef,
      sessionKey: input.sessionKey,
      ...(request.writeCapability !== undefined
        ? { writeCapability: request.writeCapability }
        : {}),
      agentCallRequest: workTurn,
      formatFollowUp: formatTurn,
    });
  };
}
