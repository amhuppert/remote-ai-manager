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
import type { AgentTaskRunner } from "@/lib/agent-backends/task";
import type {
  ConversationBackendRuntime,
  ConversationBackendFactory,
  ConversationBackendTurnInput,
  ConversationBackendTurnResult,
  ConversationBackendEvent,
  ConversationImageRef,
} from "@/lib/agent-backends/conversation";
import type { AgentSessionRef } from "@/lib/agent-backends/schemas";
import type {
  AgentCapabilityDiagnostic,
  AgentCapabilityRuntimeApplicationState,
} from "@/lib/agent-capabilities/schemas";
import type { ApplyConversationIdentity } from "@/lib/agent-capabilities/apply";
import type {
  MessageContentBlock,
  ConversationState,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import { selectLastUserTurnAgentSettings } from "@/lib/conversations/last-turn-agent-settings";
import type { ImagePayload } from "@/lib/images/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type { AlignmentInjection } from "@/lib/session-alignment/render";
import { ALIGN_SUGGESTION_INSTRUCTIONS } from "@/lib/session-alignment/render";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { formatDocumentFeedbackPrompt } from "@/lib/document-comments/format-feedback";
import { assembleUserContentBlocks } from "./assemble-user-blocks";
import { buildUserTranscriptBlocks } from "./build-user-transcript-blocks";
import type {
  TranscriptEntry,
  TranscriptBroadcastMeta,
} from "@/lib/prompt/transcript";
import type { PortableMcpConfig } from "@/lib/agent-backends/portable-mcp";
import type { ConversationApplyResult } from "@/lib/mcp/runtime-apply";
import { computeEffectiveConfigHash } from "@/lib/mcp/runtime-apply";
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";
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
import {
  isUndeliveredQuerySessionError,
  tagQuerySessionError,
  QUERY_SESSION_ERROR_CODES,
} from "@/lib/agent-backends/claude/query-session-errors";
import { mapAssistantContentBlocks } from "@/lib/agent-backends/claude/map-content-blocks";
import { buildSyntheticForkSeed } from "@/lib/sessions/synthetic-fork-seed";
import { isProjectSentinel } from "@/lib/conversations/project-conversation-scope";
import {
  PROJECT_CC_CONTEXT,
  PROJECT_SPAWN_INSTRUCTIONS,
} from "@/lib/project-conversations/system-prompt";
import { createExternalTurnHandler } from "./external-turn-handler";
import { createArtifactRegistry } from "@/lib/workflows/primitives/artifact-registry";
import { executeAgentCall as defaultExecuteAgentCall } from "@/lib/workflows/primitives/agent-call-facade";
import { resolveConfiguredTimeoutMs } from "@/lib/agent-backends/timeout";
import type {
  AgentCallRequest,
  AgentCallResult,
} from "@/lib/workflows/primitives/agent-call-vocabulary";
import type {
  AgentCallFacadeDeps,
  ConversationRuntimeResolution,
} from "@/lib/workflows/primitives/agent-call-facade";
import { capabilityViewForBackend } from "@/lib/workflows/primitives/backend-capabilities";
import { getDebugManifestPath } from "@/lib/debug-log/service";
import fs from "node:fs/promises";

const logger = createLogger("conversation-actor");

const FOCUS_MEMORY_DESCRIPTION =
  "Current work-in-progress and remaining tasks for this session";

type ProjectCapabilitySeed =
  import("@/lib/agent-capabilities/default-deps").ComposedProjectConversationCapabilitySeed;
type RuntimeProjectCapabilitySeed = Exclude<
  ProjectCapabilitySeed,
  { kind: "diagnostics-only" }
>;

function isRuntimeProjectCapabilitySeed(
  seed: ProjectCapabilitySeed | undefined,
): seed is RuntimeProjectCapabilitySeed {
  return seed !== undefined && seed.kind !== "diagnostics-only";
}

export interface RegisterFocusMemoryIfPresentInput {
  worktreePath: string;
  projectPath: string;
  sessionName: string;
  conversationId: string;
  fileExists: (filePath: string) => boolean;
  registerReferenceDocument: (
    projectPath: string,
    sessionName: string,
    filePath: string,
    description: string,
  ) => Promise<unknown>;
  /** Optional registry override; production constructs one if omitted. */
  artifactRegistry?: ReturnType<typeof createArtifactRegistry>;
}

/**
 * Register `memory-bank/focus.md` as a `focus_memory` artifact when present.
 *
 * Always routes through the shared `ArtifactRegistry.register()` flow so the
 * canonical path is enforced and shallow source metadata (workflowId =
 * conversationId) is recorded alongside the existing reference-document
 * registration. Preserves the prior behavior of doing nothing when the file
 * is absent.
 */
export async function registerFocusMemoryIfPresent(
  input: RegisterFocusMemoryIfPresentInput,
): Promise<void> {
  const focusPath = `${input.worktreePath}/memory-bank/focus.md`;
  if (!input.fileExists(focusPath)) return;

  const registry =
    input.artifactRegistry ??
    createArtifactRegistry({
      writeFile: (absolutePath, contents) =>
        fs.writeFile(absolutePath, contents),
      ensureDir: (absolutePath) =>
        fs.mkdir(absolutePath, { recursive: true }).then(() => {}),
      registration: {
        registerReferenceDocument: async ({ relativePath, description }) => {
          await input.registerReferenceDocument(
            input.projectPath,
            input.sessionName,
            relativePath,
            description,
          );
        },
      },
    });

  await registry.register({
    kind: "focus_memory",
    worktreePath: input.worktreePath,
    relativePath: "memory-bank/focus.md",
    description: FOCUS_MEMORY_DESCRIPTION,
    source: { workflowId: input.conversationId },
  });
}

// ============================================================
// Minimal types for deps interface
// ============================================================

/** Subset of GlobalConfig properties used by actor implementations. */
export interface ActorConfig {
  defaultModel?: string;
  defaultEffort?: string;
  claudeTimeoutMs: number;
  maxTurns: number;
  idleQuerySessionTtlMs: number;
  pushNotification?: unknown;
  codex?: {
    enabled?: boolean;
    model?: string;
    reasoningEffort?: string;
    timeoutMs?: number | null;
  };
}

// ============================================================
// Dependency Injection
// ============================================================

export interface ActorImplementationDeps {
  // Resource acquisition
  acquireConversationLock(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): () => void;
  acquireQuerySlot(label: string): Promise<() => void>;
  getTranscriptPath(conversationId: string): Promise<string>;

  // Config & project
  readConfig(): Promise<ActorConfig>;
  getProjectDisplayName(projectPath: string): string;
  getDebugLogUrl(conversationId: string): string;

  // Transcript I/O. `meta` is forwarded to `appendTranscriptEntry` so callers
  // that know the project + session identity (the conversation turn actor and
  // external-turn handler) can trigger the `message-appended` SSE broadcast.
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

  // Backend runtime lifecycle
  getConversationBackendFactory(
    backend: AgentBackendId,
  ): ConversationBackendFactory;
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

  // Transcript reading (for synthetic fork seed and last-used model/effort
  // resolution). Returns the full TranscriptMessage so per-turn model/effort
  // metadata is available, not just role/content.
  readConversationMessages(
    transcriptPath: string | null,
  ): Promise<TranscriptMessage[]>;

  // Lifecycle registries
  registerAbortController(
    conversationId: string,
    controller: AbortController,
  ): void;
  unregisterAbortController(conversationId: string): void;

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
   * Compose the Claude capability runtime config + initial apply state for a
   * new conversation runtime. The actor passes `config` to the backend
   * factory's `tooling.claudeCapabilityConfig` and persists `runtimeState` to
   * `conversation.agentCapabilitiesRuntime` so the apply service can compare
   * subsequent mutations against the baseline the runtime was seeded with.
   * Returns `undefined` for non-Claude backends or when there are no cascade
   * overrides to apply.
   */
  composeClaudeCapabilityConfigForConversation(input: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    conversationId: string;
    worktreePath: string;
  }): Promise<
    | import("@/lib/agent-capabilities/default-deps").ComposedClaudeCapabilitySeed
    | undefined
  >;

  /**
   * Compose the Codex capability runtime config + initial apply state for a
   * new conversation runtime. See `composeClaudeCapabilityConfigForConversation`
   * for the actor wiring contract.
   */
  composeCodexCapabilityConfigForConversation(input: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    conversationId: string;
    worktreePath: string;
  }): Promise<
    | import("@/lib/agent-capabilities/default-deps").ComposedCodexCapabilitySeed
    | undefined
  >;

  /**
   * Compose capability runtime config for a project conversation. Uses the
   * fixed backend persisted on the project-conversation record and omits any
   * session layer from the cascade.
   */
  composeCapabilityConfigForProjectConversation(input: {
    projectPath: string;
    projectName: string;
    conversationId: string;
  }): Promise<
    | import("@/lib/agent-capabilities/default-deps").ComposedProjectConversationCapabilitySeed
    | undefined
  >;

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

  // Durable queue delivery result. Used only by auto-drained queued turns to
  // record the outcome of a claimed delivery batch against the message queue.
  // `markQueuedDelivered` is called after the coalesced user transcript entry
  // is appended; `markQueuedPending` returns a batch to `pending` for a
  // recoverable acceptance failure; `markQueuedFailed` marks it terminally
  // `failed`. Wired to `messageQueueService` in production.
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
    import("@/lib/agent-backends/codex/codex-output"),
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
    registerBackendRuntime: runtimeRegistryMod.registerRuntime,
    unregisterBackendRuntime: runtimeRegistryMod.unregisterRuntime,
    buildChildEnv: childEnvMod.buildChildEnv,
    resolvePluginPaths: commandsMod.resolvePluginPaths,
    getCodexToolPromptHint: codexToolMod.getCodexToolPromptHint,
    getProjectDisplayName: projectResolverMod.getProjectDisplayName,
    getDebugLogUrl: debugLogMod.getDebugLogUrl,
    mutateConversation: stateMod.mutateConversation,
    getSessionState: stateMod.getSession,
    getActiveAlignmentInjection: (projectPath: string, sessionName: string) =>
      alignmentService.getActiveInjection(projectPath, sessionName),
    getActiveAlignmentVersion: (projectPath: string, sessionName: string) =>
      alignmentService.getActiveVersion(projectPath, sessionName),
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
    composeClaudeCapabilityConfigForConversation:
      capabilitiesDepsMod.composeClaudeCapabilityConfigForConversation,
    composeCodexCapabilityConfigForConversation:
      capabilitiesDepsMod.composeCodexCapabilityConfigForConversation,
    composeCapabilityConfigForProjectConversation:
      capabilitiesDepsMod.composeCapabilityConfigForProjectConversation,
    executeAgentCall: defaultExecuteAgentCall,
    getTaskRunner: registryMod.getTaskRunner,
    markQueuedDelivered: messageQueueMod.messageQueueService.markDelivered,
    markQueuedPending: messageQueueMod.messageQueueService.markPending,
    markQueuedFailed: messageQueueMod.messageQueueService.markFailed,
  } as unknown as ActorImplementationDeps;
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
 */
export function buildEffectivePrompt(
  promptText: string,
  hasImages: boolean,
  userContentBlocks: MessageContentBlock[],
  debugMode: ConversationContext["debugMode"],
  debugLogUrl: string,
  debugManifestPath: string,
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

  return effectivePrompt;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shouldRetryUndeliveredPrompt(
  error: unknown,
  runtime: { status: string } | undefined,
  abortSignal: AbortSignal,
  attemptNumber: number,
): boolean {
  return (
    attemptNumber === 0 &&
    !abortSignal.aborted &&
    runtime?.status === "dead" &&
    isUndeliveredQuerySessionError(error)
  );
}

/**
 * Decide whether the first turn should build a synthetic-fork seed from the
 * local transcript copy. Only fires for non-Claude forks that have a
 * transcript and no backend continuity yet.
 *
 * Claude forks never need a runtime seed:
 *  - "native": arrive with `backendRef` populated (eager SDK fork).
 *  - "synthetic" fallback: `pendingPromptText` already carries the seed;
 *    re-seeding here would duplicate context on the first prompt.
 *  - case 3 (user fork at index 0): no source continuity, behaves like a
 *    brand-new conversation.
 */
export function shouldBuildRuntimeSyntheticSeed(input: {
  forkedFrom: unknown;
  backendRef: unknown;
  agentBackend: string;
  transcriptPath: string | null;
}): boolean {
  return (
    input.forkedFrom !== null &&
    input.forkedFrom !== undefined &&
    !input.backendRef &&
    input.agentBackend !== "claude" &&
    input.transcriptPath !== null
  );
}

// ============================================================
// Backend-aware settings resolution
// ============================================================

/**
 * Resolve the effective model and effort for a turn based on the backend.
 * Claude falls back to config.defaultModel; Codex falls back to config.codex.
 */
export function resolveBackendTurnSettings(
  backend: AgentBackendId,
  config: ActorConfig,
  explicitModel: string | null,
  explicitEffort: string | null,
): { effectiveModel: string | undefined; effectiveEffort: string | undefined } {
  if (backend === "codex") {
    return {
      effectiveModel: explicitModel ?? config.codex?.model,
      effectiveEffort: explicitEffort ?? config.codex?.reasoningEffort,
    };
  }
  return {
    effectiveModel: explicitModel ?? config.defaultModel,
    effectiveEffort: explicitEffort ?? config.defaultEffort,
  };
}

/**
 * Resolve the model + effort a turn should run with, using a three-tier
 * fallback: an explicit per-turn override, else the conversation's last-used
 * model/effort (from its prior user turns), else the backend's configured
 * defaults.
 *
 * The last-used tier is what keeps follow-up turns that carry no explicit
 * model/effort — drained queued messages, document feedback, alignment turns —
 * on the model the conversation was already using instead of snapping to the
 * global default. The client resolves this same last-used value for the
 * composer (`selectLastUserTurnAgentSettings`); paths that bypass the composer
 * rely on this server-side tier so the model/effort stays consistent. Backend
 * is resolved separately (from the conversation's stored `agentBackend`), so it
 * is never inferred from the transcript here.
 */
export function resolveTurnModelEffort(input: {
  backend: AgentBackendId;
  config: ActorConfig;
  explicitModel: string | null;
  explicitEffort: string | null;
  priorMessages: readonly TranscriptMessage[];
}): {
  effectiveModel: string | undefined;
  effectiveEffort: string | undefined;
} {
  const lastUsed = selectLastUserTurnAgentSettings(input.priorMessages);
  return resolveBackendTurnSettings(
    input.backend,
    input.config,
    input.explicitModel ?? lastUsed.modelId ?? null,
    input.explicitEffort ?? lastUsed.effort ?? null,
  );
}

/**
 * Resolve the safety-net timeout for a turn based on the backend.
 * Returns 0 when the backend has no timeout.
 */
export function resolveBackendTimeoutMs(
  backend: AgentBackendId,
  config: ActorConfig,
): number {
  if (backend === "codex") {
    return resolveConfiguredTimeoutMs(config.codex?.timeoutMs);
  }
  return config.claudeTimeoutMs;
}

function buildNonClaudeTranscriptEntries(input: {
  backend: Exclude<AgentBackendId, "claude">;
  backendRef: AgentSessionRef | null;
  contentBlocks: MessageContentBlock[];
  turnResult: ConversationBackendTurnResult;
  timestamp: string;
}): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];

  if (input.contentBlocks.length > 0) {
    entries.push({
      timestamp: input.timestamp,
      type: "assistant",
      role: "assistant",
      content: input.contentBlocks,
    });
  }

  entries.push({
    timestamp: input.timestamp,
    type: "result",
    raw: {
      backend: input.backend,
      backendRef: input.backendRef,
      durationMs: input.turnResult.durationMs,
      numTurns: input.turnResult.numTurns,
      contextTokens: input.turnResult.contextTokens,
      contextWindowMax: input.turnResult.contextWindowMax,
      costUsd: input.turnResult.costUsd,
      aborted: input.turnResult.aborted,
      error: input.turnResult.error,
    },
  });

  return entries;
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

// ============================================================
// Message processing (handles raw SDK messages from provider_event)
// ============================================================

export async function processMessage(
  message: SDKMessage,
  conversationId: string,
  emit: (event: string, data: unknown) => void,
  contentBlocks: MessageContentBlock[],
  safeAppendTranscriptEntry: (
    conversationId: string,
    entry: TranscriptEntry,
  ) => Promise<void>,
): Promise<void> {
  const timestamp = new Date().toISOString();

  switch (message.type) {
    case "system": {
      const sysMsg = message as SDKSystemMessage;
      if (sysMsg.subtype === "init") {
        emit("init", { sessionId: sysMsg.session_id });
        await safeAppendTranscriptEntry(conversationId, {
          timestamp,
          type: "system",
          raw: { subtype: "init", session_id: sysMsg.session_id },
        });
      } else {
        await safeAppendTranscriptEntry(conversationId, {
          timestamp,
          type: "system",
          raw: message,
        });
      }
      break;
    }

    case "assistant": {
      const asstMsg = message as SDKAssistantMessage;
      const blocks = mapAssistantContentBlocks(asstMsg.message.content);
      for (const block of blocks) {
        contentBlocks.push(block);
        emit("content", block);
      }

      await safeAppendTranscriptEntry(conversationId, {
        timestamp,
        type: "assistant",
        role: "assistant",
        content: blocks,
        uuid: asstMsg.uuid,
      });
      break;
    }

    case "user": {
      await safeAppendTranscriptEntry(conversationId, {
        timestamp,
        type: "tool_result",
        raw: message,
      });
      break;
    }

    case "result": {
      const resultMsg = message as SDKResultSuccess | SDKResultError;
      if (resultMsg.subtype === "success") {
        const success = resultMsg as SDKResultSuccess;
        if (success.result && contentBlocks.length === 0) {
          const textBlock: MessageContentBlock = {
            type: "text",
            text: success.result,
          };
          contentBlocks.push(textBlock);
          emit("content", textBlock);
        }
        emit("result", {
          sessionId: success.session_id,
          costUsd: success.total_cost_usd,
          numTurns: success.num_turns,
        });
      } else {
        const error = resultMsg as SDKResultError;
        const errorMessage = mapErrorSubtype(error);
        emit("error", { message: errorMessage });
      }

      await safeAppendTranscriptEntry(conversationId, {
        timestamp,
        type: "result",
        raw: resultMsg,
      });
      break;
    }

    default: {
      await safeAppendTranscriptEntry(conversationId, {
        timestamp,
        type: message.type,
        raw: message,
      });
      break;
    }
  }
}

export function mapErrorSubtype(error: SDKResultError): string {
  switch (error.subtype) {
    case "error_max_turns":
      return `Agent reached maximum turns (${error.num_turns})`;
    case "error_max_budget_usd":
      return `Agent exceeded budget limit ($${error.total_cost_usd.toFixed(2)})`;
    case "error_max_structured_output_retries":
      return "Agent exceeded structured output retry limit";
    case "error_during_execution":
      return error.errors.length > 0
        ? error.errors.join("; ")
        : "Error during execution";
    default:
      return "Unknown error";
  }
}

// ============================================================
// Backend runtime creation
// ============================================================

// ============================================================
// Shared AgentCall dispatch
// ============================================================

interface DispatchTurnViaAgentCallInput {
  executeAgentCall: ActorImplementationDeps["executeAgentCall"];
  getRuntime: () => ConversationBackendRuntime;
  replaceRuntime: () => Promise<ConversationBackendRuntime>;
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

interface DispatchTurnViaAgentCallOutput {
  turnResult: ConversationBackendTurnResult | undefined;
  agentCallResult: AgentCallResult | undefined;
  thrown?: unknown;
}

/**
 * Routes a single conversation turn through the shared AgentCall primitive.
 *
 * - Builds a normalized `conversation_turn` request and resolves the
 *   conversation runtime via the facade.
 * - Captures the underlying `ConversationBackendTurnResult` so the actor's
 *   downstream code keeps full access to fields the normalized primitive
 *   result drops (numTurns, raw contentBlocks).
 * - Wraps the backend runtime so its `sendTurn` performs the existing
 *   undelivered-query-session retry loop in-place; observable behavior
 *   (close + unregister + recreate) matches the prior direct-`sendTurn`
 *   path so a stale Claude query session is retried transparently.
 */
async function dispatchTurnViaAgentCall(
  input: DispatchTurnViaAgentCallInput,
): Promise<DispatchTurnViaAgentCallOutput> {
  let captured: ConversationBackendTurnResult | undefined;
  let pendingRetry: Error | undefined;

  const wrappedRuntime: ConversationBackendRuntime = new Proxy(
    input.getRuntime(),
    {
      get(_target, prop, _receiver) {
        const live = input.getRuntime();
        if (prop === "sendTurn") {
          return async (
            turnInput: ConversationBackendTurnInput,
          ): Promise<ConversationBackendTurnResult> => {
            let attempt = 0;
            let current = input.getRuntime();
            while (true) {
              try {
                const result = await current.sendTurn(turnInput);
                captured = result;
                return result;
              } catch (err) {
                if (
                  !shouldRetryUndeliveredPrompt(
                    err,
                    current,
                    input.signal,
                    attempt,
                  )
                ) {
                  // Non-retryable: capture so the actor's outer catch can
                  // surface the original error after the facade normalizes
                  // the throw into a failed AgentCallResult.
                  pendingRetry = err as Error;
                  throw err;
                }
                attempt += 1;
                logger.warn("prompt.runtime_retry", {
                  sessionName: input.sessionName,
                  conversationId: input.conversationId,
                  attempt,
                  error: getErrorMessage(err),
                });
                current = await input.replaceRuntime();
              }
            }
          };
        }
        return Reflect.get(live, prop);
      },
    },
  );

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
  };

  let agentCallResult: AgentCallResult | undefined;
  try {
    agentCallResult = await input.executeAgentCall(request, facadeDeps);
  } catch (err) {
    pendingRetry = err as Error;
  }

  return {
    turnResult: captured,
    agentCallResult,
    ...(pendingRetry ? { thrown: pendingRetry } : {}),
  };
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
      return {
        backendRef: null,
        costUsd: null,
        durationMs: null,
        numTurns: null,
        contextTokens: null,
        contextWindow: null,
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        contentBlocks: [],
        aborted: false,
        compacted: false,
        error: errorMessage,
      };
    }
  }

  // Server-side image indexing: scan transcript for cumulative count, then
  // assemble inline+strip images into a coherent block sequence with rewritten
  // markers. Images are persisted to disk by serverIndex before dispatch so
  // the backend (and downstream readers) can refer to them by path.
  //
  // Two send paths carry document feedback differently:
  //  - Immediate path: the send hook puts the formatted feedback prose in
  //    `promptText` (and `documentFeedback` for the card). The prose is used
  //    as-is, or derived here when no explicit text was supplied.
  //  - Drained queue path (`queuedDelivery` set): the durable queue dropped the
  //    feedback prose at enqueue, so `promptText` is the user's OWN text — a
  //    coalesced batch may pair a normal text message with a feedback message.
  //    Both must reach the agent, so the derived feedback prose is appended to
  //    the user text rather than replacing it.
  // Absent feedback, `effectivePromptText` equals `input.promptText`, so
  // non-feedback turns are unchanged.
  const derivedFeedbackText = input.documentFeedback
    ? formatDocumentFeedbackPrompt(input.documentFeedback.items)
    : null;
  const isDrainedFeedbackBatch =
    input.queuedDelivery !== undefined && derivedFeedbackText !== null;
  const hasExplicitPromptText = input.promptText.trim().length > 0;

  let effectivePromptText: string;
  if (!derivedFeedbackText) {
    effectivePromptText = input.promptText;
  } else if (isDrainedFeedbackBatch) {
    effectivePromptText = hasExplicitPromptText
      ? `${input.promptText}\n\n${derivedFeedbackText}`
      : derivedFeedbackText;
  } else {
    effectivePromptText = hasExplicitPromptText
      ? input.promptText
      : derivedFeedbackText;
  }

  const startIndex =
    input.images && input.images.length > 0
      ? await deps.getNextImageIndex(input.conversationId)
      : 1;

  const assembled = assembleUserContentBlocks({
    promptText: effectivePromptText,
    images: input.images ?? [],
    startIndex,
  });

  const imagesByAttachmentId = new Map<string, ImagePayload>(
    (input.images ?? []).map((img) => [img.attachmentId, img]),
  );

  const imageRefs: ConversationImageRef[] = [];
  for (const assignment of assembled.assignments) {
    const image = imagesByAttachmentId.get(assignment.attachmentId);
    if (!image) continue;
    const persistedPath = await deps.saveTranscriptImage(
      input.conversationId,
      assignment.serverIndex,
      assignment.mediaType,
      image.base64Data,
    );
    imageRefs.push({
      index: assignment.serverIndex,
      mediaType: assignment.mediaType,
      path: persistedPath,
      base64Data: image.base64Data,
    });
  }

  // For a feedback turn the transcript records the structured card. The
  // agent-facing feedback prose is carried separately as the turn's prompt text,
  // so the card-side `rewrittenPromptText` is the user's OWN text only — never
  // the prose. Immediate feedback puts the prose in `promptText`, so the card is
  // recorded alone (empty text). A drained mixed batch carries a distinct user
  // text that is preserved as a text block before the card. Queued feedback
  // content has no inline `[Image #N]` markers, so the raw user text is used
  // directly. Non-feedback turns are unchanged: text+image interleaving, or a
  // single text block, or nothing.
  const transcriptUserText = isDrainedFeedbackBatch ? input.promptText : "";
  const transcriptBlocks: MessageContentBlock[] = input.documentFeedback
    ? buildUserTranscriptBlocks({
        rewrittenPromptText: transcriptUserText,
        imageRefs,
        documentFeedback: input.documentFeedback,
      })
    : imageRefs.length > 0
      ? buildUserTranscriptBlocks({
          rewrittenPromptText: assembled.rewrittenPromptText,
          imageRefs,
        })
      : effectivePromptText
        ? [{ type: "text" as const, text: effectivePromptText }]
        : [];

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

  if (!input.queuedDelivery) {
    await safeAppendWithMeta(input.conversationId, buildUserTranscriptEntry());
  }

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

  async function seedRuntimeCapabilityState(
    seed: AgentCapabilityRuntimeApplicationState,
  ) {
    await deps.mutateConversation(
      input.projectPath,
      input.sessionName,
      input.conversationId,
      "prompt.seedCapabilityRuntime",
      (conversation) => {
        conversation.agentCapabilitiesRuntime = seed;
      },
    );
    logger.info("prompt.capability_runtime_seeded", {
      sessionName: input.sessionName,
      backend: input.agentBackend,
      conversationId: input.conversationId,
      seededCascadeKinds: Object.keys(seed.cascades),
    });
  }

  function buildCapabilityApplyInput(): ApplyConversationIdentity {
    if (isProjectConversation) {
      return {
        conversationScope: "project",
        projectPath: input.projectPath,
        projectName,
        conversationId: input.conversationId,
        worktreePath: input.worktreePath,
        backend: input.agentBackend,
      };
    }

    return {
      projectPath: input.projectPath,
      projectName,
      sessionName: input.sessionName,
      conversationId: input.conversationId,
      worktreePath: input.worktreePath,
      backend: input.agentBackend,
    };
  }

  async function composeProjectConversationCapabilitySeed(): Promise<
    ProjectCapabilitySeed | undefined
  > {
    try {
      return await deps.composeCapabilityConfigForProjectConversation({
        projectPath: input.projectPath,
        projectName,
        conversationId: input.conversationId,
      });
    } catch (err) {
      const error = getErrorMessage(err);
      logger.warn("prompt.project_conversation_capability_compose_failed", {
        sessionName: input.sessionName,
        conversationScope: "project",
        backend: input.agentBackend,
        conversationId: input.conversationId,
        error,
      });
      runtimeState.streamEmit?.("error", {
        message: `Project conversation capability configuration could not be fully composed: ${error}`,
      });
      return undefined;
    }
  }

  function emitProjectCapabilityDiagnostics(
    diagnostics: readonly AgentCapabilityDiagnostic[] | undefined,
  ): void {
    if (!diagnostics || diagnostics.length === 0) return;

    for (const diagnostic of diagnostics) {
      logger.warn("prompt.project_conversation_capability_diagnostic", {
        sessionName: input.sessionName,
        conversationScope: "project",
        backend: diagnostic.backend ?? input.agentBackend,
        cascadeKind: diagnostic.cascadeKind,
        code: diagnostic.code,
        severity: diagnostic.severity,
        conversationId: input.conversationId,
        message: diagnostic.message,
      });
      runtimeState.streamEmit?.("error", {
        message: `Project conversation capability configuration issue: ${diagnostic.message}`,
      });
    }
  }

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
    alignmentEligibleThisTurn =
      gateSession?.creationMode === "normal" &&
      !isProjectConversation &&
      input.autonomous !== true;
    desiredAlignmentVersion = alignmentEligibleThisTurn
      ? await deps.getActiveAlignmentVersion(
          input.projectPath,
          input.sessionName,
        )
      : null;
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

    // Alignment governs only attended normal sessions (R12.1/R12.2): not project
    // conversations, not optimistic sessions, not autonomous turns. Mirror the
    // result to the outer flag so the post-turn seen-version record (R8.4) holds
    // for a freshly-created runtime too.
    const alignmentEligible =
      sessionState?.creationMode === "normal" &&
      !isProjectConversation &&
      input.autonomous !== true;
    alignmentEligibleThisTurn = alignmentEligible;
    let activeAlignmentVersion: number | null = null;
    let alignmentInstruction: string | null = null;
    if (alignmentEligible) {
      const injection = await deps.getActiveAlignmentInjection(
        input.projectPath,
        input.sessionName,
      );
      if (injection) {
        // Governing section (inline charter or bounded digest), R7.1/R7.2/R7.4.
        activeAlignmentVersion = injection.version;
        alignmentInstruction = injection.text;
      } else {
        // No active charter: nudge the agent to suggest `/align` (R2.5).
        alignmentInstruction = ALIGN_SUGGESTION_INSTRUCTIONS;
      }
    }

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

    const projectCapabilitySeed = isProjectConversation
      ? await composeProjectConversationCapabilitySeed()
      : undefined;
    emitProjectCapabilityDiagnostics(projectCapabilitySeed?.diagnostics);
    const projectRuntimeCapabilitySeed = isRuntimeProjectCapabilitySeed(
      projectCapabilitySeed,
    )
      ? projectCapabilitySeed
      : undefined;

    const claudeCapabilitySeed =
      input.agentBackend === "claude"
        ? projectRuntimeCapabilitySeed?.backend === "claude"
          ? projectRuntimeCapabilitySeed
          : !isProjectConversation
            ? await deps.composeClaudeCapabilityConfigForConversation({
                projectPath: input.projectPath,
                projectName,
                sessionName: input.sessionName,
                conversationId: input.conversationId,
                worktreePath: input.worktreePath,
              })
            : undefined
        : undefined;

    const codexCapabilitySeed =
      input.agentBackend === "codex"
        ? projectRuntimeCapabilitySeed?.backend === "codex"
          ? projectRuntimeCapabilitySeed
          : !isProjectConversation
            ? await deps.composeCodexCapabilityConfigForConversation({
                projectPath: input.projectPath,
                projectName,
                sessionName: input.sessionName,
                conversationId: input.conversationId,
                worktreePath: input.worktreePath,
              })
            : undefined
        : undefined;

    if (
      projectCapabilitySeed &&
      projectCapabilitySeed.backend !== input.agentBackend
    ) {
      logger.warn("prompt.project_conversation_capability_backend_mismatch", {
        sessionName: input.sessionName,
        conversationScope: "project",
        conversationId: input.conversationId,
        actorBackend: input.agentBackend,
        composedBackend: projectCapabilitySeed.backend,
      });
    }

    const claudeCapabilityConfig = claudeCapabilitySeed?.config;
    const codexCapabilityConfig = codexCapabilitySeed?.config;
    const capabilityRuntimeStateSeed =
      claudeCapabilitySeed?.runtimeState ?? codexCapabilitySeed?.runtimeState;

    logger.info("prompt.runtime_create", {
      sessionName: input.sessionName,
      backend: input.agentBackend,
      conversationId: input.conversationId,
      hasResumeRef: input.backendRef !== null,
      promptCount: input.promptCount,
      claudeCapabilityConfigSeeded: claudeCapabilityConfig !== undefined,
      codexCapabilityConfigSeeded: codexCapabilityConfig !== undefined,
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

    const externalTurnHandler = createExternalTurnHandler(
      {
        projectPath: input.projectPath,
        projectName,
        sessionName: input.sessionName,
        conversationId: input.conversationId,
        worktreePath: input.worktreePath,
      },
      {
        sendToMachine: (event) => runtimeState.sendToMachine?.(event),
      },
      {
        safeAppendTranscriptEntry: safeAppendWithMeta,
        applyCapabilityWhenIdle:
          input.agentBackend === "claude"
            ? () => deps.applyCapabilityWhenIdle(buildCapabilityApplyInput())
            : undefined,
      },
    );

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
        ...(claudeCapabilityConfig !== undefined
          ? { claudeCapabilityConfig }
          : {}),
        ...(codexCapabilityConfig !== undefined
          ? { codexCapabilityConfig }
          : {}),
      },
      ...(runtimeState.workflowContext
        ? {
            workflowExecutionId: runtimeState.workflowContext.executionId,
            workflowContextId: runtimeState.workflowContext.contextId,
          }
        : {}),
      onExternalTurnEvent: externalTurnHandler,
    });

    // Register in runtime-registry and local state
    deps.registerBackendRuntime(input.conversationId, newRuntime);
    runtimeState.backendRuntime = newRuntime;
    backendRuntime = newRuntime;
    await seedRuntimeMcpState(portableMcp);
    if (capabilityRuntimeStateSeed) {
      await seedRuntimeCapabilityState(capabilityRuntimeStateSeed);
    }

    return newRuntime;
  }

  if (isNewRuntime) {
    backendRuntime = await createManagedBackendRuntime();
  }

  // Store the runtime in local state for reuse
  runtimeState.backendRuntime = backendRuntime;

  // ---------------------------------------------------------------
  // Safety-net timeout
  // ---------------------------------------------------------------
  if (runtimeState.abortController.signal.aborted) {
    logger.info("prompt.abort_controller_refreshed", {
      sessionName: input.sessionName,
      backend: input.agentBackend,
      conversationId: input.conversationId,
    });
    runtimeState.abortController = new AbortController();
  }
  const abortController = runtimeState.abortController;
  deps.registerAbortController(input.conversationId, abortController);

  const timeoutMs = resolveBackendTimeoutMs(input.agentBackend, config);
  let timeoutFired = false;
  logger.debug("prompt.timeout.resolved", {
    sessionName: input.sessionName,
    backend: input.agentBackend,
    timeoutMs,
    timeoutEnabled: timeoutMs > 0,
  });
  if (timeoutMs > 0) {
    runtimeState.timeoutHandle = setTimeout(() => {
      timeoutFired = true;
      logger.warn("prompt.timeout", {
        sessionName: input.sessionName,
        timeoutMs,
      });
      // Abort first so the backend's `signal.aborted` check classifies the
      // failure as `aborted` rather than a generic error.
      abortController.abort();
      backendRuntime?.close();
    }, timeoutMs);
  }

  // ---------------------------------------------------------------
  // Build turn input and execute
  // ---------------------------------------------------------------
  const contentBlocks: MessageContentBlock[] = [];
  const pendingTranscriptWrites: Promise<void>[] = [];
  let sawErrorEvent = false;

  // Guards the queued-delivery transcript append. Set true the instant the
  // coalesced user entry is appended on backend acceptance so a repeated
  // `input_accepted` cannot re-append, and so a later `markQueuedDelivered`
  // failure cannot trigger a second append. Read on all exit paths to decide
  // whether a queued batch must be returned to `pending` (no acceptance).
  let queuedUserEntryAppended = false;

  // onEvent: translate backend events into existing SSE emit path
  const onEvent = async (event: ConversationBackendEvent): Promise<void> => {
    switch (event.type) {
      case "input_accepted": {
        if (!input.queuedDelivery || queuedUserEntryAppended) {
          break;
        }
        await safeAppendWithMeta(
          input.conversationId,
          buildUserTranscriptEntry(),
        );
        // Mark appended before the queue write so a `markQueuedDelivered`
        // failure cannot cause the entry to be appended twice.
        queuedUserEntryAppended = true;
        await deps.markQueuedDelivered({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          conversationId: input.conversationId,
          ids: input.queuedDelivery.messageIds,
          deliveryAttemptId: input.queuedDelivery.deliveryAttemptId,
        });
        logger.info("queue.accepted", {
          sessionName: input.sessionName,
          conversationId: input.conversationId,
          messageIds: input.queuedDelivery.messageIds,
          deliveryAttemptId: input.queuedDelivery.deliveryAttemptId,
        });
        break;
      }

      case "backend_init":
        runtimeState.sendToMachine?.({
          type: "BACKEND_INIT",
          backendRef: event.backendRef,
        });
        if (event.backendRef.backend === "codex") {
          pendingTranscriptWrites.push(
            safeAppendWithMeta(input.conversationId, {
              timestamp: new Date().toISOString(),
              type: "system",
              raw: {
                subtype: "init",
                backend: "codex",
                thread_id: event.backendRef.threadId,
              },
            }),
          );
        }
        break;

      case "content":
        contentBlocks.push(event.block);
        runtimeState.streamEmit?.("content", event.block);
        break;

      case "provider_event": {
        // Handle raw SDK messages for transcript writing and real-time SSE streaming
        const msg = event.payload as SDKMessage;

        // Send BACKEND_INIT event to machine on SDK init
        if (msg.type === "system") {
          const sysMsg = msg as SDKSystemMessage;
          if (sysMsg.subtype === "init" && sysMsg.session_id) {
            runtimeState.sendToMachine?.({
              type: "BACKEND_INIT",
              backendRef: {
                backend: "claude",
                sessionId: sysMsg.session_id,
              } as AgentSessionRef,
            });
          }
        }

        await processMessage(
          msg,
          input.conversationId,
          runtimeState.streamEmit ?? (() => {}),
          contentBlocks,
          safeAppendWithMeta,
        );
        break;
      }

      case "error":
        sawErrorEvent = true;
        runtimeState.streamEmit?.("error", { message: event.message });
        break;
    }
  };

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
  );

  const promptText =
    typeof effectivePrompt === "string"
      ? effectivePrompt
      : effectivePrompt
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("\n\n");

  let syntheticForkSeed: ConversationBackendTurnInput["syntheticForkSeed"] =
    undefined;

  if (shouldBuildRuntimeSyntheticSeed(input)) {
    syntheticForkSeed = await buildSyntheticForkSeed(
      input.transcriptPath!,
      input.forkedFrom!.messageIndex,
      { readConversationMessages: deps.readConversationMessages },
    );
    if (syntheticForkSeed) {
      logger.info("prompt.synthetic_fork", {
        sessionName: input.sessionName,
        backend: input.agentBackend,
        seedLength: syntheticForkSeed.length,
        messageIndex: input.forkedFrom!.messageIndex,
      });
    }
  }

  let turnResult: ConversationBackendTurnResult | undefined;
  let agentCallResult: AgentCallResult | undefined;

  async function drainClaudeCapabilityWhenIdle(): Promise<void> {
    if (input.agentBackend !== "claude") return;

    try {
      await deps.applyCapabilityWhenIdle(buildCapabilityApplyInput());
    } catch (err) {
      logger.error("prompt.capability_idle_drain_failed", {
        sessionName: input.sessionName,
        conversationId: input.conversationId,
        error: getErrorMessage(err),
      });
    }
  }

  try {
    if (!isNewRuntime) {
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
        const errorMessage = formatTurnStartMcpApplyFailure(mcpApplyResult);
        logger.warn("prompt.mcp_turn_start_failed", {
          sessionName: input.sessionName,
          backend: input.agentBackend,
          conversationId: input.conversationId,
          disposition: mcpApplyResult.disposition,
          error: mcpApplyResult.error,
        });
        runtimeState.streamEmit?.("error", { message: errorMessage });
        return {
          backendRef: null,
          costUsd: null,
          durationMs: null,
          numTurns: null,
          contextTokens: null,
          contextWindow: null,
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          contentBlocks: [],
          aborted: false,
          compacted: false,
          error: errorMessage,
        };
      }
    }

    try {
      logger.info("prompt.capability_turn_start_apply", {
        sessionName: input.sessionName,
        backend: input.agentBackend,
        conversationId: input.conversationId,
        isNewRuntime,
      });
      await deps.applyCapabilityAtTurnStart(buildCapabilityApplyInput());
    } catch (err) {
      logger.error("prompt.capability_turn_start_failed", {
        sessionName: input.sessionName,
        backend: input.agentBackend,
        conversationId: input.conversationId,
        error: getErrorMessage(err),
      });
    }

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
    // second failure fails the prompt BEFORE `streamInput` rather than
    // delivering it into a broken runtime. Backends without
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
        throw tagQuerySessionError(
          new Error(
            `Prompt not delivered: runtime unrecoverable (${retry.reason})`,
          ),
          QUERY_SESSION_ERROR_CODES.promptNotDelivered,
        );
      }
    }

    // Route the turn through the shared AgentCall primitive. The wrapped
    // runtime captures the underlying `ConversationBackendTurnResult` (the
    // existing actor downstream still needs `numTurns`, `contentBlocks`, and
    // other fields the primitive's normalized result drops) and handles the
    // undelivered-query-session retry loop in-place so observable behavior
    // matches the prior direct-`sendTurn` path.
    const turnDispatch = await dispatchTurnViaAgentCall({
      executeAgentCall: deps.executeAgentCall,
      getRuntime: () => backendRuntime!,
      replaceRuntime: recreateRuntimeForTurn,
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
    turnResult = turnDispatch.turnResult;
    agentCallResult = turnDispatch.agentCallResult;
    if (turnDispatch.thrown) {
      throw turnDispatch.thrown;
    }

    await drainClaudeCapabilityWhenIdle();
  } catch (err) {
    if (abortController.signal.aborted) {
      const abortReason = timeoutFired ? "timeout" : undefined;
      logger.info("prompt.aborted", {
        sessionName: input.sessionName,
        ...(abortReason !== undefined ? { abortReason } : {}),
        ...(timeoutFired ? { timeoutMs } : {}),
      });
      runtimeState.streamEmit?.("aborted", {
        message: timeoutFired
          ? `Prompt execution timed out after ${timeoutMs}ms`
          : "Prompt execution was cancelled",
      });
      return {
        backendRef: null,
        costUsd: null,
        durationMs: null,
        numTurns: null,
        contextTokens: null,
        contextWindow: null,
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        contentBlocks,
        aborted: true,
        compacted: false,
        ...(abortReason !== undefined ? { abortReason } : {}),
        ...(timeoutFired ? { timeoutMs } : {}),
        error: null,
      };
    }

    const errorMsg = getErrorMessage(err);
    logger.error("prompt.sdk_error", {
      sessionName: input.sessionName,
      error: errorMsg,
    });
    await drainClaudeCapabilityWhenIdle();
    runtimeState.streamEmit?.("error", { message: `SDK error: ${errorMsg}` });
    return {
      backendRef: null,
      costUsd: null,
      durationMs: null,
      numTurns: null,
      contextTokens: null,
      contextWindow: null,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      contentBlocks,
      aborted: false,
      compacted: false,
      error: errorMsg,
    };
  } finally {
    // Clear timeout
    if (runtimeState.timeoutHandle) {
      clearTimeout(runtimeState.timeoutHandle);
      runtimeState.timeoutHandle = undefined;
    }
    runtimeState.currentTurnAutonomous = undefined;
    runtimeState.currentTurnMessageId = undefined;
    deps.unregisterAbortController(input.conversationId);

    // Queued delivery that never reached backend acceptance (turn completed,
    // errored, or aborted before `input_accepted`): return the claimed batch to
    // `pending` so it is never silently lost (req 4.2). No transcript entry was
    // appended for it. All acceptance failures are treated as recoverable —
    // the turn result does not surface a terminal queue-acceptance signal, so
    // we never guess `failed` here (see CONCERNS).
    if (input.queuedDelivery && !queuedUserEntryAppended) {
      try {
        await deps.markQueuedPending({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          conversationId: input.conversationId,
          ids: input.queuedDelivery.messageIds,
          deliveryAttemptId: input.queuedDelivery.deliveryAttemptId,
          error: "queued delivery did not reach backend acceptance",
        });
        logger.info("queue.return_pending", {
          sessionName: input.sessionName,
          conversationId: input.conversationId,
          messageIds: input.queuedDelivery.messageIds,
          deliveryAttemptId: input.queuedDelivery.deliveryAttemptId,
        });
      } catch (err) {
        logger.error("queue.return_pending_failed", {
          sessionName: input.sessionName,
          conversationId: input.conversationId,
          messageIds: input.queuedDelivery.messageIds,
          deliveryAttemptId: input.queuedDelivery.deliveryAttemptId,
          error: getErrorMessage(err),
        });
      }
    }
  }

  await Promise.all(pendingTranscriptWrites);

  // Funnel structured-output extraction through the shared AgentCall gate.
  // `applyStructuredOutputGate` runs inside `executeAgentCall` whenever
  // `outputSchema` is present — it may parse `text` into a structuredOutput
  // value or downgrade a completed outcome to `failed` with
  // `failureKind: "schema_validation"`. The actor consumes that result so the
  // conversation_turn and task_run paths share one validation outcome.
  const gateCompletedOutcome =
    agentCallResult?.outcome.kind === "completed"
      ? agentCallResult.outcome
      : undefined;
  const gateSchemaValidationFailure =
    agentCallResult?.outcome.kind === "failed" &&
    agentCallResult.outcome.error.failureKind === "schema_validation"
      ? agentCallResult.outcome.error
      : undefined;
  const effectiveStructuredOutput =
    gateCompletedOutcome?.structuredOutput ?? turnResult?.structuredOutput;
  const effectiveError =
    gateSchemaValidationFailure?.message ?? turnResult?.error ?? null;

  if (effectiveError && !turnResult?.aborted && !sawErrorEvent) {
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

  // Post-turn transcript for non-Claude backends.
  // Claude writes transcript entries inline via provider_event → processMessage();
  // other backends emit content events that need explicit persistence.
  if (backendRuntime!.backend !== "claude" && turnResult) {
    const transcriptEntries = buildNonClaudeTranscriptEntries({
      backend: backendRuntime!.backend,
      backendRef: turnResult.backendRef,
      contentBlocks: turnResult.contentBlocks,
      turnResult,
      timestamp: new Date().toISOString(),
    });

    for (const entry of transcriptEntries) {
      await safeAppendWithMeta(input.conversationId, entry);
    }
  }

  // Persist a typed `debug_structured` block when a debug-mode turn produced
  // a structured output. Backend-agnostic — both Claude (SDK-validated) and
  // Codex (parsed JSON) reach here with structuredOutput populated. The block
  // merges with the preceding assistant text via readConversationMessages,
  // letting the renderer dispatch on `phase`. The value comes from the shared
  // gate when the gate ran (extraction may have parsed it from `text`), else
  // from the backend's natively-populated turnResult.
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

  // R8.4: record which charter version this conversation's turn ran with, for
  // stale detection. The runtime carries the version actually baked in. Only
  // attended normal-session turns are alignment-eligible, so project/optimistic/
  // autonomous turns leave the seen-version untouched.
  if (alignmentEligibleThisTurn && turnResult && backendRuntime) {
    await deps.mutateConversation(
      input.projectPath,
      input.sessionName,
      input.conversationId,
      "prompt.recordSeenAlignmentVersion",
      (c) => {
        c.lastSeenAlignmentVersion = backendRuntime!.alignmentVersion;
      },
    );
  }

  // Build result. structuredOutput and error come from the shared gate when
  // it ran; this ensures both streaming and task_run paths surface the same
  // validation outcome.
  const result: PromptActorResult = {
    backendRef: turnResult?.backendRef ?? null,
    costUsd: turnResult?.costUsd ?? null,
    durationMs: turnResult?.durationMs ?? null,
    numTurns: turnResult?.numTurns ?? null,
    contextTokens: turnResult?.contextTokens ?? null,
    contextWindow: turnResult?.contextWindowMax ?? null,
    inputTokens: agentCallResult?.usage.inputTokens ?? null,
    outputTokens: agentCallResult?.usage.outputTokens ?? null,
    cachedInputTokens: agentCallResult?.usage.cachedInputTokens ?? null,
    contentBlocks: turnResult?.contentBlocks ?? contentBlocks,
    structuredOutput: effectiveStructuredOutput,
    aborted: turnResult?.aborted ?? false,
    compacted: turnResult?.compacted ?? false,
    ...(turnResult?.aborted && timeoutFired
      ? { abortReason: "timeout" as const, timeoutMs }
      : {}),
    error: effectiveError,
    ...(turnResult?.backgroundWait !== undefined
      ? { backgroundWait: turnResult.backgroundWait }
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
 * `task_run` AgentCallRequest from the active turn, awaits the full
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

  const projectName =
    input.projectName || deps.getProjectDisplayName(input.projectPath);

  const broadcastMeta: TranscriptBroadcastMeta = {
    projectName,
    sessionName: input.sessionName,
  };

  const request: AgentCallRequest = {
    kind: "task_run",
    prompt: input.promptText,
    backend: input.agentBackend,
    writeCapability: "write_capable",
    ...(input.outputFormat?.type === "json_schema"
      ? { outputSchema: input.outputFormat.schema }
      : {}),
    ...(input.systemInstructions !== undefined
      ? { systemInstructions: input.systemInstructions }
      : {}),
    ...(input.tooling !== undefined ? { tooling: input.tooling } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  };

  const codexHardenedSettings =
    input.agentBackend === "codex"
      ? {
          sandboxMode: "danger-full-access" as const,
          approvalPolicy: "never" as const,
          webSearchMode: "disabled" as const,
          skipGitRepoCheck: true,
          networkAccessEnabled: true,
        }
      : {};

  const facadeDeps: AgentCallFacadeDeps = {
    resolveTaskRunner: () => ({
      runner: deps.getTaskRunner(input.agentBackend),
      capabilityView: capabilityViewForBackend(input.agentBackend),
      workingDirectory: input.worktreePath,
      autonomous: true,
      ...(input.modelId != null ? { modelId: input.modelId } : {}),
      ...(input.effort != null ? { reasoningEffort: input.effort } : {}),
      ...(input.backendRef !== null ? { resumeRef: input.backendRef } : {}),
      ...(input.timeoutMs !== undefined
        ? { defaultTimeoutMs: input.timeoutMs }
        : {}),
      ...codexHardenedSettings,
    }),
    ...(input.skipStructuredOutputGate
      ? { validateStructuredOutput: () => ({ valid: true }) }
      : {}),
  };

  logger.info("task_run.dispatch", {
    sessionName: input.sessionName,
    backend: input.agentBackend,
    conversationId: input.conversationId,
    hasOutputSchema: request.outputSchema !== undefined,
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
    return {
      backendRef: null,
      costUsd: null,
      durationMs: null,
      numTurns: null,
      contextTokens: null,
      contextWindow: null,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      contentBlocks: [],
      aborted: false,
      compacted: false,
      error: errorMsg,
    };
  }

  const usage = result.usage;
  const backendRef = result.backendRef ?? null;

  if (result.outcome.kind === "completed") {
    const text = result.outcome.text;
    const contentBlocks: MessageContentBlock[] = text
      ? [{ type: "text", text }]
      : [];

    if (contentBlocks.length > 0) {
      // For Codex, attach the threadId returned by the backend as turn
      // metadata on the assistant TranscriptMessage so downstream readers can
      // discover thread continuity from the transcript itself rather than
      // from a separate side artifact. Storing it here keeps `conversationId`
      // as the primary identity and treats the threadId as resumption hint.
      const rawMetadata =
        backendRef?.backend === "codex"
          ? { backend: "codex" as const, threadId: backendRef.threadId }
          : undefined;
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
): Promise<VerifyCleanupOutput> {
  const [{ verifyCleanupAgainstManifest, deleteManifest }] = await Promise.all([
    import("@/lib/debug-log/service"),
  ]);

  const verification = verifyCleanupAgainstManifest(
    input.worktreePath,
    input.conversationId,
    input.cleanup,
  );

  if (verification.ok) {
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
