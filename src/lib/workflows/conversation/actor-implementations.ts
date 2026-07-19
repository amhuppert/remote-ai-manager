/**
 * Production actor implementations for the conversation machine.
 *
 * These are lazy-imported by the actor stubs in `actors.ts`.
 *
 * Dependencies are injected via `setActorDeps()` (test) or lazily loaded
 * from production modules on first use. Follows the same DI pattern as
 * `persistence.ts` and `state.ts`.
 */

import type {
  PrepareTurnInput,
  PrepareTurnOutput,
  ExecutePromptInput,
  PromptActorResult,
  ConversationContext,
  RunTaskRunInput,
  VerifyCleanupInput,
  VerifyCleanupOutput,
} from "./types";
import { getErrorMessage } from "@/lib/shared/errors";
import type { AgentTaskRunner } from "@/lib/agent-backends/task";
import type {
  ConversationBackendRuntime,
  ConversationBackendFactory,
  ConversationBackendTurnInput,
  ConversationBackendEvent,
} from "@/lib/agent-backends/conversation";
import type { ApplyConversationIdentity } from "@/lib/agent-capabilities/apply";
import type {
  MessageContentBlock,
  ConversationState,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type { AlignmentInjection } from "@/lib/session-alignment/render";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type {
  TranscriptEntry,
  TranscriptBroadcastMeta,
} from "@/lib/prompt/transcript";
import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import type { ConversationApplyResult } from "@/lib/mcp/runtime-apply";
import { computeEffectiveConfigHash } from "@/lib/mcp/runtime-apply";
import {
  conversationRuntimeKey,
  getConversationRuntime,
} from "./runtime-state";
import { createLogger } from "@/lib/logging";
import {
  DEBUG_MODE_INSTRUCTIONS,
  DEBUG_PHASE_CONTEXT,
  CC_CONTEXT,
  CC_CLI_INSTRUCTIONS,
  TDD_INSTRUCTIONS,
  selectAskQuestionInstructions,
} from "@/lib/prompt/sdk-driver";
import { conversationTranscriptFrame } from "@/lib/agent-backends/transcript";
import type { BackendConversationCapabilities } from "@/lib/agent-backends/descriptor";
import {
  markPromptNotDelivered,
  type AgentFailureClassification,
  type AgentFailureClassifier,
  type ContinuationDisposition,
} from "@/lib/agent-backends/errors";
import { getBackendDescriptor } from "@/lib/agent-backends/registry";
import { withRuntimeReplacementRetry } from "./with-runtime-replacement-retry";
import { isProjectSentinel } from "@/lib/conversations/project-conversation-scope";
import {
  PROJECT_CC_CONTEXT,
  PROJECT_SPAWN_INSTRUCTIONS,
} from "@/lib/project-conversations/system-prompt";
import { createExternalTurnHandler } from "./external-turn-handler";
import { executeAgentCall as defaultExecuteAgentCall } from "@/lib/workflows/primitives/agent-call-facade";
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
} from "@/lib/agent-backends/conversation-policy";
import { getDebugManifestPath } from "@/lib/debug-log/service";
import type { ActorConfig } from "./pre-turn/resolve-model-effort";
import {
  resolveTurnModelEffort,
  resolveBackendTimeoutMs,
  resolveBackendStallTimeoutMs,
} from "./pre-turn/resolve-model-effort";
import {
  resolveTurnPromptText,
  composeUserTranscriptBlocks,
} from "./pre-turn/document-feedback";
import { persistTurnImages } from "./pre-turn/image-persistence";
import type {
  CapabilitySeed,
  ProjectCapabilitySeed,
  CapabilityTurnContext,
} from "./pre-turn/capability-cascade";
import {
  buildCapabilityApplyInput,
  resolveCapabilitySeedForNewRuntime,
  seedRuntimeCapabilityState,
  applyCapabilityCascadeAtTurnStart,
  drainCapabilityWhenIdle,
} from "./pre-turn/capability-cascade";
import {
  resolveAlignmentGateForReusedRuntime,
  resolveAlignmentInstructionForNewRuntime,
  recordSeenAlignmentVersion,
} from "./pre-turn/alignment-gate";
import {
  readPendingAgentNotices,
  buildPendingNoticesInstruction,
  drainConsumedAgentNotices,
  createBackgroundTasksLostHandler,
} from "./pre-turn/notices-drain";
import { resolveSyntheticForkSeed } from "./pre-turn/fork-seed";
import { registerFocusMemoryIfPresent } from "./pre-turn/focus-memory";
import { wireTurnAbort } from "./pre-turn/abort-wiring";
import { createQueuedDeliveryAccounting } from "./post-turn/queued-delivery-accounting";
import {
  buildFailedTurnResult,
  buildAbortedTurnResult,
} from "./post-turn/failure-fallback";

const logger = createLogger("conversation-actor");

// ============================================================
// Dependency Injection — narrow port groups
// ============================================================

/** Turn orchestration: locks, config, backend runtime lifecycle, state. */
export interface TurnExecutionDeps {
  // Resource acquisition
  acquireConversationLock(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): () => void;
  acquireQuerySlot(label: string): Promise<() => void>;

  // Config & project
  readConfig(): Promise<ActorConfig>;
  getProjectDisplayName(projectPath: string): string;

  // Backend runtime lifecycle
  getConversationBackendFactory(
    backend: AgentBackendId,
  ): ConversationBackendFactory;
  /**
   * Declared conversation capabilities from the backend's registered
   * descriptor. Undefined when the backend has no conversation facet. The
   * actor branches on declared capabilities (e.g. `externalTurns`), never on
   * backend identity.
   */
  getConversationCapabilities(
    backend: AgentBackendId,
  ): BackendConversationCapabilities | undefined;
  registerBackendRuntime(
    conversationId: string,
    runtime: ConversationBackendRuntime,
  ): void;
  unregisterBackendRuntime(conversationId: string): void;

  // Child environment and plugins (passed to backend factory)
  buildChildEnv(): NodeJS.ProcessEnv;
  resolvePluginPaths(): Promise<Array<{ name: string; path: string }>>;

  getCodexToolPromptHint(enabled: boolean): string | null;

  // State mutations
  mutateConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    label: string,
    mutate: (conversation: ConversationState) => void,
  ): Promise<void>;
  getConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
  getSessionState(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  // Active-charter governing injection for the per-turn prompt seam (R7).
  // Returns null when the session has no active charter. Gated by the actor to
  // attended normal sessions only (R12.1) before being called.
  getActiveAlignmentInjection(
    projectPath: string,
    sessionName: string,
  ): Promise<AlignmentInjection | null>;
  // Cheap active-version-number accessor for the per-turn recreate gate (R7.3).
  // Read only when reusing a live runtime; null when the session has no active
  // charter. Gated by the actor to attended normal sessions before being called.
  getActiveAlignmentVersion(
    projectPath: string,
    sessionName: string,
  ): Promise<number | null>;
  // Current <active-ticket> block for the session's linked ticket, rebuilt on
  // every turn (ticket-system 5.4/5.5); null when the session is unlinked.
  // Prepended to the transient effective prompt only — never baked into
  // session instructions, which persistent runtimes freeze at creation.
  getLiveTicketBlock(
    projectPath: string,
    sessionName: string,
  ): Promise<string | null>;

  // Reference documents — production routes through the shared
  // ArtifactRegistry primitive (`register()` on `focus_memory`). Tests can
  // continue to mock `createReferenceDocument` directly because the production
  // wiring assigns it to the artifact registry's `registerReferenceDocument`
  // hook (see `loadProductionDeps`). This preserves the existing reference
  // document store semantics while routing the side effect through the shared
  // artifact flow.
  createReferenceDocument(
    projectPath: string,
    sessionName: string,
    filePath: string,
    description: string,
  ): Promise<unknown>;
  getReferenceDocuments(
    projectPath: string,
    sessionName: string,
  ): Promise<Array<{ filePath: string; description: string }>>;
  fileExists(filePath: string): boolean;

  // Lifecycle registries
  registerAbortController(
    conversationId: string,
    controller: AbortController,
  ): void;
  unregisterAbortController(
    conversationId: string,
    controller: AbortController,
  ): void;

  /**
   * Execute a single conversation/task turn through the shared AgentCall
   * primitive. Production wires this to the real `executeAgentCall` facade;
   * tests inject a spy. Routing through this dep guarantees the conversation
   * actor never bypasses the primitive layer (cf. `executePromptForMachine`).
   */
  executeAgentCall(
    request: AgentCallRequest,
    facadeDeps: AgentCallFacadeDeps,
  ): Promise<AgentCallResult>;

  /**
   * Resolve the registered `AgentTaskRunner` for a backend. Wired to the
   * agent-backends registry in production; tests inject a stub runner.
   */
  getTaskRunner(backend: AgentBackendId): AgentTaskRunner;
}

/** Transcript I/O: JSONL append, image persistence, transcript reads. */
export interface TranscriptDeps {
  getTranscriptPath(conversationId: string): Promise<string>;

  // `meta` is forwarded to `appendTranscriptEntry` so callers that know the
  // project + session identity (the conversation turn actor and external-turn
  // handler) can trigger the `message-appended` SSE broadcast.
  safeAppendTranscriptEntry(
    conversationId: string,
    entry: TranscriptEntry,
    meta?: TranscriptBroadcastMeta,
  ): Promise<void>;
  saveTranscriptImage(
    conversationId: string,
    index: number,
    mediaType: string,
    base64Data: string,
  ): Promise<string>;
  getNextImageIndex(conversationId: string): Promise<number>;

  // Transcript reading (for synthetic fork seed and last-used model/effort
  // resolution). Returns the full TranscriptMessage so per-turn model/effort
  // metadata is available, not just role/content.
  readConversationMessages(
    transcriptPath: string | null,
  ): Promise<TranscriptMessage[]>;
}

/** MCP + agent-capability cascade composition and apply. */
export interface CapabilityDeps {
  /**
   * Compose the effective portable MCP config for the next turn, honoring the
   * four-level override cascade (global → project → session → conversation),
   * gateway protection, and orphan omission. Transient caller-supplied tooling
   * (e.g., graph workflow execution tools) is merged last.
   */
  composePortableMcpForConversation(args: {
    backend: AgentBackendId;
    projectPath: string;
    projectName: string;
    sessionName: string;
    conversationId: string;
    worktreePath: string;
    transientPortableMcp?: PortableMcpConfig;
  }): Promise<PortableMcpConfig>;
  applyMcpAtTurnStart(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    backend: AgentBackendId;
  }): Promise<ConversationApplyResult>;

  /**
   * Promote any seeded `staged-next-turn` capability cascades for the
   * conversation at the start of a new turn. Live for both backends — Codex
   * rebuilds its options each turn, and Claude's seeded state from
   * conversation start needs promotion on the first turn boundary.
   */
  applyCapabilityAtTurnStart(
    input: ApplyConversationIdentity,
  ): Promise<unknown>;

  /**
   * Drain any `staged-idle` Claude capability cascades after a turn completes
   * and the conversation transitions running → idle. No-op for Codex (no
   * idle-live-apply semantics). Failures are recorded as `rejected` per
   * cascade and surfaced via diagnostics; the previously applied hash is
   * preserved so retries can proceed.
   */
  applyCapabilityWhenIdle(input: ApplyConversationIdentity): Promise<unknown>;

  /**
   * Compose the neutral capability cascade + initial apply state for a new
   * conversation runtime. The actor passes `capabilities` to the backend
   * factory's `tooling.capabilities` (the factory translates it internally)
   * and persists `runtimeState` to `conversation.agentCapabilitiesRuntime` so
   * the apply service can compare subsequent mutations against the baseline
   * the runtime was seeded with. Returns `undefined` when there are no
   * resolved cascades to seed.
   */
  composeCapabilityConfigForConversation(input: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    conversationId: string;
    worktreePath: string;
    backend: AgentBackendId;
  }): Promise<CapabilitySeed | undefined>;

  /**
   * Compose capability runtime config for a project conversation. Uses the
   * fixed backend persisted on the project-conversation record and omits any
   * session layer from the cascade.
   */
  composeCapabilityConfigForProjectConversation(input: {
    projectPath: string;
    projectName: string;
    conversationId: string;
  }): Promise<ProjectCapabilitySeed | undefined>;
}

/**
 * Durable queue delivery result. Used only by auto-drained queued turns to
 * record the outcome of a claimed delivery batch against the message queue.
 * `markQueuedDelivered` is called after the coalesced user transcript entry
 * is appended; `markQueuedPending` returns a batch to `pending` for a
 * recoverable acceptance failure; `markQueuedFailed` marks it terminally
 * `failed`. Wired to `messageQueueService` in production.
 */
export interface QueueDeliveryDeps {
  markQueuedDelivered(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    ids: string[];
    deliveryAttemptId: string;
  }): Promise<void>;
  markQueuedPending(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    ids: string[];
    deliveryAttemptId: string;
    error: string;
  }): Promise<void>;
  markQueuedFailed(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    ids: string[];
    deliveryAttemptId: string;
    error: string;
  }): Promise<void>;
}

/** Debug-mode support surfaces. */
export interface DebugDeps {
  getDebugLogUrl(conversationId: string): string;
}

export type ActorImplementationDeps = TurnExecutionDeps &
  TranscriptDeps &
  CapabilityDeps &
  QueueDeliveryDeps &
  DebugDeps;

let _deps: ActorImplementationDeps | null = null;
let _depsPromise: Promise<ActorImplementationDeps> | null = null;

async function getDeps(): Promise<ActorImplementationDeps> {
  if (_deps) return _deps;
  if (!_depsPromise) {
    _depsPromise = loadProductionDeps();
  }
  _deps = await _depsPromise;
  return _deps;
}

async function loadProductionDeps(): Promise<ActorImplementationDeps> {
  const [
    lockMod,
    semaphoreMod,
    transcriptMod,
    configMod,
    transcriptImagesMod,
    registryMod,
    runtimeRegistryMod,
    childEnvMod,
    commandsMod,
    codexToolMod,
    projectResolverMod,
    debugLogMod,
    stateMod,
    abortRegistryMod,
    composeForConversationMod,
    globalStoreMod,
    discoveryMod,
    defaultDepsMod,
    capabilitiesDepsMod,
    messageQueueMod,
    alignmentServiceFactoryMod,
    ticketServiceFactoryMod,
  ] = await Promise.all([
    import("@/lib/prompt/single-flight"),
    import("@/lib/shared/query-semaphore"),
    import("@/lib/prompt/transcript"),
    import("@/lib/config/loader"),
    import("@/lib/images/transcript-images"),
    import("@/lib/agent-backends/registry"),
    import("@/lib/agent-backends/runtime-registry"),
    import("@/lib/shared/child-env"),
    import("@/lib/commands/service"),
    import("@/lib/agent-runs/tool-hint"),
    import("@/lib/projects/resolver"),
    import("@/lib/debug-log/service"),
    import("@/lib/state-store"),
    import("@/lib/conversations/abort-registry"),
    import("@/lib/mcp/compose-for-conversation"),
    import("@/lib/mcp/global-store"),
    import("@/lib/mcp/discovery"),
    import("@/lib/mcp/default-deps"),
    import("@/lib/agent-capabilities/default-deps"),
    import("@/lib/conversations/message-queue-service"),
    import("@/lib/session-alignment/service-factory"),
    import("@/lib/tickets/service-factory"),
  ]);

  // The alignment service holds a repo bound to the live DB; construct it once
  // here (loadProductionDeps runs lazily) rather than per turn.
  const alignmentService =
    alignmentServiceFactoryMod.createSessionAlignmentServiceForProduction();

  const composePortableMcpForConversation =
    composeForConversationMod.createComposePortableMcpForConversation({
      readGlobalOverrides: () =>
        globalStoreMod.defaultGlobalOverrideStore.read(),
      readProjectOverrides: async (projectPath) => {
        return stateMod.getProjectMcpOverrides(projectPath);
      },
      readSessionOverrides: async (projectPath, sessionName) => {
        const session = await stateMod.getSession(projectPath, sessionName);
        return session?.mcpOverrides;
      },
      readConversationOverrides: async (
        projectPath,
        sessionName,
        conversationId,
      ) => {
        const session = await stateMod.getSession(projectPath, sessionName);
        return session?.conversations.find((c) => c.id === conversationId)
          ?.mcpOverrides;
      },
      discoverSources: (input) => discoveryMod.discoverAllSources(input),
      globalConfigPath: () =>
        globalStoreMod.getDefaultGlobalMcpDefinitionPath(),
    });

  return {
    acquireConversationLock: lockMod.acquireConversationLock,
    acquireQuerySlot: semaphoreMod.acquireQuerySlot,
    getTranscriptPath: transcriptMod.getTranscriptPath,
    readConfig: configMod.readConfig,
    safeAppendTranscriptEntry: (
      cid: string,
      entry: TranscriptEntry,
      meta?: TranscriptBroadcastMeta,
    ) =>
      transcriptMod.safeAppendTranscriptEntry(
        cid,
        entry,
        undefined,
        undefined,
        meta,
      ),
    saveTranscriptImage: transcriptImagesMod.saveTranscriptImage,
    getNextImageIndex: transcriptImagesMod.getNextImageIndex,
    getConversationBackendFactory: registryMod.getConversationBackendFactory,
    getConversationCapabilities: (backend: AgentBackendId) =>
      registryMod.getBackendDescriptor(backend).conversation?.capabilities,
    registerBackendRuntime: runtimeRegistryMod.registerRuntime,
    unregisterBackendRuntime: runtimeRegistryMod.unregisterRuntime,
    buildChildEnv: childEnvMod.buildChildEnv,
    resolvePluginPaths: commandsMod.resolvePluginPaths,
    getCodexToolPromptHint: codexToolMod.getCodexToolPromptHint,
    getProjectDisplayName: projectResolverMod.getProjectDisplayName,
    getDebugLogUrl: debugLogMod.getDebugLogUrl,
    mutateConversation: stateMod.mutateConversation,
    getConversation: stateMod.getConversation,
    getSessionState: stateMod.getSession,
    getActiveAlignmentInjection: (projectPath: string, sessionName: string) =>
      alignmentService.getActiveInjection(projectPath, sessionName),
    getActiveAlignmentVersion: (projectPath: string, sessionName: string) =>
      alignmentService.getActiveVersion(projectPath, sessionName),
    getLiveTicketBlock: (projectPath: string, sessionName: string) =>
      ticketServiceFactoryMod
        .getLiveTicketContextProvider()
        .getForSession(projectPath, sessionName),
    createReferenceDocument: stateMod.createReferenceDocument,
    getReferenceDocuments: stateMod.getReferenceDocuments,
    readConversationMessages: transcriptMod.readConversationMessages,
    fileExists: (await import("node:fs")).existsSync,
    registerAbortController: abortRegistryMod.registerAbortController,
    unregisterAbortController: abortRegistryMod.unregisterAbortController,
    composePortableMcpForConversation,
    applyMcpAtTurnStart:
      defaultDepsMod.defaultMcpRuntimeApplyService.applyAtTurnStart,
    applyCapabilityAtTurnStart:
      capabilitiesDepsMod.defaultCapabilityRuntimeApplyService.applyAtTurnStart,
    applyCapabilityWhenIdle:
      capabilitiesDepsMod.defaultCapabilityRuntimeApplyService
        .applyWhenConversationBecomesIdle,
    composeCapabilityConfigForConversation:
      capabilitiesDepsMod.composeCapabilityConfigForConversation,
    composeCapabilityConfigForProjectConversation:
      capabilitiesDepsMod.composeCapabilityConfigForProjectConversation,
    executeAgentCall: defaultExecuteAgentCall,
    getTaskRunner: registryMod.getTaskRunner,
    markQueuedDelivered: messageQueueMod.messageQueueService.markDelivered,
    markQueuedPending: messageQueueMod.messageQueueService.markPending,
    markQueuedFailed: messageQueueMod.messageQueueService.markFailed,
  } satisfies ActorImplementationDeps;
}

export function setActorDeps(deps: ActorImplementationDeps): void {
  _deps = deps;
  _depsPromise = null;
}

export function _resetActorDepsForTesting(): void {
  _deps = null;
  _depsPromise = null;
}

// ============================================================
// Extracted testable functions
// ============================================================

/**
 * Determine whether an existing backend runtime should be closed and recreated
 * because the model, effort level, outputFormat, or baked-in alignment charter
 * version changed. An alignment-version mismatch is the seam that guarantees a
 * charter change propagates to an already-running runtime (R7.3): the new
 * version is baked into the rebuilt session instructions on recreation.
 */
export function shouldRecreateRuntime(
  runtime:
    | {
        status: string;
        modelId: unknown;
        reasoningEffort: unknown;
        outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
        alignmentVersion?: number | null;
      }
    | undefined,
  effectiveModel: string | undefined,
  effectiveEffort: string | undefined,
  desiredOutputFormat?: {
    type: "json_schema";
    schema: Record<string, unknown>;
  },
  desiredAlignmentVersion: number | null = null,
): boolean {
  if (!runtime || runtime.status !== "alive") return false;
  const modelChanged = runtime.modelId !== effectiveModel;
  const effortChanged = runtime.reasoningEffort !== effectiveEffort;
  const outputFormatChanged = runtime.outputFormat !== desiredOutputFormat;
  const alignmentChanged =
    (runtime.alignmentVersion ?? null) !== desiredAlignmentVersion;
  return (
    modelChanged || effortChanged || outputFormatChanged || alignmentChanged
  );
}

/**
 * Build the effective prompt, prepending debug mode instructions on the
 * first debug turn and phase-specific context on subsequent turns.
 *
 * `activeTicketBlock` is the linked ticket's current view (5.4); it is
 * rebuilt and prepended per turn — transient by design, never baked into
 * session instructions or the persistent runtime, so attachment changes
 * appear on the next turn without runtime recreation (5.5).
 */
export function buildEffectivePrompt(
  promptText: string,
  hasImages: boolean,
  userContentBlocks: MessageContentBlock[],
  debugMode: ConversationContext["debugMode"],
  debugLogUrl: string,
  debugManifestPath: string,
  activeTicketBlock: string | null,
): string | MessageContentBlock[] {
  let effectivePrompt: string | MessageContentBlock[] = hasImages
    ? userContentBlocks
    : promptText;

  if (debugMode?.active) {
    let prefix: string;
    if (!debugMode.instructionsDelivered) {
      prefix = DEBUG_MODE_INSTRUCTIONS.replaceAll(
        "{DEBUG_LOG_URL}",
        debugLogUrl,
      )
        .replaceAll("{DEBUG_LOG_FILE_PATH}", debugMode.logFilePath)
        .replaceAll("{DEBUG_MANIFEST_PATH}", debugManifestPath);
    } else {
      prefix = (DEBUG_PHASE_CONTEXT[debugMode.phase] ?? "").replaceAll(
        "{DEBUG_MANIFEST_PATH}",
        debugManifestPath,
      );
    }

    if (!debugMode.recording) {
      const pausedNotice =
        "<debug-paused>Recording is paused. New runtime evidence will not be appended to the debug log until recording is re-enabled.</debug-paused>";
      prefix = prefix ? `${pausedNotice}\n\n${prefix}` : pausedNotice;
    }

    if (prefix) {
      if (typeof effectivePrompt === "string") {
        effectivePrompt = prefix + "\n\n" + effectivePrompt;
      } else {
        effectivePrompt = [
          { type: "text" as const, text: prefix },
          ...effectivePrompt,
        ];
      }
    }
  }

  if (activeTicketBlock) {
    if (typeof effectivePrompt === "string") {
      effectivePrompt = activeTicketBlock + "\n\n" + effectivePrompt;
    } else {
      effectivePrompt = [
        { type: "text" as const, text: activeTicketBlock },
        ...effectivePrompt,
      ];
    }
  }

  return effectivePrompt;
}

function formatTurnStartMcpApplyFailure(
  result: ConversationApplyResult,
): string {
  const parts = ["Failed to apply portable MCP configuration"];
  if (result.error) {
    parts.push(result.error);
  }
  return parts.join(". ");
}

/**
 * Resolve the backend descriptor's failure classifier. Falls back to a plain
 * `backend_error` classification when the backend is not registered (test
 * doubles outside the registry), preserving the classifier's never-throw
 * contract.
 */
const fallbackFailureClassifier: AgentFailureClassifier = {
  classify(error): AgentFailureClassification {
    return {
      kind: "backend_error",
      message: getErrorMessage(error),
      retryable: false,
    };
  },
  classifyWithContinuation(error) {
    return {
      failure: this.classify(error),
      continuationDisposition: "retain",
    };
  },
};

function resolveFailureClassifierForBackend(
  backend: AgentBackendId,
): AgentFailureClassifier {
  try {
    return getBackendDescriptor(backend).errors;
  } catch {
    return fallbackFailureClassifier;
  }
}

function classifyFailureForBackend(
  backend: AgentBackendId,
  error: unknown,
): AgentFailureClassification {
  return resolveFailureClassifierForBackend(backend).classify(error);
}

// ============================================================
// Shared AgentCall dispatch
// ============================================================

interface DispatchTurnViaAgentCallInput {
  executeAgentCall: ActorImplementationDeps["executeAgentCall"];
  getRuntime: () => ConversationBackendRuntime;
  replaceRuntime: () => Promise<ConversationBackendRuntime>;
  /** Pre-turn MCP apply hook the facade runs before dispatch, when set. */
  applyMcp: (() => Promise<McpApplyHookResult>) | undefined;
  signal: AbortSignal;
  conversationId: string;
  sessionName: string;
  backend: AgentBackendId;
  promptText: string;
  imageRefs: ConversationBackendTurnInput["imageRefs"] | undefined;
  modelId: string | null | undefined;
  reasoningEffort: string | undefined;
  autonomous: boolean;
  waitForBackgroundTasks: boolean;
  outputFormat: ConversationBackendTurnInput["outputFormat"];
  onEvent: ConversationBackendTurnInput["onEvent"];
  syntheticForkSeed: ConversationBackendTurnInput["syntheticForkSeed"];
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
      sessionName: input.sessionName,
      backend: input.backend,
    },
  });

  const request: AgentCallRequest = {
    kind: "conversation_turn",
    prompt: input.promptText,
    backend: input.backend,
    writeCapability: "write_capable",
    ...(input.outputFormat?.type === "json_schema"
      ? { outputSchema: input.outputFormat.schema }
      : {}),
  };

  const facadeDeps: AgentCallFacadeDeps = {
    resolveConversationRuntime: () => {
      const resolution: ConversationRuntimeResolution = {
        runtime: wrappedRuntime,
        capabilityView: capabilityViewForBackend(input.backend),
        signal: input.signal,
        ...(input.modelId != null ? { modelId: input.modelId } : {}),
        ...(input.reasoningEffort !== undefined
          ? { reasoningEffort: input.reasoningEffort }
          : {}),
        autonomous: input.autonomous,
        ...(input.waitForBackgroundTasks
          ? { waitForBackgroundTasks: true }
          : {}),
        sessionInstructions: [],
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
 * Acquire session lock, query slot, and initialize transcript path.
 */
export async function prepareTurnForMachine(
  input: PrepareTurnInput,
): Promise<PrepareTurnOutput> {
  const deps = await getDeps();

  const key = conversationRuntimeKey(
    input.projectPath,
    input.sessionName,
    input.conversationId,
  );
  const runtime = getConversationRuntime(key);
  if (!runtime) {
    throw new Error(
      `No runtime state registered for conversation ${key}. Was the actor started via the conversation manager?`,
    );
  }

  // Acquire conversation lock (throws if already busy) — skip for validator
  // conversations that run within an already-locked parent conversation
  if (!runtime.skipConversationLock) {
    const releaseConversationLock = deps.acquireConversationLock(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    runtime.releaseConversationLock = releaseConversationLock;
  }

  // Acquire concurrency slot (waits if at capacity)
  const releaseQuerySlot = await deps.acquireQuerySlot(
    `prompt:${input.sessionName}`,
  );
  runtime.releaseQuerySlot = releaseQuerySlot;

  // Get or create transcript path
  const transcriptPath =
    input.transcriptPath ??
    (await deps.getTranscriptPath(input.conversationId));

  return { transcriptPath };
}

/**
 * Execute a prompt via a backend-neutral conversation runtime.
 *
 * Orchestrates turn execution using ConversationBackendRuntime:
 * - Gets or creates the backend runtime via factory
 * - Constructs ConversationBackendTurnInput with onEvent callback
 * - Translates backend events into SSE emit and machine events
 */
export async function executePromptForMachine(
  input: ExecutePromptInput,
): Promise<PromptActorResult> {
  const deps = await getDeps();
  const transcriptProjection = getConversationTranscriptProjection(
    input.agentBackend,
  );

  const key = conversationRuntimeKey(
    input.projectPath,
    input.sessionName,
    input.conversationId,
  );
  const runtime = getConversationRuntime(key);
  if (!runtime) {
    throw new Error(
      `No runtime state registered for conversation ${key}. Was the actor started via the conversation manager?`,
    );
  }
  const runtimeState = runtime;
  runtimeState.currentTurnAutonomous = input.autonomous === true;

  const config = await deps.readConfig();
  const projectName =
    input.projectName || deps.getProjectDisplayName(input.projectPath);
  const isProjectConversation =
    input.conversationScope === "project" ||
    isProjectSentinel(input.sessionName);

  const broadcastMeta: TranscriptBroadcastMeta = {
    projectName,
    sessionName: input.sessionName,
  };
  const safeAppendWithMeta = (
    conversationId: string,
    entry: TranscriptEntry,
  ): Promise<void> =>
    deps.safeAppendTranscriptEntry(conversationId, entry, broadcastMeta);

  // Resolve model/effort with a three-tier fallback (explicit → conversation's
  // last-used → backend config default). A follow-up turn that carries no
  // explicit model/effort — a drained queued message, document feedback, an
  // alignment turn — continues on the model the conversation was already using
  // rather than snapping to the global default. Reading the transcript is only
  // needed when a tier below "explicit" could apply, so the common composer
  // path (both supplied) skips it.
  const priorMessages =
    input.modelId == null || input.effort == null
      ? await deps.readConversationMessages(input.transcriptPath ?? null)
      : [];
  const { effectiveModel, effectiveEffort } = resolveTurnModelEffort({
    backend: input.agentBackend,
    config,
    explicitModel: input.modelId,
    explicitEffort: input.effort,
    priorMessages,
  });
  const factory = deps.getConversationBackendFactory(input.agentBackend);

  if (factory.validateModelAndEffort) {
    try {
      factory.validateModelAndEffort({
        modelId: effectiveModel,
        reasoningEffort: effectiveEffort,
      });
    } catch (err) {
      const errorMessage = getErrorMessage(err);
      logger.warn("prompt.model_effort_validation_failed_actor", {
        sessionName: input.sessionName,
        backend: input.agentBackend,
        modelId: effectiveModel,
        reasoningEffort: effectiveEffort,
        error: errorMessage,
      });
      runtimeState.streamEmit?.("error", { message: errorMessage });
      return buildFailedTurnResult({
        contentBlocks: [],
        error: errorMessage,
        continuationDisposition: "retain",
      });
    }
  }

  const { effectivePromptText, isDrainedFeedbackBatch } = resolveTurnPromptText(
    {
      promptText: input.promptText,
      documentFeedback: input.documentFeedback,
      isQueuedDelivery: input.queuedDelivery !== undefined,
    },
  );

  const { assembled, imageRefs } = await persistTurnImages(deps, {
    conversationId: input.conversationId,
    promptText: effectivePromptText,
    images: input.images ?? [],
  });

  const transcriptBlocks: MessageContentBlock[] = composeUserTranscriptBlocks({
    promptText: input.promptText,
    effectivePromptText,
    rewrittenPromptText: assembled.rewrittenPromptText,
    isDrainedFeedbackBatch,
    documentFeedback: input.documentFeedback,
    imageRefs,
  });

  const currentTurnMessageId =
    input.queuedDelivery?.messageIds[0] ?? input.streamId ?? null;
  runtimeState.currentTurnMessageId = currentTurnMessageId ?? undefined;

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
    model: effectiveModel ?? undefined,
    effort: effectiveEffort,
  });

  const queuedAccounting = createQueuedDeliveryAccounting(deps, {
    projectPath: input.projectPath,
    sessionName: input.sessionName,
    conversationId: input.conversationId,
    queuedDelivery: input.queuedDelivery,
    appendUserEntry: () =>
      safeAppendWithMeta(input.conversationId, buildUserTranscriptEntry()),
  });

  await queuedAccounting.appendUserEntryAtDispatch();

  // ---------------------------------------------------------------
  // Get-or-create ConversationBackendRuntime
  // ---------------------------------------------------------------
  let backendRuntime = runtimeState.backendRuntime;

  // Cancel any inactivity timer the existing runtime may have armed after its
  // last turn. The pre-turn pipeline below (state reads, MCP discovery,
  // capability cascades) can run long enough to outlast the idle TTL budget;
  // without this, the timer fires mid-prep and closes the subprocess we are
  // about to send a prompt to. No-op for new/dead runtimes (the timer can
  // only be armed once a turn has completed).
  backendRuntime?.notifyTurnStarting?.();

  async function seedRuntimeMcpState(portableMcp: PortableMcpConfig) {
    const hash = computeEffectiveConfigHash(portableMcp);
    await deps.mutateConversation(
      input.projectPath,
      input.sessionName,
      input.conversationId,
      "prompt.seedMcpRuntime",
      (conversation) => {
        const next = {
          ...(conversation.mcpRuntime ?? {}),
          lastAppliedConfigHash: hash,
          lastApplyDisposition: "applied_now" as const,
        };
        delete next.lastApplyError;
        if (next.pendingConfigHash === hash) {
          delete next.pendingConfigHash;
          delete next.pendingServerKeys;
        }
        conversation.mcpRuntime = next;
      },
    );
    logger.info("prompt.mcp_seeded", {
      sessionName: input.sessionName,
      backend: input.agentBackend,
      conversationId: input.conversationId,
    });
  }

  const capabilityCtx: CapabilityTurnContext = {
    projectPath: input.projectPath,
    projectName,
    sessionName: input.sessionName,
    conversationId: input.conversationId,
    worktreePath: input.worktreePath,
    backend: input.agentBackend,
    isProjectConversation,
    emitStreamError: (message) =>
      runtimeState.streamEmit?.("error", { message }),
  };

  // Tracks whether THIS turn governs under an active charter (R12.1/R12.2:
  // attended normal sessions only). Set on the recreate gate's reuse path and on
  // the new-runtime path so the post-turn seen-version record (R8.4) never fires
  // for project/optimistic/autonomous turns. Both paths also read getSessionState
  // — a focused cached accessor, so the small duplicate read is acceptable.
  let alignmentEligibleThisTurn = false;

  // Read the active alignment version cheaply for the recreate gate, but only
  // when a runtime exists to reuse: a new runtime bakes in the current version
  // directly, so no comparison read is needed on that path (R7.3).
  let desiredAlignmentVersion: number | null = null;
  if (backendRuntime) {
    const gateSession = await deps.getSessionState(
      input.projectPath,
      input.sessionName,
    );
    const gate = await resolveAlignmentGateForReusedRuntime(deps, {
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      creationMode: gateSession?.creationMode,
      isProjectConversation,
      autonomous: input.autonomous,
    });
    alignmentEligibleThisTurn = gate.eligible;
    desiredAlignmentVersion = gate.desiredAlignmentVersion;
  }

  // Close existing runtime if model, effort, outputFormat, or alignment version changed
  if (
    backendRuntime &&
    shouldRecreateRuntime(
      backendRuntime,
      effectiveModel,
      effectiveEffort,
      input.outputFormat,
      desiredAlignmentVersion,
    )
  ) {
    const reason =
      effectiveModel != null && backendRuntime.modelId !== effectiveModel
        ? "model_changed"
        : effectiveEffort != null &&
            backendRuntime.reasoningEffort !== effectiveEffort
          ? "effort_changed"
          : input.outputFormat !== backendRuntime.outputFormat
            ? "output_format_changed"
            : "alignment_changed";
    logger.info("prompt.runtime_recreate", {
      sessionName: input.sessionName,
      reason,
    });
    backendRuntime.close();
    deps.unregisterBackendRuntime(input.conversationId);
    backendRuntime = undefined;
  }

  const isNewRuntime = !backendRuntime || backendRuntime.status === "dead";

  async function createManagedBackendRuntime(): Promise<ConversationBackendRuntime> {
    const sessionState = await deps.getSessionState(
      input.projectPath,
      input.sessionName,
    );

    // Project conversations are session-less: the focus-memory registration and
    // reference-document loading are session-scoped (they read/write through the
    // session aggregate, which the project sentinel cannot address — a write
    // would fail because `__project__` is not a real session). Skip both for a
    // project turn so a repo-root with `memory-bank/focus.md` does not break
    // turn startup.
    if (!isProjectConversation) {
      await registerFocusMemoryIfPresent({
        worktreePath: input.worktreePath,
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        conversationId: input.conversationId,
        fileExists: deps.fileExists,
        registerReferenceDocument: deps.createReferenceDocument,
      });
    }

    // Build reference documents system prompt section
    const referenceDocs = isProjectConversation
      ? []
      : await deps.getReferenceDocuments(input.projectPath, input.sessionName);
    const referenceDocsPrompt =
      referenceDocs.length > 0
        ? [
            "## Reference Documents",
            "The following reference documents provide additional context. Read them when relevant to your current task.",
            "",
            ...referenceDocs.map(
              (d) => `- **${d.filePath}**: ${d.description}`,
            ),
          ].join("\n")
        : null;

    // Alignment governs only attended normal sessions (R12.1/R12.2). Mirror the
    // result to the outer flag so the post-turn seen-version record (R8.4) holds
    // for a freshly-created runtime too.
    const alignment = await resolveAlignmentInstructionForNewRuntime(deps, {
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      creationMode: sessionState?.creationMode,
      isProjectConversation,
      autonomous: input.autonomous,
    });
    alignmentEligibleThisTurn = alignment.eligible;
    const activeAlignmentVersion = alignment.activeAlignmentVersion;
    const alignmentInstruction = alignment.alignmentInstruction;

    // Pending agent notices — messages recorded while the conversation had no
    // live backend session (e.g. background tasks lost with a dead session).
    // Injected into this runtime's instructions and drained below once the
    // runtime exists, so a notice is delivered exactly once.
    const pendingAgentNotices = isProjectConversation
      ? []
      : await readPendingAgentNotices(deps, {
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          conversationId: input.conversationId,
        });
    const pendingNoticesInstruction =
      buildPendingNoticesInstruction(pendingAgentNotices);

    // Build session instructions (baked into the runtime once). Project
    // conversations run in the main worktree, so they use a CC context that
    // omits the per-session dev-server promise.
    const ccContext = isProjectConversation ? PROJECT_CC_CONTEXT : CC_CONTEXT;
    const sessionInstructions = [
      ccContext,
      // `cctl ask` works for session and project conversations alike, so the
      // ask-at-real-forks encouragement applies to every CC agent. Workflow
      // lanes whose effective toggle is on get the enabled variant (tool
      // available, protocol, context pauses); everyone else keeps the default.
      selectAskQuestionInstructions(input.askUserQuestionsEnabled),
      // cctl is on PATH for every CC agent (session env contract), so the
      // CLI nudge applies to session and project conversations alike.
      CC_CLI_INSTRUCTIONS,
      // Spawn-proposal convention is a project-conversation-only capability:
      // session agents cannot propose sibling sessions from a conversation.
      isProjectConversation ? PROJECT_SPAWN_INSTRUCTIONS : null,
      alignmentInstruction,
      sessionState?.tddEnabled ? TDD_INSTRUCTIONS : null,
      deps.getCodexToolPromptHint(config.codex?.enabled === true),
      referenceDocsPrompt,
      pendingNoticesInstruction,
    ].filter((s): s is string => s != null && s.length > 0);
    const portableMcp = await deps.composePortableMcpForConversation({
      backend: input.agentBackend,
      projectPath: input.projectPath,
      projectName,
      sessionName: input.sessionName,
      conversationId: input.conversationId,
      worktreePath: input.worktreePath,
      ...(runtimeState.tooling?.portableMcp !== undefined
        ? { transientPortableMcp: runtimeState.tooling.portableMcp }
        : {}),
    });

    const capabilitySeed = await resolveCapabilitySeedForNewRuntime(
      deps,
      capabilityCtx,
    );
    const capabilityCascadeSeed = capabilitySeed?.capabilities;
    const capabilityRuntimeStateSeed = capabilitySeed?.runtimeState;

    logger.info("prompt.runtime_create", {
      sessionName: input.sessionName,
      backend: input.agentBackend,
      conversationId: input.conversationId,
      hasResumeRef: input.backendRef !== null,
      promptCount: input.promptCount,
      capabilityCascadeSeeded: capabilityCascadeSeed !== undefined,
    });

    // A conversation with completed turns but no resume handle cannot restore
    // the agent's context — the new backend session starts with no memory of
    // the transcript. Reachable after a mid-turn server death that outran
    // BACKEND_INIT persistence, or a Codex thread cleared by a failed turn.
    if (input.promptCount > 0 && input.backendRef === null) {
      logger.warn("prompt.resume_ref_missing", {
        sessionName: input.sessionName,
        backend: input.agentBackend,
        conversationId: input.conversationId,
        promptCount: input.promptCount,
      });
    }

    // External (background auto-continuation) turns are a declared backend
    // capability: only backends whose descriptor claims `externalTurns` get a
    // handler wired. The idle capability drain is likewise gated on a
    // declared `idle_live` capability kind rather than backend identity.
    const conversationCapabilities = deps.getConversationCapabilities(
      input.agentBackend,
    );
    const supportsIdleCapabilityDrain =
      conversationCapabilities?.capabilityKinds.some(
        (k) => k.applyTiming === "idle_live",
      ) ?? false;
    const externalTurnHandler = conversationCapabilities?.externalTurns
      ? createExternalTurnHandler(
          { conversationId: input.conversationId },
          {
            sendToMachine: (event) => runtimeState.sendToMachine?.(event),
          },
          {
            safeAppendTranscriptEntry: safeAppendWithMeta,
            applyCapabilityWhenIdle: supportsIdleCapabilityDrain
              ? () =>
                  deps.applyCapabilityWhenIdle(
                    buildCapabilityApplyInput(capabilityCtx),
                  )
              : undefined,
          },
        )
      : undefined;

    const onBackgroundTasksLost = createBackgroundTasksLostHandler(deps, {
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      conversationId: input.conversationId,
      isProjectConversation,
      appendTranscriptEntry: safeAppendWithMeta,
    });

    const newRuntime = await factory.createRuntime({
      conversationId: input.conversationId,
      projectPath: input.projectPath,
      projectName,
      sessionName: input.sessionName,
      worktreePath: input.worktreePath,
      persistedRef: input.backendRef,
      modelId: effectiveModel,
      reasoningEffort: effectiveEffort,
      outputFormat: input.outputFormat,
      alignmentVersion: activeAlignmentVersion,
      sessionInstructions,
      tooling: {
        portableMcp,
        ...(capabilityCascadeSeed !== undefined
          ? { capabilities: capabilityCascadeSeed }
          : {}),
      },
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
    });

    // Register in runtime-registry and local state
    deps.registerBackendRuntime(input.conversationId, newRuntime);
    runtimeState.backendRuntime = newRuntime;
    backendRuntime = newRuntime;
    await seedRuntimeMcpState(portableMcp);
    if (capabilityRuntimeStateSeed) {
      await seedRuntimeCapabilityState(
        deps,
        capabilityCtx,
        capabilityRuntimeStateSeed,
      );
    }

    if (!isProjectConversation) {
      await drainConsumedAgentNotices(
        deps,
        {
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          conversationId: input.conversationId,
        },
        pendingAgentNotices,
      );
    }

    return newRuntime;
  }

  if (isNewRuntime) {
    backendRuntime = await createManagedBackendRuntime();
  }

  // Store the runtime in local state for reuse
  runtimeState.backendRuntime = backendRuntime;

  // ---------------------------------------------------------------
  // Safety-net timeout + inactivity (stall) watchdog
  // ---------------------------------------------------------------
  const timeoutMs = resolveBackendTimeoutMs(input.agentBackend, config);
  const stallTimeoutMs = resolveBackendStallTimeoutMs(
    input.agentBackend,
    config,
  );
  const abortWiring = wireTurnAbort(deps, {
    runtimeState,
    conversationId: input.conversationId,
    sessionName: input.sessionName,
    backend: input.agentBackend,
    timeoutMs,
    stallTimeoutMs,
    closeRuntime: () => backendRuntime?.close(),
  });
  const abortController = abortWiring.abortController;

  // ---------------------------------------------------------------
  // Build turn input and execute
  // ---------------------------------------------------------------
  const contentBlocks: MessageContentBlock[] = [];
  let persistedContentEventCount = 0;
  let sawErrorEvent = false;

  // onEvent: translate backend events into existing SSE emit path
  const onEvent = async (event: ConversationBackendEvent): Promise<void> => {
    // Every backend event proves the turn is alive, whatever its type.
    abortWiring.notifyActivity();
    switch (event.type) {
      case "input_accepted": {
        await queuedAccounting.handleInputAccepted();
        break;
      }

      case "backend_init":
        runtimeState.sendToMachine?.({
          type: "BACKEND_INIT",
          backendRef: event.backendRef,
        });
        {
          const initEntry = transcriptProjection.projectBackendInit({
            timestamp: new Date().toISOString(),
            backendRef: event.backendRef,
          });
          if (initEntry !== null) {
            await safeAppendWithMeta(input.conversationId, initEntry);
          }
        }
        break;

      case "content":
        contentBlocks.push(event.block);
        runtimeState.streamEmit?.("content", event.block);
        if (transcriptProjection.persistContentEvents) {
          await safeAppendWithMeta(input.conversationId, {
            timestamp: new Date().toISOString(),
            type: "assistant",
            role: "assistant",
            content: [event.block],
          });
          persistedContentEventCount += 1;
          logger.debug("prompt.content_event_persisted", {
            sessionName: input.sessionName,
            conversationId: input.conversationId,
            backend: input.agentBackend,
            blockType: event.block.type,
            contentBlockCount: persistedContentEventCount,
          });
        }
        break;

      case "transcript_entry":
        // The adapter interprets; the actor records. The frame is appended
        // verbatim — the payload is never read above the backend seam.
        await safeAppendWithMeta(
          input.conversationId,
          conversationTranscriptFrame(event.entry),
        );
        break;

      case "error":
        sawErrorEvent = true;
        runtimeState.streamEmit?.("error", { message: event.message });
        break;
    }
  };

  // Fetch the linked ticket's current view for this turn. Project
  // conversations are session-less and can never be ticket-linked. A lookup
  // failure degrades to an uncontextualized turn rather than failing it.
  let activeTicketBlock: string | null = null;
  if (!isProjectConversation) {
    try {
      activeTicketBlock = await deps.getLiveTicketBlock(
        input.projectPath,
        input.sessionName,
      );
    } catch (err) {
      logger.warn("prompt.live_ticket_block_failed", {
        sessionName: input.sessionName,
        conversationId: input.conversationId,
        error: getErrorMessage(err),
      });
    }
  }

  // Prepend debug mode instructions to the rewritten prompt text. Backends
  // receive a single string with `[Image #N]` markers; image data is carried
  // separately on `imageRefs`.
  const effectivePrompt = buildEffectivePrompt(
    assembled.rewrittenPromptText,
    false,
    [],
    input.debugMode,
    deps.getDebugLogUrl(input.conversationId),
    getDebugManifestPath(input.worktreePath, input.conversationId),
    activeTicketBlock,
  );

  const promptText =
    typeof effectivePrompt === "string"
      ? effectivePrompt
      : effectivePrompt
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("\n\n");

  const syntheticForkSeed: ConversationBackendTurnInput["syntheticForkSeed"] =
    await resolveSyntheticForkSeed(deps, {
      sessionName: input.sessionName,
      agentBackend: input.agentBackend,
      backendRef: input.backendRef,
      forkedFrom: input.forkedFrom,
      transcriptPath: input.transcriptPath,
    });

  let agentCallResult: AgentCallResult | undefined;

  // Pre-turn MCP apply, run by the facade in its fixed pre-dispatch order.
  // Only reused runtimes need it — a fresh runtime was created with the
  // composed config already baked in. A rejected apply fails the call inside
  // the facade (capability_unavailable) before the prompt is delivered.
  const applyMcpHook = isNewRuntime
    ? undefined
    : async (): Promise<McpApplyHookResult> => {
        logger.info("prompt.mcp_turn_start_apply", {
          sessionName: input.sessionName,
          backend: input.agentBackend,
          conversationId: input.conversationId,
        });
        const mcpApplyResult = await deps.applyMcpAtTurnStart({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          conversationId: input.conversationId,
          backend: input.agentBackend,
        });

        logger.info("prompt.mcp_turn_start_result", {
          sessionName: input.sessionName,
          backend: input.agentBackend,
          conversationId: input.conversationId,
          disposition: mcpApplyResult.disposition,
        });

        if (mcpApplyResult.disposition === "rejected") {
          logger.warn("prompt.mcp_turn_start_failed", {
            sessionName: input.sessionName,
            backend: input.agentBackend,
            conversationId: input.conversationId,
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

  try {
    await applyCapabilityCascadeAtTurnStart(deps, capabilityCtx, {
      isNewRuntime,
    });

    // Close + unregister the current runtime and build a fresh, resume-
    // preserving one (createManagedBackendRuntime threads `persistedRef`).
    // Shared by the pre-turn readiness gate and the dispatch retry loop.
    const recreateRuntimeForTurn =
      async (): Promise<ConversationBackendRuntime> => {
        backendRuntime?.close();
        deps.unregisterBackendRuntime(input.conversationId);
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
      logger.warn("prompt.runtime_recreated_after_session_tools_failure", {
        sessionName: input.sessionName,
        conversationId: input.conversationId,
        reason: ready.reason,
      });
      await recreateRuntimeForTurn();
      const retry = (await backendRuntime!.prepareForTurnStart?.()) ?? {
        status: "ready" as const,
      };
      if (retry.status === "recreate-runtime") {
        logger.error("prompt.session_tools_unrecoverable", {
          sessionName: input.sessionName,
          conversationId: input.conversationId,
          reason: retry.reason,
        });
        throw markPromptNotDelivered(
          new Error(
            `Prompt not delivered: runtime unrecoverable (${retry.reason})`,
          ),
        );
      }
    }

    // Route the turn through the shared AgentCall primitive. The runtime is
    // wrapped in the named `withRuntimeReplacementRetry` policy (single
    // reattempt on the neutral prompt-not-delivered fact) and the facade
    // normalizes every failure through the backend's failure classifier, so
    // the actor consumes only the widened `AgentCallResult`.
    agentCallResult = await dispatchTurnViaAgentCall({
      executeAgentCall: deps.executeAgentCall,
      getRuntime: () => backendRuntime!,
      replaceRuntime: recreateRuntimeForTurn,
      applyMcp: applyMcpHook,
      signal: abortController.signal,
      conversationId: input.conversationId,
      sessionName: input.sessionName,
      backend: input.agentBackend,
      promptText,
      imageRefs: imageRefs.length > 0 ? imageRefs : undefined,
      modelId: effectiveModel,
      reasoningEffort: effectiveEffort,
      autonomous: input.autonomous ?? false,
      waitForBackgroundTasks: input.waitForBackgroundTasks ?? false,
      outputFormat: input.outputFormat,
      onEvent,
      syntheticForkSeed,
    });

    // A failed outcome without `contentBlocks` means the failure carries no
    // adapter turn result: dispatch threw (normalized by the facade) or the
    // pre-turn MCP apply rejected. These reproduce the legacy thrown-error
    // surfaces; failures derived from an adapter turn result flow through the
    // shared result mapping below.
    const turnlessFailure =
      agentCallResult.outcome.kind === "failed" &&
      agentCallResult.outcome.contentBlocks === undefined
        ? agentCallResult.outcome
        : undefined;

    if (turnlessFailure && abortController.signal.aborted) {
      const timeoutFired = abortWiring.timeoutFired();
      const stallFired = abortWiring.stallFired();
      logger.info("prompt.aborted", {
        sessionName: input.sessionName,
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

    if (turnlessFailure) {
      const errorMsg = turnlessFailure.error.message;
      // Pre-turn MCP rejection surfaces its formatted message directly; a
      // normalized dispatch throw keeps the legacy "SDK error:" surface.
      if (turnlessFailure.error.failureKind === "capability_unavailable") {
        runtimeState.streamEmit?.("error", { message: errorMsg });
      } else {
        logger.error("prompt.sdk_error", {
          sessionName: input.sessionName,
          failureKind: turnlessFailure.error.failureKind,
          error: errorMsg,
        });
        await drainCapabilityWhenIdle(deps, capabilityCtx);
        runtimeState.streamEmit?.("error", {
          message: `SDK error: ${errorMsg}`,
        });
      }
      return buildFailedTurnResult({
        contentBlocks:
          turnlessFailure.error.failureKind === "capability_unavailable"
            ? []
            : contentBlocks,
        error: errorMsg,
        continuationDisposition:
          agentCallResult.continuationDisposition ?? "retain",
      });
    }

    await drainCapabilityWhenIdle(deps, capabilityCtx);
  } catch (err) {
    if (abortController.signal.aborted) {
      const timeoutFired = abortWiring.timeoutFired();
      const stallFired = abortWiring.stallFired();
      logger.info("prompt.aborted", {
        sessionName: input.sessionName,
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
    logger.error("prompt.sdk_error", {
      sessionName: input.sessionName,
      error: errorMsg,
    });
    await drainCapabilityWhenIdle(deps, capabilityCtx);
    runtimeState.streamEmit?.("error", { message: `SDK error: ${errorMsg}` });
    return buildFailedTurnResult({
      contentBlocks,
      error: errorMsg,
      continuationDisposition: "retain",
    });
  } finally {
    abortWiring.cleanup();
    runtimeState.currentTurnAutonomous = undefined;
    runtimeState.currentTurnMessageId = undefined;
    await queuedAccounting.settleAfterTurn();
  }

  // Every turnless-failure path returned inside the try (or the catch); a
  // result that reaches this mapping carries an adapter-built outcome.
  const callResult = agentCallResult!;
  const completedOutcome =
    callResult.outcome.kind === "completed" ? callResult.outcome : undefined;
  const failedOutcome =
    callResult.outcome.kind === "failed" ? callResult.outcome : undefined;
  const gateSchemaValidationFailure =
    failedOutcome?.error.failureKind === "schema_validation"
      ? failedOutcome.error
      : undefined;
  const turnAborted = failedOutcome?.error.failureKind === "aborted";
  // The structured-output gate ran inside `executeAgentCall` whenever
  // `outputSchema` was present — it may have parsed `text` into a
  // structuredOutput value or downgraded a completed outcome to `failed` with
  // `failureKind: "schema_validation"`. The actor consumes that result so the
  // conversation_turn and task_run paths share one validation outcome.
  const effectiveStructuredOutput = completedOutcome?.structuredOutput;
  // Aborted turns report through `aborted`, never as an error surface.
  const effectiveError =
    failedOutcome !== undefined && !turnAborted
      ? failedOutcome.error.message
      : null;
  const resultNumTurns =
    completedOutcome?.numTurns ?? failedOutcome?.numTurns ?? null;
  const resultContentBlocks =
    completedOutcome?.contentBlocks ??
    failedOutcome?.contentBlocks ??
    contentBlocks;

  // The facade preserves the adapter's continuation verdict through every
  // outcome projection. The fallback keeps tolerant injected facades safe
  // when they omit the optional field without inventing invalidation.
  const continuationDisposition: ContinuationDisposition =
    callResult.continuationDisposition ?? "retain";

  if (effectiveError && !turnAborted && !sawErrorEvent) {
    logger.warn("prompt.turn_error_fallback_emitted", {
      sessionName: input.sessionName,
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
        logger.warn("prompt.content_event_fallback", {
          sessionName: input.sessionName,
          conversationId: input.conversationId,
          backend: backendRuntime!.backend,
          missingContentBlockCount: missingContent.length,
        });
        await safeAppendWithMeta(input.conversationId, {
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
      aborted: turnAborted,
      error: effectiveError,
    });
    if (resultEntry !== null) {
      await safeAppendWithMeta(input.conversationId, resultEntry);
    }
  }

  // Persist a typed `debug_structured` block when a debug-mode turn produced
  // a structured output. Backend-agnostic — both Claude (SDK-validated) and
  // Codex (parsed JSON) reach here with structuredOutput populated. The block
  // merges with the preceding assistant text via readConversationMessages,
  // letting the renderer dispatch on `phase`. The value is the completed
  // outcome's structuredOutput — the shared gate may have parsed it from
  // `text`, else it is the backend's natively-populated payload.
  if (
    input.debugMode?.active === true &&
    effectiveStructuredOutput != null &&
    !effectiveError
  ) {
    await safeAppendWithMeta(input.conversationId, {
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
    await recordSeenAlignmentVersion(deps, {
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      conversationId: input.conversationId,
      seenAlignmentVersion: backendRuntime.alignmentVersion,
    });
  }

  // Build result. structuredOutput and error come from the shared gate when
  // it ran; this ensures both streaming and task_run paths surface the same
  // validation outcome.
  const result: PromptActorResult = {
    backendRef: callResult.backendRef,
    costUsd: callResult.usage.costUsd ?? null,
    durationMs: callResult.usage.durationMs ?? null,
    numTurns: resultNumTurns,
    contextTokens: callResult.usage.contextTokens ?? null,
    contextWindow: callResult.usage.contextWindowMax ?? null,
    inputTokens: callResult.usage.inputTokens ?? null,
    outputTokens: callResult.usage.outputTokens ?? null,
    cachedInputTokens: callResult.usage.cachedInputTokens ?? null,
    contentBlocks: resultContentBlocks,
    structuredOutput: effectiveStructuredOutput,
    aborted: turnAborted,
    compacted: callResult.compacted ?? false,
    ...(turnAborted && abortWiring.timeoutFired()
      ? { abortReason: "timeout" as const, timeoutMs }
      : turnAborted && abortWiring.stallFired()
        ? { abortReason: "stalled" as const, timeoutMs: stallTimeoutMs }
        : {}),
    error: effectiveError,
    continuationDisposition,
    ...(callResult.backgroundWait !== undefined
      ? { backgroundWait: callResult.backgroundWait }
      : {}),
  };

  // Emit done on the SSE stream
  runtime.streamEmit?.("done", {});

  logger.info("prompt.complete", {
    sessionName: input.sessionName,
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
export async function runTaskRunTurnForMachine(
  input: RunTaskRunInput,
): Promise<PromptActorResult> {
  const deps = await getDeps();
  const transcriptProjection = getTaskTranscriptProjection(input.agentBackend);

  const projectName =
    input.projectName || deps.getProjectDisplayName(input.projectPath);

  const broadcastMeta: TranscriptBroadcastMeta = {
    projectName,
    sessionName: input.sessionName,
  };

  let effectivePrompt = input.promptText;
  if (!isProjectSentinel(input.sessionName)) {
    try {
      const activeTicketBlock = await deps.getLiveTicketBlock(
        input.projectPath,
        input.sessionName,
      );
      if (activeTicketBlock !== null) {
        effectivePrompt = `${activeTicketBlock}\n\n${effectivePrompt}`;
      }
    } catch (err) {
      logger.warn("task_run.live_ticket_block_failed", {
        sessionName: input.sessionName,
        conversationId: input.conversationId,
        error: getErrorMessage(err),
      });
    }
  }

  const request: AgentCallRequest = {
    kind: "task_run",
    prompt: effectivePrompt,
    backend: input.agentBackend,
    writeCapability: "write_capable",
    ...(input.modelId != null ? { modelId: input.modelId } : {}),
    ...(input.effort != null ? { reasoningEffort: input.effort } : {}),
    ...(input.outputFormat?.type === "json_schema"
      ? { outputSchema: input.outputFormat.schema }
      : {}),
    ...(input.systemInstructions !== undefined
      ? { systemInstructions: input.systemInstructions }
      : {}),
    ...(input.tooling !== undefined ? { tooling: input.tooling } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  };

  // Register the run in the conversations abort-registry so a workflow
  // abort/pause/halt (which fires abortConversation for lane conversations)
  // tears down the live task-run instead of letting it burn to completion.
  // The runner receives the controller's signal through the facade.
  const abortController = new AbortController();
  deps.registerAbortController(input.conversationId, abortController);

  // Per-run inactivity bound, resolved from config + the backend descriptor
  // exactly like the streaming prompt path's stall watchdog. A config read
  // failure degrades to the descriptor default via the runner's own fallback.
  let taskStallTimeoutMs: number | undefined;
  try {
    taskStallTimeoutMs = resolveBackendStallTimeoutMs(
      input.agentBackend,
      await deps.readConfig(),
    );
  } catch (err) {
    logger.warn("task_run.stall_timeout_resolution_failed", {
      sessionName: input.sessionName,
      backend: input.agentBackend,
      conversationId: input.conversationId,
      error: getErrorMessage(err),
    });
  }

  // Semantic execution intent: the facade resolves the runner and capability
  // view from the registry (`deps.getTaskRunner` stays the DI seam for tests).
  const facadeDeps: AgentCallFacadeDeps = {
    taskExecution: {
      workingDirectory: input.worktreePath,
      autonomous: true,
      signal: abortController.signal,
      ...(input.backendRef !== null ? { resumeRef: input.backendRef } : {}),
      ...(input.timeoutMs !== undefined
        ? { defaultTimeoutMs: input.timeoutMs }
        : {}),
      ...(taskStallTimeoutMs !== undefined
        ? { stallTimeoutMs: taskStallTimeoutMs }
        : {}),
      sandboxMode: "danger-full-access",
      approvalPolicy: "never",
      webSearchMode: "disabled",
      skipGitRepoCheck: true,
      networkAccessEnabled: true,
    },
    getTaskRunner: (backend) => deps.getTaskRunner(backend),
    getFailureClassifier: resolveFailureClassifierForBackend,
  };

  logger.info("task_run.dispatch", {
    sessionName: input.sessionName,
    backend: input.agentBackend,
    conversationId: input.conversationId,
    hasOutputSchema: request.outputSchema !== undefined,
    structuredOutputTextField: input.structuredOutputTextField,
  });

  let result: AgentCallResult;
  try {
    result = await deps.executeAgentCall(request, facadeDeps);
  } catch (err) {
    const errorMsg = getErrorMessage(err);
    logger.error("task_run.execute_threw", {
      sessionName: input.sessionName,
      backend: input.agentBackend,
      conversationId: input.conversationId,
      error: errorMsg,
    });
    return buildFailedTurnResult({
      contentBlocks: [],
      error: errorMsg,
      continuationDisposition: "retain",
    });
  } finally {
    deps.unregisterAbortController(input.conversationId, abortController);
  }

  const usage = result.usage;
  const backendRef = result.backendRef ?? null;

  if (result.outcome.kind === "completed") {
    let text = result.outcome.text;
    if (input.structuredOutputTextField !== undefined) {
      const structuredOutput = result.outcome.structuredOutput;
      const presentedValue =
        typeof structuredOutput === "object" && structuredOutput !== null
          ? Reflect.get(structuredOutput, input.structuredOutputTextField)
          : undefined;
      if (typeof presentedValue === "string") {
        text = presentedValue;
      } else {
        text = null;
        logger.warn("task_run.structured_output_text_field_missing", {
          sessionName: input.sessionName,
          backend: input.agentBackend,
          conversationId: input.conversationId,
          structuredOutputTextField: input.structuredOutputTextField,
        });
      }
    }
    const contentBlocks: MessageContentBlock[] = text
      ? [{ type: "text", text }]
      : [];

    if (contentBlocks.length > 0) {
      const rawMetadata =
        transcriptProjection.projectAssistantMetadata(backendRef);
      await deps.safeAppendTranscriptEntry(
        input.conversationId,
        {
          timestamp: new Date().toISOString(),
          type: "assistant",
          role: "assistant",
          content: contentBlocks,
          ...(rawMetadata !== undefined ? { raw: rawMetadata } : {}),
          ...(input.origin !== undefined ? { origin: input.origin } : {}),
        },
        broadcastMeta,
      );
    }

    logger.info("task_run.complete", {
      sessionName: input.sessionName,
      backend: input.agentBackend,
      conversationId: input.conversationId,
      hasStructuredOutput: result.outcome.structuredOutput !== undefined,
    });

    return {
      backendRef,
      costUsd: usage.costUsd ?? null,
      durationMs: usage.durationMs ?? null,
      numTurns: null,
      contextTokens: usage.contextTokens ?? null,
      contextWindow: usage.contextWindowMax ?? null,
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
      cachedInputTokens: usage.cachedInputTokens ?? null,
      contentBlocks,
      ...(result.outcome.structuredOutput !== undefined
        ? { structuredOutput: result.outcome.structuredOutput }
        : {}),
      ...(result.outcome.transcript !== undefined
        ? { transcript: result.outcome.transcript }
        : {}),
      aborted: false,
      compacted: false,
      error: null,
      continuationDisposition: result.continuationDisposition ?? "retain",
    };
  }

  if (result.outcome.kind === "failed") {
    const failureKind = result.outcome.error.failureKind;
    const errorMsg = result.outcome.error.message;
    logger.warn("task_run.failed", {
      sessionName: input.sessionName,
      backend: input.agentBackend,
      conversationId: input.conversationId,
      failureKind,
      message: errorMsg,
    });
    return {
      backendRef,
      costUsd: usage.costUsd ?? null,
      durationMs: usage.durationMs ?? null,
      numTurns: null,
      contextTokens: usage.contextTokens ?? null,
      contextWindow: usage.contextWindowMax ?? null,
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
      cachedInputTokens: usage.cachedInputTokens ?? null,
      contentBlocks: [],
      ...(result.outcome.transcript !== undefined
        ? { transcript: result.outcome.transcript }
        : {}),
      aborted: failureKind === "aborted",
      compacted: false,
      error: errorMsg,
      continuationDisposition: result.continuationDisposition ?? "retain",
    };
  }

  // outcome.kind === "paused": task_run path produces no pauses today.
  // Surface as an error so callers see a deterministic outcome.
  logger.warn("task_run.unexpected_paused_outcome", {
    sessionName: input.sessionName,
    backend: input.agentBackend,
    conversationId: input.conversationId,
  });
  return {
    backendRef,
    costUsd: usage.costUsd ?? null,
    durationMs: usage.durationMs ?? null,
    numTurns: null,
    contextTokens: usage.contextTokens ?? null,
    contextWindow: usage.contextWindowMax ?? null,
    inputTokens: usage.inputTokens ?? null,
    outputTokens: usage.outputTokens ?? null,
    cachedInputTokens: usage.cachedInputTokens ?? null,
    contentBlocks: [],
    aborted: false,
    compacted: false,
    error: "task_run produced unexpected paused outcome",
    continuationDisposition: result.continuationDisposition ?? "retain",
  };
}

/**
 * Cross-checks the agent's cleanup result against the persisted manifest.
 * On a passing verification the manifest is deleted; on failure the
 * structured remediation prompt is returned so the machine can route to
 * `debug.error` and let the user re-run cleanup.
 */
export async function verifyCleanupForMachine(
  input: VerifyCleanupInput,
  signal?: AbortSignal,
): Promise<VerifyCleanupOutput> {
  const [{ verifyCleanupAgainstManifest, deleteManifest }] = await Promise.all([
    import("@/lib/debug-log/service"),
  ]);
  if (signal?.aborted) {
    throw new Error("Cleanup verification aborted");
  }

  const verification = verifyCleanupAgainstManifest(
    input.worktreePath,
    input.conversationId,
    input.cleanup,
  );

  if (verification.ok) {
    if (signal?.aborted) {
      throw new Error("Cleanup verification aborted");
    }
    deleteManifest(input.worktreePath, input.conversationId);
    logger.info("debug.cleanup_verified", {
      conversationId: input.conversationId,
    });
  } else {
    logger.warn("debug.cleanup_verification_failed", {
      conversationId: input.conversationId,
      failedConditions: verification.failedConditions,
      missingFiles: verification.missingFiles,
    });
  }

  return verification;
}
