import { stableStringify } from "@/lib/state-store/serialization";
import { reconcileDeliveredCapabilityState } from "@/lib/agent-capabilities/runtime-seed";
import { toPromptActorResult } from "./turn-result";
import {
  prepareConversationTurnContext,
  prepareTaskPrompt,
  type PreparedConversationTurnContext,
} from "./turn-context";
import { prepareRuntimeInstructions } from "./runtime-instructions";
import { conversationStoreIdentity } from "@/lib/conversations/conversation-target";
import { conversationTargetStoreSessionName } from "@/lib/conversations/conversation-target";
import type { ConversationActorDependencies } from "./actor-dependencies";
import { queuedMessageNeedsReview } from "@/lib/conversations/message-queue-schemas";
import { assertBackendExecution } from "@/lib/agent-backends/task-execution";
import {
  BackendAdmissionError,
  type ExecutionClass,
} from "@/lib/agent-backends/execution-admission";
/**
 * Conversation execution with required construction-time collaborators.
 */

import { randomUUID } from "node:crypto";
import type {
  PrepareTurnInput,
  PrepareTurnOutput,
  ExecutePromptInput,
  PromptActorResult,
  RunTaskRunInput,
} from "./types";
import { deriveTaskRunPermissions } from "./task-run-permissions";

import { getErrorMessage } from "@/lib/shared/errors";
import type { FsWritePolicy } from "@/lib/agent-backends/task";
import type {
  ConversationBackendRuntime,
  ConversationBackendTurnInput,
  ConversationBackendEvent,
  ProjectModelSelectionValidation,
} from "@/lib/agent-backends/conversation";

import { isOrdinaryConversationRole } from "@/lib/conversations/schemas";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
import { selectLastUserTurnAgentSettings } from "@/lib/conversations/last-turn-agent-settings";

import type { AgentBackendId } from "@/lib/shared/schemas";
import type {
  TranscriptEntry,
  TranscriptBroadcastMeta,
} from "@/lib/prompt/transcript";
import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import type { ConversationApplyResult } from "@/lib/mcp/runtime-apply";
import { recordMcpConfigReceipt } from "@/lib/mcp/runtime-apply";
import { computeEffectiveConfigHash } from "@/lib/mcp/config-hash";
import {
  conversationRuntimeKey,
  getConversationRuntime,
} from "./runtime-state";
import { type Logger } from "@/lib/logging";

import { conversationTranscriptFrame } from "@/lib/agent-backends/transcript";

import { markPromptNotDelivered } from "@/lib/agent-backends/errors";
import {
  classifyFailureForBackend,
  resolveFailureClassifierForBackend,
} from "./failure-classification";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import { ModelSelectionPolicyError } from "@/lib/agent-backends/model-selection";
import {
  withRuntimeReplacementRetry,
  type RuntimeReplacementRetryDeps,
} from "./with-runtime-replacement-retry";

import { getBackgroundActivityChannel } from "@/lib/conversations/background-activity";
import type { BackgroundTasksLostInfo } from "@/lib/agent-backends/conversation";
import {
  scopeRefFromStoreSessionName,
  type ConversationScopeRef,
} from "@/lib/conversations/conversation-target";

import {
  runtimeConfigurationChanges,
  type DesiredRuntimeConfiguration,
} from "./pre-turn/runtime-recreate";
import { isRuntimeCreatedWithoutResume } from "@/lib/memory/delivery-decision";
import { resolveContinuationSeed } from "./pre-turn/continuation-seed";
import {
  prepareCheckpointSeed,
  type PreparedCheckpointSeed,
} from "./pre-turn/checkpoint-seed";
import { checkpointScopeKeyForStoreIdentity } from "./actor-input-loader";
import {
  fingerprintAssembledInput,
  fingerprintSubmittedInput,
} from "@/lib/conversation-checkpoints/input-fingerprint";

import { createExternalTurnHandler } from "./external-turn-handler";

import type {
  AgentCallRequest,
  AgentCallResult,
} from "@/lib/workflows/primitives/agent-call-vocabulary";
import type {
  AgentCallFacadeDeps,
  ConversationRuntimeResolution,
  McpApplyHookResult,
} from "@/lib/workflows/primitives/agent-call-facade";
import { capabilityViewForBackend } from "@/lib/workflows/primitives/backend-capabilities";
import {
  getConversationTranscriptProjection,
  getTaskTranscriptProjection,
  resolveAgentBackendTurnDefaults,
} from "@/lib/agent-backends/conversation-policy";

import type { ActorConfig } from "./pre-turn/resolve-model-effort";
import {
  resolveTurnModelSelection,
  resolveBackendTimeoutMs,
  resolveBackendStallTimeoutMs,
} from "./pre-turn/resolve-model-effort";
import {
  resolveTurnPromptText,
  composeUserTranscriptBlocks,
} from "./pre-turn/review-feedback";
import { persistTurnImages } from "./pre-turn/image-persistence";

import type { CapabilityTurnContext } from "./pre-turn/capability-cascade";
import {
  buildCapabilityApplyInput,
  resolveCapabilitySeedForNewRuntime,
  seedRuntimeCapabilityState,
  applyCapabilityCascadeAtTurnStart,
  drainCapabilityWhenIdle,
} from "./pre-turn/capability-cascade";
import { recordSeenAlignmentVersion } from "./pre-turn/alignment-gate";
import { createBackgroundTasksLostHandler } from "./pre-turn/notices-drain";

import { wireTurnAbort } from "./pre-turn/abort-wiring";
import { createQueuedDeliveryAccounting } from "./post-turn/queued-delivery-accounting";
import {
  buildFailedTurnResult,
  buildAbortedTurnResult,
} from "./post-turn/failure-fallback";

// ============================================================
// Extracted testable functions
// ============================================================

function formatTurnStartMcpApplyFailure(
  result: ConversationApplyResult,
): string {
  const parts = ["Failed to apply portable MCP configuration"];
  if (result.error) {
    parts.push(result.error);
  }
  return parts.join(". ");
}

// ============================================================
// Shared AgentCall dispatch
// ============================================================

function admissionFailure(error: BackendAdmissionError): PromptActorResult {
  return {
    ...buildFailedTurnResult({
      contentBlocks: [],
      error: error.message,
      continuationDisposition: "retain",
    }),
    failure: {
      kind: "capability_unavailable",
      message: error.message,
      code: error.code,
      retryable: false,
    },
  };
}

interface DispatchTurnViaAgentCallInput {
  onUserQuestion?: ConversationBackendTurnInput["onUserQuestion"];
  executionClass: ExecutionClass;
  executeAgentCall: ConversationActorDependencies["execution"]["executeAgentCall"];
  getRuntime: () => ConversationBackendRuntime;
  replaceRuntime: () => Promise<ConversationBackendRuntime>;
  /** Pre-turn MCP apply hook the facade runs before dispatch, when set. */
  applyMcp: (() => Promise<McpApplyHookResult>) | undefined;
  signal: AbortSignal;
  conversationId: string;
  /**
   * Diagnostic scope for the retry policy's structured events (R1.3). The turn's
   * store session name stays behind: it is the sentinel at project scope, and
   * `prompt.runtime_retry` / `prompt.continuation_pair_contradiction` would
   * otherwise report it as a session identity.
   */
  scopeRef: ConversationScopeRef;
  log: Logger;
  backend: AgentBackendId;
  promptText: string;
  userPromptText: string;
  promptContext?: string;
  imageRefs: ConversationBackendTurnInput["imageRefs"] | undefined;
  modelSelection: BackendModelSelection;
  autonomous: boolean;
  waitForBackgroundTasks: boolean;
  outputFormat: ConversationBackendTurnInput["outputFormat"];
  onEvent: ConversationBackendTurnInput["onEvent"];
  syntheticForkSeed: ConversationBackendTurnInput["syntheticForkSeed"];
  /** Neutral send/failure facts for a checkpoint delivery; see the retry policy. */
  observe: RuntimeReplacementRetryDeps["observe"];
  /**
   * The turn's write envelope, restated on the neutral request. The runtime
   * already carries it (it was established at session start), so this is what
   * makes the envelope OBSERVABLE at the backend-neutral boundary — the same
   * place the task path declares it.
   */
  fsWritePolicy: FsWritePolicy | undefined;
}

/**
 * Routes a single conversation turn through the shared AgentCall primitive.
 *
 * The runtime handed to the facade is wrapped in the named
 * `withRuntimeReplacementRetry` policy so a dead runtime whose prompt was
 * never delivered is replaced (resume-preserving) and retried exactly once.
 * The actor consumes the facade's normalized `AgentCallResult` — including
 * failures, which the facade normalizes through the backend's failure
 * classifier — and never a raw runtime result.
 */
async function dispatchTurnViaAgentCall(
  input: DispatchTurnViaAgentCallInput,
): Promise<AgentCallResult> {
  const wrappedRuntime = withRuntimeReplacementRetry({
    getRuntime: input.getRuntime,
    replaceRuntime: input.replaceRuntime,
    classify: (error) => classifyFailureForBackend(input.backend, error),
    signal: input.signal,
    meta: {
      conversationId: input.conversationId,
      scopeRef: input.scopeRef,
      backend: input.backend,
    },
    log: input.log,
    ...(input.observe !== undefined ? { observe: input.observe } : {}),
  });

  const request: AgentCallRequest = {
    kind: "conversation_turn",
    executionClass: input.executionClass,
    prompt: input.promptText,
    backend: input.backend,
    writeCapability: "write_capable",
    ...(input.outputFormat?.type === "json_schema"
      ? { outputSchema: input.outputFormat.schema }
      : {}),
    ...(input.fsWritePolicy !== undefined
      ? { fsWritePolicy: input.fsWritePolicy }
      : {}),
  };

  const facadeDeps: AgentCallFacadeDeps = {
    resolveConversationRuntime: () => {
      const resolution: ConversationRuntimeResolution = {
        onUserQuestion: input.onUserQuestion,
        runtime: wrappedRuntime,
        capabilityView: capabilityViewForBackend(input.backend),
        signal: input.signal,
        modelSelection: input.modelSelection,
        autonomous: input.autonomous,
        ...(input.waitForBackgroundTasks
          ? { waitForBackgroundTasks: true }
          : {}),
        sessionInstructions: [],
        userPromptText: input.userPromptText,
        ...(input.promptContext !== undefined
          ? { promptContext: input.promptContext }
          : {}),
        ...(input.imageRefs !== undefined
          ? { imageRefs: input.imageRefs }
          : {}),
        onEvent: input.onEvent,
        ...(input.syntheticForkSeed !== undefined
          ? { syntheticForkSeed: input.syntheticForkSeed }
          : {}),
      };
      return resolution;
    },
    getFailureClassifier: resolveFailureClassifierForBackend,
    ...(input.applyMcp !== undefined ? { applyMcp: input.applyMcp } : {}),
  };

  return input.executeAgentCall(request, facadeDeps);
}

// ============================================================
// Main actor implementations
// ============================================================

/**
 * The query semaphore's diagnostic identity for this turn. The label is the only
 * turn-derived value that module emits — it appears in every `semaphore.*` event
 * and is interpolated into the queue-timeout Error message a client can see — so
 * it is built from the discriminated scope, never from the storage name (R1.3).
 * A project conversation has no owning session to attribute the slot to, so the
 * conversation itself is the identity.
 */
function querySlotLabel(
  scope: ConversationScopeRef,
  conversationId: string,
): string {
  return scope.scope === "session"
    ? `prompt:${scope.sessionName}`
    : `prompt:project:${conversationId}`;
}

/**
 * How a turn NAMES its conversation when reporting a missing runtime. The
 * runtime key itself cannot be used: it embeds the store session name, and this
 * message propagates out of the turn into a published SSE `error` frame (R1.3).
 */
function conversationRuntimeDescriptor(
  scope: ConversationScopeRef,
  projectPath: string,
  conversationId: string,
): string {
  const scopeSegment =
    scope.scope === "session" ? scope.sessionName : "project";
  return `${projectPath}::${scopeSegment}::${conversationId}`;
}

function missingRuntimeError(
  projectPath: string,
  storeSessionName: string,
  conversationId: string,
): Error {
  return new Error(
    `No runtime state registered for conversation ${conversationRuntimeDescriptor(
      scopeRefFromStoreSessionName(storeSessionName),
      projectPath,
      conversationId,
    )}. Was the actor started via the conversation manager?`,
  );
}

/**
 * Acquire session lock, query slot, and initialize transcript path.
 */
async function prepareTurnForMachine(
  deps: ConversationActorDependencies,
  input: PrepareTurnInput,
  signal?: AbortSignal,
): Promise<PrepareTurnOutput> {
  const key = conversationRuntimeKey(
    input.projectPath,
    conversationTargetStoreSessionName(input.target),
    input.target.conversationId,
  );
  const runtime = deps.execution.getRuntime(key);
  if (!runtime) {
    throw missingRuntimeError(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
  }

  signal?.throwIfAborted();
  const releaseConversationLock = deps.execution.acquireConversationLock(
    input.projectPath,
    conversationTargetStoreSessionName(input.target),
    input.target.conversationId,
  );
  runtime.releaseConversationLock = releaseConversationLock;
  runtime.attempt?.ownRelease(() => {
    releaseConversationLock();
    runtime.releaseConversationLock = undefined;
  });
  signal?.throwIfAborted();

  // Acquire concurrency slot (waits if at capacity)
  const releaseQuerySlot = await deps.execution.acquireQuerySlot(
    querySlotLabel(
      scopeRefFromStoreSessionName(
        conversationTargetStoreSessionName(input.target),
      ),
      input.target.conversationId,
    ),
    { signal },
  );
  runtime.releaseQuerySlot = releaseQuerySlot;
  runtime.attempt?.ownRelease(() => {
    releaseQuerySlot();
    runtime.releaseQuerySlot = undefined;
  });
  signal?.throwIfAborted();

  // Get or create transcript path
  const transcriptPath =
    input.transcriptPath ??
    (await deps.transcript.getTranscriptPath(input.target.conversationId));

  signal?.throwIfAborted();
  return { transcriptPath };
}

/**
 * Whether a producer stamped this entry with an id — the assertion that the
 * entry has an identity a re-delivery can be recognized by.
 */
function hasStableEntryId(
  entry: TranscriptEntry,
): entry is TranscriptEntry & { id: string } {
  return entry.id !== undefined;
}

async function resetMemoryIndexAfterBackendCompaction(
  deps: ConversationActorDependencies,
  conversationId: string,
): Promise<void> {
  try {
    await deps.effects.resetMemoryIndexDelivery(conversationId);
    deps.log.info("prompt.memory_delivery_reset", {
      conversationId,
      reason: "backend_compaction",
    });
  } catch (err) {
    deps.log.warn("prompt.memory_delivery_reset_failed", {
      conversationId,
      reason: "backend_compaction",
      error: getErrorMessage(err),
    });
  }
}

/**
 * Execute a prompt via a backend-neutral conversation runtime.
 *
 * Orchestrates turn execution using ConversationBackendRuntime:
 * - Gets or creates the backend runtime via factory
 * - Constructs ConversationBackendTurnInput with onEvent callback
 * - Translates backend events into SSE emit and machine events
 */
async function executePromptForMachine(
  deps: ConversationActorDependencies,
  input: ExecutePromptInput,
  signal?: AbortSignal,
): Promise<PromptActorResult> {
  const transcriptProjection = getConversationTranscriptProjection(
    input.agentBackend,
  );

  const key = conversationRuntimeKey(
    input.projectPath,
    conversationTargetStoreSessionName(input.target),
    input.target.conversationId,
  );
  const runtime = deps.execution.getRuntime(key);
  if (!runtime) {
    throw missingRuntimeError(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
  }
  const runtimeState = runtime;
  const attempt = runtime.attempt;
  signal ??= runtime.abortController.signal;
  signal.throwIfAborted();
  const persistedConversation =
    input.persistence === "ephemeral"
      ? null
      : await deps.execution.getConversation(
          input.projectPath,
          conversationTargetStoreSessionName(input.target),
          input.target.conversationId,
        );
  if (
    input.persistence !== "ephemeral" &&
    input.turn.queuedDelivery === undefined
  ) {
    if (
      persistedConversation?.pendingQueue.some((row) =>
        queuedMessageNeedsReview(row.status),
      )
    ) {
      const error = "Review queued deliveries before sending another prompt.";
      deps.log.warn("queue.prompt_blocked_for_review", {
        ...scopeRefFromStoreSessionName(
          conversationTargetStoreSessionName(input.target),
        ),
        conversationId: input.target.conversationId,
      });
      runtimeState.streamEmit?.("error", {
        message: error,
        code: "QUEUE_REVIEW_REQUIRED",
      });
      return buildFailedTurnResult({
        contentBlocks: [],
        error,
        continuationDisposition: "retain",
      });
    }
  }

  const executionClass: ExecutionClass =
    isOrdinaryConversationRole(input.role) &&
    runtimeState.workflowContext === undefined &&
    input.turn.fsWritePolicy === undefined
      ? "ordinary-conversation"
      : "governed-execution";
  try {
    await assertBackendExecution(input.agentBackend, {
      facet: "conversation",
      operation: "conversation-turn",
      executionClass,
      requiresFsWriteRestriction: input.turn.fsWritePolicy !== undefined,
    });
  } catch (error) {
    if (!(error instanceof BackendAdmissionError)) throw error;
    runtimeState.attempt?.recordFailure(error);
    runtimeState.streamEmit?.("error", {
      message: error.message,
      code: error.code,
    });
    return admissionFailure(error);
  }
  runtimeState.currentTurnAutonomous = input.turn.autonomous === true;

  const config = await deps.execution.readConfig();
  const projectName = input.target.projectName;
  const isProjectConversation = input.target.scope === "project";

  // Diagnostic identity for this turn (R1.3). The session-keyed STORE name
  // is the sentinel for a project conversation, so it may be handed to
  // runtime/state-store adapters below but must never be
  // logged. Diagnostic fields preserve the target's explicit scope.
  const scopeRef: ConversationScopeRef = isProjectConversation
    ? { scope: "project" }
    : {
        scope: "session",
        sessionName: conversationTargetStoreSessionName(input.target),
      };

  const broadcastMeta: TranscriptBroadcastMeta = {
    projectName,
    storeSessionName: conversationTargetStoreSessionName(input.target),
  };
  const safeAppendWithMeta = (
    conversationId: string,
    entry: TranscriptEntry,
  ): Promise<void> =>
    deps.transcript.safeAppendTranscriptEntry(
      conversationId,
      entry,
      broadcastMeta,
    );

  /**
   * Persist a frame the backend emitted this turn. A backend that stamps its
   * frames with a stable id is asserting event identity, so a re-delivered
   * frame persists and broadcasts once; a frame without an id has no identity
   * to compare and takes the ordinary append.
   */
  const appendBackendEventEntry = (
    conversationId: string,
    entry: TranscriptEntry,
  ): Promise<void> =>
    hasStableEntryId(entry)
      ? deps.transcript.safeAppendTranscriptEntryOnce(
          conversationId,
          entry,
          broadcastMeta,
        )
      : safeAppendWithMeta(conversationId, entry);

  // Resolve the atomic model selection with a three-tier fallback (explicit →
  // conversation's last-used → backend config default). Reading the transcript
  // is only needed when a tier below "explicit" could apply.
  const priorMessages =
    input.turn.modelSelection === null
      ? await deps.transcript.readConversationMessages(
          input.transcriptPath ?? null,
        )
      : [];
  const forkInitialSelection =
    persistedConversation?.promptCount === 0 &&
    persistedConversation.checkpointFork?.initialSelection.backend ===
      input.agentBackend
      ? persistedConversation.checkpointFork.initialSelection.modelSelection
      : null;
  let effectiveModelSelection = resolveTurnModelSelection({
    backend: input.agentBackend,
    config,
    explicitModelSelection: input.turn.modelSelection ?? forkInitialSelection,
    priorMessages,
  });
  const lastTurnSelection =
    input.turn.modelSelection === null
      ? selectLastUserTurnAgentSettings(priorMessages).modelSelection
      : undefined;
  const modelSelectionSourceLayer =
    input.turn.modelSelection !== null
      ? "explicit"
      : lastTurnSelection !== undefined
        ? "last_turn"
        : "backend_default";
  const factory = deps.execution.getConversationBackendFactory(
    input.agentBackend,
  );

  const buildModelSelectionFailure = async (
    selection: BackendModelSelection,
    code: string,
    errorMessage: string,
    parameterId?: string,
  ): Promise<PromptActorResult> => {
    deps.log.warn("model_selection.rejected", {
      backend: input.agentBackend,
      modelId: selection.modelId,
      parameterIds: Object.keys(selection.parameters).sort(),
      sourceLayer: modelSelectionSourceLayer,
      code,
      ...(parameterId !== undefined ? { parameterId } : {}),
    });
    if (input.turn.queuedDelivery !== undefined) {
      await deps.effects.markQueuedFailed({
        projectPath: input.projectPath,
        sessionName: conversationTargetStoreSessionName(input.target),
        conversationId: input.target.conversationId,
        ids: input.turn.queuedDelivery.messageIds,
        deliveryAttemptId: input.turn.queuedDelivery.deliveryAttemptId,
        error: errorMessage,
      });
    }
    runtimeState.streamEmit?.("error", { message: errorMessage });
    return buildFailedTurnResult({
      contentBlocks: [],
      error: errorMessage,
      continuationDisposition: "retain",
    });
  };

  if (factory.validateModelSelection) {
    try {
      factory.validateModelSelection(effectiveModelSelection);
    } catch (err) {
      const errorMessage = getErrorMessage(err);
      const issue =
        err instanceof ModelSelectionPolicyError ? err.issues[0] : undefined;
      deps.log.warn("prompt.model_selection_validation_failed_actor", {
        ...scopeRef,
        backend: input.agentBackend,
        modelSelection: effectiveModelSelection,
        error: errorMessage,
      });
      return await buildModelSelectionFailure(
        effectiveModelSelection,
        issue?.code ?? "selection_invalid",
        errorMessage,
        issue?.parameterId,
      );
    }
  }

  if (factory.validateProjectModelSelection) {
    let validation;
    try {
      validation = await factory.validateProjectModelSelection({
        projectPath: input.projectPath,
        modelSelection: effectiveModelSelection,
      });
    } catch (err) {
      return await buildModelSelectionFailure(
        effectiveModelSelection,
        "project_model_selection_validation_failed",
        getErrorMessage(err),
      );
    }

    if (!validation.ok) {
      return await buildModelSelectionFailure(
        effectiveModelSelection,
        validation.code,
        validation.message,
        validation.parameterId,
      );
    }

    effectiveModelSelection = validation.modelSelection;
  }

  deps.log.debug("model_selection.resolved", {
    backend: input.agentBackend,
    modelId: effectiveModelSelection.modelId,
    parameterIds: Object.keys(effectiveModelSelection.parameters).sort(),
    sourceLayer: modelSelectionSourceLayer,
  });

  await input.onModelSelectionResolved(effectiveModelSelection);

  const { effectivePromptText, isDrainedFeedbackBatch } = resolveTurnPromptText(
    {
      promptText: input.turn.promptText,
      documentFeedback: input.turn.documentFeedback,
      notepadFeedback: input.turn.notepadFeedback,
      isQueuedDelivery: input.turn.queuedDelivery !== undefined,
    },
  );

  const { assembled, imageRefs } = await persistTurnImages(deps.transcript, {
    conversationId: input.target.conversationId,
    promptText: effectivePromptText,
    images: input.turn.images ?? [],
  });

  const transcriptBlocks: MessageContentBlock[] = composeUserTranscriptBlocks({
    promptText: input.turn.promptText,
    effectivePromptText,
    rewrittenPromptText: assembled.rewrittenPromptText,
    isDrainedFeedbackBatch,
    documentFeedback: input.turn.documentFeedback,
    notepadFeedback: input.turn.notepadFeedback,
    imageRefs,
  });

  const currentTurnMessageId =
    input.turn.queuedDelivery?.messageIds[0] ?? input.streamId ?? null;
  runtimeState.currentTurnMessageId = currentTurnMessageId ?? undefined;
  const workflowResultAttemptId =
    input.turn.queuedDelivery?.deliveryAttemptId ??
    input.streamId ??
    currentTurnMessageId ??
    randomUUID();
  let preparedContext: PreparedConversationTurnContext | undefined;
  // Build the user prompt transcript entry once. For normal turns it is
  // appended immediately. For queued (auto-drained) turns the durable queue —
  // not the JSONL transcript — owns this content until the backend confirms
  // acceptance, so the append is deferred to the `input_accepted` event and the
  // claimed queue rows are only marked delivered after that append succeeds.
  const buildUserTranscriptEntry = (): TranscriptEntry => ({
    ...(currentTurnMessageId ? { id: currentTurnMessageId } : {}),
    timestamp: new Date().toISOString(),
    type: "user",
    role: "user",
    content: transcriptBlocks,
    modelSelection: effectiveModelSelection,
  });

  const queuedAccounting = createQueuedDeliveryAccounting(deps.effects, {
    projectPath: input.projectPath,
    sessionName: conversationTargetStoreSessionName(input.target),
    conversationId: input.target.conversationId,
    queuedDelivery: input.turn.queuedDelivery,
    appendUserEntry: () =>
      input.turn.queuedDelivery
        ? deps.transcript.appendTranscriptEntryOnce(
            input.target.conversationId,
            {
              ...buildUserTranscriptEntry(),
              id:
                currentTurnMessageId ??
                input.turn.queuedDelivery.deliveryAttemptId,
            },
            broadcastMeta,
          )
        : safeAppendWithMeta(
            input.target.conversationId,
            buildUserTranscriptEntry(),
          ),
  });

  await queuedAccounting.appendUserEntryAtDispatch();

  // ---------------------------------------------------------------
  // Get-or-create ConversationBackendRuntime
  // ---------------------------------------------------------------
  let backendRuntime = runtimeState.managed.backend;

  // Cancel any inactivity timer the existing runtime may have armed after its
  // last turn. The pre-turn pipeline below (state reads, MCP discovery,
  // capability cascades) can run long enough to outlast the idle TTL budget;
  // without this, the timer fires mid-prep and closes the subprocess we are
  // about to send a prompt to. No-op for new/dead runtimes (the timer can
  // only be armed once a turn has completed).
  backendRuntime?.notifyTurnStarting?.();

  async function seedRuntimeMcpState(
    portableMcp: PortableMcpConfig,
    delivery: ConversationBackendRuntime["mcpConfigDelivery"],
  ) {
    const hash = computeEffectiveConfigHash(portableMcp);
    await deps.policy.state.mcp.update(
      conversationStoreIdentity(input),
      "prompt.seedMcpRuntime",
      (state) => {
        if (delivery === "input-accepted")
          return {
            ...state,
            pendingConfigHash: hash,
            lastApplyDisposition: "deferred_to_next_turn" as const,
          };
        const next = {
          ...(state ?? {}),
          lastAppliedConfigHash: hash,
          lastApplyDisposition: "applied_now" as const,
        };
        delete next.lastApplyError;
        if (next.pendingConfigHash === hash) {
          delete next.pendingConfigHash;
          delete next.pendingServerKeys;
        }
        return next;
      },
    );
    deps.log.info("prompt.mcp_seeded", {
      ...scopeRef,
      backend: input.agentBackend,
      conversationId: input.target.conversationId,
    });
  }

  const capabilityCtx: CapabilityTurnContext = {
    projectPath: input.projectPath,
    projectName,
    sessionName: conversationTargetStoreSessionName(input.target),
    conversationId: input.target.conversationId,
    worktreePath: input.worktreePath,
    backend: input.agentBackend,
    isProjectConversation,
    emitStreamError: (message) =>
      runtimeState.streamEmit?.("error", { message }),
  };

  const instructions = await prepareRuntimeInstructions(
    deps,
    input,
    attempt?.profile,
  );
  const alignmentEligibleThisTurn = instructions.alignmentEligible;
  const desiredConfiguration = {
    backend: input.agentBackend,
    modelSelection: effectiveModelSelection,
    outputFormat: input.turn.outputFormat,
    fsWritePolicy: input.turn.fsWritePolicy,
    alignmentVersion: instructions.alignmentVersion,
    repeatableInstructions: instructions.repeatableInstructions,
    instructionSelection: {
      askUserQuestionsEnabled: input.turn.askUserQuestionsEnabled,
      autonomous: input.turn.autonomous,
    },
  } satisfies DesiredRuntimeConfiguration;
  // One continuation decision for the whole turn: a ready checkpoint, the
  // synthetic fork seed, or ordinary resume. Decided before the runtime is
  // reused or created, because a checkpoint delivery resumes nothing.
  const continuation = await resolveContinuationSeed(
    {
      readPayload: async (key, operationId) =>
        (await deps.checkpoint.repo()).getPayload(key, operationId),
      readContinuity: async (key) => ({
        accepted:
          (await (await deps.checkpoint.repo()).getStateForAdmission(key))
            .latestAccepted !== null,
      }),
      transcript: deps.transcript,
      log: deps.log,
    },
    {
      key:
        input.persistence === "ephemeral"
          ? null
          : checkpointScopeKeyForStoreIdentity(
              conversationStoreIdentity(input),
            ),
      checkpoint: input.checkpoint ?? null,
      sessionName: conversationTargetStoreSessionName(input.target),
      agentBackend: input.agentBackend,
      backendRef: input.backendRef,
      forkedFrom: persistedConversation?.forkedFrom ?? input.forkedFrom,
      transcriptPath: input.transcriptPath,
    },
  );
  const deliversCheckpoint = continuation.kind === "checkpoint";
  const forkOrigin =
    continuation.kind === "checkpoint" &&
    persistedConversation?.checkpointFork?.operationId ===
      continuation.operationId
      ? persistedConversation.checkpointFork
      : undefined;
  if (
    forkOrigin &&
    !deps.execution.backendSupportsCheckpointFork(input.agentBackend)
  ) {
    throw new Error(
      "The selected backend has no certified checkpoint fork continuation",
    );
  }
  const resumeRef = deliversCheckpoint ? null : input.backendRef;
  // A checkpoint delivery's receipt belongs to the attempt from here, before
  // any runtime exists: whatever fails between the fresh runtime's install
  // and the provider call — a state write, context preparation, the
  // readiness check, the binding itself — settles through this receipt,
  // which closes the runtime the attempt installed rather than leaving it to
  // carry the seed later as a reused one.
  const closeAttemptedRuntime = async (): Promise<void> => {
    if (attempt) await attempt.closeBackend();
    else await runtimeState.managed.close();
  };
  const checkpoint: PreparedCheckpointSeed | null =
    continuation.kind === "checkpoint"
      ? prepareCheckpointSeed(
          { checkpoint: deps.checkpoint, log: deps.log },
          {
            key: checkpointScopeKeyForStoreIdentity(
              conversationStoreIdentity(input),
            ),
            operationId: continuation.operationId,
            payload: continuation.payload,
            ...(forkOrigin === undefined ? {} : { forkOrigin }),
            closeAttemptedRuntime,
          },
        )
      : null;
  if (checkpoint) attempt?.ownReceipt(checkpoint.finish);

  const changes = runtimeConfigurationChanges({
    current: runtimeState.managed.configurationSnapshot,
    desired: desiredConfiguration,
  });
  if (backendRuntime && changes.length > 0) {
    deps.log.info("prompt.runtime_recreate", { ...scopeRef, changes });
    if (attempt) await attempt.closeBackend();
    else await runtimeState.managed.close();
    backendRuntime = undefined;
  }
  // Retirement closed the runtime a ready checkpoint replaces; a handle that
  // somehow survived is the retired continuation and must not carry the seed.
  if (backendRuntime && deliversCheckpoint) {
    deps.log.warn("checkpoint.stale_runtime_closed", {
      ...scopeRef,
      conversationId: input.target.conversationId,
      operationId: continuation.operationId,
    });
    if (attempt) await attempt.closeBackend();
    else await runtimeState.managed.close();
    backendRuntime = undefined;
  }
  const isNewRuntime = !backendRuntime || backendRuntime.status === "dead";

  async function createManagedBackendRuntime(): Promise<ConversationBackendRuntime> {
    const sessionInstructions = instructions.sessionInstructions;
    const portableMcp = await deps.policy.composePortableMcpForConversation({
      backend: input.agentBackend,
      projectPath: input.projectPath,
      projectName,
      sessionName: conversationTargetStoreSessionName(input.target),
      conversationId: input.target.conversationId,
      worktreePath: input.worktreePath,
      ...(runtimeState.tooling?.portableMcp !== undefined
        ? { transientPortableMcp: runtimeState.tooling.portableMcp }
        : {}),
    });

    const capabilitySeed = await resolveCapabilitySeedForNewRuntime(
      deps.policy,
      capabilityCtx,
    );
    const capabilityCascadeSeed = capabilitySeed?.capabilities;
    const capabilityRuntimeStateSeed = capabilitySeed?.runtimeState;

    deps.log.info("prompt.runtime_create", {
      ...scopeRef,
      backend: input.agentBackend,
      conversationId: input.target.conversationId,
      hasResumeRef: resumeRef !== null,
      promptCount: input.promptCount,
      capabilityCascadeSeeded: capabilityCascadeSeed !== undefined,
    });

    if (continuation.kind === "checkpoint") {
      // Planned: the checkpoint retired the prior continuation and this
      // runtime is created fresh to receive its seed.
      deps.log.info("checkpoint.fresh_runtime", {
        ...scopeRef,
        backend: input.agentBackend,
        conversationId: input.target.conversationId,
        operationId: continuation.operationId,
        promptCount: input.promptCount,
      });
    } else if (input.promptCount > 0 && input.backendRef === null) {
      // A conversation with completed turns but no resume handle cannot
      // restore the agent's context — the new backend session starts with no
      // memory of the transcript. Reachable after a mid-turn server death
      // that outran BACKEND_INIT persistence, or a Codex thread cleared by a
      // failed turn.
      deps.log.warn("prompt.resume_ref_missing", {
        ...scopeRef,
        backend: input.agentBackend,
        conversationId: input.target.conversationId,
        promptCount: input.promptCount,
      });
    }

    // External (background auto-continuation) turns are a declared backend
    // capability: only backends whose descriptor claims `externalTurns` get a
    // handler wired. The idle capability drain is likewise gated on a
    // declared `idle_live` capability kind rather than backend identity.
    const conversationCapabilities = deps.execution.getConversationCapabilities(
      input.agentBackend,
    );
    const supportsIdleCapabilityDrain =
      conversationCapabilities?.capabilityKinds.some(
        (k) => k.applyTiming === "idle_live",
      ) ?? false;
    if (runtimeState.managed.backend) await runtimeState.managed.close();
    const incarnation = runtimeState.managed.beginCreation();
    const externalTurnHandler = conversationCapabilities?.externalTurns
      ? createExternalTurnHandler(
          { conversationId: input.target.conversationId },
          {
            isCurrent: () =>
              deps.execution.getRuntime(key) === runtimeState &&
              runtimeState.managed.isCurrent(incarnation),
            sendToMachine: (event) => runtimeState.sendToMachine?.(event),
          },
          {
            safeAppendTranscriptEntry: safeAppendWithMeta,
            onBackendCompaction: () =>
              resetMemoryIndexAfterBackendCompaction(
                deps,
                input.target.conversationId,
              ),
            applyCapabilityWhenIdle: supportsIdleCapabilityDrain
              ? () =>
                  deps.policy.applyCapabilityWhenIdle(
                    buildCapabilityApplyInput(capabilityCtx),
                  )
              : undefined,
          },
        )
      : undefined;

    // Background-activity identity: scope-invariant project + conversation,
    // plus the store-level session name the channel maps onto the event scope.
    const backgroundActivityIdentity = {
      projectName,
      sessionName: conversationTargetStoreSessionName(input.target),
      conversationId: input.target.conversationId,
    };
    const clearBackgroundActivity = (): void => {
      getBackgroundActivityChannel().record(backgroundActivityIdentity, null);
    };

    const surfaceBackgroundTasksLost = createBackgroundTasksLostHandler(
      deps.effects,
      {
        projectPath: input.projectPath,
        sessionName: conversationTargetStoreSessionName(input.target),
        conversationId: input.target.conversationId,
        isProjectConversation,
        appendTranscriptEntry: safeAppendWithMeta,
      },
    );
    // This is also the teardown retraction. A non-null activity snapshot is a
    // subset of the waitable in-flight set, so every backend death that could
    // strand an indicator (close, idle timeout, pump death, actor stop, which
    // closes the runtime) necessarily reports tasks lost here first.
    const onBackgroundTasksLost = (info: BackgroundTasksLostInfo): void => {
      if (
        deps.execution.getRuntime(key) !== runtimeState ||
        !runtimeState.managed.isCurrent(incarnation)
      )
        return;
      clearBackgroundActivity();
      const completion = Promise.resolve().then(() =>
        surfaceBackgroundTasksLost(info),
      );
      void runtimeState.managed.track(completion).catch((error) =>
        deps.log.warn("prompt.background_tasks_lost_persist_failed", {
          ...scopeRef,
          conversationId: input.target.conversationId,
          error: getErrorMessage(error),
        }),
      );
    };

    // A replacement subprocess starts with an empty task set (the SDK's level
    // signal is per-process and emits nothing at startup), so the outgoing
    // subprocess's snapshot must not survive the swap.
    clearBackgroundActivity();

    // A collaboration runtime routes to its parent, but must not act as that parent.
    const workflowCallerConversationId =
      runtimeState.workflowContext === undefined &&
      !isProjectConversation &&
      input.persistence === "durable" &&
      isOrdinaryConversationRole(input.role)
        ? input.target.conversationId
        : null;

    const newRuntime = await factory.createRuntime({
      executionClass,
      conversationId: input.target.conversationId,
      projectPath: input.projectPath,
      projectName,
      // Scope is decided here, where it is known authoritatively, and passed
      // forward as declared input (D4) — the runtimes never re-derive it.
      conversationTarget: input.target,
      ...(workflowCallerConversationId !== null
        ? { workflowCallerConversationId }
        : {}),
      worktreePath: input.worktreePath,
      persistedRef: resumeRef,
      modelSelection: effectiveModelSelection,
      outputFormat: input.turn.outputFormat,
      sessionInstructions,
      tooling: {
        portableMcp,
        ...(capabilityCascadeSeed !== undefined
          ? { capabilities: capabilityCascadeSeed }
          : {}),
      },
      // Established at session start, so it is create-input rather than
      // turn-input; the recreation check above guarantees the live runtime's
      // envelope is the one this turn asked for.
      ...(input.turn.fsWritePolicy !== undefined
        ? { fsWritePolicy: input.turn.fsWritePolicy }
        : {}),
      ...(runtimeState.workflowContext
        ? {
            workflowExecutionId: runtimeState.workflowContext.executionId,
            workflowContextId: runtimeState.workflowContext.contextId,
          }
        : {}),
      ...(externalTurnHandler
        ? { onExternalTurnEvent: externalTurnHandler }
        : {}),
      onBackgroundTasksLost,
      onBackgroundActivity: (activity) => {
        if (
          deps.execution.getRuntime(key) !== runtimeState ||
          !runtimeState.managed.isCurrent(incarnation)
        )
          return;
        getBackgroundActivityChannel().record(
          backgroundActivityIdentity,
          activity,
        );
      },
    });

    // Register the created handle before testing cancellation so teardown owns it.
    runtimeState.managed.install(
      incarnation,
      newRuntime,
      desiredConfiguration,
      {
        register: deps.execution.registerBackendRuntime,
        unregister: deps.execution.unregisterBackendRuntime,
      },
      externalTurnHandler,
    );
    backendRuntime = newRuntime;
    if (signal?.aborted) {
      if (attempt) await attempt.closeBackend();
      else await runtimeState.managed.close();
      signal.throwIfAborted();
    }
    await seedRuntimeMcpState(portableMcp, newRuntime.mcpConfigDelivery);
    if (capabilityRuntimeStateSeed) {
      await seedRuntimeCapabilityState(
        deps.policy,
        capabilityCtx,
        reconcileDeliveredCapabilityState(
          capabilityRuntimeStateSeed,
          newRuntime.capabilitiesAtCreation,
        ),
      );
    }

    await instructions.consumeNotices();

    return newRuntime;
  }

  if (isNewRuntime) {
    backendRuntime = await createManagedBackendRuntime();
  }
  const turnAlignmentVersion =
    runtimeState.managed.configurationSnapshot?.alignmentVersion ?? null;

  // ---------------------------------------------------------------
  // Safety-net timeout + inactivity (stall) watchdog
  // ---------------------------------------------------------------
  const timeoutMs = resolveBackendTimeoutMs(input.agentBackend, config);
  const stallTimeoutMs = resolveBackendStallTimeoutMs(
    input.agentBackend,
    config,
  );
  signal?.throwIfAborted();
  const abortWiring = wireTurnAbort({
    runtimeState,
    conversationId: input.target.conversationId,
    sessionName: conversationTargetStoreSessionName(input.target),
    backend: input.agentBackend,
    timeoutMs,
    stallTimeoutMs,
  });
  attempt?.ownDisposer(abortWiring.cleanup);
  const abortController = abortWiring.abortController;
  const abortInvocation = () => abortController.abort(signal?.reason);
  signal?.addEventListener("abort", abortInvocation, { once: true });

  // ---------------------------------------------------------------
  // Build turn input and execute
  // ---------------------------------------------------------------
  const contentBlocks: MessageContentBlock[] = [];
  let persistedContentEventCount = 0;
  let sawErrorEvent = false;
  let seedBackendRef = input.backendRef;

  // onEvent: translate backend events into existing SSE emit path
  const onEvent = async (event: ConversationBackendEvent): Promise<void> => {
    if (attempt && !attempt.isCurrent()) return;
    // Every backend event proves the turn is alive, whatever its type.
    abortWiring.notifyActivity();
    switch (event.type) {
      case "input_accepted": {
        if (event.mcpConfigHash)
          await recordMcpConfigReceipt(
            deps.policy.state.mcp,
            {
              ...conversationStoreIdentity(input),
              projectName: input.target.projectName,
            },
            event.mcpConfigHash,
          );
        await preparedContext?.onInputAccepted(seedBackendRef);
        break;
      }

      case "backend_init":
        seedBackendRef = event.backendRef;
        runtimeState.sendToMachine?.({
          type: "BACKEND_INIT",
          executionAttemptId: input.executionAttemptId,
          backendRef: event.backendRef,
        });
        await preparedContext?.onBackendInit(event.backendRef);
        {
          const initEntry = transcriptProjection.projectBackendInit({
            timestamp: new Date().toISOString(),
            backendRef: event.backendRef,
          });
          if (initEntry !== null) {
            await appendBackendEventEntry(
              input.target.conversationId,
              initEntry,
            );
          }
        }
        break;

      case "content":
        contentBlocks.push(event.block);
        runtimeState.streamEmit?.("content", event.block);
        if (transcriptProjection.persistContentEvents) {
          await appendBackendEventEntry(input.target.conversationId, {
            timestamp: new Date().toISOString(),
            type: "assistant",
            role: "assistant",
            content: [event.block],
          });
          persistedContentEventCount += 1;
          deps.log.debug("prompt.content_event_persisted", {
            ...scopeRef,
            conversationId: input.target.conversationId,
            backend: input.agentBackend,
            blockType: event.block.type,
            contentBlockCount: persistedContentEventCount,
          });
        }
        break;

      case "transcript_entry":
        // The adapter interprets; the actor records. The frame is appended
        // verbatim — the payload is never read above the backend seam.
        await appendBackendEventEntry(
          input.target.conversationId,
          conversationTranscriptFrame(event.entry),
        );
        break;

      case "error":
        sawErrorEvent = true;
        runtimeState.streamEmit?.("error", { message: event.message });
        break;
    }
  };

  let agentCallResult: AgentCallResult | undefined;
  try {
    preparedContext = await prepareConversationTurnContext(deps, {
      execution: input,
      promptText: assembled.rewrittenPromptText,
      continuation,
      workflowContext: runtimeState.workflowContext,
      runtimeCreatedWithoutResume: isRuntimeCreatedWithoutResume({
        willCreateRuntime: isNewRuntime,
        promptCount: input.promptCount,
        hasResumeHandle: resumeRef !== null,
        pendingCheckpoint: deliversCheckpoint,
      }),
      checkpoint,
      resultAttemptId: workflowResultAttemptId,
      ownReceipt: (finish) => attempt?.ownReceipt(finish),
      archiveQueuedInput: () => queuedAccounting.appendAcceptedUserEntry(),
      onQueueAccepted: () => queuedAccounting.handleInputAccepted(),
    });
    const {
      promptText,
      userPromptText,
      dispatchPromptText,
      promptContext,
      syntheticForkSeed,
    } = preparedContext;

    // Pre-turn MCP apply, run by the facade in its fixed pre-dispatch order.
    // Only reused runtimes need it — a fresh runtime was created with the
    // composed config already baked in. A rejected apply fails the call inside
    // the facade (capability_unavailable) before the prompt is delivered.
    const applyMcpHook = isNewRuntime
      ? undefined
      : async (): Promise<McpApplyHookResult> => {
          deps.log.info("prompt.mcp_turn_start_apply", {
            ...scopeRef,
            backend: input.agentBackend,
            conversationId: input.target.conversationId,
          });
          const mcpApplyResult = await deps.policy.applyMcpAtTurnStart({
            projectPath: input.projectPath,
            sessionName: conversationTargetStoreSessionName(input.target),
            conversationId: input.target.conversationId,
            backend: input.agentBackend,
          });

          deps.log.info("prompt.mcp_turn_start_result", {
            ...scopeRef,
            backend: input.agentBackend,
            conversationId: input.target.conversationId,
            disposition: mcpApplyResult.disposition,
          });

          if (mcpApplyResult.disposition === "rejected") {
            deps.log.warn("prompt.mcp_turn_start_failed", {
              ...scopeRef,
              backend: input.agentBackend,
              conversationId: input.target.conversationId,
              disposition: mcpApplyResult.disposition,
              error: mcpApplyResult.error,
            });
            return {
              ok: false,
              message: formatTurnStartMcpApplyFailure(mcpApplyResult),
            };
          }
          return { ok: true };
        };

    await applyCapabilityCascadeAtTurnStart(deps.policy, capabilityCtx, {
      isNewRuntime,
    });

    // Close + unregister the current runtime and build a fresh, resume-
    // preserving one (createManagedBackendRuntime threads `persistedRef`).
    // Shared by the pre-turn readiness gate and the dispatch retry loop.
    const recreateRuntimeForTurn =
      async (): Promise<ConversationBackendRuntime> => {
        if (attempt) await attempt.closeBackend();
        else await runtimeState.managed.close();
        signal?.throwIfAborted();
        backendRuntime = await createManagedBackendRuntime();
        return backendRuntime;
      };

    // Pre-turn readiness (the primary fix). For a reused runtime this lets the
    // runtime refresh its transport BEFORE the prompt is delivered — the
    // disconnect window is safe because no tool call is in flight. On an
    // unrecoverable runtime, recreate it (resume-preserving) and retry once; a
    // second failure fails the prompt BEFORE delivery rather than
    // feeding it into a broken runtime. Backends without
    // `prepareForTurnStart` are unaffected.
    const ready = (await backendRuntime!.prepareForTurnStart?.()) ?? {
      status: "ready" as const,
    };
    if (ready.status === "recreate-runtime") {
      deps.log.warn("prompt.runtime_recreated_after_session_tools_failure", {
        ...scopeRef,
        conversationId: input.target.conversationId,
        reason: ready.reason,
      });
      await recreateRuntimeForTurn();
      const retry = (await backendRuntime!.prepareForTurnStart?.()) ?? {
        status: "ready" as const,
      };
      if (retry.status === "recreate-runtime") {
        deps.log.error("prompt.session_tools_unrecoverable", {
          ...scopeRef,
          conversationId: input.target.conversationId,
          reason: retry.reason,
        });
        throw markPromptNotDelivered(
          new Error(
            `Prompt not delivered: runtime unrecoverable (${retry.reason})`,
          ),
        );
      }
    }

    // A checkpoint delivery binds the admitted attempt to the seed BEFORE the
    // provider is called: the fingerprint of the exact input dispatched
    // below, the fingerprint of the input as submitted (what a queued batch
    // can be reassembled into) and the queued rows it carries are durable
    // first, so a crash after this point is an attempt whose outcome is
    // unknown rather than one that never was.
    if (checkpoint) {
      if (input.executionAttemptId === undefined)
        throw new Error(
          "checkpoint delivery requires an admitted turn attempt to bind",
        );
      await checkpoint.bind({
        attemptId: input.executionAttemptId,
        inputFingerprint: fingerprintAssembledInput({
          promptText,
          images: imageRefs,
        }),
        submittedInputFingerprint: fingerprintSubmittedInput({
          promptText: input.turn.promptText,
          images: input.turn.images ?? [],
          documentFeedback: input.turn.documentFeedback,
          notepadFeedback: input.turn.notepadFeedback,
        }),
        queuedAttemptId: input.turn.queuedDelivery?.deliveryAttemptId ?? null,
        queuedMessageId: input.turn.queuedDelivery?.messageIds[0] ?? null,
      });
    }

    // Route the turn through the shared AgentCall primitive. The runtime is
    // wrapped in the named `withRuntimeReplacementRetry` policy (single
    // reattempt on the neutral prompt-not-delivered fact) and the facade
    // normalizes every failure through the backend's failure classifier, so
    // the actor consumes only the widened `AgentCallResult`.
    agentCallResult = await dispatchTurnViaAgentCall({
      onUserQuestion:
        (input.turn.askUserQuestionsEnabled ?? !input.turn.autonomous)
          ? async (questions, signal) => {
              const { inTurnQuestionService } =
                await import("@/lib/conversations/in-turn-question-service");
              return inTurnQuestionService.request(
                {
                  projectPath: input.projectPath,
                  sessionName: conversationTargetStoreSessionName(input.target),
                  conversationId: input.target.conversationId,
                },
                questions,
                signal,
              );
            }
          : undefined,
      executionClass,
      executeAgentCall: deps.execution.executeAgentCall,
      getRuntime: () => backendRuntime!,
      replaceRuntime: recreateRuntimeForTurn,
      applyMcp: applyMcpHook,
      signal: abortController.signal,
      conversationId: input.target.conversationId,
      scopeRef,
      log: deps.log,
      backend: input.agentBackend,
      promptText: dispatchPromptText,
      userPromptText,
      ...(promptContext !== undefined ? { promptContext } : {}),
      imageRefs: imageRefs.length > 0 ? imageRefs : undefined,
      modelSelection: effectiveModelSelection,
      autonomous: input.turn.autonomous ?? false,
      waitForBackgroundTasks: input.turn.waitForBackgroundTasks ?? false,
      outputFormat: input.turn.outputFormat,
      onEvent,
      syntheticForkSeed,
      observe: {
        sending: () => checkpoint?.markDispatched(),
        failed: (error) => checkpoint?.markDispatchFailure(error),
        completed: (result) => {
          if (
            !result.cleanupFailure ||
            !runtimeState.managed.recordCleanupFailure(result.cleanupFailure)
          )
            return;
          deps.log.error("conversation.cleanup_unverified", {
            ...input.target,
            worktreePath: input.worktreePath,
            message: result.cleanupFailure.message,
          });
          void runtimeState.managed.track(
            Promise.resolve()
              .then(() =>
                deps.effects.notifyRuntimeCleanup({
                  target: input.target,
                  worktreePath: input.worktreePath,
                }),
              )
              .catch((error: unknown) => {
                deps.log.error("conversation.cleanup_notification_failed", {
                  ...input.target,
                  error: getErrorMessage(error),
                });
              }),
          );
        },
      },
      fsWritePolicy: input.turn.fsWritePolicy,
    });
    runtimeState.attempt?.recordResult(
      agentCallResult,
      abortWiring.timeoutFired()
        ? { reason: "timeout", timeoutMs }
        : abortWiring.stallFired()
          ? { reason: "stalled", timeoutMs: stallTimeoutMs }
          : undefined,
    );

    // A failed outcome without `contentBlocks` means the failure carries no
    // adapter turn result: dispatch threw (normalized by the facade) or the
    // pre-turn MCP apply rejected. Their stream events are emitted here;
    // the shared projection still retains normalized usage and classification.
    const turnlessFailure =
      agentCallResult.outcome.kind === "failed" &&
      agentCallResult.outcome.contentBlocks === undefined
        ? agentCallResult.outcome
        : undefined;

    if (turnlessFailure && abortController.signal.aborted) {
      const timeoutFired = abortWiring.timeoutFired();
      const stallFired = abortWiring.stallFired();
      deps.log.info("prompt.aborted", {
        ...scopeRef,
        ...(timeoutFired
          ? { abortReason: "timeout", timeoutMs }
          : stallFired
            ? { abortReason: "stalled", stallTimeoutMs }
            : {}),
      });
      runtimeState.streamEmit?.("aborted", {
        message: timeoutFired
          ? `Prompt execution timed out after ${timeoutMs}ms`
          : stallFired
            ? `Prompt execution stalled: no agent activity for ${stallTimeoutMs}ms`
            : "Prompt execution was cancelled",
      });
      return toPromptActorResult(
        {
          kind: "call_result",
          result: agentCallResult,
          interruption: {
            reason: timeoutFired ? "timeout" : stallFired ? "stalled" : "user",
            ...(timeoutFired
              ? { timeoutMs }
              : stallFired
                ? { timeoutMs: stallTimeoutMs }
                : {}),
          },
        },
        { fallbackContentBlocks: contentBlocks, suppressAbortError: true },
      );
    }

    if (turnlessFailure) {
      const errorMsg = turnlessFailure.error.message;
      // Pre-turn MCP rejection surfaces its formatted message directly; a
      // normalized dispatch throw keeps the legacy "SDK error:" surface.
      if (turnlessFailure.error.failureKind === "capability_unavailable") {
        runtimeState.streamEmit?.("error", {
          message: errorMsg,
          ...(turnlessFailure.error.code !== undefined
            ? { code: turnlessFailure.error.code }
            : {}),
        });
      } else {
        deps.log.error("prompt.sdk_error", {
          ...scopeRef,
          failureKind: turnlessFailure.error.failureKind,
          error: errorMsg,
        });
        await drainCapabilityWhenIdle(deps.policy, capabilityCtx);
        runtimeState.streamEmit?.("error", {
          message: `SDK error: ${errorMsg}`,
        });
      }
      return toPromptActorResult(
        { kind: "call_result", result: agentCallResult },
        {
          fallbackContentBlocks:
            turnlessFailure.error.failureKind === "capability_unavailable"
              ? []
              : contentBlocks,
          suppressAbortError: true,
        },
      );
    }

    await drainCapabilityWhenIdle(deps.policy, capabilityCtx);
  } catch (err) {
    if (abortController.signal.aborted) {
      const timeoutFired = abortWiring.timeoutFired();
      const stallFired = abortWiring.stallFired();
      deps.log.info("prompt.aborted", {
        ...scopeRef,
        ...(timeoutFired
          ? { abortReason: "timeout", timeoutMs }
          : stallFired
            ? { abortReason: "stalled", stallTimeoutMs }
            : {}),
      });
      runtimeState.streamEmit?.("aborted", {
        message: timeoutFired
          ? `Prompt execution timed out after ${timeoutMs}ms`
          : stallFired
            ? `Prompt execution stalled: no agent activity for ${stallTimeoutMs}ms`
            : "Prompt execution was cancelled",
      });
      return buildAbortedTurnResult({
        contentBlocks,
        timeoutFired,
        timeoutMs,
        stallFired,
        stallTimeoutMs,
      });
    }

    const errorMsg = getErrorMessage(err);
    deps.log.error("prompt.sdk_error", {
      ...scopeRef,
      error: errorMsg,
    });
    await drainCapabilityWhenIdle(deps.policy, capabilityCtx);
    runtimeState.streamEmit?.("error", { message: `SDK error: ${errorMsg}` });
    return buildFailedTurnResult({
      contentBlocks,
      error: errorMsg,
      continuationDisposition: "retain",
    });
  } finally {
    signal?.removeEventListener("abort", abortInvocation);
    abortWiring.cleanup();
    runtimeState.currentTurnAutonomous = undefined;
    runtimeState.currentTurnMessageId = undefined;
    if (!attempt) {
      await preparedContext?.finish();
      await checkpoint?.finish();
    }
  }

  // Every turnless-failure path returned inside the try (or the catch); a
  // result that reaches this mapping carries an adapter-built outcome.
  const callResult = agentCallResult!;
  if (callResult.compacted === true) {
    await resetMemoryIndexAfterBackendCompaction(
      deps,
      input.target.conversationId,
    );
  }
  const completedOutcome =
    callResult.outcome.kind === "completed" ? callResult.outcome : undefined;
  const failedOutcome =
    callResult.outcome.kind === "failed" ? callResult.outcome : undefined;
  const projected = toPromptActorResult(
    {
      kind: "call_result",
      result: callResult,
      ...(abortWiring.timeoutFired()
        ? { interruption: { reason: "timeout", timeoutMs } }
        : abortWiring.stallFired()
          ? { interruption: { reason: "stalled", timeoutMs: stallTimeoutMs } }
          : {}),
    },
    {
      fallbackContentBlocks: contentBlocks,
      suppressAbortError: !runtimeState.managed.cleanupFailure,
    },
  );
  const {
    aborted: turnAborted,
    error: effectiveError,
    structuredOutput: effectiveStructuredOutput,
    numTurns: resultNumTurns,
  } = projected;
  const gateSchemaValidationFailure =
    failedOutcome?.error.failureKind === "schema_validation";

  if (effectiveError && !turnAborted && !sawErrorEvent) {
    deps.log.warn("prompt.turn_error_fallback_emitted", {
      ...scopeRef,
      backend: input.agentBackend,
      message: effectiveError,
      ...(gateSchemaValidationFailure
        ? { failureKind: "schema_validation" as const }
        : {}),
    });
    runtimeState.streamEmit?.("error", { message: effectiveError });
  }

  // Preserve any trailing blocks returned by a backend that were not emitted
  // through onEvent, then append its optional compatibility result envelope.
  const adapterContentBlocks =
    completedOutcome?.contentBlocks ?? failedOutcome?.contentBlocks;
  if (adapterContentBlocks) {
    if (transcriptProjection.persistContentEvents) {
      const missingContent = adapterContentBlocks.slice(
        persistedContentEventCount,
      );
      if (missingContent.length > 0) {
        deps.log.warn("prompt.content_event_fallback", {
          ...scopeRef,
          conversationId: input.target.conversationId,
          backend: backendRuntime!.backend,
          missingContentBlockCount: missingContent.length,
        });
        await safeAppendWithMeta(input.target.conversationId, {
          timestamp: new Date().toISOString(),
          type: "assistant",
          role: "assistant",
          content: missingContent,
        });
      }
    }

    const resultEntry = transcriptProjection.projectTurnResult({
      timestamp: new Date().toISOString(),
      backendRef: callResult.backendRef,
      durationMs: callResult.usage.durationMs ?? null,
      numTurns: resultNumTurns,
      contextTokens: callResult.usage.contextTokens ?? null,
      contextWindowMax: callResult.usage.contextWindowMax ?? null,
      costUsd: callResult.usage.costUsd ?? null,
      cumulativeCostUsd: callResult.usage.cumulativeCostUsd ?? null,
      aborted: turnAborted,
      error: effectiveError,
    });
    if (resultEntry !== null) {
      await safeAppendWithMeta(input.target.conversationId, resultEntry);
    }
  }

  // Queued turns have no browser prompt stream, and transient error events
  // cannot explain a stopped turn after the conversation is reloaded.
  if (effectiveError && !turnAborted) {
    await safeAppendWithMeta(input.target.conversationId, {
      timestamp: new Date().toISOString(),
      type: "notice",
      role: "notice",
      content: [{ type: "text", text: `Turn stopped: ${effectiveError}` }],
    });
  }

  // Persist a typed `debug_structured` block when a debug-mode turn produced
  // a structured output. Backend-agnostic — the shared gate populates the
  // value from accepted final-response text or a backend-native payload. The
  // block merges with the preceding assistant text via
  // readConversationMessages, letting the renderer dispatch on `phase`.
  if (
    input.debugMode?.active === true &&
    effectiveStructuredOutput != null &&
    !effectiveError
  ) {
    await safeAppendWithMeta(input.target.conversationId, {
      timestamp: new Date().toISOString(),
      type: "assistant",
      role: "assistant",
      content: [
        {
          type: "debug_structured",
          phase: input.debugMode.phase,
          payload: effectiveStructuredOutput,
        },
      ],
    });
  }

  // R8.4: the runtime carries the charter version actually baked in. Only
  // attended normal-session turns are alignment-eligible, so project/optimistic/
  // autonomous turns leave the seen-version untouched.
  if (alignmentEligibleThisTurn && backendRuntime) {
    await recordSeenAlignmentVersion(deps.effects, {
      projectPath: input.projectPath,
      sessionName: conversationTargetStoreSessionName(input.target),
      conversationId: input.target.conversationId,
      seenAlignmentVersion: turnAlignmentVersion,
    });
  }

  const result = projected;

  deps.log.info("prompt.complete", {
    ...scopeRef,
    costUsd: result.costUsd,
    numTurns: result.numTurns,
  });

  return result;
}

/**
 * Execute a single-shot `task_run` turn via the shared AgentCall primitive.
 *
 * Non-streaming counterpart to `executePromptForMachine`. Builds one
 * `task_run` AgentCallRequest from the active turn, prepends the linked
 * ticket's current context through the same transient per-turn seam, awaits the full
 * `AgentCallResult` (the facade's structured-output gate runs inside
 * `executeAgentCall` when `outputSchema` is present — the actor never
 * extracts structured payloads itself), persists exactly ONE final assistant
 * TranscriptMessage via the existing append path, and lets the broadcast
 * meta trigger `message-appended` SSE once.
 */
async function runTaskRunTurnForMachine(
  deps: ConversationActorDependencies,
  input: RunTaskRunInput,
  signal?: AbortSignal,
): Promise<PromptActorResult> {
  const runtime = getConversationRuntime(
    conversationRuntimeKey(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    ),
  );
  if (!runtime)
    throw missingRuntimeError(
      input.projectPath,
      conversationTargetStoreSessionName(input.target),
      input.target.conversationId,
    );
  signal ??= runtime.abortController.signal;
  signal.throwIfAborted();
  try {
    await assertBackendExecution(input.agentBackend, {
      facet: "tasks",
      operation: "task-run",
      executionClass: input.turn.executionClass,
      executionProfile: input.turn.executionProfile ?? "standard",
      requiresPrivilegedInstructions: input.turn.requiresPrivilegedInstructions,
      requiresFsWriteRestriction: input.turn.fsWritePolicy !== undefined,
    });
  } catch (error) {
    if (!(error instanceof BackendAdmissionError)) throw error;
    runtime.attempt?.recordFailure(error);
    return admissionFailure(error);
  }
  const transcriptProjection = getTaskTranscriptProjection(input.agentBackend);

  // Diagnostic identity (R1.3) omits the session field for project scope.
  const scopeRef = scopeRefFromStoreSessionName(
    conversationTargetStoreSessionName(input.target),
  );

  const projectName = input.target.projectName;

  const broadcastMeta: TranscriptBroadcastMeta = {
    projectName,
    storeSessionName: conversationTargetStoreSessionName(input.target),
  };

  const effectivePrompt = await prepareTaskPrompt(deps, {
    projectPath: input.projectPath,
    target: input.target,
    promptText: input.turn.promptText,
  });

  let effectiveModelSelection = input.turn.modelSelection;
  let effectiveTimeoutMs = input.turn.timeoutMs;
  let taskStallTimeoutMs: number | undefined;
  let config: ActorConfig | undefined;
  try {
    config = await deps.execution.readConfig();
    const defaults = resolveAgentBackendTurnDefaults({
      backend: input.agentBackend,
      config,
      explicit: { modelSelection: input.turn.modelSelection },
    });
    effectiveModelSelection = defaults.modelSelection;
    effectiveTimeoutMs = input.turn.timeoutMs ?? defaults.timeoutMs;
    taskStallTimeoutMs = defaults.stallTimeoutMs;
  } catch (err) {
    deps.log.warn("task_run.defaults_resolution_failed", {
      ...scopeRef,
      backend: input.agentBackend,
      conversationId: input.target.conversationId,
      error: getErrorMessage(err),
    });
    if (effectiveModelSelection === null) throw err;
  }

  if (effectiveModelSelection === null) {
    throw new Error(
      `Task run for backend "${input.agentBackend}" has no model selection.`,
    );
  }
  const requestedModelSelection = effectiveModelSelection;

  const modelSelectionSourceLayer =
    input.turn.modelSelection === null ? "backend_default" : "explicit";
  const buildModelSelectionFailure = (diagnostic: {
    code: string;
    message: string;
    modelId: string;
    parameterId?: string;
  }): PromptActorResult => {
    deps.log.warn("model_selection.rejected", {
      ...scopeRef,
      backend: input.agentBackend,
      conversationId: input.target.conversationId,
      modelId: diagnostic.modelId,
      parameterIds: Object.keys(requestedModelSelection.parameters).sort(),
      sourceLayer: modelSelectionSourceLayer,
      code: diagnostic.code,
      ...(diagnostic.parameterId !== undefined
        ? { parameterId: diagnostic.parameterId }
        : {}),
    });
    return buildFailedTurnResult({
      contentBlocks: [],
      error: diagnostic.message,
      continuationDisposition: "retain",
    });
  };

  let admission: ProjectModelSelectionValidation;
  try {
    admission = await deps.execution.admitConfiguredModelSelection({
      backend: input.agentBackend,
      projectPath: input.projectPath,
      modelSelection: requestedModelSelection,
      ...(config !== undefined ? { config } : {}),
    });
  } catch (error) {
    return buildModelSelectionFailure({
      code: "selection_validation_failed",
      message: getErrorMessage(error),
      modelId: requestedModelSelection.modelId,
    });
  }

  if (!admission.ok) {
    return buildModelSelectionFailure(admission);
  }
  effectiveModelSelection = admission.modelSelection;

  deps.log.debug("model_selection.resolved", {
    ...scopeRef,
    backend: input.agentBackend,
    conversationId: input.target.conversationId,
    modelId: effectiveModelSelection.modelId,
    parameterIds: Object.keys(effectiveModelSelection.parameters).sort(),
    sourceLayer: modelSelectionSourceLayer,
  });

  await input.onModelSelectionResolved(effectiveModelSelection);

  // The turn's permission literals are derived from the lane's role — the
  // presence of a server-derived write envelope — never asserted here.
  const permissions = deriveTaskRunPermissions(input.turn.fsWritePolicy);

  const request: AgentCallRequest = {
    kind: "task_run",
    executionClass: input.turn.executionClass,
    executionProfile: input.turn.executionProfile ?? "standard",
    requiresPrivilegedInstructions: input.turn.requiresPrivilegedInstructions,
    prompt: effectivePrompt,
    backend: input.agentBackend,
    writeCapability: permissions.writeCapability,
    ...(input.turn.fsWritePolicy !== undefined
      ? { fsWritePolicy: input.turn.fsWritePolicy }
      : {}),
    modelSelection: effectiveModelSelection,
    ...(input.turn.outputFormat?.type === "json_schema"
      ? { outputSchema: input.turn.outputFormat.schema }
      : {}),
    ...(input.turn.systemInstructions !== undefined
      ? { systemInstructions: input.turn.systemInstructions }
      : {}),
    ...(input.turn.tooling !== undefined
      ? { tooling: input.turn.tooling }
      : {}),
    ...(effectiveTimeoutMs !== undefined
      ? { timeoutMs: effectiveTimeoutMs }
      : {}),
  };

  const abortController = runtime.abortController;
  signal.throwIfAborted();

  // Semantic execution intent: the facade resolves the runner and capability
  // view from the registry (`deps.execution.getTaskRunner` stays the DI seam for tests).
  const resumeRef =
    input.turn.resumeRef === undefined
      ? input.backendRef
      : input.turn.resumeRef;
  const facadeDeps: AgentCallFacadeDeps = {
    taskExecution: {
      workingDirectory: input.worktreePath,
      ...(input.persistence === "durable" &&
      input.turn.executionProfile !== "isolated-one-shot"
        ? { conversationTarget: input.target }
        : {}),
      ...(input.persistence === "durable" &&
      input.target.scope === "session" &&
      input.turn.executionProfile !== "isolated-one-shot" &&
      (input.role === "validator" ||
        input.turn.executionClass === "governed-execution")
        ? {
            ccSessionScope: {
              project: input.target.projectName,
              session: input.target.sessionName,
              conversationId: input.target.conversationId,
            },
          }
        : {}),
      autonomous: true,
      signal: abortController.signal,
      ...(resumeRef !== null ? { resumeRef } : {}),
      ...(effectiveTimeoutMs !== undefined
        ? { defaultTimeoutMs: effectiveTimeoutMs }
        : {}),
      ...(taskStallTimeoutMs !== undefined
        ? { stallTimeoutMs: taskStallTimeoutMs }
        : {}),
      sandboxMode: permissions.sandboxMode,
      approvalPolicy: permissions.approvalPolicy,
      webSearchMode: permissions.webSearchMode,
      skipGitRepoCheck: permissions.skipGitRepoCheck,
      networkAccessEnabled: permissions.networkAccessEnabled,
    },
    getTaskRunner: (backend) => deps.execution.getTaskRunner(backend),
    getFailureClassifier: resolveFailureClassifierForBackend,
  };

  deps.log.info("task_run.dispatch", {
    ...scopeRef,
    backend: input.agentBackend,
    conversationId: input.target.conversationId,
    hasOutputSchema: request.outputSchema !== undefined,
    hasCcSessionScope: facadeDeps.taskExecution?.ccSessionScope !== undefined,
    hasConversationTarget:
      facadeDeps.taskExecution?.conversationTarget !== undefined,
    executionClass: request.executionClass,
    executionProfile: request.executionProfile,
    structuredOutputTextField: input.turn.structuredOutputTextField,
  });

  let result: AgentCallResult;
  try {
    signal.throwIfAborted();
    if (runtime.managed.backend) {
      await runtime.managed.close();
      deps.log.info("task_run.conversation_runtime_released", {
        ...scopeRef,
        backend: input.agentBackend,
        conversationId: input.target.conversationId,
      });
      signal.throwIfAborted();
    }
    result = await deps.execution.executeAgentCall(request, facadeDeps);
    runtime.attempt?.recordResult(result);
  } catch (err) {
    const errorMsg = getErrorMessage(err);
    deps.log.error("task_run.execute_threw", {
      ...scopeRef,
      backend: input.agentBackend,
      conversationId: input.target.conversationId,
      error: errorMsg,
    });
    return buildFailedTurnResult({
      contentBlocks: [],
      error: errorMsg,
      continuationDisposition: "retain",
    });
  }

  const projected = toPromptActorResult(
    { kind: "call_result", result },
    { structuredOutputTextField: input.turn.structuredOutputTextField },
  );
  const backendRef = projected.backendRef;
  // Partial content from a failed task travels to its caller for inspection;
  // only completed task output is appended to the assistant transcript.
  if (result.outcome.kind === "completed") {
    const contentBlocks = projected.contentBlocks;
    if (
      input.turn.structuredOutputTextField !== undefined &&
      (typeof result.outcome.structuredOutput !== "object" ||
        result.outcome.structuredOutput === null ||
        typeof Reflect.get(
          result.outcome.structuredOutput,
          input.turn.structuredOutputTextField,
        ) !== "string")
    ) {
      deps.log.warn("task_run.structured_output_text_field_missing", {
        ...scopeRef,
        backend: input.agentBackend,
        conversationId: input.target.conversationId,
        structuredOutputTextField: input.turn.structuredOutputTextField,
      });
    }

    if (contentBlocks.length > 0) {
      const rawMetadata =
        transcriptProjection.projectAssistantMetadata(backendRef);
      await deps.transcript.safeAppendTranscriptEntry(
        input.target.conversationId,
        {
          timestamp: new Date().toISOString(),
          type: "assistant",
          role: "assistant",
          content: contentBlocks,
          ...(rawMetadata !== undefined ? { raw: rawMetadata } : {}),
          ...(input.turn.origin !== undefined
            ? { origin: input.turn.origin }
            : {}),
        },
        broadcastMeta,
      );
    }

    deps.log.info("task_run.complete", {
      ...scopeRef,
      backend: input.agentBackend,
      conversationId: input.target.conversationId,
      hasStructuredOutput: result.outcome.structuredOutput !== undefined,
    });

    return projected;
  }
  if (result.outcome.kind === "failed") {
    deps.log.warn("task_run.failed", {
      ...scopeRef,
      backend: input.agentBackend,
      conversationId: input.target.conversationId,
      failureKind: result.outcome.error.failureKind,
      message: result.outcome.error.message,
      issueCount: projected.structuredOutputIssues?.length ?? 0,
    });
    return projected;
  }
  // The task path produces no pauses; callers receive a deterministic failure.
  deps.log.warn("task_run.unexpected_paused_outcome", {
    ...scopeRef,
    backend: input.agentBackend,
    conversationId: input.target.conversationId,
  });
  return projected;
}

/** Cancellation must finish dispatch and teardown before review can repeat work. */
async function finalizeQueuedDeliveryForMachine(
  deps: ConversationActorDependencies,
  input: import("./types").FinalizeQueuedDeliveryInput,
): Promise<void> {
  try {
    await deps.effects.markQueuedUncertain({
      projectPath: input.projectPath,
      sessionName: conversationTargetStoreSessionName(input.target),
      conversationId: input.target.conversationId,
      ids: input.queuedDelivery.messageIds,
      deliveryAttemptId: input.queuedDelivery.deliveryAttemptId,
      error:
        "Delivery ended without a durable acknowledgement. Review before retrying or discarding.",
    });
  } catch (error) {
    deps.log.error("queue.finalization_failed", {
      ...scopeRefFromStoreSessionName(
        conversationTargetStoreSessionName(input.target),
      ),
      conversationId: input.target.conversationId,
      deliveryAttemptId: input.queuedDelivery.deliveryAttemptId,
      error: getErrorMessage(error),
    });
    throw error;
  }
}

export type CheckpointCaptureRuntimeInput = Pick<
  import("@/lib/agent-backends/conversation").ConversationBackendCreateInput,
  "projectPath" | "worktreePath"
> & {
  target: import("@/lib/conversations/conversation-target").ConversationTarget;
  agentBackend: AgentBackendId;
  modelSelection: BackendModelSelection;
  backendRef: import("@/lib/shared/schemas").AgentSessionRef;
  captureId: string;
  mode: import("@/lib/agent-backends/schemas").CaptureMode;
};

export interface CheckpointCaptureSelectionInput {
  agentBackend: AgentBackendId;
  transcriptPath: string | null;
  projectPath: string;
}

export async function resolveCheckpointCaptureSelection(
  deps: Pick<ConversationActorDependencies, "execution" | "transcript">,
  input: CheckpointCaptureSelectionInput,
): Promise<BackendModelSelection> {
  const [config, priorMessages] = await Promise.all([
    deps.execution.readConfig(),
    deps.transcript.readConversationMessages(input.transcriptPath),
  ]);
  return resolveTurnModelSelection({
    backend: input.agentBackend,
    config,
    priorMessages,
    explicitModelSelection: null,
  });
}

export async function acquireCheckpointCaptureRuntime(
  deps: {
    execution: ConversationActorDependencies["execution"];
    policy: Pick<
      ConversationActorDependencies["policy"],
      | "composePortableMcpForConversation"
      | "composeCapabilityConfigForConversation"
      | "composeCapabilityConfigForProjectConversation"
    >;
  },
  input: CheckpointCaptureRuntimeInput,
  signal?: AbortSignal,
): Promise<ConversationBackendRuntime | undefined> {
  signal?.throwIfAborted();
  const sessionName = conversationTargetStoreSessionName(input.target);
  const key = conversationRuntimeKey(
    input.projectPath,
    sessionName,
    input.target.conversationId,
  );
  const host = deps.execution.getRuntime(key);
  if (!host || input.backendRef.backend !== input.agentBackend)
    return undefined;
  const matches = (runtime: ConversationBackendRuntime) =>
    runtime.backend === input.agentBackend &&
    stableStringify(runtime.modelSelection) ===
      stableStringify(input.modelSelection);
  const current = host.managed.backend;
  if (current?.status === "alive") {
    if (!matches(current)) return undefined;
    // Disable idle eviction while maintenance awaits control acknowledgement;
    // a timer-driven close must not bypass the capture mode setup barrier.
    current.notifyTurnStarting?.();
    return current;
  }
  const projectName = input.target.projectName;
  const portableMcp = await deps.policy.composePortableMcpForConversation({
    backend: input.agentBackend,
    projectPath: input.projectPath,
    projectName,
    sessionName,
    conversationId: input.target.conversationId,
    worktreePath: input.worktreePath,
    ...(host.tooling?.portableMcp !== undefined
      ? { transientPortableMcp: host.tooling.portableMcp }
      : {}),
  });
  const capabilitySeed = await resolveCapabilitySeedForNewRuntime(deps.policy, {
    projectPath: input.projectPath,
    projectName,
    sessionName,
    conversationId: input.target.conversationId,
    worktreePath: input.worktreePath,
    backend: input.agentBackend,
    isProjectConversation: input.target.scope === "project",
    emitStreamError() {},
  });
  signal?.throwIfAborted();
  if (host.managed.backend) await host.managed.close();
  const incarnation = host.managed.beginCreation();
  const backgroundIdentity = {
    projectName,
    sessionName,
    conversationId: input.target.conversationId,
  };
  const created = await deps.execution
    .getConversationBackendFactory(input.agentBackend)
    .createRuntime({
      executionClass: "ordinary-conversation",
      initialPurpose: {
        kind: "checkpoint_handoff",
        captureId: input.captureId,
        mode: input.mode,
      },
      conversationId: input.target.conversationId,
      conversationTarget: input.target,
      projectPath: input.projectPath,
      projectName,
      worktreePath: input.worktreePath,
      persistedRef: input.backendRef,
      modelSelection: input.modelSelection,
      sessionInstructions: [],
      tooling: {
        portableMcp,
        ...(capabilitySeed
          ? { capabilities: capabilitySeed.capabilities }
          : {}),
      },
      onBackgroundActivity(activity) {
        if (
          deps.execution.getRuntime(key) === host &&
          host.managed.isCurrent(incarnation)
        )
          getBackgroundActivityChannel().record(backgroundIdentity, activity);
      },
    });
  // Installation precedes cancellation checks so the existing owner retains cleanup.
  host.managed.install(
    incarnation,
    created,
    {
      backend: input.agentBackend,
      modelSelection: input.modelSelection,
      alignmentVersion: null,
      repeatableInstructions: [],
      instructionSelection: { autonomous: false },
    },
    {
      register: deps.execution.registerBackendRuntime,
      unregister: deps.execution.unregisterBackendRuntime,
    },
  );
  if (signal?.aborted || !matches(created)) {
    await host.managed.close();
    signal?.throwIfAborted();
    return undefined;
  }
  return created;
}

export function createConversationActorImplementations(
  deps: ConversationActorDependencies,
) {
  return {
    resolveCheckpointCaptureSelection: (
      input: CheckpointCaptureSelectionInput,
    ) => resolveCheckpointCaptureSelection(deps, input),
    acquireCheckpointCaptureRuntime: (
      input: CheckpointCaptureRuntimeInput,
      signal?: AbortSignal,
    ) => acquireCheckpointCaptureRuntime(deps, input, signal),
    prepareTurnForMachine: (input: PrepareTurnInput, signal?: AbortSignal) =>
      prepareTurnForMachine(deps, input, signal),
    executePromptForMachine: (
      input: ExecutePromptInput,
      signal?: AbortSignal,
    ) => executePromptForMachine(deps, input, signal),
    runTaskRunTurnForMachine: (input: RunTaskRunInput, signal?: AbortSignal) =>
      runTaskRunTurnForMachine(deps, input, signal),
    finalizeQueuedDeliveryForMachine: (
      input: import("./types").FinalizeQueuedDeliveryInput,
    ) => finalizeQueuedDeliveryForMachine(deps, input),
  };
}
export type ConversationActorImplementations = ReturnType<
  typeof createConversationActorImplementations
>;
