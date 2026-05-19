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
  VerifyCleanupInput,
  VerifyCleanupOutput,
} from "./types";
import type {
  MessageContentBlock,
  ConversationState,
  SessionState,
  AgentBackendId,
  AgentSessionRef,
  ConversationBackendRuntime,
  ConversationBackendFactory,
  ConversationBackendTurnInput,
  ConversationBackendTurnResult,
  ConversationBackendEvent,
  ConversationImageRef,
  ImagePayload,
  AgentCapabilityRuntimeApplicationState,
} from "@/types";
import { assembleUserContentBlocks } from "./assemble-user-blocks";
import { buildUserTranscriptBlocks } from "./build-user-transcript-blocks";
import type {
  TranscriptEntry,
  TranscriptBroadcastMeta,
} from "@/lib/transcript";
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
  TDD_INSTRUCTIONS,
} from "@/lib/prompt";
import { isUndeliveredQuerySessionError } from "@/lib/agent-backends/claude/query-session-errors";
import { buildSyntheticForkSeed } from "@/lib/synthetic-fork-seed";
import { createExternalTurnHandler } from "./external-turn-handler";
import { createArtifactRegistry } from "@/lib/workflows/primitives/artifact-registry";
import { executeAgentCall as defaultExecuteAgentCall } from "@/lib/workflows/primitives/agent-call-facade";
import type {
  AgentCallRequest,
  AgentCallResult,
} from "@/lib/workflows/primitives/agent-call-vocabulary";
import type {
  AgentCallFacadeDeps,
  ConversationRuntimeResolution,
} from "@/lib/workflows/primitives/agent-call-facade";
import { capabilityViewForBackend } from "@/lib/workflows/primitives/backend-capabilities";
import { getDebugManifestPath } from "@/lib/debug-log";
import fs from "node:fs/promises";

const logger = createLogger("conversation-actor");

const FOCUS_MEMORY_DESCRIPTION =
  "Current work-in-progress and remaining tasks for this session";

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
    timeout?: number | null;
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

  // Transcript reading (for synthetic fork seed)
  readConversationMessages(
    transcriptPath: string | null,
  ): Promise<Array<{ role: string; content: MessageContentBlock[] }>>;

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
  applyCapabilityAtTurnStart(input: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    conversationId: string;
    worktreePath: string;
    backend: AgentBackendId;
  }): Promise<unknown>;

  /**
   * Drain any `staged-idle` Claude capability cascades after a turn completes
   * and the conversation transitions running → idle. No-op for Codex (no
   * idle-live-apply semantics). Failures are recorded as `rejected` per
   * cascade and surfaced via diagnostics; the previously applied hash is
   * preserved so retries can proceed.
   */
  applyCapabilityWhenIdle(input: {
    projectPath: string;
    projectName: string;
    sessionName: string;
    conversationId: string;
    worktreePath: string;
    backend: AgentBackendId;
  }): Promise<unknown>;

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
   * Execute a single conversation/task turn through the shared AgentCall
   * primitive. Production wires this to the real `executeAgentCall` facade;
   * tests inject a spy. Routing through this dep guarantees the conversation
   * actor never bypasses the primitive layer (cf. `executePromptForMachine`).
   */
  executeAgentCall(
    request: AgentCallRequest,
    facadeDeps: AgentCallFacadeDeps,
  ): Promise<AgentCallResult>;
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
    gatewayPortableConfigMod,
    defaultDepsMod,
    capabilitiesDepsMod,
  ] = await Promise.all([
    import("@/lib/lock"),
    import("@/lib/query-semaphore"),
    import("@/lib/transcript"),
    import("@/lib/config"),
    import("@/lib/transcript-images"),
    import("@/lib/agent-backends/registry"),
    import("@/lib/agent-backends/runtime-registry"),
    import("@/lib/child-env"),
    import("@/lib/commands"),
    import("@/lib/codex-tool"),
    import("@/lib/project-resolver"),
    import("@/lib/debug-log"),
    import("@/lib/state"),
    import("@/lib/abort-registry"),
    import("@/lib/mcp/compose-for-conversation"),
    import("@/lib/mcp/global-store"),
    import("@/lib/mcp/discovery"),
    import("@/lib/mcp-gateway/portable-config"),
    import("@/lib/mcp/default-deps"),
    import("@/lib/agent-capabilities/default-deps"),
  ]);

  const composePortableMcpForConversation =
    composeForConversationMod.createComposePortableMcpForConversation({
      readGlobalOverrides: () =>
        globalStoreMod.defaultGlobalOverrideStore.read(),
      readProjectOverrides: async (projectPath) => {
        const state = await stateMod.readState();
        return state.projects[projectPath]?.mcpOverrides;
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
      buildGatewayServers:
        gatewayPortableConfigMod.buildSessionToolsGatewayServers,
      buildReservedGatewayIds:
        gatewayPortableConfigMod.buildSessionToolsReservedIds,
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
    executeAgentCall: defaultExecuteAgentCall,
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
 * because the model, effort level, or outputFormat changed.
 */
export function shouldRecreateRuntime(
  runtime:
    | {
        status: string;
        modelId: unknown;
        reasoningEffort: unknown;
        outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
      }
    | undefined,
  effectiveModel: string | undefined,
  effectiveEffort: string | undefined,
  desiredOutputFormat?: {
    type: "json_schema";
    schema: Record<string, unknown>;
  },
): boolean {
  if (!runtime || runtime.status !== "alive") return false;
  const modelChanged = runtime.modelId !== effectiveModel;
  const effortChanged = runtime.reasoningEffort !== effectiveEffort;
  const outputFormatChanged = runtime.outputFormat !== desiredOutputFormat;
  return modelChanged || effortChanged || outputFormatChanged;
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

export function shouldRetryUndeliveredPrompt(
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

const CODEX_DEFAULT_TIMEOUT_S = 600;

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
 * Resolve the safety-net timeout for a turn based on the backend.
 * Returns 0 when the backend has no timeout (codex timeout: null).
 */
export function resolveBackendTimeoutMs(
  backend: AgentBackendId,
  config: ActorConfig,
): number {
  if (backend === "codex") {
    const timeout = config.codex?.timeout;
    if (timeout === null) return 0;
    if (timeout !== undefined) return timeout * 1000;
    return CODEX_DEFAULT_TIMEOUT_S * 1000;
  }
  return config.claudeTimeoutMs;
}

export function buildNonClaudeTranscriptEntries(input: {
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
      const blocks: MessageContentBlock[] = [];
      for (const block of asstMsg.message.content) {
        if (block.type === "text" && "text" in block) {
          const textBlock: MessageContentBlock = {
            type: "text",
            text: block.text,
          };
          blocks.push(textBlock);
          contentBlocks.push(textBlock);
          emit("content", textBlock);
        } else if (block.type === "tool_use" && "name" in block) {
          const toolBlock: MessageContentBlock = {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown> | undefined,
          };
          blocks.push(toolBlock);
          contentBlocks.push(toolBlock);
          emit("content", toolBlock);
        }
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
  outputFormat: ConversationBackendTurnInput["outputFormat"];
  onEvent: ConversationBackendTurnInput["onEvent"];
  syntheticForkSeed: ConversationBackendTurnInput["syntheticForkSeed"];
}

interface DispatchTurnViaAgentCallOutput {
  turnResult: ConversationBackendTurnResult | undefined;
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

  try {
    await input.executeAgentCall(request, facadeDeps);
  } catch (err) {
    pendingRetry = err as Error;
  }

  return {
    turnResult: captured,
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

  const broadcastMeta: TranscriptBroadcastMeta = {
    projectName,
    sessionName: input.sessionName,
  };
  const safeAppendWithMeta = (
    conversationId: string,
    entry: TranscriptEntry,
  ): Promise<void> =>
    deps.safeAppendTranscriptEntry(conversationId, entry, broadcastMeta);

  // Resolve backend-specific model and effort defaults
  const { effectiveModel, effectiveEffort } = resolveBackendTurnSettings(
    input.agentBackend,
    config,
    input.modelId,
    input.effort,
  );
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
        contentBlocks: [],
        aborted: false,
        error: errorMessage,
      };
    }
  }

  // Server-side image indexing: scan transcript for cumulative count, then
  // assemble inline+strip images into a coherent block sequence with rewritten
  // markers. Images are persisted to disk by serverIndex before dispatch so
  // the backend (and downstream readers) can refer to them by path.
  const startIndex =
    input.images && input.images.length > 0
      ? await deps.getNextImageIndex(input.conversationId)
      : 1;

  const assembled = assembleUserContentBlocks({
    promptText: input.promptText,
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

  const transcriptBlocks =
    imageRefs.length > 0
      ? buildUserTranscriptBlocks({
          rewrittenPromptText: assembled.rewrittenPromptText,
          imageRefs,
        })
      : input.promptText
        ? [{ type: "text" as const, text: input.promptText }]
        : [];

  // Persist user prompt in transcript
  await safeAppendWithMeta(input.conversationId, {
    timestamp: new Date().toISOString(),
    type: "user",
    role: "user",
    content: transcriptBlocks,
    model: effectiveModel ?? undefined,
    effort: effectiveEffort,
  });

  // ---------------------------------------------------------------
  // Get-or-create ConversationBackendRuntime
  // ---------------------------------------------------------------
  let backendRuntime = runtimeState.backendRuntime;

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

  // Close existing runtime if model, effort, or outputFormat changed
  if (
    backendRuntime &&
    shouldRecreateRuntime(
      backendRuntime,
      effectiveModel,
      effectiveEffort,
      input.outputFormat,
    )
  ) {
    const reason =
      effectiveModel != null && backendRuntime.modelId !== effectiveModel
        ? "model_changed"
        : effectiveEffort != null &&
            backendRuntime.reasoningEffort !== effectiveEffort
          ? "effort_changed"
          : "output_format_changed";
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

    await registerFocusMemoryIfPresent({
      worktreePath: input.worktreePath,
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      conversationId: input.conversationId,
      fileExists: deps.fileExists,
      registerReferenceDocument: deps.createReferenceDocument,
    });

    // Build reference documents system prompt section
    const referenceDocs = await deps.getReferenceDocuments(
      input.projectPath,
      input.sessionName,
    );
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

    // Build session instructions (baked into the runtime once)
    const sessionInstructions = [
      CC_CONTEXT,
      sessionState?.objective
        ? `<objective>${sessionState.objective}</objective>`
        : null,
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

    const claudeCapabilitySeed =
      input.agentBackend === "claude"
        ? await deps.composeClaudeCapabilityConfigForConversation({
            projectPath: input.projectPath,
            projectName,
            sessionName: input.sessionName,
            conversationId: input.conversationId,
            worktreePath: input.worktreePath,
          })
        : undefined;

    const codexCapabilitySeed =
      input.agentBackend === "codex"
        ? await deps.composeCodexCapabilityConfigForConversation({
            projectPath: input.projectPath,
            projectName,
            sessionName: input.sessionName,
            conversationId: input.conversationId,
            worktreePath: input.worktreePath,
          })
        : undefined;

    const claudeCapabilityConfig = claudeCapabilitySeed?.config;
    const codexCapabilityConfig = codexCapabilitySeed?.config;
    const capabilityRuntimeStateSeed =
      claudeCapabilitySeed?.runtimeState ?? codexCapabilitySeed?.runtimeState;

    logger.info("prompt.runtime_create", {
      sessionName: input.sessionName,
      backend: input.agentBackend,
      conversationId: input.conversationId,
      claudeCapabilityConfigSeeded: claudeCapabilityConfig !== undefined,
      codexCapabilityConfigSeeded: codexCapabilityConfig !== undefined,
    });

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
            ? (port) => deps.applyCapabilityWhenIdle(port)
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
  const abortController = runtimeState.abortController;
  deps.registerAbortController(input.conversationId, abortController);

  const timeoutMs = resolveBackendTimeoutMs(input.agentBackend, config);
  if (timeoutMs > 0) {
    runtimeState.timeoutHandle = setTimeout(() => {
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

  // onEvent: translate backend events into existing SSE emit path
  const onEvent = async (event: ConversationBackendEvent): Promise<void> => {
    switch (event.type) {
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

  async function drainClaudeCapabilityWhenIdle(): Promise<void> {
    if (input.agentBackend !== "claude") return;

    try {
      await deps.applyCapabilityWhenIdle({
        projectPath: input.projectPath,
        projectName,
        sessionName: input.sessionName,
        conversationId: input.conversationId,
        worktreePath: input.worktreePath,
        backend: input.agentBackend,
      });
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
          contentBlocks: [],
          aborted: false,
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
      await deps.applyCapabilityAtTurnStart({
        projectPath: input.projectPath,
        projectName,
        sessionName: input.sessionName,
        conversationId: input.conversationId,
        worktreePath: input.worktreePath,
        backend: input.agentBackend,
      });
    } catch (err) {
      logger.error("prompt.capability_turn_start_failed", {
        sessionName: input.sessionName,
        backend: input.agentBackend,
        conversationId: input.conversationId,
        error: getErrorMessage(err),
      });
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
      replaceRuntime: async () => {
        backendRuntime?.close();
        deps.unregisterBackendRuntime(input.conversationId);
        backendRuntime = await createManagedBackendRuntime();
        return backendRuntime;
      },
      signal: abortController.signal,
      conversationId: input.conversationId,
      sessionName: input.sessionName,
      backend: input.agentBackend,
      promptText,
      imageRefs: imageRefs.length > 0 ? imageRefs : undefined,
      modelId: effectiveModel,
      reasoningEffort: effectiveEffort,
      autonomous: input.autonomous ?? false,
      outputFormat: input.outputFormat,
      onEvent,
      syntheticForkSeed,
    });
    turnResult = turnDispatch.turnResult;
    if (turnDispatch.thrown) {
      throw turnDispatch.thrown;
    }

    await drainClaudeCapabilityWhenIdle();
  } catch (err) {
    if (abortController.signal.aborted) {
      logger.info("prompt.aborted", { sessionName: input.sessionName });
      runtimeState.streamEmit?.("aborted", {
        message: "Prompt execution was cancelled",
      });
      return {
        backendRef: null,
        costUsd: null,
        durationMs: null,
        numTurns: null,
        contextTokens: null,
        contextWindow: null,
        contentBlocks,
        aborted: true,
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
      contentBlocks,
      aborted: false,
      error: errorMsg,
    };
  } finally {
    // Clear timeout
    if (runtimeState.timeoutHandle) {
      clearTimeout(runtimeState.timeoutHandle);
      runtimeState.timeoutHandle = undefined;
    }
    runtimeState.currentTurnAutonomous = undefined;
    deps.unregisterAbortController(input.conversationId);
  }

  await Promise.all(pendingTranscriptWrites);

  if (turnResult?.error && !turnResult.aborted && !sawErrorEvent) {
    logger.warn("prompt.turn_error_fallback_emitted", {
      sessionName: input.sessionName,
      backend: input.agentBackend,
      message: turnResult.error,
    });
    runtimeState.streamEmit?.("error", { message: turnResult.error });
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
  // letting the renderer dispatch on `phase`.
  if (
    input.debugMode?.active === true &&
    turnResult?.structuredOutput != null &&
    !turnResult.error
  ) {
    await safeAppendWithMeta(input.conversationId, {
      timestamp: new Date().toISOString(),
      type: "assistant",
      role: "assistant",
      content: [
        {
          type: "debug_structured",
          phase: input.debugMode.phase,
          payload: turnResult.structuredOutput,
        },
      ],
    });
  }

  // Build result
  const result: PromptActorResult = {
    backendRef: turnResult?.backendRef ?? null,
    costUsd: turnResult?.costUsd ?? null,
    durationMs: turnResult?.durationMs ?? null,
    numTurns: turnResult?.numTurns ?? null,
    contextTokens: turnResult?.contextTokens ?? null,
    contextWindow: turnResult?.contextWindowMax ?? null,
    contentBlocks: turnResult?.contentBlocks ?? contentBlocks,
    structuredOutput: turnResult?.structuredOutput,
    aborted: turnResult?.aborted ?? false,
    error: turnResult?.error ?? null,
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
 * Cross-checks the agent's cleanup result against the persisted manifest.
 * On a passing verification the manifest is deleted; on failure the
 * structured remediation prompt is returned so the machine can route to
 * `debug.error` and let the user re-run cleanup.
 */
export async function verifyCleanupForMachine(
  input: VerifyCleanupInput,
): Promise<VerifyCleanupOutput> {
  const [{ verifyCleanupAgainstManifest, deleteManifest }] = await Promise.all([
    import("@/lib/debug-log"),
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
