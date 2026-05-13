/**
 * Claude ConversationBackendRuntime — wraps the Anthropic query() lifecycle
 * behind the backend-neutral conversation runtime interface.
 */

import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { MessageContentBlock } from "@/types";
import type {
  AgentBackendId,
  AgentSessionRef,
  ConversationBackendCapabilities,
} from "../types";
import type {
  ConversationBackendEvent,
  ConversationBackendRuntime,
  ConversationBackendTurnInput,
  ConversationBackendTurnResult,
  ConversationQueuedUserInput,
  ConversationBackendCreateInput,
  ConversationBackendFactory,
} from "../conversation";
import type { PortableMcpConfig, McpApplyResult } from "../portable-mcp";
import { registerConversationBackendFactory } from "../registry-core";
import {
  createQuerySession,
  type QuerySession,
  type QuerySessionOptions,
  type TurnResult,
} from "./query-session";
import { buildClaudePromptBlocks } from "./build-prompt-blocks";
import { createCanUseTool } from "./native-tooling";
import { buildChildEnv } from "@/lib/child-env";
import { createLogger } from "@/lib/logging";
import {
  claudeModelSchema,
  claudeEffortLevelSchema,
  type McpDiscoveredTool,
} from "@/lib/schemas";
import { translatePortableMcpToClaude } from "../mcp-translation";
import { createPortableMcpFilterLookup } from "@/lib/mcp/portable-mcp-filter";
import {
  createSessionMcpServer,
  type SessionMcpServerParams,
} from "@/lib/mcp-gateway/session-server";

const logger = createLogger("claude:conversation-runtime");

const CC_SESSION_TOOLS_SERVER_NAME = "cc-session-tools";

export interface ClaudeFactoryDeps {
  createSessionMcpServer(params: SessionMcpServerParams): Promise<McpServer>;
}

export const defaultClaudeFactoryDeps: ClaudeFactoryDeps = {
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
  private readonly sessionToolsInstance: McpServer;

  constructor(
    querySession: QuerySession,
    opts: {
      modelId?: string;
      reasoningEffort?: string;
      outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
      onPortableMcpApplied?: (config: PortableMcpConfig | null) => void;
      sessionToolsInstance: McpServer;
    },
  ) {
    this.querySession = querySession;
    this.modelId = opts.modelId;
    this.reasoningEffort = opts.reasoningEffort;
    this.outputFormat = opts.outputFormat;
    this.onPortableMcpApplied = opts.onPortableMcpApplied ?? (() => {});
    this.sessionToolsInstance = opts.sessionToolsInstance;

    logger.info("claude-runtime.created", {
      conversationId: querySession.conversationId,
      modelId: opts.modelId,
    });
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
    await this.querySession.query.setMcpServers(merged);
  }

  get status(): "alive" | "dead" {
    if (this.querySession.status === "dead") {
      this._status = "dead";
    }
    return this._status;
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
      const result = await this.querySession.query.setMcpServers(
        this.mergeSessionToolsServer(servers),
      );

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

    const sessionToolsInstance = await deps.createSessionMcpServer({
      name: input.projectName,
      session: input.sessionName,
      conversationId: mcpScopeConversationId,
    });

    // Mutable portable-config holder — reflects the resolver's current
    // effective output. Updated by applyPortableMcpConfig on successful apply.
    // The filter lookup reads from it live, so setMcpServers-driven changes
    // take effect in canUseTool without rebuilding the callback.
    let currentPortableConfig: PortableMcpConfig | null =
      input.tooling.portableMcp ?? null;

    const canUseTool = createCanUseTool({
      conversationId: input.conversationId,
      mcpFilter: createPortableMcpFilterLookup(() => currentPortableConfig),
    });

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
    };

    const querySession = createQuerySession(sessionOptions);

    const runtime = new ClaudeConversationRuntime(querySession, {
      modelId: input.modelId,
      reasoningEffort: input.reasoningEffort,
      outputFormat: input.outputFormat,
      onPortableMcpApplied: (config) => {
        currentPortableConfig = config;
      },
      sessionToolsInstance,
    });

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

export { ClaudeConversationRuntime, claudeConversationBackendFactory };
