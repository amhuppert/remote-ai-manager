/**
 * Claude ConversationBackendRuntime — wraps the Anthropic query() lifecycle
 * behind the backend-neutral conversation runtime interface.
 */

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
import { createCanUseTool, type CanUseToolTurnContext } from "./native-tooling";
import { buildChildEnv } from "@/lib/child-env";
import { createLogger } from "@/lib/logging";
import {
  claudeModelSchema,
  claudeEffortLevelSchema,
  type McpDiscoveredTool,
} from "@/lib/schemas";
import { translatePortableMcpToClaude } from "../mcp-translation";
import { createPortableMcpFilterLookup } from "@/lib/mcp/portable-mcp-filter";

const logger = createLogger("claude:conversation-runtime");

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
  private readonly baseSessionOptions: QuerySessionOptions;
  private readonly onPortableMcpApplied: (
    config: PortableMcpConfig | null,
  ) => void;

  constructor(
    querySession: QuerySession,
    baseSessionOptions: QuerySessionOptions,
    opts: {
      modelId?: string;
      reasoningEffort?: string;
      outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
      onPortableMcpApplied?: (config: PortableMcpConfig | null) => void;
    },
  ) {
    this.querySession = querySession;
    this.baseSessionOptions = baseSessionOptions;
    this.modelId = opts.modelId;
    this.reasoningEffort = opts.reasoningEffort;
    this.outputFormat = opts.outputFormat;
    this.onPortableMcpApplied = opts.onPortableMcpApplied ?? (() => {});

    logger.info("claude-runtime.created", {
      conversationId: querySession.conversationId,
      modelId: opts.modelId,
    });
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
      hasFork: !!input.nativeFork,
    });

    const startTime = Date.now();

    // Handle native fork: create a new QuerySession forking from the source
    if (input.nativeFork) {
      const sourceSessionId =
        input.nativeFork.sourceRef.backend === "claude"
          ? input.nativeFork.sourceRef.sessionId
          : undefined;

      if (sourceSessionId) {
        logger.info("claude-runtime.fork", {
          conversationId: this.querySession.conversationId,
          sourceSessionId,
          forkLocator: input.nativeFork.forkLocator,
        });

        // Close existing session before creating fork
        this.querySession.close();

        this.querySession = createQuerySession({
          ...this.baseSessionOptions,
          resume: sourceSessionId,
          forkSession: true,
          resumeSessionAt: input.nativeFork.forkLocator ?? undefined,
        });
      }
    }

    // Build prompt content — text + images
    const promptBlocks: MessageContentBlock[] = [];
    if (input.syntheticForkSeed) {
      promptBlocks.push({ type: "text", text: input.syntheticForkSeed });
    }
    promptBlocks.push({ type: "text", text: input.promptText });
    for (const img of input.images) {
      promptBlocks.push({
        type: "image",
        mediaType: img.mediaType,
        base64Data: img.base64Data,
      });
    }

    const prompt: string | MessageContentBlock[] =
      promptBlocks.length === 1 && promptBlocks[0]!.type === "text"
        ? (promptBlocks[0] as { type: "text"; text: string }).text
        : promptBlocks;

    // Emit adapter: translates raw SDK messages to backend events
    const emit = (event: string, data: unknown) => {
      if (event === "__raw_message") {
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
      logger.error("claude-runtime.turn_error", {
        conversationId: this.querySession.conversationId,
        error: errorMsg,
      });

      input.onEvent({ type: "error", message: errorMsg });

      return {
        backendRef: null,
        costUsd: null,
        durationMs: Date.now() - startTime,
        numTurns: null,
        contextTokens: null,
        contextWindowMax: null,
        contentBlocks: [],
        aborted: false,
        error: errorMsg,
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
      const result = await this.querySession.query.setMcpServers(servers);

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

    logger.info("claude-runtime.close", {
      conversationId: this.querySession.conversationId,
    });

    this.querySession.close();
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

const claudeConversationBackendFactory: ConversationBackendFactory = {
  backend: "claude" as AgentBackendId,

  async createRuntime(
    input: ConversationBackendCreateInput,
  ): Promise<ConversationBackendRuntime> {
    logger.info("claude-factory.create_runtime", {
      conversationId: input.conversationId,
      projectName: input.projectName,
      sessionName: input.sessionName,
      modelId: input.modelId,
    });

    // Mutable per-turn context holder — the canUseTool callback reads from
    // this at invocation time, so autonomy and question handling change per turn.
    let turnContext: CanUseToolTurnContext | null = null;

    // Mutable portable-config holder — reflects the resolver's current
    // effective output. Updated by applyPortableMcpConfig on successful apply.
    // The filter lookup reads from it live, so setMcpServers-driven changes
    // take effect in canUseTool without rebuilding the callback.
    let currentPortableConfig: PortableMcpConfig | null =
      input.tooling.portableMcp ?? null;

    const canUseTool = createCanUseTool(() => turnContext, {
      conversationId: input.conversationId,
      mcpFilter: createPortableMcpFilterLookup(() => currentPortableConfig),
    });

    // Determine resume session ID from persisted ref
    const resumeSessionId =
      input.persistedRef?.backend === "claude"
        ? input.persistedRef.sessionId
        : undefined;

    // Build MCP servers config from tooling overrides
    const mcpServers: Record<string, unknown> = {};

    if (input.tooling.portableMcp) {
      const { servers } = translatePortableMcpToClaude(
        input.tooling.portableMcp,
      );
      Object.assign(mcpServers, servers);
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
      mcpServers,
      canUseTool: canUseTool as never,
      env: buildChildEnv() as Record<string, string>,
      maxTurns: undefined,
      plugins: [],
      settingSources: ["user", "project", "local"],
      disallowedTools: [],
      outputFormat: input.outputFormat,
      externalTurnHandler,
    };

    const querySession = createQuerySession(sessionOptions);

    const runtime = new ClaudeConversationRuntime(
      querySession,
      sessionOptions,
      {
        modelId: input.modelId,
        reasoningEffort: input.reasoningEffort,
        outputFormat: input.outputFormat,
        onPortableMcpApplied: (config) => {
          currentPortableConfig = config;
        },
      },
    );

    // Wire the runtime's turnContext into the shared mutable holder
    // so the canUseTool callback can read per-turn state from any
    // QuerySession the runtime creates (including forks).
    const originalSendTurn = runtime.sendTurn.bind(runtime);
    runtime.sendTurn = async (turnInput: ConversationBackendTurnInput) => {
      turnContext = {
        autonomous: turnInput.autonomous,
        onAskQuestion: turnInput.onAskQuestion
          ? async (questions: unknown[]) => {
              const typed = questions as import("@/types").AskQuestionItem[];
              return turnInput.onAskQuestion!(typed);
            }
          : undefined,
      };
      try {
        return await originalSendTurn(turnInput);
      } finally {
        turnContext = null;
      }
    };

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
};

// ============================================================
// Register factory
// ============================================================

registerConversationBackendFactory(claudeConversationBackendFactory);

export { ClaudeConversationRuntime, claudeConversationBackendFactory };
