import { assertBackendExecution } from "@/lib/agent-backends/task-execution";
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
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
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
   * Conversation that initiated the collaboration. Each Claude lane gets its
   * own synthetic SDK session ID, but the `cctl` identity handed to the lane
   * has to resolve to a conversation that exists in CC state — that's this one.
   */
  originatingConversationId: string;
  /**
   * Opt-in: let the Codex task lane act as the originating CC session, so the
   * `<active-ticket>` block's `cctl` retrieval commands can actually execute
   * there (a task subprocess otherwise has no CC identity at all).
   *
   * Set ONLY by standalone collaboration, which is one attended logical turn
   * owned by the originating conversation. Graph-workflow collaboration omits
   * it: its task runs stay neutralized, exactly as before. The identity is
   * derived here from `projectPath` / `sessionName` /
   * `originatingConversationId` rather than accepted from the caller, so no
   * caller can name a session it does not own.
   */
  grantsOriginatingSessionScope?: boolean;
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
   * Both flow agents' resolved lane runtimes, keyed by flow-agent id. The
   * asymmetric slice builds requests without per-call settings, so each lane's
   * complete profile must cross this boundary. A per-call `modelSelection` (if
   * a future caller sets one) replaces that lane selection as a whole. Timeouts
   * follow the backend profile convention: zero disables the bound.
   */
  agents: CollaborationLaneAgentsInput;
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

/**
 * One flow agent's resolved lane runtime as the production caller consumes it.
 * The complete selection is deliberately required before any lane runs.
 */
export interface CollaborationLaneAgentConfig {
  backend: AgentBackendId;
  modelSelection: BackendModelSelection;
  /**
   * Whole-turn safety bound from the backend profile; zero disables it.
   * Absent means the underlying runner's own default applies (the
   * graph-workflow collaboration path deliberately omits it).
   */
  timeoutMs?: number;
  /** Inactivity bound from the backend profile; zero disables it. */
  stallTimeoutMs?: number;
}

export interface CollaborationLaneAgentsInput {
  agent_one: CollaborationLaneAgentConfig;
  agent_two: CollaborationLaneAgentConfig;
}

/**
 * The flow agent a request addresses, read from its lane ref. Collaboration
 * lane identity IS the flow agent (`agent_one` | `agent_two`); a request
 * without one has no lane settings to run under, so this fails loudly rather
 * than guessing by backend — with a same-backend pair, backend cannot
 * disambiguate the two lanes.
 */
function laneAgentFor(
  request: AgentCallRequest,
): keyof CollaborationLaneAgentsInput {
  const laneId = request.laneRef?.laneId;
  if (laneId === "agent_one" || laneId === "agent_two") return laneId;
  throw new Error(
    `collaboration production callAgent: request laneRef must name a flow agent (agent_one|agent_two), got "${String(laneId)}"`,
  );
}

function laneAgentConfigFor(
  input: CollaborationProductionAgentCallerInput,
  request: AgentCallRequest,
): CollaborationLaneAgentConfig {
  const agent = laneAgentFor(request);
  const config = input.agents[agent];
  if (request.backend !== undefined && request.backend !== config.backend) {
    throw new Error(
      `collaboration production callAgent: request backend "${request.backend}" does not match ${agent}'s configured backend "${config.backend}"`,
    );
  }
  return config;
}

function buildInnerCallAgent(
  input: CollaborationProductionAgentCallerInput,
): InnerCallAgent {
  const projectName = path.basename(input.projectPath);
  // Built once from the caller's own session facts: the same identity the
  // Claude lane's conversation runtime resolves cctl against, so both lanes
  // address the originating conversation rather than a synthetic lane handle.
  const ccSessionScope = input.grantsOriginatingSessionScope
    ? {
        project: projectName,
        session: input.sessionName,
        conversationId: input.originatingConversationId,
      }
    : undefined;
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
      const laneDefaults = laneAgentConfigFor(input, request);
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
      const modelSelection =
        request.modelSelection ?? laneDefaults.modelSelection;
      const effectiveRequest = { ...request, modelSelection };
      const result = await exec(effectiveRequest, {
        resolveTaskRunner: () => ({
          runner,
          capabilityView: capabilityViewForBackend(request.backend),
          workingDirectory: input.worktreePath,
          autonomous: true,
          modelSelection,
          ...(laneDefaults.timeoutMs !== undefined
            ? { defaultTimeoutMs: laneDefaults.timeoutMs }
            : {}),
          ...(laneDefaults.stallTimeoutMs !== undefined
            ? { stallTimeoutMs: laneDefaults.stallTimeoutMs }
            : {}),
          ...(codexResumeRef !== null ? { resumeRef: codexResumeRef } : {}),
          ...(ccSessionScope !== undefined ? { ccSessionScope } : {}),
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

    const laneDefaults = laneAgentConfigFor(input, request);
    const backend = request.backend ?? laneDefaults.backend;
    const claudeResumeRef =
      continuity.laneAction === "reuse" &&
      continuity.resumeRef &&
      continuity.resumeRef.backend === "claude"
        ? continuity.resumeRef
        : null;
    await assertBackendExecution(backend, {
      facet: "conversation",
      operation: "collaboration",
      executionClass: "governed-execution",
    });
    const factory = resolveConversationFactory(backend);
    const conversationId =
      claudeResumeRef?.ref ?? `collab-${input.workflowId}-${newId()}`;
    const outputFormat = request.outputSchema
      ? { type: "json_schema" as const, schema: request.outputSchema }
      : undefined;
    const modelSelection =
      request.modelSelection ?? laneDefaults.modelSelection;
    // Semantic → transport: the request's governing instructions become the
    // conversation's session instructions, the same channel an ordinary turn
    // gives the charter. Both the runtime (which bakes governance at creation)
    // and the dispatched turn carry them. No `alignmentVersion` is stamped:
    // collaboration creates and closes a runtime per call, so the
    // version-gated recreate path it feeds could never fire.
    const sessionInstructions =
      request.systemInstructions !== undefined
        ? [request.systemInstructions]
        : [];
    const runtime = await factory.createRuntime({
      executionClass: "governed-execution",
      conversationId,
      ccScopeConversationId: input.originatingConversationId,
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
      modelSelection,
      ...(outputFormat !== undefined ? { outputFormat } : {}),
      sessionInstructions,
      tooling: {},
    });
    const abort = new AbortController();
    const timeoutMs = request.timeoutMs ?? laneDefaults.timeoutMs ?? 0;
    const stallTimeoutMs = laneDefaults.stallTimeoutMs ?? 0;
    let timeoutFired = false;
    let runtimeClosed = false;
    // Called from timeout/stall timers as well as the terminal path, so
    // teardown is not awaited here; a failed close is recorded.
    const closeRuntime = (): void => {
      if (runtimeClosed) return;
      runtimeClosed = true;
      void runtime.close().catch((err: unknown) => {
        logger.warn("collaboration.agent_call.runtime_close_error", {
          workflowId: input.workflowId,
          backend,
          error: String(err),
        });
      });
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
      const effectiveRequest = { ...request, modelSelection };
      const result = await exec(effectiveRequest, {
        resolveConversationRuntime: () => ({
          runtime,
          capabilityView: capabilityViewForBackend(backend),
          signal: abort.signal,
          modelSelection,
          autonomous: true,
          onEvent: () => stallWatchdog.touch(),
          sessionInstructions,
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
 * Turn a schema-bearing phase prompt into its prose work-turn form by swapping
 * the builder-owned structured-output reminder for the prose directive.
 *
 * The reminder is only ever the prompt's terminal segment — every phase builder
 * emits it last — so the swap is anchored to the suffix. A blind
 * `replace()` would rewrite the FIRST occurrence anywhere in the prompt, and by
 * this point `callPrimitive` has prefixed the captured `<active-ticket>` block,
 * whose title and description are unrestricted user text: a ticket that quotes
 * the reminder would have its own words rewritten while the real trailing
 * reminder survived. The canonical block has to reach the agent byte-for-byte.
 */
function swapTrailingReminderForProseDirective(
  prompt: string,
  context: { workflowId: string; laneId: string | undefined },
): string {
  if (!prompt.endsWith(COLLABORATION_STRUCTURED_OUTPUT_REMINDER)) {
    // Not a builder-shaped phase prompt. Dispatch it unchanged rather than
    // guessing which occurrence was meant; the work turn then keeps whatever
    // output directive its author wrote.
    logger.warn("collaboration.work_turn.prose_swap_skipped", {
      workflowId: context.workflowId,
      laneId: context.laneId,
    });
    return prompt;
  }
  return (
    prompt.slice(
      0,
      prompt.length - COLLABORATION_STRUCTURED_OUTPUT_REMINDER.length,
    ) + COLLABORATION_PROSE_TURN_INSTRUCTION
  );
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
      prompt: swapTrailingReminderForProseDirective(request.prompt, {
        workflowId: input.workflowId,
        laneId: laneRef.laneId,
      }),
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
