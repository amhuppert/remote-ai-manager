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
import type {
  ConversationBackendRuntime,
  ConversationBackendEvent,
  ConversationBackendTurnInput,
  ConversationBackendTurnResult,
  ConversationImageRef,
} from "@/lib/agent-backends/conversation";
import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import {
  buildAgentCallLogFields,
  type AgentCallRequest,
  type AgentCallResult,
  type ArtifactRef,
  type BackendCapabilityView,
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
  autonomous?: boolean;
  sessionInstructions?: string[];
  imageRefs?: readonly ConversationImageRef[];
  onEvent?: (event: ConversationBackendEvent) => Promise<void> | void;
  /** Pre-known artifact references the caller wants attached to the result. */
  artifacts?: readonly ArtifactRef[];
  syntheticForkSeed?: ConversationBackendTurnInput["syntheticForkSeed"];
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
      });
    }
  }

  const turnInput: ConversationBackendTurnInput = {
    promptText: request.prompt,
    imageRefs: deps.imageRefs ?? [],
    sessionInstructions: [...(deps.sessionInstructions ?? [])],
    modelId: deps.modelId,
    reasoningEffort: deps.reasoningEffort,
    autonomous: deps.autonomous ?? false,
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
    const message = err instanceof Error ? err.message : String(err);
    log.warn("agent_call.conversation.send_turn_threw", {
      ...baseLogFields,
      outcome: "failed",
      message,
    });
    return buildFailureResult({
      backend,
      capabilityView,
      backendRef: null,
      artifacts: deps.artifacts,
      failureKind: "backend_error",
      message,
    });
  }

  if (turnResult.aborted) {
    log.warn("agent_call.conversation.aborted", {
      ...baseLogFields,
      outcome: "failed",
      message: turnResult.error ?? "aborted",
    });
    return buildFailureResult({
      backend,
      capabilityView,
      backendRef: turnResult.backendRef,
      artifacts: deps.artifacts,
      failureKind: "aborted",
      message: turnResult.error ?? "aborted",
    });
  }

  if (turnResult.error) {
    log.warn("agent_call.conversation.runtime_error", {
      ...baseLogFields,
      outcome: "failed",
      message: turnResult.error,
    });
    return buildFailureResult({
      backend,
      capabilityView,
      backendRef: turnResult.backendRef,
      artifacts: deps.artifacts,
      failureKind: "backend_error",
      message: turnResult.error,
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
    },
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
  failureKind:
    | "timeout"
    | "schema_validation"
    | "backend_error"
    | "aborted"
    | "capability_unavailable";
  message: string;
}

function buildFailureResult(input: BuildFailureResultInput): AgentCallResult {
  return {
    backend: input.backend,
    backendRef: input.backendRef,
    capabilities: input.capabilityView,
    usage: {},
    artifacts: [...(input.artifacts ?? [])],
    outcome: {
      kind: "failed",
      error: {
        failureKind: input.failureKind,
        backend: input.backend,
        message: input.message,
      },
    },
  };
}

function deriveArtifactKinds(
  artifacts: readonly ArtifactRef[] | undefined,
): readonly string[] | undefined {
  if (!artifacts || artifacts.length === 0) return undefined;
  return artifacts.map((a) => a.kind);
}

function extractText(result: ConversationBackendTurnResult): string | null {
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
  if (result.durationMs != null) usage.durationMs = result.durationMs;
  return usage;
}
