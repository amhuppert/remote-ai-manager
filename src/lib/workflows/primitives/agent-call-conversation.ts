/**
 * Conversation-style dispatch path for the AgentCall primitive.
 *
 * Forwards a shared `conversation_turn` request to an existing
 * `ConversationBackendRuntime` (the conversation-oriented runtime path) and
 * normalizes the runtime's `ConversationBackendTurnResult` into the shared
 * `AgentCallResult` shape from the execution vocabulary.
 *
 * Responsibilities:
 *  - Inject any workflow-specific portable MCP tooling before the turn starts.
 *  - Normalize backend errors, aborts, and thrown exceptions into the shared
 *    failure shape while preserving backend identity.
 *
 * Lane continuity is owned by the LaneService (introduced in section 2);
 * this module assumes the caller has already constructed a
 * `ConversationBackendRuntime` from the appropriate lane state.
 */

import { createLogger, type Logger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type {
  ConversationBackendRuntime,
  ConversationBackendEvent,
  ConversationBackendTurnInput,
  ConversationBackendTurnResult,
  ConversationImageRef,
} from "@/lib/agent-backends/conversation";
import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import type { AgentFailureWithContinuation } from "@/lib/agent-backends/errors";
import {
  buildAgentCallLogFields,
  type AgentCallRequest,
  type AgentCallResult,
  type ArtifactRef,
  type BackendCapabilityView,
  type NormalizedAgentCallFailureKind,
} from "./agent-call-vocabulary";

const defaultLogger = createLogger(
  "workflows.primitives.agent-call.conversation",
);

export interface DispatchConversationTurnDeps {
  runtime: ConversationBackendRuntime;
  capabilityView: BackendCapabilityView;
  signal: AbortSignal;
  modelId?: string;
  reasoningEffort?: string;
  codexFastMode?: boolean;
  autonomous?: boolean;
  /**
   * Opt-in: hold the turn open until in-flight waitable background tasks
   * settle. Forwarded onto the backend turn input; backends without
   * background-task lifecycle signals ignore it.
   */
  waitForBackgroundTasks?: boolean;
  sessionInstructions?: string[];
  imageRefs?: readonly ConversationImageRef[];
  onEvent?: (event: ConversationBackendEvent) => Promise<void> | void;
  /** Pre-known artifact references the caller wants attached to the result. */
  artifacts?: readonly ArtifactRef[];
  syntheticForkSeed?: ConversationBackendTurnInput["syntheticForkSeed"];
  /**
   * Backend failure classifier for thrown dispatch errors (the registered
   * descriptor's `errors.classify`). When absent, a thrown error normalizes
   * to `backend_error`.
   */
  classifyFailure?(error: unknown): AgentFailureWithContinuation;
  /** Optional logger override; defaults to the module logger. */
  logger?: Logger;
}

export async function dispatchConversationTurn(
  request: AgentCallRequest,
  deps: DispatchConversationTurnDeps,
): Promise<AgentCallResult> {
  if (request.kind !== "conversation_turn") {
    throw new Error(
      `dispatchConversationTurn requires kind "conversation_turn", got "${request.kind}"`,
    );
  }

  const { runtime, capabilityView, signal } = deps;
  const backend = runtime.backend;
  const log = deps.logger ?? defaultLogger;
  const artifactKinds = deriveArtifactKinds(deps.artifacts);
  const baseLogFields = buildAgentCallLogFields({
    requestKind: "conversation_turn",
    backend,
    workflowId: request.laneRef?.workflowId,
    laneId: request.laneRef?.laneId,
    ...(artifactKinds !== undefined ? { artifactKinds } : {}),
  });

  log.debug("agent_call.conversation.dispatch_start", baseLogFields);

  if (request.tooling) {
    const toolingResult = await applyToolingIfPossible(
      runtime,
      request.tooling as PortableMcpConfig,
      capabilityView,
    );
    if (!toolingResult.ok) {
      log.warn("agent_call.conversation.tooling_unavailable", {
        ...baseLogFields,
        outcome: "failed",
        message: toolingResult.message,
      });
      return buildFailureResult({
        backend,
        capabilityView,
        backendRef: null,
        artifacts: deps.artifacts,
        failureKind: "capability_unavailable",
        message: toolingResult.message,
        continuationDisposition: "retain",
      });
    }
  }

  const turnInput: ConversationBackendTurnInput = {
    promptText: request.prompt,
    imageRefs: deps.imageRefs ?? [],
    sessionInstructions: [...(deps.sessionInstructions ?? [])],
    modelId: deps.modelId,
    reasoningEffort: deps.reasoningEffort,
    ...(deps.codexFastMode !== undefined
      ? { codexFastMode: deps.codexFastMode }
      : {}),
    autonomous: deps.autonomous ?? false,
    ...(deps.waitForBackgroundTasks ? { waitForBackgroundTasks: true } : {}),
    outputFormat: request.outputSchema
      ? { type: "json_schema", schema: request.outputSchema }
      : undefined,
    signal,
    onEvent: deps.onEvent ?? (() => {}),
    syntheticForkSeed: deps.syntheticForkSeed ?? null,
  };

  let turnResult: ConversationBackendTurnResult;
  try {
    turnResult = await runtime.sendTurn(turnInput);
  } catch (err) {
    const decision = deps.classifyFailure?.(err);
    const classification = decision?.failure;
    const message = classification?.message ?? getErrorMessage(err);
    log.warn("agent_call.conversation.send_turn_threw", {
      ...baseLogFields,
      outcome: "failed",
      ...(classification !== undefined
        ? { failureKind: classification.kind }
        : {}),
      message,
    });
    return buildFailureResult({
      backend,
      capabilityView,
      backendRef: null,
      artifacts: deps.artifacts,
      failureKind: classification?.kind ?? "backend_error",
      message,
      continuationDisposition: decision?.continuationDisposition ?? "retain",
    });
  }

  if (turnResult.aborted) {
    log.warn("agent_call.conversation.aborted", {
      ...baseLogFields,
      outcome: "failed",
      message: turnResult.failure?.message ?? "aborted",
    });
    return buildFailureResult({
      backend,
      capabilityView,
      backendRef: turnResult.backendRef,
      artifacts: deps.artifacts,
      failureKind: "aborted",
      message: turnResult.failure?.message ?? "aborted",
      turnResult,
    });
  }

  if (turnResult.failure) {
    log.warn("agent_call.conversation.runtime_error", {
      ...baseLogFields,
      outcome: "failed",
      failureKind: turnResult.failure.kind,
      message: turnResult.failure.message,
    });
    return buildFailureResult({
      backend,
      capabilityView,
      backendRef: turnResult.backendRef,
      artifacts: deps.artifacts,
      failureKind: turnResult.failure.kind,
      message: turnResult.failure.message,
      turnResult,
    });
  }

  const text = extractText(turnResult);
  const usage = buildUsageMetrics(turnResult);

  log.debug("agent_call.conversation.dispatch_complete", {
    ...baseLogFields,
    outcome: "completed",
  });

  return {
    backend,
    backendRef: turnResult.backendRef,
    capabilities: capabilityView,
    usage,
    artifacts: [...(deps.artifacts ?? [])],
    outcome: {
      kind: "completed",
      text,
      ...(turnResult.structuredOutput !== undefined
        ? { structuredOutput: turnResult.structuredOutput }
        : {}),
      ...(turnResult.numTurns != null ? { numTurns: turnResult.numTurns } : {}),
      contentBlocks: turnResult.contentBlocks,
    },
    continuationDisposition: turnResult.continuationDisposition,
    compacted: turnResult.compacted,
    ...(turnResult.backgroundWait !== undefined
      ? { backgroundWait: turnResult.backgroundWait }
      : {}),
  };
}

interface ApplyToolingOk {
  ok: true;
}

interface ApplyToolingFail {
  ok: false;
  message: string;
}

async function applyToolingIfPossible(
  runtime: ConversationBackendRuntime,
  tooling: PortableMcpConfig,
  capabilityView: BackendCapabilityView,
): Promise<ApplyToolingOk | ApplyToolingFail> {
  if (!runtime.applyPortableMcpConfig) {
    return {
      ok: false,
      message: `runtime "${runtime.backend}" does not support portable MCP application (boundary: ${capabilityView.mcpApplicationBoundary})`,
    };
  }
  const applied = await runtime.applyPortableMcpConfig(tooling);
  if (
    applied.disposition === "rejected" ||
    applied.disposition === "unsupported"
  ) {
    return {
      ok: false,
      message: `tooling rejected by runtime: ${applied.disposition}`,
    };
  }
  return { ok: true };
}

interface BuildFailureResultInput {
  backend: BackendCapabilityView["backend"];
  capabilityView: BackendCapabilityView;
  backendRef: AgentCallResult["backendRef"];
  artifacts?: readonly ArtifactRef[];
  failureKind: NormalizedAgentCallFailureKind;
  message: string;
  /**
   * Adapter turn result the failure was derived from, when one exists. Its
   * partial content, usage, and continuation verdict ride the normalized
   * result so consumers never need the raw runtime result. Absent for thrown
   * errors, where `continuationDisposition` must be supplied explicitly.
   */
  turnResult?: ConversationBackendTurnResult;
  continuationDisposition?: AgentCallResult["continuationDisposition"];
}

function buildFailureResult(input: BuildFailureResultInput): AgentCallResult {
  const turnResult = input.turnResult;
  return {
    backend: input.backend,
    backendRef: input.backendRef,
    capabilities: input.capabilityView,
    usage: turnResult !== undefined ? buildUsageMetrics(turnResult) : {},
    artifacts: [...(input.artifacts ?? [])],
    outcome: {
      kind: "failed",
      error: {
        failureKind: input.failureKind,
        backend: input.backend,
        message: input.message,
      },
      ...(turnResult !== undefined
        ? {
            contentBlocks: turnResult.contentBlocks,
            ...(turnResult.numTurns != null
              ? { numTurns: turnResult.numTurns }
              : {}),
          }
        : {}),
    },
    ...(turnResult !== undefined
      ? {
          continuationDisposition: turnResult.continuationDisposition,
          compacted: turnResult.compacted,
          ...(turnResult.backgroundWait !== undefined
            ? { backgroundWait: turnResult.backgroundWait }
            : {}),
        }
      : input.continuationDisposition !== undefined
        ? { continuationDisposition: input.continuationDisposition }
        : {}),
  };
}

function deriveArtifactKinds(
  artifacts: readonly ArtifactRef[] | undefined,
): readonly string[] | undefined {
  if (!artifacts || artifacts.length === 0) return undefined;
  return artifacts.map((a) => a.kind);
}

function extractText(result: ConversationBackendTurnResult): string | null {
  if (result.finalText !== undefined) return result.finalText;
  for (const block of result.contentBlocks) {
    if (block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return null;
}

function buildUsageMetrics(
  result: ConversationBackendTurnResult,
): AgentCallResult["usage"] {
  const usage: AgentCallResult["usage"] = {};
  if (result.contextTokens != null) usage.contextTokens = result.contextTokens;
  if (result.contextWindowMax != null) {
    usage.contextWindowMax = result.contextWindowMax;
  }
  if (result.costUsd != null) usage.costUsd = result.costUsd;
  if (result.cumulativeCostUsd != null) {
    usage.cumulativeCostUsd = result.cumulativeCostUsd;
  }
  if (result.durationMs != null) usage.durationMs = result.durationMs;
  return usage;
}
