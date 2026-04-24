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
  AskQuestionItem,
} from "@/types";
import type { TranscriptEntry } from "@/lib/transcript";
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
import { randomUUID } from "node:crypto";
import {
  conversationRuntimeKey,
  getConversationRuntime,
  type ConversationRuntimeState,
} from "./runtime-state";
import { createLogger } from "@/lib/logging";
import {
  DEBUG_MODE_INSTRUCTIONS,
  DEBUG_PHASE_CONTEXT,
  CC_CONTEXT,
  TDD_INSTRUCTIONS,
} from "@/lib/prompt";
import { isUndeliveredQuerySessionError } from "@/lib/agent-backends/claude/query-session-errors";
import { createExternalTurnHandler } from "./external-turn-handler";

const logger = createLogger("conversation-actor");

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
  acquireSessionLock(projectPath: string, sessionName: string): () => void;
  acquireQuerySlot(label: string): Promise<() => void>;
  getTranscriptPath(conversationId: string): Promise<string>;

  // Config & project
  readConfig(): Promise<ActorConfig>;
  getProjectDisplayName(projectPath: string): string;
  getDebugLogUrl(conversationId: string): string;

  // Transcript I/O
  safeAppendTranscriptEntry(
    conversationId: string,
    entry: TranscriptEntry,
  ): Promise<void>;
  externalizeImageBlocks(
    conversationId: string,
    blocks: MessageContentBlock[],
  ): Promise<MessageContentBlock[]>;

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

  // Reference documents
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
      buildGatewayServers: (projectName, sessionName) =>
        gatewayPortableConfigMod.buildSessionToolsPortableMcp(
          projectName,
          sessionName,
        ).servers,
    });

  return {
    acquireSessionLock: lockMod.acquireSessionLock,
    acquireQuerySlot: semaphoreMod.acquireQuerySlot,
    getTranscriptPath: transcriptMod.getTranscriptPath,
    readConfig: configMod.readConfig,
    safeAppendTranscriptEntry: transcriptMod.safeAppendTranscriptEntry,
    externalizeImageBlocks: transcriptImagesMod.externalizeImageBlocks,
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
      ).replaceAll("{DEBUG_LOG_FILE_PATH}", debugMode.logFilePath);
    } else {
      prefix = DEBUG_PHASE_CONTEXT[debugMode.phase] ?? "";
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
// Synthetic fork seed
// ============================================================

/**
 * Build a text seed from the transcript up to the fork point so backends
 * without native fork support can receive prior conversation context.
 */
const SYNTHETIC_FORK_MAX_CHARS = 24_000;
const SYNTHETIC_FORK_TRUNCATION_PREFIX = "[truncated historical context]\n\n";

async function buildSyntheticForkSeed(
  deps: ActorImplementationDeps,
  transcriptPath: string,
  messageIndex: number,
): Promise<string | null> {
  try {
    const messages = await deps.readConversationMessages(transcriptPath);
    const forkSlice = messages.slice(0, messageIndex + 1);
    if (forkSlice.length === 0) return null;

    const blocks: string[] = [];
    for (const msg of forkSlice) {
      const role = msg.role === "user" ? "User" : "Assistant";
      const textParts = msg.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text);
      if (textParts.length > 0) {
        blocks.push(`${role}: ${textParts.join("\n")}`);
      }
    }

    const header =
      "The following is the conversation history up to the fork point. Continue from here:\n";
    let body = blocks.join("\n\n");

    if (header.length + body.length > SYNTHETIC_FORK_MAX_CHARS) {
      const budget =
        SYNTHETIC_FORK_MAX_CHARS -
        header.length -
        SYNTHETIC_FORK_TRUNCATION_PREFIX.length;
      body = SYNTHETIC_FORK_TRUNCATION_PREFIX + body.slice(-budget);
    }

    return header + "\n" + body;
  } catch (err) {
    logger.warn("prompt.synthetic_fork_failed", {
      transcriptPath,
      error: getErrorMessage(err),
    });
    return null;
  }
}

// ============================================================
// Backend runtime creation
// ============================================================

/**
 * Build an onAskQuestion callback that bridges between the backend runtime
 * and the conversation machine's question flow.
 */
function buildOnAskQuestion(
  runtimeState: ConversationRuntimeState,
  identity: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
  },
  mutateConversation: ActorImplementationDeps["mutateConversation"],
): (questions: AskQuestionItem[]) => Promise<Record<string, string>> {
  return async (
    questions: AskQuestionItem[],
  ): Promise<Record<string, string>> => {
    const questionId = randomUUID();

    // Send ASK_QUESTION event to the machine
    runtimeState.sendToMachine?.({
      type: "ASK_QUESTION",
      questionId,
      questions,
    });

    // Persist question state (for crash recovery)
    await mutateConversation(
      identity.projectPath,
      identity.sessionName,
      identity.conversationId,
      "prompt.setWaitingForInput",
      (c) => {
        c.status = "waiting_for_input";
        c.pendingQuestionId = questionId;
        c.pendingQuestions = questions as typeof c.pendingQuestions;
      },
    ).catch(() => {});

    // Emit on prompt stream for SSE
    runtimeState.streamEmit?.("ask-question", { questionId, questions });

    // Block until user answers — use deferred promise from runtime
    const answers = await new Promise<Record<string, string>>(
      (resolve, reject) => {
        runtimeState.activeQuestionResolver = { resolve, reject };
      },
    );

    // Restore running status
    await mutateConversation(
      identity.projectPath,
      identity.sessionName,
      identity.conversationId,
      "prompt.resumeRunning",
      (c) => {
        c.status = "running";
        c.pendingQuestionId = null;
        c.pendingQuestions = null;
      },
    ).catch(() => {});

    return answers;
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

  // Acquire session lock (throws if already busy) — skip for validator
  // conversations that run within an already-locked session
  if (!runtime.skipSessionLock) {
    const releaseSessionLock = deps.acquireSessionLock(
      input.projectPath,
      input.sessionName,
    );
    runtime.releaseSessionLock = releaseSessionLock;
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
 * - Constructs ConversationBackendTurnInput with onEvent/onAskQuestion callbacks
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

  const config = await deps.readConfig();
  const projectName =
    input.projectName || deps.getProjectDisplayName(input.projectPath);

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

  // Build user content blocks
  const userContentBlocks: MessageContentBlock[] = [
    ...(input.promptText
      ? [{ type: "text" as const, text: input.promptText }]
      : []),
    ...(input.images ?? []).map((img) => ({
      type: "image" as const,
      mediaType: img.mediaType,
      base64Data: img.base64Data,
    })),
  ];

  // Externalize images for transcript storage
  const transcriptBlocks = input.images?.length
    ? await deps.externalizeImageBlocks(input.conversationId, userContentBlocks)
    : userContentBlocks;

  // Persist user prompt in transcript
  await deps.safeAppendTranscriptEntry(input.conversationId, {
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

    // Auto-register focus.md as a reference document
    const focusPath = `${input.worktreePath}/memory-bank/focus.md`;
    if (deps.fileExists(focusPath)) {
      await deps.createReferenceDocument(
        input.projectPath,
        input.sessionName,
        "memory-bank/focus.md",
        "Current work-in-progress and remaining tasks for this session",
      );
    }

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

    logger.info("prompt.runtime_create", {
      sessionName: input.sessionName,
      backend: input.agentBackend,
      conversationId: input.conversationId,
    });

    const externalTurnHandler = createExternalTurnHandler(
      {
        projectPath: input.projectPath,
        projectName,
        sessionName: input.sessionName,
        conversationId: input.conversationId,
      },
      {
        sendToMachine: (event) => runtimeState.sendToMachine?.(event),
      },
      { safeAppendTranscriptEntry: deps.safeAppendTranscriptEntry },
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
      },
      onExternalTurnEvent: externalTurnHandler,
    });

    // Register in runtime-registry and local state
    deps.registerBackendRuntime(input.conversationId, newRuntime);
    runtimeState.backendRuntime = newRuntime;
    backendRuntime = newRuntime;
    await seedRuntimeMcpState(portableMcp);

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
      backendRuntime?.close();
      abortController.abort();
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
            deps.safeAppendTranscriptEntry(input.conversationId, {
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
          deps.safeAppendTranscriptEntry,
        );
        break;
      }

      case "error":
        sawErrorEvent = true;
        runtimeState.streamEmit?.("error", { message: event.message });
        break;
    }
  };

  // onAskQuestion: bridges question flow between backend and machine
  const onAskQuestion = input.autonomous
    ? undefined
    : buildOnAskQuestion(
        runtimeState,
        {
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          conversationId: input.conversationId,
        },
        deps.mutateConversation,
      );

  // Prepend debug mode instructions
  const effectivePrompt = buildEffectivePrompt(
    input.promptText,
    (input.images?.length ?? 0) > 0,
    userContentBlocks,
    input.debugMode,
    deps.getDebugLogUrl(input.conversationId),
  );

  // Determine prompt text — backend receives string, images are separate
  const promptText =
    typeof effectivePrompt === "string"
      ? effectivePrompt
      : effectivePrompt
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("\n\n");

  // Determine fork params
  let nativeFork: ConversationBackendTurnInput["nativeFork"] = undefined;
  let syntheticForkSeed: ConversationBackendTurnInput["syntheticForkSeed"] =
    undefined;

  if (input.forkedFrom && !input.backendRef) {
    // First turn of a forked conversation
    const sourceRef = input.forkedFrom.sourceBackendRef ?? undefined;
    const locator = input.forkedFrom.forkLocator ?? null;

    if (backendRuntime!.capabilities.preciseFork && sourceRef) {
      logger.info("prompt.native_fork", {
        sessionName: input.sessionName,
        sourceRef,
        forkLocator: locator,
      });
      nativeFork = { sourceRef, forkLocator: locator };
    } else {
      // Backend doesn't support precise fork — synthesize context from transcript
      syntheticForkSeed = await buildSyntheticForkSeed(
        deps,
        input.transcriptPath,
        input.forkedFrom.messageIndex,
      );
      if (syntheticForkSeed) {
        logger.info("prompt.synthetic_fork", {
          sessionName: input.sessionName,
          seedLength: syntheticForkSeed.length,
          messageIndex: input.forkedFrom.messageIndex,
        });
      }
    }
  }

  let turnResult: ConversationBackendTurnResult | undefined;

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

    let deliveryAttempt = 0;

    while (true) {
      try {
        turnResult = await backendRuntime!.sendTurn({
          promptText,
          images: input.images,
          sessionInstructions: [], // Already baked into the runtime
          modelId: effectiveModel,
          reasoningEffort: effectiveEffort,
          autonomous: input.autonomous,
          outputFormat: input.outputFormat,
          signal: abortController.signal,
          onEvent,
          onAskQuestion,
          nativeFork,
          syntheticForkSeed,
        });
        break;
      } catch (err) {
        if (
          !shouldRetryUndeliveredPrompt(
            err,
            backendRuntime,
            abortController.signal,
            deliveryAttempt,
          )
        ) {
          throw err;
        }

        deliveryAttempt += 1;
        logger.warn("prompt.runtime_retry", {
          sessionName: input.sessionName,
          conversationId: input.conversationId,
          attempt: deliveryAttempt,
          error: getErrorMessage(err),
        });

        backendRuntime?.close();
        deps.unregisterBackendRuntime(input.conversationId);
        backendRuntime = await createManagedBackendRuntime();
      }
    }
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
      await deps.safeAppendTranscriptEntry(input.conversationId, entry);
    }
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
