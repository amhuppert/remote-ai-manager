/**
 * Shared execution facade for the AgentCall primitive.
 *
 * Routes a normalized `AgentCallRequest` to the conversation runtime path or
 * the task runner path based on `request.kind`, owning the pre-turn pipeline
 * in a fixed order: backend/runner resolution (via the agent-backends
 * registry when the caller passes semantic intent), portable-MCP apply,
 * dispatch, the shared structured-output gate, and continuity recording.
 * Thrown backend errors are normalized through the registered descriptor's
 * failure classifier, so callers always receive an `AgentCallResult` — never
 * a raw runtime result or a provider error shape.
 *
 * The structured-output gate runs when an `outputSchema` is present — even on
 * a backend that natively enforces the schema — so workflows always see a
 * single normalized validation outcome regardless of where enforcement
 * happens.
 */

import { createLogger, type Logger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type {
  ConversationBackendEvent,
  ConversationBackendRuntime,
  ConversationBackendTurnInput,
  ConversationImageRef,
} from "@/lib/agent-backends/conversation";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import type {
  AgentTaskRequest,
  AgentTaskRunner,
} from "@/lib/agent-backends/task";
import {
  getBackendDescriptor as registryGetBackendDescriptor,
  getTaskRunner as registryGetTaskRunner,
} from "@/lib/agent-backends/registry";
import {
  failureMessage,
  type AgentFailureClassifier,
  type AgentFailureWithContinuation,
  type ContinuationDisposition,
} from "@/lib/agent-backends/errors";
import {
  extractStructuredOutputCandidates,
  type StructuredOutputCandidate,
  type StructuredOutputSource,
} from "@/lib/agent-backends/structured-output";
import {
  buildStructuredOutputRepairPrompt,
  STRUCTURED_OUTPUT_REPAIR_MAX_ISSUES,
  STRUCTURED_OUTPUT_REPAIR_MAX_ISSUE_CHARS,
  STRUCTURED_OUTPUT_REPAIR_MAX_ISSUE_PATHS,
  STRUCTURED_OUTPUT_REPAIR_MAX_ISSUE_PATH_CHARS,
} from "@/lib/agent-backends/structured-output-repair";
import { capabilityViewForBackend } from "./backend-capabilities";
import {
  dispatchConversationTurn,
  type DispatchConversationTurnDeps,
} from "./agent-call-conversation";
import { dispatchTaskRun, type DispatchTaskRunDeps } from "./agent-call-task";
import {
  agentCallRequestSchema,
  buildAgentCallLogFields,
  DEFAULT_LANE_WRITE_CAPABILITY,
  type AgentCallRequest,
  type AgentCallResult,
  type AgentCallStructuredOutputParse,
  type ArtifactRef,
  type BackendCapabilityView,
  type LaneWriteCapability,
} from "./agent-call-vocabulary";
import type { GateFailResult } from "./gate-vocabulary";
import {
  runStructuredOutputGate,
  validateJsonSchemaSubset,
  type StructuredOutputValidator,
} from "./structured-output-gate";

const defaultLogger = createLogger("workflows.primitives.agent-call.facade");

export interface ConversationRuntimeResolution {
  runtime: ConversationBackendRuntime;
  capabilityView: BackendCapabilityView;
  signal: AbortSignal;
  modelId?: string;
  reasoningEffort?: string;
  codexFastMode?: boolean;
  autonomous?: boolean;
  waitForBackgroundTasks?: boolean;
  sessionInstructions?: string[];
  imageRefs?: readonly ConversationImageRef[];
  onEvent?: (event: ConversationBackendEvent) => Promise<void> | void;
  artifacts?: readonly ArtifactRef[];
  syntheticForkSeed?: ConversationBackendTurnInput["syntheticForkSeed"];
}

interface TaskRunnerResolution {
  runner: AgentTaskRunner;
  capabilityView: BackendCapabilityView;
  workingDirectory: string;
  modelId?: string;
  reasoningEffort?: string;
  codexFastMode?: boolean;
  autonomous?: boolean;
  resumeRef?: AgentSessionRef | null;
  defaultTimeoutMs?: number;
  stallTimeoutMs?: number;
  sandboxMode?: AgentTaskRequest["sandboxMode"];
  approvalPolicy?: AgentTaskRequest["approvalPolicy"];
  networkAccessEnabled?: boolean;
  webSearchMode?: AgentTaskRequest["webSearchMode"];
  additionalDirectories?: readonly string[];
  skipGitRepoCheck?: boolean;
  artifacts?: readonly ArtifactRef[];
  /** External cancellation signal for the run (see DispatchTaskRunDeps). */
  signal?: AbortSignal;
  /**
   * Opt-in CC session identity for the child process (see the trust contract
   * on `ccTaskSessionScopeSchema`). Deliberately absent from
   * `TaskExecutionIntent`: only a resolver-callback caller that owns a real
   * session — today the standalone collaboration production caller — can grant
   * it, so no registry-resolved intent path can.
   */
  ccSessionScope?: AgentTaskRequest["ccSessionScope"];
  /**
   * The run's filesystem-write envelope. Sourced from the request rather than
   * from a resolver seam — see the normalization in
   * {@link resolveTaskRunnerResolution}.
   */
  fsWritePolicy?: AgentTaskRequest["fsWritePolicy"];
}

/**
 * Semantic execution intent for a `task_run`: the caller states where and how
 * the run executes; the facade resolves the runner and capability view from
 * the registered backend descriptor. Preferred over `resolveTaskRunner`,
 * which survives only for consumers not yet migrated off resolver callbacks.
 */
export interface TaskExecutionIntent {
  workingDirectory: string;
  autonomous?: boolean;
  resumeRef?: AgentSessionRef | null;
  defaultTimeoutMs?: number;
  /** Per-run inactivity bound forwarded to the runner (see AgentTaskRequest). */
  stallTimeoutMs?: number;
  sandboxMode?: AgentTaskRequest["sandboxMode"];
  approvalPolicy?: AgentTaskRequest["approvalPolicy"];
  networkAccessEnabled?: boolean;
  webSearchMode?: AgentTaskRequest["webSearchMode"];
  additionalDirectories?: readonly string[];
  skipGitRepoCheck?: boolean;
  artifacts?: readonly ArtifactRef[];
  signal?: AbortSignal;
}

/** Outcome of the pre-turn portable-MCP apply hook. */
export type McpApplyHookResult = { ok: true } | { ok: false; message: string };

/** Continuity facts the facade reports after every call. */
export interface ContinuityRecord {
  backend: AgentBackendId;
  backendRef: AgentSessionRef | null;
  continuationDisposition: ContinuationDisposition | undefined;
}

export interface AgentCallFacadeDeps {
  resolveConversationRuntime?: (
    request: Extract<AgentCallRequest, { kind: "conversation_turn" }>,
  ) => ConversationRuntimeResolution | Promise<ConversationRuntimeResolution>;
  /**
   * Legacy resolver seam for `task_run`. New callers pass `taskExecution`
   * (semantic intent) and let the facade resolve the runner via the registry.
   */
  resolveTaskRunner?: (
    request: Extract<AgentCallRequest, { kind: "task_run" }>,
  ) => TaskRunnerResolution | Promise<TaskRunnerResolution>;
  /** Semantic intent for `task_run`; the facade resolves the runner. */
  taskExecution?: TaskExecutionIntent;
  /** Registry override for runner resolution (DI seam; defaults to registry). */
  getTaskRunner?(backend: AgentBackendId): AgentTaskRunner;
  /**
   * Failure-classifier resolution (DI seam; defaults to the registered
   * descriptor's `errors` facet). Thrown dispatch errors and runner-reported
   * error strings normalize through it into the extended failure kinds
   * (`stale_resume_ref`, `session_died`, …).
   */
  getFailureClassifier?(
    backend: AgentBackendId,
  ): AgentFailureClassifier | undefined;
  /**
   * Pre-turn portable-MCP apply hook, run BEFORE dispatch. A `{ ok: false }`
   * outcome fails the call with `capability_unavailable` and the hook's
   * message; the backend never sees the prompt.
   */
  applyMcp?(): Promise<McpApplyHookResult> | McpApplyHookResult;
  /**
   * Post-call continuity recording, invoked with the normalized result's
   * continuation facts after the structured-output gate. Errors are logged
   * and swallowed — recording must never mask the turn result.
   */
  recordContinuity?(record: ContinuityRecord): Promise<void> | void;
  defaultConversationBackend?: AgentBackendId;
  validateStructuredOutput?: StructuredOutputValidator;
  logger?: Logger;
  /**
   * Monotonic clock for the structured-output repair's own elapsed time. A
   * repair is charged against the same budget as the call it repairs, and no
   * backend reports a task run's duration, so this is where that cost becomes
   * observable.
   */
  now?(): number;
}

export interface SchedulingHint {
  writeCapability: LaneWriteCapability;
  allowParallel: boolean;
}

export function resolveSchedulingHint(
  request: AgentCallRequest,
): SchedulingHint {
  const writeCapability =
    request.writeCapability ?? DEFAULT_LANE_WRITE_CAPABILITY;
  return {
    writeCapability,
    allowParallel: writeCapability !== "write_capable",
  };
}

/**
 * Build the follow-up request for a structured-output repair attempt.
 *
 * The repair re-asks for the same answer under the same governance, so the
 * fields that decide *how* the call runs carry forward verbatim — including
 * `systemInstructions`, without which the retry would answer stripped of the
 * instructions that governed the call it repairs. Per-turn payloads (tooling,
 * images) are deliberately dropped: the repair is an isolated one-shot over
 * the prior output, not a re-run of the original turn.
 */
/**
 * Repair turns the structured-output gate spends when a request declares no
 * `structuredOutputRepair` budget of its own.
 *
 * Exported because the budget is otherwise invisible to callers that never set
 * the field — the graph-workflow output-capture turn is one — and a surface
 * reporting "1 of ?" repair turns would be reporting a number it cannot
 * interpret.
 */
export const DEFAULT_STRUCTURED_OUTPUT_REPAIR_ATTEMPTS = 1;

export function buildStructuredOutputRepairRequest(input: {
  request: AgentCallRequest;
  prompt: string;
  backend: AgentBackendId;
}): AgentCallRequest {
  const { request, prompt, backend } = input;
  const carried = {
    prompt,
    ...(request.outputSchema !== undefined
      ? { outputSchema: request.outputSchema }
      : {}),
    ...(request.laneRef !== undefined ? { laneRef: request.laneRef } : {}),
    ...(request.systemInstructions !== undefined
      ? { systemInstructions: request.systemInstructions }
      : {}),
    ...(request.writeCapability !== undefined
      ? { writeCapability: request.writeCapability }
      : {}),
    ...(request.timeoutMs !== undefined
      ? { timeoutMs: request.timeoutMs }
      : {}),
    ...(request.modelId !== undefined ? { modelId: request.modelId } : {}),
    ...(request.reasoningEffort !== undefined
      ? { reasoningEffort: request.reasoningEffort }
      : {}),
  };
  return request.kind === "task_run"
    ? {
        kind: "task_run",
        backend,
        ...carried,
        // A repair turn runs the same agent against the same worktree; letting
        // it drop the envelope would make schema repair the way out of it.
        ...(request.fsWritePolicy !== undefined
          ? { fsWritePolicy: request.fsWritePolicy }
          : {}),
      }
    : { kind: "conversation_turn", backend, ...carried };
}

export async function executeAgentCall(
  request: AgentCallRequest,
  deps: AgentCallFacadeDeps,
): Promise<AgentCallResult> {
  const parsed = agentCallRequestSchema.parse(request);

  if (parsed.kind === "conversation_turn") {
    return finalizeAgentCall(await executeConversationTurn(parsed, deps), deps);
  }
  if (parsed.kind === "task_run") {
    return finalizeAgentCall(await executeTaskRun(parsed, deps), deps);
  }
  // The discriminated union exhausts above; this throw guards against
  // future additions that forget to wire a path.
  throw new Error(
    `executeAgentCall: unsupported request kind "${(parsed as { kind: string }).kind}"`,
  );
}

function resolveClassifier(
  backend: AgentBackendId,
  deps: AgentCallFacadeDeps,
): ((error: unknown) => AgentFailureWithContinuation) | undefined {
  if (deps.getFailureClassifier) {
    const classifier = deps.getFailureClassifier(backend);
    return classifier
      ? (error) => classifier.classifyWithContinuation(error)
      : undefined;
  }
  return (error) => {
    try {
      return registryGetBackendDescriptor(
        backend,
      ).errors.classifyWithContinuation(error);
    } catch {
      // Unregistered backend (e.g. a test double outside the registry): the
      // classifier contract still holds — fall back to a plain backend_error.
      return {
        failure: {
          kind: "backend_error",
          message: failureMessage(error),
          retryable: false,
        },
        continuationDisposition: "retain",
      };
    }
  };
}

/**
 * Run the pre-turn MCP apply hook. Returns a normalized failure result when
 * the hook rejects, null when dispatch may proceed.
 */
async function runMcpApplyHook(
  request: AgentCallRequest,
  deps: AgentCallFacadeDeps,
  backend: AgentBackendId,
): Promise<AgentCallResult | null> {
  if (!deps.applyMcp) return null;
  const applied = await deps.applyMcp();
  if (applied.ok) return null;

  const log = deps.logger ?? defaultLogger;
  const capabilityView = capabilityViewForBackend(backend);
  log.warn("agent_call.facade.mcp_apply_rejected", {
    ...buildAgentCallLogFields({
      requestKind: request.kind,
      backend,
      workflowId: request.laneRef?.workflowId,
      laneId: request.laneRef?.laneId,
    }),
    outcome: "failed",
    message: applied.message,
  });
  return {
    backend,
    backendRef: null,
    capabilities: capabilityView,
    usage: {},
    artifacts: [],
    outcome: {
      kind: "failed",
      error: {
        failureKind: "capability_unavailable",
        backend,
        message: applied.message,
      },
    },
    continuationDisposition: "retain",
  };
}

async function executeConversationTurn(
  request: Extract<AgentCallRequest, { kind: "conversation_turn" }>,
  deps: AgentCallFacadeDeps,
): Promise<AgentCallResult> {
  if (!deps.resolveConversationRuntime) {
    throw new Error(
      "executeAgentCall: deps.resolveConversationRuntime is required for conversation_turn requests",
    );
  }

  const requestedBackend = request.backend ?? deps.defaultConversationBackend;
  const effectiveRequest: typeof request = requestedBackend
    ? { ...request, backend: requestedBackend }
    : request;

  const resolution = await deps.resolveConversationRuntime(effectiveRequest);

  const mcpFailure = await runMcpApplyHook(
    effectiveRequest,
    deps,
    resolution.capabilityView.backend,
  );
  if (mcpFailure) return mcpFailure;

  const classifyFailure = resolveClassifier(
    resolution.capabilityView.backend,
    deps,
  );
  const dispatchDeps: DispatchConversationTurnDeps = {
    runtime: resolution.runtime,
    capabilityView: resolution.capabilityView,
    signal: resolution.signal,
    ...(classifyFailure !== undefined ? { classifyFailure } : {}),
    ...(resolution.modelId !== undefined
      ? { modelId: resolution.modelId }
      : {}),
    ...(resolution.reasoningEffort !== undefined
      ? { reasoningEffort: resolution.reasoningEffort }
      : {}),
    ...(resolution.codexFastMode !== undefined
      ? { codexFastMode: resolution.codexFastMode }
      : {}),
    ...(resolution.autonomous !== undefined
      ? { autonomous: resolution.autonomous }
      : {}),
    ...(resolution.waitForBackgroundTasks !== undefined
      ? { waitForBackgroundTasks: resolution.waitForBackgroundTasks }
      : {}),
    ...(resolution.sessionInstructions !== undefined
      ? { sessionInstructions: [...resolution.sessionInstructions] }
      : {}),
    ...(effectiveRequest.imageRefs !== undefined
      ? { imageRefs: effectiveRequest.imageRefs }
      : resolution.imageRefs !== undefined
        ? { imageRefs: resolution.imageRefs }
        : {}),
    ...(resolution.onEvent !== undefined
      ? { onEvent: resolution.onEvent }
      : {}),
    ...(resolution.artifacts !== undefined
      ? { artifacts: resolution.artifacts }
      : {}),
    ...(resolution.syntheticForkSeed !== undefined
      ? { syntheticForkSeed: resolution.syntheticForkSeed }
      : {}),
  };
  const dispatchResult = await dispatchConversationTurn(
    effectiveRequest,
    dispatchDeps,
  );

  return applyStructuredOutputGate(
    effectiveRequest,
    dispatchResult,
    deps,
    async (prompt) => {
      const repairRequest = buildStructuredOutputRepairRequest({
        request: effectiveRequest,
        prompt,
        backend: resolution.capabilityView.backend,
      });
      return dispatchConversationTurn(repairRequest, {
        ...dispatchDeps,
        waitForBackgroundTasks: false,
        sessionInstructions: [],
        imageRefs: [],
        syntheticForkSeed: null,
      });
    },
  );
}

/**
 * Resolve the runner, then re-assert the request's write envelope over whatever
 * the resolution produced.
 *
 * The policy is server-derived at the dispatch site, so a resolver seam — which
 * may predate the envelope entirely — must not be able to drop it. A resolution
 * may still supply one for a request that carries none (the legacy callback
 * path's only way to restrict a run).
 */
async function resolveTaskRunnerResolution(
  request: Extract<AgentCallRequest, { kind: "task_run" }>,
  deps: AgentCallFacadeDeps,
): Promise<TaskRunnerResolution> {
  const resolution = await resolveTaskRunnerTarget(request, deps);
  return request.fsWritePolicy !== undefined
    ? { ...resolution, fsWritePolicy: request.fsWritePolicy }
    : resolution;
}

async function resolveTaskRunnerTarget(
  request: Extract<AgentCallRequest, { kind: "task_run" }>,
  deps: AgentCallFacadeDeps,
): Promise<TaskRunnerResolution> {
  if (deps.taskExecution) {
    const intent = deps.taskExecution;
    const getRunner = deps.getTaskRunner ?? registryGetTaskRunner;
    return {
      runner: getRunner(request.backend),
      capabilityView: capabilityViewForBackend(request.backend),
      workingDirectory: intent.workingDirectory,
      ...(request.modelId !== undefined ? { modelId: request.modelId } : {}),
      ...(request.reasoningEffort !== undefined
        ? { reasoningEffort: request.reasoningEffort }
        : {}),
      ...(intent.autonomous !== undefined
        ? { autonomous: intent.autonomous }
        : {}),
      ...(intent.resumeRef !== undefined
        ? { resumeRef: intent.resumeRef }
        : {}),
      ...(intent.defaultTimeoutMs !== undefined
        ? { defaultTimeoutMs: intent.defaultTimeoutMs }
        : {}),
      ...(intent.stallTimeoutMs !== undefined
        ? { stallTimeoutMs: intent.stallTimeoutMs }
        : {}),
      ...(intent.sandboxMode !== undefined
        ? { sandboxMode: intent.sandboxMode }
        : {}),
      ...(intent.approvalPolicy !== undefined
        ? { approvalPolicy: intent.approvalPolicy }
        : {}),
      ...(intent.networkAccessEnabled !== undefined
        ? { networkAccessEnabled: intent.networkAccessEnabled }
        : {}),
      ...(intent.webSearchMode !== undefined
        ? { webSearchMode: intent.webSearchMode }
        : {}),
      ...(intent.additionalDirectories !== undefined
        ? { additionalDirectories: intent.additionalDirectories }
        : {}),
      ...(intent.skipGitRepoCheck !== undefined
        ? { skipGitRepoCheck: intent.skipGitRepoCheck }
        : {}),
      ...(intent.artifacts !== undefined
        ? { artifacts: intent.artifacts }
        : {}),
      ...(intent.signal !== undefined ? { signal: intent.signal } : {}),
    };
  }
  if (deps.resolveTaskRunner) {
    return deps.resolveTaskRunner(request);
  }
  throw new Error(
    "executeAgentCall: task_run requests require deps.taskExecution (semantic intent) or deps.resolveTaskRunner",
  );
}

async function executeTaskRun(
  request: Extract<AgentCallRequest, { kind: "task_run" }>,
  deps: AgentCallFacadeDeps,
): Promise<AgentCallResult> {
  const resolution = await resolveTaskRunnerResolution(request, deps);

  const mcpFailure = await runMcpApplyHook(request, deps, request.backend);
  if (mcpFailure) return mcpFailure;

  const classifyFailure = resolveClassifier(request.backend, deps);
  const dispatchDeps: DispatchTaskRunDeps = {
    runner: resolution.runner,
    capabilityView: resolution.capabilityView,
    workingDirectory: resolution.workingDirectory,
    ...(classifyFailure !== undefined ? { classifyFailure } : {}),
    ...(resolution.modelId !== undefined
      ? { modelId: resolution.modelId }
      : {}),
    ...(resolution.reasoningEffort !== undefined
      ? { reasoningEffort: resolution.reasoningEffort }
      : {}),
    ...(resolution.codexFastMode !== undefined
      ? { codexFastMode: resolution.codexFastMode }
      : {}),
    ...(resolution.autonomous !== undefined
      ? { autonomous: resolution.autonomous }
      : {}),
    ...(resolution.resumeRef !== undefined
      ? { resumeRef: resolution.resumeRef }
      : {}),
    ...(resolution.defaultTimeoutMs !== undefined
      ? { defaultTimeoutMs: resolution.defaultTimeoutMs }
      : {}),
    ...(resolution.stallTimeoutMs !== undefined
      ? { stallTimeoutMs: resolution.stallTimeoutMs }
      : {}),
    ...(resolution.sandboxMode !== undefined
      ? { sandboxMode: resolution.sandboxMode }
      : {}),
    ...(resolution.approvalPolicy !== undefined
      ? { approvalPolicy: resolution.approvalPolicy }
      : {}),
    ...(resolution.networkAccessEnabled !== undefined
      ? { networkAccessEnabled: resolution.networkAccessEnabled }
      : {}),
    ...(resolution.webSearchMode !== undefined
      ? { webSearchMode: resolution.webSearchMode }
      : {}),
    ...(resolution.additionalDirectories !== undefined
      ? { additionalDirectories: resolution.additionalDirectories }
      : {}),
    ...(resolution.skipGitRepoCheck !== undefined
      ? { skipGitRepoCheck: resolution.skipGitRepoCheck }
      : {}),
    ...(resolution.artifacts !== undefined
      ? { artifacts: resolution.artifacts }
      : {}),
    ...(resolution.signal !== undefined ? { signal: resolution.signal } : {}),
    ...(resolution.ccSessionScope !== undefined
      ? { ccSessionScope: resolution.ccSessionScope }
      : {}),
    ...(resolution.fsWritePolicy !== undefined
      ? { fsWritePolicy: resolution.fsWritePolicy }
      : {}),
    ...(request.imageRefs !== undefined
      ? { imagePaths: request.imageRefs.map((ref) => ref.path) }
      : {}),
  };
  const dispatchResult = await dispatchTaskRun(request, dispatchDeps);

  return applyStructuredOutputGate(
    request,
    dispatchResult,
    deps,
    async (prompt) => {
      const repairRequest = buildStructuredOutputRepairRequest({
        request,
        prompt,
        backend: request.backend,
      });
      return dispatchTaskRun(repairRequest, {
        ...dispatchDeps,
        resumeRef: null,
        executionProfile: "isolated-one-shot",
        imagePaths: undefined,
      });
    },
  );
}

/** Continuity recording + final logging, shared by both dispatch paths. */
async function finalizeAgentCall(
  result: AgentCallResult,
  deps: AgentCallFacadeDeps,
): Promise<AgentCallResult> {
  if (deps.recordContinuity) {
    try {
      await deps.recordContinuity({
        backend: result.backend,
        backendRef: result.backendRef,
        continuationDisposition: result.continuationDisposition,
      });
    } catch (err) {
      const log = deps.logger ?? defaultLogger;
      log.error("agent_call.facade.record_continuity_failed", {
        backend: result.backend,
        error: getErrorMessage(err),
      });
    }
  }
  return result;
}

type StructuredOutputRepairDispatch = (
  prompt: string,
) => Promise<AgentCallResult>;

type StructuredOutputGateEvaluation =
  | {
      status: "pass";
      candidate: StructuredOutputCandidate | null;
    }
  | {
      status: "fail";
      failure: GateFailResult;
      candidates: StructuredOutputCandidate[];
    };

interface StructuredOutputRepairAggregate {
  usage: AgentCallResult["usage"];
  numTurns?: number;
  compacted?: boolean;
  backgroundWait?: AgentCallResult["backgroundWait"];
}

const MAX_DIAGNOSTIC_TOP_LEVEL_KEYS = 25;
const MAX_DIAGNOSTIC_KEY_CHARS = 80;

async function applyStructuredOutputGate(
  request: AgentCallRequest,
  dispatchResult: AgentCallResult,
  deps: AgentCallFacadeDeps,
  dispatchRepair: StructuredOutputRepairDispatch,
): Promise<AgentCallResult> {
  if (request.outputSchema === undefined) return dispatchResult;
  if (dispatchResult.outcome.kind !== "completed") return dispatchResult;

  const log = deps.logger ?? defaultLogger;
  const now = deps.now ?? (() => performance.now());
  const artifactKinds = deriveArtifactKinds(dispatchResult.artifacts);
  const sharedFields = buildAgentCallLogFields({
    requestKind: request.kind,
    backend: dispatchResult.backend,
    workflowId: request.laneRef?.workflowId,
    laneId: request.laneRef?.laneId,
    ...(artifactKinds !== undefined ? { artifactKinds } : {}),
  });

  const validateStructuredOutput =
    deps.validateStructuredOutput ?? validateJsonSchemaSubset;
  let evaluated = evaluateStructuredOutput(
    dispatchResult.outcome,
    request.outputSchema,
    validateStructuredOutput,
  );
  if (evaluated.status === "pass") {
    return acceptStructuredOutputCandidate(dispatchResult, evaluated.candidate);
  }

  const candidateSources: StructuredOutputSource[] = [];
  const observedSources = new Set<StructuredOutputSource>();
  let currentCandidateTopLevelKeys = topLevelKeys(
    evaluated.candidates[0]?.value,
  );
  let bestCandidateTopLevelKeys = currentCandidateTopLevelKeys;
  collectCandidateSources(
    evaluated.candidates,
    observedSources,
    candidateSources,
  );

  const maxAttempts =
    request.structuredOutputRepair?.maxAttempts ??
    DEFAULT_STRUCTURED_OUTPUT_REPAIR_ATTEMPTS;
  let repairAttempts = 0;
  let failedResult = dispatchResult;
  let latestRepairResult: AgentCallResult | null = null;
  let aggregate = createRepairAggregate(dispatchResult);

  while (repairAttempts < maxAttempts) {
    const attempt = repairAttempts + 1;
    const issues = failureIssues(
      evaluated.failure,
      currentCandidateTopLevelKeys,
    );
    const issuePaths = extractIssuePaths(issues);
    const priorOutputText = priorOutputForRepair(
      failedResult.outcome.kind === "completed"
        ? failedResult.outcome.text
        : null,
      evaluated.candidates[0],
    );

    log.info("agent_call.facade.structured_output_repair_attempted", {
      ...sharedFields,
      attempt,
      issuePaths,
      ...usageLogFields("initial", dispatchResult.usage),
    });

    const repairStartedAt = now();
    const repairResult = await dispatchRepair(
      buildStructuredOutputRepairPrompt({
        schema: request.outputSchema,
        priorOutputText,
        issues,
      }),
    );
    const repairDurationMs = Math.round(now() - repairStartedAt);
    repairAttempts = attempt;
    latestRepairResult = repairResult;
    aggregate = appendRepairAggregate(aggregate, repairResult);

    if (repairResult.outcome.kind !== "completed") {
      log.warn("agent_call.facade.structured_output_repair_failed", {
        ...sharedFields,
        attempt,
        issuePaths,
        repairDurationMs,
        ...usageLogFields("initial", dispatchResult.usage),
        ...usageLogFields("repair", repairResult.usage),
      });
      return buildNonCompletedRepairResult({
        requestKind: request.kind,
        initialResult: dispatchResult,
        repairResult,
        aggregate,
      });
    }

    const repairedEvaluation = evaluateStructuredOutput(
      repairResult.outcome,
      request.outputSchema,
      validateStructuredOutput,
    );
    if (repairedEvaluation.status === "pass") {
      log.info("agent_call.facade.structured_output_repair_succeeded", {
        ...sharedFields,
        attempt,
        issuePaths,
        repairDurationMs,
        ...usageLogFields("initial", dispatchResult.usage),
        ...usageLogFields("repair", repairResult.usage),
      });
      return buildRepairedSuccess({
        requestKind: request.kind,
        initialResult: dispatchResult,
        repairResult,
        candidate: repairedEvaluation.candidate,
        repairAttempts,
        aggregate,
      });
    }

    collectCandidateSources(
      repairedEvaluation.candidates,
      observedSources,
      candidateSources,
    );
    currentCandidateTopLevelKeys = topLevelKeys(
      repairedEvaluation.candidates[0]?.value,
    );
    if (
      currentCandidateTopLevelKeys.length > bestCandidateTopLevelKeys.length
    ) {
      bestCandidateTopLevelKeys = currentCandidateTopLevelKeys;
    }
    evaluated = repairedEvaluation;
    failedResult = repairResult;
    log.warn("agent_call.facade.structured_output_repair_failed", {
      ...sharedFields,
      attempt,
      issuePaths: extractIssuePaths(
        failureIssues(evaluated.failure, currentCandidateTopLevelKeys),
      ),
    });
  }

  const backendDetails = {
    ...(evaluated.failure.details ?? {}),
    candidateSources,
    candidateTopLevelKeys: bestCandidateTopLevelKeys,
    repairAttempts,
    // The budget those attempts were spent against travels with them: a caller
    // that reports "1 repair turn" cannot say whether that exhausted the gate
    // or merely opened it without knowing what the bound was.
    repairMaxAttempts: maxAttempts,
  };

  log.warn("agent_call.facade.structured_output_failed", {
    ...sharedFields,
    outcome: "failed",
    reason: evaluated.failure.reason,
    candidateSources,
    candidateTopLevelKeys: bestCandidateTopLevelKeys,
    repairAttempts,
  });

  return failWithSchemaValidation(
    buildInitialEvidenceResult({
      requestKind: request.kind,
      initialResult: dispatchResult,
      latestRepairResult,
      aggregate,
    }),
    evaluated.failure.reason,
    backendDetails,
  );
}

function evaluateStructuredOutput(
  completed: Extract<AgentCallResult["outcome"], { kind: "completed" }>,
  schema: Record<string, unknown>,
  validator: StructuredOutputValidator,
): StructuredOutputGateEvaluation {
  const candidates = extractStructuredOutputCandidates({
    ...(completed.structuredOutput !== undefined
      ? { native: completed.structuredOutput }
      : {}),
    text: completed.text,
  });

  // Candidates are gated in extraction-precedence order; the first passing one
  // wins, so an invalid native payload falls through to a valid raw/fenced one.
  // When every candidate fails, the reported reason is the highest-priority
  // candidate's — that is the payload the backend intended as the answer.
  let firstFailure: GateFailResult | null = null;
  for (const candidate of candidates) {
    const gate = runStructuredOutputGate(schema, candidate.value, validator);
    if (gate.status === "pass") {
      return { status: "pass", candidate };
    }
    firstFailure ??= gate;
  }

  if (firstFailure !== null) {
    return { status: "fail", failure: firstFailure, candidates };
  }

  const gate = runStructuredOutputGate(schema, undefined, validator);
  return gate.status === "pass"
    ? { status: "pass", candidate: null }
    : { status: "fail", failure: gate, candidates };
}

function acceptStructuredOutputCandidate(
  result: AgentCallResult,
  candidate: StructuredOutputCandidate | null,
): AgentCallResult {
  if (candidate === null || result.outcome.kind !== "completed") return result;
  const parse: AgentCallStructuredOutputParse = {
    source: candidate.source,
  };
  return {
    ...result,
    outcome: {
      ...result.outcome,
      structuredOutput: candidate.value,
      parse,
    },
  };
}

function topLevelKeys(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  return Object.keys(value)
    .sort()
    .slice(0, MAX_DIAGNOSTIC_TOP_LEVEL_KEYS)
    .map((key) => key.slice(0, MAX_DIAGNOSTIC_KEY_CHARS));
}

function collectCandidateSources(
  candidates: readonly StructuredOutputCandidate[],
  observed: Set<StructuredOutputSource>,
  destination: StructuredOutputSource[],
): void {
  for (const candidate of candidates) {
    if (observed.has(candidate.source)) continue;
    observed.add(candidate.source);
    destination.push(candidate.source);
  }
}

function failureIssues(
  failure: GateFailResult,
  candidateTopLevelKeys: readonly string[],
): string[] {
  const detailErrors = failure.details?.["errors"];
  const rawIssues =
    Array.isArray(detailErrors) &&
    detailErrors.every((error): error is string => typeof error === "string") &&
    detailErrors.length > 0
      ? [...detailErrors]
      : [failure.reason];
  const hasDecodedKeys = candidateTopLevelKeys.length > 0;
  const issueBudget =
    STRUCTURED_OUTPUT_REPAIR_MAX_ISSUES - (hasDecodedKeys ? 1 : 0);
  const issues = rawIssues
    .slice(0, issueBudget)
    .map((issue) => issue.slice(0, STRUCTURED_OUTPUT_REPAIR_MAX_ISSUE_CHARS));
  if (hasDecodedKeys) {
    issues.push(
      `Decoded top-level keys were ${JSON.stringify(
        candidateTopLevelKeys,
      )}`.slice(0, STRUCTURED_OUTPUT_REPAIR_MAX_ISSUE_CHARS),
    );
  }
  return issues;
}

function extractIssuePaths(issues: readonly string[]): string[] {
  const paths = new Set<string>();
  for (const issue of issues) {
    const match = issue.match(/(\$(?:\.[A-Za-z0-9_-]+|\[[0-9]+\])*)/);
    if (match?.[1]) {
      paths.add(
        match[1].slice(0, STRUCTURED_OUTPUT_REPAIR_MAX_ISSUE_PATH_CHARS),
      );
    }
    if (paths.size >= STRUCTURED_OUTPUT_REPAIR_MAX_ISSUE_PATHS) break;
  }
  return paths.size > 0 ? [...paths] : ["$"];
}

function priorOutputForRepair(
  text: string | null,
  candidate: StructuredOutputCandidate | undefined,
): string {
  if (text !== null && text.length > 0) return text;
  if (candidate === undefined) return "";
  try {
    return JSON.stringify(candidate.value) ?? "";
  } catch {
    return "";
  }
}

function sumOptionalNumber(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return left + right;
}

function mergeUsage(
  initial: AgentCallResult["usage"],
  repair: AgentCallResult["usage"],
): AgentCallResult["usage"] {
  const inputTokens = sumOptionalNumber(
    initial.inputTokens,
    repair.inputTokens,
  );
  const outputTokens = sumOptionalNumber(
    initial.outputTokens,
    repair.outputTokens,
  );
  const cachedInputTokens = sumOptionalNumber(
    initial.cachedInputTokens,
    repair.cachedInputTokens,
  );
  const costUsd = sumOptionalNumber(initial.costUsd, repair.costUsd);
  const durationMs = sumOptionalNumber(initial.durationMs, repair.durationMs);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(repair.contextTokens !== undefined
      ? { contextTokens: repair.contextTokens }
      : initial.contextTokens !== undefined
        ? { contextTokens: initial.contextTokens }
        : {}),
    ...(repair.contextWindowMax !== undefined
      ? { contextWindowMax: repair.contextWindowMax }
      : initial.contextWindowMax !== undefined
        ? { contextWindowMax: initial.contextWindowMax }
        : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    // Cumulative snapshot: latest wins, like contextTokens.
    ...(repair.cumulativeCostUsd !== undefined
      ? { cumulativeCostUsd: repair.cumulativeCostUsd }
      : initial.cumulativeCostUsd !== undefined
        ? { cumulativeCostUsd: initial.cumulativeCostUsd }
        : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

function outcomeNumTurns(result: AgentCallResult): number | undefined {
  return result.outcome.kind === "completed" || result.outcome.kind === "failed"
    ? result.outcome.numTurns
    : undefined;
}

/**
 * One attempt's token and cost usage, flattened onto a log line under a prefix.
 *
 * A repair earns its place only if it costs a fraction of the call it repairs,
 * so the baseline and the repair are reported on the same event: the ratio is
 * readable from one line instead of a join across two. A metric the backend did
 * not report stays absent rather than being flattened to zero, which would read
 * as "free".
 *
 * Elapsed time is not among these. `AgentTaskResult.usage` carries no duration,
 * so a repair's wall-clock cost is measured here, at the only place that spans
 * the dispatch.
 */
function usageLogFields(
  prefix: "initial" | "repair",
  usage: AgentCallResult["usage"],
): Record<string, number> {
  const fields: Record<string, number> = {};
  const put = (suffix: string, value: number | undefined): void => {
    if (value !== undefined) fields[`${prefix}${suffix}`] = value;
  };
  put("CostUsd", usage.costUsd);
  put("InputTokens", usage.inputTokens);
  put("OutputTokens", usage.outputTokens);
  return fields;
}

function createRepairAggregate(
  result: AgentCallResult,
): StructuredOutputRepairAggregate {
  const numTurns = outcomeNumTurns(result);
  return {
    usage: result.usage,
    ...(numTurns !== undefined ? { numTurns } : {}),
    ...(result.compacted !== undefined ? { compacted: result.compacted } : {}),
    ...(result.backgroundWait !== undefined
      ? { backgroundWait: result.backgroundWait }
      : {}),
  };
}

function appendRepairAggregate(
  aggregate: StructuredOutputRepairAggregate,
  result: AgentCallResult,
): StructuredOutputRepairAggregate {
  const numTurns = sumOptionalNumber(
    aggregate.numTurns,
    outcomeNumTurns(result),
  );
  const hasCompactionSignal =
    aggregate.compacted !== undefined || result.compacted !== undefined;
  return {
    usage: mergeUsage(aggregate.usage, result.usage),
    ...(numTurns !== undefined ? { numTurns } : {}),
    ...(hasCompactionSignal
      ? { compacted: aggregate.compacted === true || result.compacted === true }
      : {}),
    ...(result.backgroundWait !== undefined
      ? { backgroundWait: result.backgroundWait }
      : aggregate.backgroundWait !== undefined
        ? { backgroundWait: aggregate.backgroundWait }
        : {}),
  };
}

function applyRepairAggregate(
  result: AgentCallResult,
  aggregate: StructuredOutputRepairAggregate,
): AgentCallResult {
  const outcome =
    aggregate.numTurns !== undefined &&
    (result.outcome.kind === "completed" || result.outcome.kind === "failed")
      ? { ...result.outcome, numTurns: aggregate.numTurns }
      : result.outcome;
  return {
    ...result,
    usage: aggregate.usage,
    outcome,
    ...(aggregate.compacted !== undefined
      ? { compacted: aggregate.compacted }
      : {}),
    ...(aggregate.backgroundWait !== undefined
      ? { backgroundWait: aggregate.backgroundWait }
      : {}),
  };
}

function buildInitialEvidenceResult(input: {
  requestKind: AgentCallRequest["kind"];
  initialResult: AgentCallResult;
  latestRepairResult: AgentCallResult | null;
  aggregate: StructuredOutputRepairAggregate;
}): AgentCallResult {
  const accountedInitial = applyRepairAggregate(
    input.initialResult,
    input.aggregate,
  );
  if (input.requestKind === "task_run" || input.latestRepairResult === null) {
    return accountedInitial;
  }
  const continuationDisposition =
    input.latestRepairResult.continuationDisposition;
  const backendRef =
    continuationDisposition === "clear"
      ? null
      : (input.latestRepairResult.backendRef ?? input.initialResult.backendRef);
  return {
    ...accountedInitial,
    backendRef,
    continuationDisposition,
  };
}

function buildNonCompletedRepairResult(input: {
  requestKind: AgentCallRequest["kind"];
  initialResult: AgentCallResult;
  repairResult: AgentCallResult;
  aggregate: StructuredOutputRepairAggregate;
}): AgentCallResult {
  const base = buildInitialEvidenceResult({
    requestKind: input.requestKind,
    initialResult: input.initialResult,
    latestRepairResult: input.repairResult,
    aggregate: input.aggregate,
  });
  if (
    input.initialResult.outcome.kind !== "completed" ||
    input.repairResult.outcome.kind !== "failed"
  ) {
    return { ...base, outcome: input.repairResult.outcome };
  }

  const initialOutcome = input.initialResult.outcome;
  const repairOutcome = input.repairResult.outcome;
  const transcript = initialOutcome.transcript ?? repairOutcome.transcript;
  const contentBlocks =
    initialOutcome.contentBlocks ?? repairOutcome.contentBlocks;
  return {
    ...base,
    outcome: {
      kind: "failed",
      ...(transcript !== undefined ? { transcript } : {}),
      ...(contentBlocks !== undefined ? { contentBlocks } : {}),
      ...(input.aggregate.numTurns !== undefined
        ? { numTurns: input.aggregate.numTurns }
        : {}),
      error: repairOutcome.error,
    },
  };
}

function buildRepairedSuccess(input: {
  requestKind: AgentCallRequest["kind"];
  initialResult: AgentCallResult;
  repairResult: AgentCallResult;
  candidate: StructuredOutputCandidate | null;
  repairAttempts: number;
  aggregate: StructuredOutputRepairAggregate;
}): AgentCallResult {
  if (input.repairResult.outcome.kind !== "completed") {
    return input.initialResult;
  }
  const repairedOutcome =
    input.candidate === null
      ? input.repairResult.outcome
      : {
          ...input.repairResult.outcome,
          structuredOutput: input.candidate.value,
          parse: {
            source: input.candidate.source,
            repaired: true,
            repairAttempts: input.repairAttempts,
          } satisfies AgentCallStructuredOutputParse,
        };
  if (input.requestKind === "conversation_turn") {
    return applyRepairAggregate(
      {
        ...input.repairResult,
        artifacts: [...input.initialResult.artifacts],
        outcome: repairedOutcome,
      },
      input.aggregate,
    );
  }

  return applyRepairAggregate(
    {
      ...input.initialResult,
      outcome: repairedOutcome,
    },
    input.aggregate,
  );
}

function deriveArtifactKinds(
  artifacts: readonly ArtifactRef[] | undefined,
): readonly string[] | undefined {
  if (!artifacts || artifacts.length === 0) return undefined;
  return artifacts.map((a) => a.kind);
}

function failWithSchemaValidation(
  dispatchResult: AgentCallResult,
  message: string,
  details?: Record<string, unknown>,
): AgentCallResult {
  const completed =
    dispatchResult.outcome.kind === "completed"
      ? dispatchResult.outcome
      : undefined;
  // The refused reply IS the evidence for a schema failure — a caller can only
  // report what was wrong, or feed it back to a retry, if it can still see it.
  // Backends that report a turn as `text` alone (the task-run adapters) carry no
  // `contentBlocks`, so project the text into the block vocabulary rather than
  // dropping the payload on the way to `failed`.
  const refusedContentBlocks =
    completed?.contentBlocks ??
    (completed?.text
      ? [{ type: "text" as const, text: completed.text }]
      : undefined);
  return {
    ...dispatchResult,
    outcome: {
      kind: "failed",
      ...(completed?.transcript !== undefined
        ? { transcript: completed.transcript }
        : {}),
      ...(refusedContentBlocks !== undefined
        ? { contentBlocks: refusedContentBlocks }
        : {}),
      ...(completed?.numTurns !== undefined
        ? { numTurns: completed.numTurns }
        : {}),
      error: {
        failureKind: "schema_validation",
        backend: dispatchResult.backend,
        message,
        ...(details !== undefined ? { backendDetails: details } : {}),
      },
    },
    // Validation changes the workflow outcome, not the provider continuation.
    // Preserve the adapter verdict/ref pair exactly as returned by dispatch.
    continuationDisposition: dispatchResult.continuationDisposition,
  };
}
