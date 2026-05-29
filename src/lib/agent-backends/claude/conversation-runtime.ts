/**
 * Claude ConversationBackendRuntime — wraps the Anthropic query() lifecycle
 * behind the backend-neutral conversation runtime interface.
 */

import type {
  CanUseTool,
  McpServerConfig,
  Settings,
} from "@anthropic-ai/claude-agent-sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { MessageContentBlock } from "@/lib/conversations/schemas";
import type {
  AgentBackendId,
  AgentSessionRef,
  ConversationBackendCapabilities,
} from "../types";
import type {
  ClaudeCapabilityApplyResult,
  ConversationBackendEvent,
  ConversationBackendRuntime,
  ConversationBackendTurnInput,
  ConversationBackendTurnResult,
  ConversationQueuedUserInput,
  ConversationBackendCreateInput,
  ConversationBackendFactory,
} from "../conversation";
import type { PortableMcpConfig, McpApplyResult } from "../portable-mcp";
import type { ClaudeRuntimeCapabilityConfig } from "@/lib/agent-capabilities/claude-runtime-translator";
import { registerConversationBackendFactory } from "../registry-core";
import {
  createQuerySession,
  type QuerySession,
  type QuerySessionOptions,
  type TurnResult,
} from "./query-session";
import {
  isUndeliveredQuerySessionError,
  isSessionDiedMidTurnError,
} from "./query-session-errors";
import { buildClaudePromptBlocks } from "./build-prompt-blocks";
import { createCanUseTool } from "./native-tooling";
import { buildChildEnv } from "@/lib/shared/child-env";
import { createLogger } from "@/lib/logging";
import {
  claudeModelSchema,
  claudeEffortLevelSchema,
} from "@/lib/agent-backends/schemas";
import { type McpDiscoveredTool } from "@/lib/mcp/schemas";
import { translatePortableMcpToClaude } from "../mcp-translation";
import { createPortableMcpFilterLookup } from "@/lib/mcp/portable-mcp-filter";
import {
  createSessionMcpServer,
  type SessionMcpServerParams,
} from "@/lib/mcp-gateway/session-server";
import { composeClaudeAgentCanUseTool } from "@/lib/agent-capabilities/claude-agent-suppression";

const logger = createLogger("claude:conversation-runtime");

const CC_SESSION_TOOLS_SERVER_NAME = "cc-session-tools";

export interface ClaudeFactoryDeps {
  createSessionMcpServer(params: SessionMcpServerParams): Promise<McpServer>;
}

const defaultClaudeFactoryDeps: ClaudeFactoryDeps = {
  createSessionMcpServer,
};

const KNOWN_CLAUDE_MODELS = claudeModelSchema.options;
const KNOWN_EFFORT_LEVELS = claudeEffortLevelSchema.options;

// ============================================================
// Claude Conversation Runtime
// ============================================================

class ClaudeConversationRuntime implements ConversationBackendRuntime {
  readonly backend: AgentBackendId = "claude";
  readonly capabilities: ConversationBackendCapabilities = {
    queueWhileRunning: true,
    askUserQuestion: true,
    preciseFork: true,
    portableMcpAtStart: true,
    portableMcpBetweenTurns: true,
    contextWindowMetrics: true,
  };

  readonly modelId: string | undefined;
  readonly reasoningEffort: string | undefined;
  readonly outputFormat:
    | { type: "json_schema"; schema: Record<string, unknown> }
    | undefined;

  private _status: "alive" | "dead" = "alive";
  private querySession: QuerySession;
  private readonly onPortableMcpApplied: (
    config: PortableMcpConfig | null,
  ) => void;
  private sessionToolsInstance: McpServer;
  private readonly recreateSessionToolsServer: () => Promise<McpServer>;
  private lastAppliedTranslatedServers: Record<string, McpServerConfig> = {};
  private readonly onCapabilityConfigApplied: (
    config: ClaudeRuntimeCapabilityConfig,
  ) => Promise<void>;

  constructor(
    querySession: QuerySession,
    opts: {
      modelId?: string;
      reasoningEffort?: string;
      outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
      onPortableMcpApplied?: (config: PortableMcpConfig | null) => void;
      /**
       * Mid-session capability apply hook. Production wires this to
       * `query.applyFlagSettings(...)` + `query.reloadPlugins()` so cascade
       * deltas actually mutate the live SDK process. Initial capability
       * seeding flows through `Settings` on `QuerySessionOptions` instead, so
       * the constructor does not self-fire this callback at runtime creation.
       */
      onCapabilityConfigApplied?: (
        config: ClaudeRuntimeCapabilityConfig,
      ) => Promise<void>;
      sessionToolsInstance: McpServer;
      /**
       * Factory closure that builds a fresh `cc-session-tools` `McpServer`
       * instance with the same project/session/conversation scoping the
       * runtime was created with. Used by `rebuildSessionToolsInstance` to
       * recover from stale in-memory transports between turns.
       */
      recreateSessionToolsServer: () => Promise<McpServer>;
    },
  ) {
    this.querySession = querySession;
    this.modelId = opts.modelId;
    this.reasoningEffort = opts.reasoningEffort;
    this.outputFormat = opts.outputFormat;
    this.onPortableMcpApplied = opts.onPortableMcpApplied ?? (() => {});
    this.onCapabilityConfigApplied =
      opts.onCapabilityConfigApplied ?? (async () => {});
    this.sessionToolsInstance = opts.sessionToolsInstance;
    this.recreateSessionToolsServer = opts.recreateSessionToolsServer;

    logger.info("claude-runtime.created", {
      conversationId: querySession.conversationId,
      modelId: opts.modelId,
    });
  }

  get isTurnActive(): boolean {
    return this.querySession.isTurnActive;
  }

  private mergeSessionToolsServer(
    base: Record<string, McpServerConfig>,
  ): Record<string, McpServerConfig> {
    return {
      ...base,
      [CC_SESSION_TOOLS_SERVER_NAME]: {
        type: "sdk",
        name: CC_SESSION_TOOLS_SERVER_NAME,
        instance: this.sessionToolsInstance,
      },
    };
  }

  async init(translated: Record<string, McpServerConfig>): Promise<void> {
    const merged = this.mergeSessionToolsServer(translated);
    await this.querySession.setMcpServers(merged);
    this.lastAppliedTranslatedServers = translated;
  }

  get status(): "alive" | "dead" {
    if (this.querySession.status === "dead") {
      this._status = "dead";
    }
    return this._status;
  }

  notifyTurnStarting(): void {
    this.querySession.notifyTurnStarting();
  }

  async sendTurn(
    input: ConversationBackendTurnInput,
  ): Promise<ConversationBackendTurnResult> {
    logger.info("claude-runtime.turn_start", {
      conversationId: this.querySession.conversationId,
      autonomous: input.autonomous,
    });

    const startTime = Date.now();

    const promptBlocks: MessageContentBlock[] = buildClaudePromptBlocks({
      promptText: input.promptText,
      imageRefs: input.imageRefs,
      syntheticForkSeed: input.syntheticForkSeed ?? null,
    });

    const prompt: string | MessageContentBlock[] =
      promptBlocks.length === 1 && promptBlocks[0]!.type === "text"
        ? (promptBlocks[0] as { type: "text"; text: string }).text
        : promptBlocks;

    // Track the most recent session_id observed on any raw SDK message so
    // that a turn aborted or terminated mid-flight (timeout, runtime close)
    // can still surface the live SDK session for the next turn's `resume:`.
    let lastKnownSessionId: string | null = null;

    const emit = (event: string, data: unknown) => {
      if (event === "__raw_message") {
        const msg = data as { session_id?: string } | null;
        if (msg && typeof msg.session_id === "string" && msg.session_id) {
          lastKnownSessionId = msg.session_id;
        }
        input.onEvent({ type: "provider_event", payload: data });
      }
    };

    try {
      const turnResult: TurnResult = await this.querySession.sendPrompt(
        prompt,
        emit,
        { autonomous: input.autonomous },
      );

      const backendRef: AgentSessionRef | null = turnResult.sessionId
        ? { backend: "claude", sessionId: turnResult.sessionId }
        : null;

      if (backendRef) {
        input.onEvent({ type: "backend_init", backendRef });
      }

      for (const block of turnResult.contentBlocks) {
        input.onEvent({ type: "content", block });
      }

      const result: ConversationBackendTurnResult = {
        backendRef,
        costUsd: turnResult.costUsd,
        durationMs: turnResult.durationMs ?? Date.now() - startTime,
        numTurns: turnResult.numTurns,
        contextTokens: turnResult.contextTokens,
        contextWindowMax: turnResult.contextWindow,
        contentBlocks: turnResult.contentBlocks,
        structuredOutput: turnResult.structuredOutput,
        aborted: turnResult.aborted,
        error: turnResult.error,
      };

      logger.info("claude-runtime.turn_end", {
        conversationId: this.querySession.conversationId,
        costUsd: result.costUsd,
        numTurns: result.numTurns,
        error: result.error,
      });

      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const wasAborted = input.signal.aborted;
      const backendRef: AgentSessionRef | null = lastKnownSessionId
        ? { backend: "claude", sessionId: lastKnownSessionId }
        : null;

      logger.error("claude-runtime.turn_error", {
        conversationId: this.querySession.conversationId,
        error: errorMsg,
        aborted: wasAborted,
        sessionId: lastKnownSessionId,
      });

      // Surface retryable QuerySession errors to the caller so the actor's
      // dispatch-turn proxy can replace the dead runtime and retry. Aborts
      // continue to flow through the structured aborted-result path below.
      if (
        !wasAborted &&
        (isUndeliveredQuerySessionError(err) || isSessionDiedMidTurnError(err))
      ) {
        throw err;
      }

      if (!wasAborted) {
        input.onEvent({ type: "error", message: errorMsg });
      }

      return {
        backendRef,
        costUsd: null,
        durationMs: Date.now() - startTime,
        numTurns: null,
        contextTokens: null,
        contextWindowMax: null,
        contentBlocks: [],
        aborted: wasAborted,
        error: wasAborted ? null : errorMsg,
      };
    }
  }

  async queueUserInput(input: ConversationQueuedUserInput): Promise<void> {
    logger.debug("claude-runtime.queue_input", {
      conversationId: this.querySession.conversationId,
      blockCount: input.content.length,
    });
    await this.querySession.query.streamInput(wrapAsUserMessage(input.content));
  }

  async applyPortableMcpConfig(
    config: PortableMcpConfig,
  ): Promise<McpApplyResult> {
    logger.info("claude-runtime.mcp_apply", {
      conversationId: this.querySession.conversationId,
      serverCount: config.servers.length,
    });

    const { servers, rejectedServers, rejectedFields, errorsByServer } =
      translatePortableMcpToClaude(config);

    if (
      Object.keys(errorsByServer).length > 0 &&
      Object.keys(servers).length === 0
    ) {
      return {
        disposition: "rejected",
        droppedServerIds: rejectedServers,
        droppedFields: rejectedFields,
        errors: errorsByServer,
      };
    }

    if (this.querySession.isTurnActive) {
      logger.info("claude-runtime.mcp_deferred", {
        conversationId: this.querySession.conversationId,
      });
      return {
        disposition: "deferred_to_next_turn",
        droppedServerIds: rejectedServers,
        droppedFields: rejectedFields,
        errors: errorsByServer,
      };
    }

    try {
      const result = await this.querySession.setMcpServers(
        this.mergeSessionToolsServer(servers),
      );

      this.lastAppliedTranslatedServers = servers;
      this.onPortableMcpApplied(config);

      logger.info("claude-runtime.mcp_applied", {
        conversationId: this.querySession.conversationId,
        added: result.added,
        removed: result.removed,
        errors: result.errors,
      });

      return {
        disposition: "applied_now",
        droppedServerIds: rejectedServers,
        droppedFields: rejectedFields,
        errors: { ...errorsByServer, ...result.errors },
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error("claude-runtime.mcp_apply_error", {
        conversationId: this.querySession.conversationId,
        error: errorMsg,
      });

      return {
        disposition: "rejected",
        droppedServerIds: [],
        droppedFields: [],
        errors: { _setMcpServers: errorMsg },
      };
    }
  }

  /**
   * Build a fresh `cc-session-tools` MCP server instance and re-bind it via
   * `setMcpServers`. The user-server portion of the payload is replayed from
   * `lastAppliedTranslatedServers` so the SDK's diffing logic sees no churn
   * for stdio/HTTP servers — only the in-process `sdk` entry's `instance`
   * field changes, forcing a fresh in-memory transport pair on the SDK side.
   *
   * No-ops when the runtime is dead or a turn is currently active. On
   * setMcpServers failure the new instance is closed and the field is left
   * pointing at the old one so the next caller doesn't try to use a
   * half-bound server. All failures are swallowed at this layer — the apply
   * service wires this in for resilience and must not propagate errors that
   * would block the turn that triggered the rebuild.
   */
  async rebuildSessionToolsInstance(): Promise<void> {
    const conversationId = this.querySession.conversationId;

    if (this._status === "dead" || this.querySession.status === "dead") {
      return;
    }
    if (this.querySession.isTurnActive) {
      logger.info("claude-runtime.session_tools_rebuild_skipped_turn_active", {
        conversationId,
      });
      return;
    }

    let newInstance: McpServer;
    try {
      newInstance = await this.recreateSessionToolsServer();
    } catch (err) {
      logger.warn("claude-runtime.session_tools_rebuild_create_failed", {
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const merged: Record<string, McpServerConfig> = {
      ...this.lastAppliedTranslatedServers,
      [CC_SESSION_TOOLS_SERVER_NAME]: {
        type: "sdk",
        name: CC_SESSION_TOOLS_SERVER_NAME,
        instance: newInstance,
      },
    };

    try {
      await this.querySession.setMcpServers(merged);
    } catch (err) {
      logger.warn("claude-runtime.session_tools_rebuild_bind_failed", {
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
      void newInstance.close().catch((closeErr: unknown) => {
        logger.warn(
          "claude-runtime.session_tools_rebuild_orphan_close_failed",
          {
            conversationId,
            error:
              closeErr instanceof Error ? closeErr.message : String(closeErr),
          },
        );
      });
      return;
    }

    const previous = this.sessionToolsInstance;
    this.sessionToolsInstance = newInstance;
    void previous.close().catch((err: unknown) => {
      logger.warn("claude-runtime.session_tools_rebuild_old_close_failed", {
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    logger.info("claude-runtime.session_tools_rebuilt", { conversationId });
  }

  /**
   * Live-apply a Claude capability configuration to this runtime. The
   * installed SDK does not expose runtime `setSkills`/`setPlugins`/`setAgents`
   * setters, so the runtime forwards the config to the registered
   * `onCapabilityConfigApplied` callback — production wiring forwards it to
   * the `QuerySession` so the next SDK options ingestion picks it up. Returns
   * `skipped-turn-active` while a turn is in flight so the apply service can
   * record `staged-idle` and drain after the turn completes.
   */
  async applyClaudeCapabilityConfig(
    config: ClaudeRuntimeCapabilityConfig,
  ): Promise<ClaudeCapabilityApplyResult> {
    const conversationId = this.querySession.conversationId;
    if (this._status === "dead" || this.querySession.status === "dead") {
      return {
        status: "rejected",
        error: "runtime is closed",
      };
    }
    if (this.querySession.isTurnActive) {
      logger.info("claude-runtime.capability_deferred_turn_active", {
        conversationId,
      });
      return { status: "skipped-turn-active" };
    }

    try {
      await this.onCapabilityConfigApplied(config);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error("claude-runtime.capability_apply_failed", {
        conversationId,
        error: errorMsg,
      });
      return { status: "rejected", error: errorMsg };
    }
    logger.info("claude-runtime.capability_applied", {
      conversationId,
      pluginCount: Object.keys(config.enabledPlugins).length,
      skillOverrideCount: Object.keys(config.skillOverrides).length,
      disabledAgentCount: config.disabledAgentNames.length,
    });
    return { status: "applied" };
  }

  async supportedCommands(): Promise<readonly { name: string }[]> {
    return this.querySession.query.supportedCommands();
  }

  async supportedAgents(): Promise<readonly { name: string }[]> {
    return this.querySession.query.supportedAgents();
  }

  async listMcpServerTools(
    serverKey: string,
  ): Promise<readonly McpDiscoveredTool[] | undefined> {
    if (this._status === "dead" || this.querySession.status === "dead") {
      return undefined;
    }

    let statuses;
    try {
      statuses = await this.querySession.query.mcpServerStatus();
    } catch (err) {
      logger.warn("claude-runtime.mcp_status_failed", {
        conversationId: this.querySession.conversationId,
        serverKey,
      });
      return undefined;
    }

    const match = statuses.find((status) => status.name === serverKey);
    if (!match || match.status !== "connected" || !match.tools) {
      return undefined;
    }

    return match.tools.map<McpDiscoveredTool>((tool) => ({
      name: tool.name,
      ...(tool.description !== undefined
        ? { description: tool.description }
        : {}),
    }));
  }

  close(): void {
    if (this._status === "dead") return;
    this._status = "dead";

    const conversationId = this.querySession.conversationId;
    logger.info("claude-runtime.close", { conversationId });

    this.querySession.close();

    void this.sessionToolsInstance.close().catch((err: unknown) => {
      logger.warn("claude-runtime.session_tools_close_failed", {
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

// ============================================================
// Helpers
// ============================================================

function buildExternalTurnHandler(
  onExternalTurnEvent: (event: ConversationBackendEvent) => void,
): {
  emit: (event: string, data: unknown) => void;
  onComplete: (result: TurnResult) => void;
} {
  let started = false;
  return {
    emit(event, data) {
      if (event !== "__raw_message") return;
      if (!started) {
        started = true;
        onExternalTurnEvent({ type: "external_turn_started" });
      }
      onExternalTurnEvent({ type: "provider_event", payload: data });
    },
    onComplete(turnResult: TurnResult) {
      started = false;
      const backendRef: AgentSessionRef | null = turnResult.sessionId
        ? { backend: "claude", sessionId: turnResult.sessionId }
        : null;
      onExternalTurnEvent({
        type: "external_turn_completed",
        result: {
          backendRef,
          costUsd: turnResult.costUsd,
          durationMs: turnResult.durationMs,
          numTurns: turnResult.numTurns,
          contextTokens: turnResult.contextTokens,
          contextWindowMax: turnResult.contextWindow,
          contentBlocks: turnResult.contentBlocks,
          structuredOutput: turnResult.structuredOutput,
          aborted: turnResult.aborted,
          error: turnResult.error,
        },
      });
    },
  };
}

async function* wrapAsUserMessage(
  content: MessageContentBlock[],
): AsyncGenerator<import("@anthropic-ai/claude-agent-sdk").SDKUserMessage> {
  yield {
    type: "user",
    session_id: "",
    message: {
      role: "user",
      content: content.map((block) => {
        if (block.type === "image") {
          return {
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: block.mediaType,
              data: block.base64Data,
            },
          };
        }
        return block;
      }),
    },
    parent_tool_use_id: null,
  } as import("@anthropic-ai/claude-agent-sdk").SDKUserMessage;
}

// ============================================================
// Claude Conversation Backend Factory
// ============================================================

const claudeConversationBackendFactory = {
  backend: "claude" as AgentBackendId,

  async createRuntime(
    input: ConversationBackendCreateInput,
    deps: ClaudeFactoryDeps = defaultClaudeFactoryDeps,
  ): Promise<ConversationBackendRuntime> {
    const mcpScopeConversationId =
      input.mcpScopeConversationId ?? input.conversationId;

    logger.info("claude-factory.create_runtime", {
      conversationId: input.conversationId,
      mcpScopeConversationId,
      projectName: input.projectName,
      sessionName: input.sessionName,
      modelId: input.modelId,
    });

    const recreateSessionToolsServer = (): Promise<McpServer> =>
      deps.createSessionMcpServer({
        name: input.projectName,
        session: input.sessionName,
        conversationId: mcpScopeConversationId,
      });

    const sessionToolsInstance = await recreateSessionToolsServer();

    // Mutable portable-config holder — reflects the resolver's current
    // effective output. Updated by applyPortableMcpConfig on successful apply.
    // The filter lookup reads from it live, so setMcpServers-driven changes
    // take effect in canUseTool without rebuilding the callback.
    let currentPortableConfig: PortableMcpConfig | null =
      input.tooling.portableMcp ?? null;

    const mcpCanUseTool = createCanUseTool({
      conversationId: input.conversationId,
      mcpFilter: createPortableMcpFilterLookup(() => currentPortableConfig),
    });

    // Adapt the 2-argument MCP filter callback to the SDK's 3-argument
    // CanUseTool signature so the suppression layer can call it through.
    const innerCanUseTool: CanUseTool = async (toolName, toolInput) => {
      const result = await mcpCanUseTool(
        toolName,
        toolInput as Record<string, unknown>,
      );
      return result;
    };

    // Compose the sub-agent suppression layer. The suppression set is bound
    // at session creation per `CLAUDE_AGENT_SUPPRESSION_STRATEGY.applyPoint`
    // ("next-conversation"); mid-session changes require a fresh runtime.
    const disabledAgentNames = new Set<string>(
      input.tooling.claudeCapabilityConfig?.disabledAgentNames ?? [],
    );
    const canUseTool = composeClaudeAgentCanUseTool({
      disabledAgentNames,
      inner: innerCanUseTool,
    });

    // Build initial SDK Settings from the translated capability config so the
    // SDK applies plugin/skill overrides natively at session start. Without
    // this, capability seeding for a brand-new runtime would be a no-op.
    const initialSettings: Settings | undefined = (() => {
      const cfg = input.tooling.claudeCapabilityConfig;
      if (!cfg) return undefined;
      const settings: Settings = {};
      if (Object.keys(cfg.enabledPlugins).length > 0) {
        settings.enabledPlugins = cfg.enabledPlugins;
      }
      if (Object.keys(cfg.skillOverrides).length > 0) {
        settings.skillOverrides = cfg.skillOverrides;
      }
      return Object.keys(settings).length > 0 ? settings : undefined;
    })();

    // Determine resume session ID from persisted ref
    const resumeSessionId =
      input.persistedRef?.backend === "claude"
        ? input.persistedRef.sessionId
        : undefined;

    // Build MCP servers config from tooling overrides.
    //
    // The SDK's static-Options init path (XP6 in cli.js) connects servers and
    // lists tools but does NOT iterate `tools[].permission_policy` on
    // HTTP/SSE configs. Only the dynamic `mcp_set_servers` handler (fX5)
    // extracts those policies into the session's `alwaysDenyRules`/
    // `alwaysAllowRules` — and those rules are checked before the
    // `bypassPermissions` short-circuit, which is how native per-tool denies
    // are enforced for HTTP servers.
    //
    // Pass an empty `mcpServers` to the SDK initially and immediately call
    // `setMcpServers` after creation so the dynamic path runs once at start.
    // Without this, conversation-level disabledTools on HTTP servers leak
    // through (root cause of context7 `resolve-library-id` not being denied).
    let translatedServers: Record<string, McpServerConfig> = {};
    if (input.tooling.portableMcp) {
      const { servers } = translatePortableMcpToClaude(
        input.tooling.portableMcp,
      );
      translatedServers = servers;
    }

    const externalTurnHandler = input.onExternalTurnEvent
      ? buildExternalTurnHandler(input.onExternalTurnEvent)
      : undefined;

    const sessionOptions: QuerySessionOptions = {
      conversationId: input.conversationId,
      cwd: input.worktreePath,
      model: input.modelId,
      effort: input.reasoningEffort as QuerySessionOptions["effort"],
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append:
          input.sessionInstructions.length > 0
            ? input.sessionInstructions.join("\n\n")
            : undefined,
      },
      resume: resumeSessionId,
      forkSession: undefined,
      mcpServers: {},
      canUseTool: canUseTool as never,
      env: buildChildEnv() as Record<string, string>,
      maxTurns: undefined,
      plugins: [],
      settingSources: ["user", "project", "local"],
      disallowedTools: ["AskUserQuestion"],
      outputFormat: input.outputFormat,
      externalTurnHandler,
      ...(initialSettings ? { settings: initialSettings } : {}),
    };

    const querySession = createQuerySession(sessionOptions);

    const runtime = new ClaudeConversationRuntime(querySession, {
      modelId: input.modelId,
      reasoningEffort: input.reasoningEffort,
      outputFormat: input.outputFormat,
      onPortableMcpApplied: (config) => {
        currentPortableConfig = config;
      },
      onCapabilityConfigApplied: async (config) => {
        const flagSettings: Settings = {
          enabledPlugins: config.enabledPlugins,
          skillOverrides: config.skillOverrides,
        };
        await querySession.query.applyFlagSettings(flagSettings);
        await querySession.query.reloadPlugins();
        logger.info("claude-runtime.capability_sdk_mutation", {
          conversationId: input.conversationId,
          pluginCount: Object.keys(config.enabledPlugins).length,
          skillOverrideCount: Object.keys(config.skillOverrides).length,
        });
      },
      sessionToolsInstance,
      recreateSessionToolsServer,
    });

    if (input.tooling.claudeCapabilityConfig) {
      logger.info("claude-runtime.initial_capability_config", {
        conversationId: input.conversationId,
        pluginCount: Object.keys(
          input.tooling.claudeCapabilityConfig.enabledPlugins,
        ).length,
        skillOverrideCount: Object.keys(
          input.tooling.claudeCapabilityConfig.skillOverrides,
        ).length,
        disabledAgentCount:
          input.tooling.claudeCapabilityConfig.disabledAgentNames.length,
      });
    }

    try {
      await runtime.init(translatedServers);
      logger.info("claude-runtime.initial_mcp_set", {
        conversationId: input.conversationId,
        serverCount: Object.keys(translatedServers).length + 1,
      });
    } catch (err) {
      logger.error("claude-runtime.initial_mcp_set_failed", {
        conversationId: input.conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        await sessionToolsInstance.close();
      } catch {
        // swallow secondary failure
      }
      try {
        querySession.close();
      } catch {
        // swallow secondary failure
      }
      throw err;
    }

    return runtime;
  },

  validateModelAndEffort(input: {
    modelId?: string;
    reasoningEffort?: string;
  }): void {
    if (input.modelId) {
      const result = claudeModelSchema.safeParse(input.modelId);
      if (!result.success) {
        throw new Error(
          `Invalid Claude model: "${input.modelId}". Must be one of: ${KNOWN_CLAUDE_MODELS.join(", ")}.`,
        );
      }
    }

    if (input.reasoningEffort) {
      const result = claudeEffortLevelSchema.safeParse(input.reasoningEffort);
      if (!result.success) {
        throw new Error(
          `Invalid reasoning effort: "${input.reasoningEffort}". Must be one of: ${KNOWN_EFFORT_LEVELS.join(", ")}.`,
        );
      }
    }
  },
} satisfies ConversationBackendFactory;

// ============================================================
// Register factory
// ============================================================

registerConversationBackendFactory(claudeConversationBackendFactory);

export { claudeConversationBackendFactory };
