/**
 * Shared execution facade for the AgentCall primitive.
 *
 * Routes a normalized `AgentCallRequest` to the conversation runtime path or
 * the task runner path based on `request.kind`, then runs the shared
 * structured-output gate when an `outputSchema` is present — even on a
 * backend that natively enforces the schema — so workflows always see a
 * single normalized validation outcome regardless of where enforcement
 * happens.
 *
 * Lane construction (resolving the right runtime/runner for a lane state) is
 * the responsibility of the LaneService introduced in section 2; this
 * facade only consumes the resolver callbacks.
 */

import { createLogger, type Logger } from "@/lib/logging";
import type {
  ConversationBackendEvent,
  ConversationBackendRuntime,
  ConversationBackendTurnInput,
  ConversationImageRef,
} from "@/lib/agent-backends/conversation";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { AgentSessionRef } from "@/lib/agent-backends/schemas";
import type {
  AgentTaskRequest,
  AgentTaskRunner,
} from "@/lib/agent-backends/task";
import { dispatchConversationTurn } from "./agent-call-conversation";
import { dispatchTaskRun } from "./agent-call-task";
import {
  agentCallRequestSchema,
  buildAgentCallLogFields,
  type AgentCallRequest,
  type AgentCallResult,
  type ArtifactRef,
  type BackendCapabilityView,
  type LaneWriteCapability,
} from "./agent-call-vocabulary";
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

export interface AgentCallFacadeDeps {
  resolveConversationRuntime?: (
    request: Extract<AgentCallRequest, { kind: "conversation_turn" }>,
  ) => ConversationRuntimeResolution | Promise<ConversationRuntimeResolution>;
  resolveTaskRunner?: (
    request: Extract<AgentCallRequest, { kind: "task_run" }>,
  ) => TaskRunnerResolution | Promise<TaskRunnerResolution>;
  defaultConversationBackend?: AgentBackendId;
  validateStructuredOutput?: StructuredOutputValidator;
  logger?: Logger;
}

export interface SchedulingHint {
  writeCapability: LaneWriteCapability;
  allowParallel: boolean;
}

const DEFAULT_WRITE_CAPABILITY: LaneWriteCapability = "write_capable";

export function resolveSchedulingHint(
  request: AgentCallRequest,
): SchedulingHint {
  const writeCapability = request.writeCapability ?? DEFAULT_WRITE_CAPABILITY;
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
    return executeConversationTurn(parsed, deps);
  }
  if (parsed.kind === "task_run") {
    return executeTaskRun(parsed, deps);
  }
  // The discriminated union exhausts above; this throw guards against
  // future additions that forget to wire a path.
  throw new Error(
    `executeAgentCall: unsupported request kind "${(parsed as { kind: string }).kind}"`,
  );
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
  const dispatchResult = await dispatchConversationTurn(effectiveRequest, {
    runtime: resolution.runtime,
    capabilityView: resolution.capabilityView,
    signal: resolution.signal,
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
    ...(resolution.imageRefs !== undefined
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

async function executeTaskRun(
  request: Extract<AgentCallRequest, { kind: "task_run" }>,
  deps: AgentCallFacadeDeps,
): Promise<AgentCallResult> {
  if (!deps.resolveTaskRunner) {
    throw new Error(
      "executeAgentCall: deps.resolveTaskRunner is required for task_run requests",
    );
  }
  const resolution = await deps.resolveTaskRunner(request);
  const dispatchResult = await dispatchTaskRun(request, {
    runner: resolution.runner,
    capabilityView: resolution.capabilityView,
    workingDirectory: resolution.workingDirectory,
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
  });

  return applyStructuredOutputGate(request, dispatchResult, deps);
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
  const structuredOutput = resolveStructuredOutputCandidate(completed);
  const validateStructuredOutput =
    deps.validateStructuredOutput ?? validateJsonSchemaSubset;
  const gate = runStructuredOutputGate(
    request.outputSchema,
    structuredOutput.value,
    validateStructuredOutput,
  );

  if (gate.status === "pass") {
    if (structuredOutput.source === "existing") return dispatchResult;
    return {
      ...dispatchResult,
      outcome: {
        ...completed,
        structuredOutput: structuredOutput.value,
      },
    };
  }

  log.warn("agent_call.facade.structured_output_failed", {
    ...sharedFields,
    outcome: "failed",
    reason: gate.reason,
  });

  return failWithSchemaValidation(dispatchResult, gate.reason, gate.details);
}

function resolveStructuredOutputCandidate(
  outcome: Extract<AgentCallResult["outcome"], { kind: "completed" }>,
): { source: "existing" | "parsed_text"; value: unknown } {
  if (outcome.structuredOutput !== undefined) {
    return { source: "existing", value: outcome.structuredOutput };
  }
  const parsed = parseStructuredOutputText(outcome.text);
  if (parsed.found) return { source: "parsed_text", value: parsed.value };
  return { source: "existing", value: undefined };
}

function parseStructuredOutputText(
  text: string | null,
): { found: true; value: unknown } | { found: false } {
  if (!text) return { found: false };
  const raw = tryParseJson(text);
  if (raw.found) return raw;

  const fenced = extractLastJsonFence(text);
  if (!fenced) return { found: false };
  return tryParseJson(fenced);
}

function tryParseJson(
  text: string,
): { found: true; value: unknown } | { found: false } {
  try {
    return { found: true, value: JSON.parse(text) };
  } catch {
    return { found: false };
  }
}

function extractLastJsonFence(text: string): string | null {
  const matches = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const last = matches.at(-1);
  return last?.[1]?.trim() ?? null;
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
  return {
    ...dispatchResult,
    outcome: {
      kind: "failed",
      ...(dispatchResult.outcome.kind === "completed" &&
      dispatchResult.outcome.transcript !== undefined
        ? { transcript: dispatchResult.outcome.transcript }
        : {}),
      error: {
        failureKind: "schema_validation",
        backend: dispatchResult.backend,
        message,
        ...(details !== undefined ? { backendDetails: details } : {}),
      },
    },
  };
}
