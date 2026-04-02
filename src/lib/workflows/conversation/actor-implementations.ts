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
} from "@/types";
import type { TranscriptEntry } from "@/lib/transcript";
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

const logger = createLogger("conversation-actor");

// ============================================================
// Minimal types for deps interface
// ============================================================

/** Subset of QuerySession properties used by actor implementations. */
export interface QuerySessionLike {
  status: "alive" | "dead";
  model: unknown;
  effort: unknown;
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  close(): void;
  sendPrompt(
    prompt: string | MessageContentBlock[],
    emit: (event: string, data: unknown) => void,
    options?: Record<string, unknown>,
  ): Promise<
    | {
        sessionId: string | null;
        costUsd: number | null;
        durationMs: number | null;
        numTurns: number | null;
        contextTokens: number | null;
        contextWindow: number | null;
        contentBlocks: MessageContentBlock[];
        structuredOutput?: unknown;
        aborted: boolean;
        error: string | null;
      }
    | undefined
  >;
  query: unknown;
}

/** Subset of GlobalConfig properties used by actor implementations. */
export interface ActorConfig {
  defaultModel?: string;
  claudeTimeoutMs: number;
  maxTurns: number;
  idleQuerySessionTtlMs: number;
  pushNotification?: unknown;
  codex?: unknown;
}

export type CanUseToolResult =
  | { behavior: "deny"; message: string }
  | { behavior: "allow"; updatedInput: Record<string, unknown> };

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

  // SDK session lifecycle
  getSessionFromRegistry(conversationId: string): QuerySessionLike | undefined;
  createQuerySession(options: Record<string, unknown>): QuerySessionLike;
  buildChildEnv(): NodeJS.ProcessEnv;
  resolvePluginPaths(): Promise<Array<{ name: string; path: string }>>;

  // MCP tool factories
  createNotificationToolServer(
    context: Record<string, unknown>,
    deps: Record<string, unknown>,
  ): unknown;
  createRoadmapToolServer(context: Record<string, unknown>): unknown;
  createWiredPlannerToolServer(
    context: Record<string, unknown>,
    wireDeps: Record<string, unknown>,
  ): unknown;
  createReferenceDocumentToolServer(context: Record<string, unknown>): unknown;
  maybeCreateCodexToolServer(
    config: unknown,
    context: Record<string, unknown>,
  ): unknown;
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

  // Lifecycle registries
  registerAbortController(
    conversationId: string,
    controller: AbortController,
  ): void;
  unregisterAbortController(conversationId: string): void;
  registerQuery(conversationId: string, q: unknown): void;
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
    querySessionRegistryMod,
    querySessionMod,
    childEnvMod,
    commandsMod,
    notificationToolMod,
    roadmapToolsMod,
    referenceDocumentToolsMod,
    codexToolMod,
    plannerToolsMod,
    projectResolverMod,
    debugLogMod,
    queryRegistryMod,
    stateMod,
    abortRegistryMod,
  ] = await Promise.all([
    import("@/lib/lock"),
    import("@/lib/query-semaphore"),
    import("@/lib/transcript"),
    import("@/lib/config"),
    import("@/lib/transcript-images"),
    import("@/lib/query-session-registry"),
    import("@/lib/query-session"),
    import("@/lib/child-env"),
    import("@/lib/commands"),
    import("@/lib/agent-notification-tool"),
    import("@/lib/roadmap-tools"),
    import("@/lib/reference-document-tools"),
    import("@/lib/codex-tool"),
    import("@/lib/workflow-graph/planner-tools"),
    import("@/lib/project-resolver"),
    import("@/lib/debug-log"),
    import("@/lib/query-registry"),
    import("@/lib/state"),
    import("@/lib/abort-registry"),
  ]);

  return {
    acquireSessionLock: lockMod.acquireSessionLock,
    acquireQuerySlot: semaphoreMod.acquireQuerySlot,
    getTranscriptPath: transcriptMod.getTranscriptPath,
    readConfig: configMod.readConfig,
    safeAppendTranscriptEntry: transcriptMod.safeAppendTranscriptEntry,
    externalizeImageBlocks: transcriptImagesMod.externalizeImageBlocks,
    getSessionFromRegistry: querySessionRegistryMod.getSession,
    createQuerySession: querySessionMod.createQuerySession,
    buildChildEnv: childEnvMod.buildChildEnv,
    resolvePluginPaths: commandsMod.resolvePluginPaths,
    createNotificationToolServer:
      notificationToolMod.createNotificationToolServer,
    createRoadmapToolServer: roadmapToolsMod.createRoadmapToolServer,
    createWiredPlannerToolServer: plannerToolsMod.createWiredPlannerToolServer,
    createReferenceDocumentToolServer:
      referenceDocumentToolsMod.createReferenceDocumentToolServer,
    maybeCreateCodexToolServer: codexToolMod.maybeCreateCodexToolServer,
    getCodexToolPromptHint: codexToolMod.getCodexToolPromptHint,
    getProjectDisplayName: projectResolverMod.getProjectDisplayName,
    getDebugLogUrl: debugLogMod.getDebugLogUrl,
    registerQuery: queryRegistryMod.registerQuery,
    mutateConversation: stateMod.mutateConversation,
    getSessionState: stateMod.getSession,
    createReferenceDocument: stateMod.createReferenceDocument,
    getReferenceDocuments: stateMod.getReferenceDocuments,
    fileExists: (await import("node:fs")).existsSync,
    registerAbortController: abortRegistryMod.registerAbortController,
    unregisterAbortController: abortRegistryMod.unregisterAbortController,
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
 * Determine whether an existing QuerySession should be closed and recreated
 * because the model, effort level, or outputFormat changed.
 */
export function shouldRecreateSession(
  session:
    | {
        status: string;
        model: unknown;
        effort: unknown;
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
  if (!session || session.status !== "alive") return false;
  const modelChanged =
    effectiveModel != null && session.model !== effectiveModel;
  const effortChanged =
    effectiveEffort != null && session.effort !== effectiveEffort;
  const outputFormatChanged = session.outputFormat !== desiredOutputFormat;
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
      // First debug turn: full instructions
      prefix = DEBUG_MODE_INSTRUCTIONS.replaceAll(
        "{DEBUG_LOG_URL}",
        debugLogUrl,
      ).replaceAll("{DEBUG_LOG_FILE_PATH}", debugMode.logFilePath);
    } else {
      // Subsequent turns: phase-specific context
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

/**
 * Build the canUseTool callback for the SDK QuerySession.
 * Handles AskUserQuestion (blocking for user input or denying in autonomous mode).
 */
export function buildCanUseTool(
  runtime: ConversationRuntimeState,
  identity: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
  },
  autonomous: boolean,
  mutateConversation: ActorImplementationDeps["mutateConversation"],
): (
  toolName: string,
  toolInput: Record<string, unknown>,
) => Promise<CanUseToolResult> {
  return async (
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<CanUseToolResult> => {
    if (toolName === "AskUserQuestion") {
      if (autonomous) {
        return {
          behavior: "deny" as const,
          message:
            "Autonomous optimistic mode — make your best judgment and proceed without asking questions.",
        };
      }

      const questions = toolInput.questions;
      if (!questions || !Array.isArray(questions)) {
        return { behavior: "allow" as const, updatedInput: toolInput };
      }

      const questionId = randomUUID();

      // Send ASK_QUESTION event to the machine
      runtime.sendToMachine?.({
        type: "ASK_QUESTION",
        questionId,
        questions,
      });

      // Also persist question state (for crash recovery)
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
      runtime.streamEmit?.("ask-question", { questionId, questions });

      // Block until user answers — use deferred promise from runtime
      const answers = await new Promise<Record<string, string>>(
        (resolve, reject) => {
          runtime.activeQuestionResolver = { resolve, reject };
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

      return {
        behavior: "allow" as const,
        updatedInput: { ...toolInput, answers },
      };
    }

    return { behavior: "allow" as const, updatedInput: toolInput };
  };
}

// ============================================================
// Message processing
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
 * Execute a prompt via the Claude Agent SDK.
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

  const config = await deps.readConfig();
  const projectName =
    input.projectName || deps.getProjectDisplayName(input.projectPath);

  // Resolve model and effort
  const effectiveModel = input.modelId ?? config.defaultModel;
  const effectiveEffort = input.effort ?? undefined;

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
  // Get-or-create QuerySession
  // ---------------------------------------------------------------
  let querySession = deps.getSessionFromRegistry(input.conversationId);

  // Close existing session if model, effort, or outputFormat changed
  if (
    querySession &&
    shouldRecreateSession(
      querySession,
      effectiveModel,
      effectiveEffort,
      input.outputFormat,
    )
  ) {
    const reason =
      effectiveModel != null && querySession.model !== effectiveModel
        ? "model_changed"
        : effectiveEffort != null && querySession.effort !== effectiveEffort
          ? "effort_changed"
          : "output_format_changed";
    logger.info("prompt.session_recreate", {
      sessionName: input.sessionName,
      reason,
    });
    querySession.close();
    querySession = undefined;
  }

  const isNewSession = !querySession || querySession.status === "dead";

  if (isNewSession) {
    const sessionState = await deps.getSessionState(
      input.projectPath,
      input.sessionName,
    );

    const pushConfig = config.pushNotification as
      | { enabled?: boolean; topic?: string }
      | undefined;
    const notificationToolEnabled = pushConfig?.enabled && pushConfig?.topic;
    const notificationToolServer = notificationToolEnabled
      ? deps.createNotificationToolServer(
          { projectName, sessionName: input.sessionName },
          {
            sendNotification: async (
              title: string,
              message: string,
              tags: string,
            ) => {
              const { sendAgentNotification } =
                await import("@/lib/push-notification");
              await sendAgentNotification(
                config.pushNotification as never,
                title,
                message,
                tags,
                projectName,
                input.sessionName,
              );
            },
          },
        )
      : null;

    const codexToolServer = deps.maybeCreateCodexToolServer(config.codex, {
      worktreePath: input.worktreePath,
      sessionName: input.sessionName,
    });

    const pluginPaths = await deps.resolvePluginPaths();
    const sdkPlugins = pluginPaths.map((p) => ({
      type: "local" as const,
      path: p.path,
    }));

    // Build canUseTool callback
    const canUseTool = buildCanUseTool(
      runtime,
      {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        conversationId: input.conversationId,
      },
      input.autonomous,
      deps.mutateConversation,
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

    // Build system prompt append
    const systemPromptParts =
      [
        CC_CONTEXT,
        sessionState?.objective
          ? `<objective>${sessionState.objective}</objective>`
          : null,
        sessionState?.tddEnabled ? TDD_INSTRUCTIONS : null,
        deps.getCodexToolPromptHint(codexToolServer != null),
        referenceDocsPrompt,
      ]
        .filter(Boolean)
        .join("\n\n") || undefined;

    querySession = deps.createQuerySession({
      conversationId: input.conversationId,
      cwd: input.worktreePath,
      model: effectiveModel ?? undefined,
      effort: effectiveEffort,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: systemPromptParts,
      },
      resume:
        input.claudeSessionId ??
        input.forkedFrom?.sourceClaudeSessionId ??
        undefined,
      forkSession:
        input.forkedFrom != null && input.claudeSessionId == null
          ? true
          : undefined,
      resumeSessionAt:
        input.forkedFrom != null &&
        input.claudeSessionId == null &&
        input.forkedFrom.forkPointAssistantUuid != null
          ? input.forkedFrom.forkPointAssistantUuid
          : undefined,
      mcpServers: {
        ...(notificationToolServer
          ? { "agent-notification": notificationToolServer }
          : {}),
        ...(codexToolServer ? { "codex-tool": codexToolServer } : {}),
        "roadmap-tools": deps.createRoadmapToolServer({
          projectPath: input.projectPath,
        }),
        "graph-workflow-planner": deps.createWiredPlannerToolServer(
          {
            projectPath: input.projectPath,
            sessionName: input.sessionName,
          },
          {
            readConfig: deps.readConfig,
            getSession: deps.getSessionState,
          },
        ),
        "reference-document-tools": deps.createReferenceDocumentToolServer({
          projectPath: input.projectPath,
          sessionName: input.sessionName,
          worktreePath: input.worktreePath,
        }),
        ...(runtime.additionalMcpServers ?? {}),
      },
      canUseTool: canUseTool as never,
      env: { ...deps.buildChildEnv(), CLAUDECODE: "" },
      maxTurns: config.maxTurns,
      plugins: sdkPlugins,
      settingSources: ["user", "project", "local"],
      disallowedTools: ["EnterPlanMode", "ExitPlanMode"],
      idleTtlMs: config.idleQuerySessionTtlMs,
      ...(input.outputFormat ? { outputFormat: input.outputFormat } : {}),
    });

    // Register raw Query for backward compat (queueMessage)
    deps.registerQuery(input.conversationId, querySession.query);
  }

  // Store the session in runtime for reuse
  runtime.querySession = querySession;

  // ---------------------------------------------------------------
  // Safety-net timeout
  // ---------------------------------------------------------------
  const abortController = runtime.abortController;
  deps.registerAbortController(input.conversationId, abortController);

  runtime.timeoutHandle = setTimeout(() => {
    logger.warn("prompt.timeout", {
      sessionName: input.sessionName,
      timeoutMs: config.claudeTimeoutMs,
    });
    querySession?.close();
    abortController.abort();
  }, config.claudeTimeoutMs);

  // ---------------------------------------------------------------
  // Process messages and send prompt
  // ---------------------------------------------------------------
  const contentBlocks: MessageContentBlock[] = [];

  const turnEmit = async (event: string, data: unknown) => {
    if (event === "__raw_message") {
      const msg = data as SDKMessage;

      // Send SDK_INIT event to machine for session ID capture
      if (msg.type === "system") {
        const sysMsg = msg as SDKSystemMessage;
        if (sysMsg.subtype === "init" && sysMsg.session_id) {
          runtime.sendToMachine?.({
            type: "SDK_INIT",
            sessionId: sysMsg.session_id,
          });
        }
      }

      await processMessage(
        msg,
        input.conversationId,
        runtime.streamEmit ?? (() => {}),
        contentBlocks,
        deps.safeAppendTranscriptEntry,
      );
      return;
    }
    runtime.streamEmit?.(event, data);
  };

  // Prepend debug mode instructions on first debug turn
  const effectivePrompt = buildEffectivePrompt(
    input.promptText,
    (input.images?.length ?? 0) > 0,
    userContentBlocks,
    input.debugMode,
    deps.getDebugLogUrl(input.conversationId),
  );

  let turnResult:
    | {
        sessionId: string | null;
        costUsd: number | null;
        durationMs: number | null;
        numTurns: number | null;
        contextTokens: number | null;
        contextWindow: number | null;
        contentBlocks: MessageContentBlock[];
        structuredOutput?: unknown;
        aborted: boolean;
        error: string | null;
      }
    | undefined;

  try {
    turnResult = await querySession!.sendPrompt(effectivePrompt, turnEmit, {
      autonomous: input.autonomous,
      ...(input.outputFormat ? { outputFormat: input.outputFormat } : {}),
    });
  } catch (err) {
    if (abortController.signal.aborted) {
      logger.info("prompt.aborted", { sessionName: input.sessionName });
      runtime.streamEmit?.("aborted", {
        message: "Prompt execution was cancelled",
      });
      return {
        sessionId: null,
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

    const errorMsg = err instanceof Error ? err.message : "Unknown SDK error";
    logger.error("prompt.sdk_error", {
      sessionName: input.sessionName,
      error: errorMsg,
    });
    runtime.streamEmit?.("error", { message: `SDK error: ${errorMsg}` });
    return {
      sessionId: null,
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
    if (runtime.timeoutHandle) {
      clearTimeout(runtime.timeoutHandle);
      runtime.timeoutHandle = undefined;
    }
    deps.unregisterAbortController(input.conversationId);
  }

  // Build result
  const result: PromptActorResult = {
    sessionId: turnResult?.sessionId ?? null,
    costUsd: turnResult?.costUsd ?? null,
    durationMs: turnResult?.durationMs ?? null,
    numTurns: turnResult?.numTurns ?? null,
    contextTokens: turnResult?.contextTokens ?? null,
    contextWindow: turnResult?.contextWindow ?? null,
    contentBlocks: turnResult?.contentBlocks ?? contentBlocks,
    structuredOutput: turnResult?.structuredOutput,
    aborted: false,
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
