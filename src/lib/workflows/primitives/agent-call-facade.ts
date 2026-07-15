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
import { extractStructuredOutputCandidates } from "@/lib/agent-backends/structured-output";
import { capabilityViewForBackend } from "./backend-capabilities";
import { dispatchConversationTurn } from "./agent-call-conversation";
import { dispatchTaskRun } from "./agent-call-task";
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
  autonomous?: boolean;
  resumeRef?: AgentSessionRef | null;
  defaultTimeoutMs?: number;
  sandboxMode?: AgentTaskRequest["sandboxMode"];
  approvalPolicy?: AgentTaskRequest["approvalPolicy"];
  networkAccessEnabled?: boolean;
  webSearchMode?: AgentTaskRequest["webSearchMode"];
  additionalDirectories?: readonly string[];
  skipGitRepoCheck?: boolean;
  artifacts?: readonly ArtifactRef[];
  /** External cancellation signal for the run (see DispatchTaskRunDeps). */
  signal?: AbortSignal;
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
  const dispatchResult = await dispatchConversationTurn(effectiveRequest, {
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
  });

  return applyStructuredOutputGate(effectiveRequest, dispatchResult, deps);
}

async function resolveTaskRunnerResolution(
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
  const dispatchResult = await dispatchTaskRun(request, {
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
    ...(resolution.autonomous !== undefined
      ? { autonomous: resolution.autonomous }
      : {}),
    ...(resolution.resumeRef !== undefined
      ? { resumeRef: resolution.resumeRef }
      : {}),
    ...(resolution.defaultTimeoutMs !== undefined
      ? { defaultTimeoutMs: resolution.defaultTimeoutMs }
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
    ...(request.imageRefs !== undefined
      ? { imagePaths: request.imageRefs.map((ref) => ref.path) }
      : {}),
  });

  return applyStructuredOutputGate(request, dispatchResult, deps);
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

function applyStructuredOutputGate(
  request: AgentCallRequest,
  dispatchResult: AgentCallResult,
  deps: AgentCallFacadeDeps,
): AgentCallResult {
  if (request.outputSchema === undefined) return dispatchResult;
  if (dispatchResult.outcome.kind !== "completed") return dispatchResult;

  const log = deps.logger ?? defaultLogger;
  const artifactKinds = deriveArtifactKinds(dispatchResult.artifacts);
  const sharedFields = buildAgentCallLogFields({
    requestKind: request.kind,
    backend: dispatchResult.backend,
    workflowId: request.laneRef?.workflowId,
    laneId: request.laneRef?.laneId,
    ...(artifactKinds !== undefined ? { artifactKinds } : {}),
  });

  const completed = dispatchResult.outcome;
  const validateStructuredOutput =
    deps.validateStructuredOutput ?? validateJsonSchemaSubset;
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
    const gate = runStructuredOutputGate(
      request.outputSchema,
      candidate.value,
      validateStructuredOutput,
    );
    if (gate.status === "pass") {
      const parse: AgentCallStructuredOutputParse = {
        source: candidate.source,
      };
      return {
        ...dispatchResult,
        outcome: {
          ...completed,
          structuredOutput: candidate.value,
          parse,
        },
      };
    }
    firstFailure ??= gate;
  }

  if (firstFailure === null) {
    const gate = runStructuredOutputGate(
      request.outputSchema,
      undefined,
      validateStructuredOutput,
    );
    if (gate.status === "pass") return dispatchResult;
    firstFailure = gate;
  }

  log.warn("agent_call.facade.structured_output_failed", {
    ...sharedFields,
    outcome: "failed",
    reason: firstFailure.reason,
  });

  return failWithSchemaValidation(
    dispatchResult,
    firstFailure.reason,
    firstFailure.details,
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
  return {
    ...dispatchResult,
    outcome: {
      kind: "failed",
      ...(completed?.transcript !== undefined
        ? { transcript: completed.transcript }
        : {}),
      ...(completed?.contentBlocks !== undefined
        ? { contentBlocks: completed.contentBlocks }
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
