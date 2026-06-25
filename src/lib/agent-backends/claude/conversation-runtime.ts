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
  BackgroundWaitSummary,
  ClaudeCapabilityApplyResult,
  ConversationBackendEvent,
  ConversationBackendRuntime,
  ConversationBackendTurnInput,
  ConversationBackendTurnResult,
  ConversationQueuedUserInput,
  ConversationBackendCreateInput,
  ConversationBackendFactory,
  ReadyResult,
} from "../conversation";
import type { PortableMcpConfig, McpApplyResult } from "../portable-mcp";
import type { ClaudeRuntimeCapabilityConfig } from "@/lib/agent-capabilities/claude-runtime-translator";
import { registerConversationBackendFactory } from "../registry-core";
import {
  createQuerySession,
  type BackgroundWaitOutcome,
  type QuerySession,
  type QuerySessionOptions,
  type SdkMcpStreamClosedInfo,
  type TurnResult,
} from "./query-session";
import { getWaitableInFlightTaskIds } from "./background-task-tracker";
import {
  createSessionToolsSupervisor,
  type SessionToolsSupervisor,
} from "./session-tools-supervisor";
import {
  isUndeliveredQuerySessionError,
  isSessionDiedMidTurnError,
} from "./query-session-errors";
import {
  conversationRuntimeKey,
  hasActiveQuestionResolver,
} from "@/lib/workflows/conversation/runtime-state";
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
import { backendCapabilities } from "@/lib/agent-backends/capabilities-descriptor";

const logger = createLogger("claude:conversation-runtime");
const sessionToolsLogger = createLogger("claude:session-tools-supervisor");

const CC_SESSION_TOOLS_SERVER_NAME = "cc-session-tools";

/**
 * Default hard ceiling for the background-task wait barrier. Decoupled from the
 * 5-minute idle TTL (which is suppressed while waitable tasks are in flight) so
 * a long-running build/test can settle without the wait timing out prematurely.
 */
const DEFAULT_BACKGROUND_TASK_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

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
  readonly capabilities: ConversationBackendCapabilities =
    backendCapabilities("claude");

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
  private readonly sessionTools: SessionToolsSupervisor;
  private readonly _isQuestionPending: () => boolean;
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
       * runtime was created with. Used by `replaceSessionToolsInstance` to
       * recover from a broken in-process transport.
       */
      recreateSessionToolsServer: () => Promise<McpServer>;
      /**
       * True iff a turn is blocked on a validly pending AskUserQuestion
       * resolver for this conversation. Injected (rather than read directly)
       * so the runtime stays decoupled from the conversation runtime-state
       * registry and the session-tools supervisor can honor the
       * pending-question guard.
       */
      isQuestionPending: () => boolean;
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
    this._isQuestionPending = opts.isQuestionPending;

    this.sessionTools = createSessionToolsSupervisor({
      conversationId: querySession.conversationId,
      // The two-phase remove-then-add rebind is the only correct repair for a
      // broken in-process sdk server; the supervisor never replays the config.
      rebind: async () => {
        const outcome = await this.replaceSessionToolsInstance();
        if (outcome === "skipped-dead") {
          throw new Error("cc-session-tools rebind skipped: runtime is dead");
        }
      },
      isQuestionPending: () => this._isQuestionPending(),
      isDead: () =>
        this._status === "dead" || this.querySession.status === "dead",
      // The supervisor never tears the runtime down itself; it asks the query
      // session to kill the live turn so the actor recreates a resumed runtime.
      escalateToKill: (reason) => this.querySession.forceTerminate(reason),
      now: () => Date.now(),
      logger: sessionToolsLogger,
    });

    logger.info("claude-runtime.created", {
      conversationId: querySession.conversationId,
      modelId: opts.modelId,
    });
  }

  get isTurnActive(): boolean {
    return this.querySession.isTurnActive;
  }

  /**
   * INVARIANT: every `setMcpServers` payload must include the current
   * session-tools entry. The SDK diffs sdk-type servers by name — omitting
   * the name actively DISCONNECTS the in-process server, after which every
   * cc-session-tools tool call fails with "Stream closed".
   */
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

  /**
   * Pre-turn readiness contract. For a reused runtime the supervisor forces a
   * fresh `cc-session-tools` rebind before the prompt is delivered (the
   * disconnect window is safe — no tool call is in flight), so the observed
   * "Stream closed" failure cannot occur on a reused turn without a successful
   * rebind first. Returns `recreate-runtime` when the binding is unrecoverable,
   * asking the actor to recreate (resume-preserving). Mid-turn robustness is
   * best-effort and handled reactively (`handleSdkMcpStreamClosed`) — CC does
   * not control the agent loop, so a transport that breaks mid-turn after a
   * successful pre-turn rebind cannot be guaranteed.
   */
  async prepareForTurnStart(): Promise<ReadyResult> {
    return this.sessionTools.ensureReady("turn_start");
  }

  /** True iff a turn is blocked on a validly pending AskUserQuestion. */
  isQuestionPending(): boolean {
    return this._isQuestionPending();
  }

  /**
   * Hold the just-yielded turn open until its in-flight waitable background
   * tasks settle, when the turn opted into `waitForBackgroundTasks`. Returns the
   * wait summary only when a wait actually occurred (the flag was on AND the
   * waitable set was non-empty); returns `undefined` otherwise so the result
   * carries no `backgroundWait` for the no-op path.
   */
  private async waitForBackgroundTasksIfOptedIn(
    input: ConversationBackendTurnInput,
  ): Promise<BackgroundWaitSummary | undefined> {
    if (input.waitForBackgroundTasks !== true) return undefined;

    const waitable = getWaitableInFlightTaskIds(
      this.querySession.backgroundTaskState,
    );
    if (waitable.length === 0) return undefined;

    const timeoutMs =
      input.backgroundTaskWaitTimeoutMs ??
      DEFAULT_BACKGROUND_TASK_WAIT_TIMEOUT_MS;

    logger.info("claude-runtime.background_wait_begin", {
      conversationId: this.querySession.conversationId,
      waitedTaskIds: waitable,
      timeoutMs,
    });

    const outcome: BackgroundWaitOutcome =
      await this.querySession.awaitBackgroundTaskSettlement(timeoutMs);

    logger.info("claude-runtime.background_wait_end", {
      conversationId: this.querySession.conversationId,
      settledCount: outcome.settledTaskIds.length,
      timedOut: outcome.timedOut,
      durationMs: outcome.durationMs,
    });

    return {
      waitedTaskIds: outcome.waitedTaskIds,
      settledTaskIds: outcome.settledTaskIds,
      timedOut: outcome.timedOut,
      durationMs: outcome.durationMs,
    };
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

    // Emit `input_accepted` exactly once, on the first raw provider message and
    // before the first provider_event. Claude writes assistant transcript via
    // the actor's provider_event path DURING sendPrompt, so the queued-delivery
    // user transcript entry must be appended before any assistant content —
    // hence acceptance precedes the first provider_event rather than firing
    // after sendPrompt resolves. A dispatch failure delivers no raw message, so
    // the flag stays false and acceptance never fires (the actor returns the
    // queue row to pending for retry).
    let inputAcceptedEmitted = false;

    const emit = (event: string, data: unknown) => {
      if (event === "__raw_message") {
        if (!inputAcceptedEmitted) {
          inputAcceptedEmitted = true;
          input.onEvent({ type: "input_accepted" });
          logger.debug("claude-runtime.input_accepted", {
            conversationId: this.querySession.conversationId,
          });
        }
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

      // Bounded wait barrier: if the turn opted in and the agent left waitable
      // background tasks in flight, hold the turn open until they settle (or the
      // wait times out). The SDK's virtual-turn auto-continuation runs on the
      // pump during the await, delivering each settled task's notification to the
      // agent so it can finish within this same iteration. Returns immediately
      // when the set is empty or the flag is off (no-op for interactive turns).
      const backgroundWait = await this.waitForBackgroundTasksIfOptedIn(input);

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
        ...(backgroundWait ? { backgroundWait } : {}),
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
    const conversationId = this.querySession.conversationId;

    // Gate live delivery on the session being able to accept input. A dead
    // session cannot accept a streamInput, so reject (rather than silently
    // resolve) — the caller leaves the queue row pending for next-turn drain.
    if (this._status === "dead" || this.querySession.status === "dead") {
      logger.warn("claude-runtime.queue_input_rejected_dead", {
        conversationId,
      });
      throw new Error("Cannot queue input: Claude runtime is closed");
    }

    logger.debug("claude-runtime.queue_input", {
      conversationId,
      blockCount: input.content.length,
    });

    // Resolution is gated on streamInput resolving: that is the live
    // input-acceptance signal. A streamInput rejection (e.g. tagged
    // promptNotDelivered) propagates so the caller leaves the row pending.
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
   * the query session's two-phase `replaceSdkServer` (the SDK diffs sdk-type
   * servers by name only, so a same-name single-call swap is a silent no-op
   * — the name must be dropped and re-added). The non-sdk server portion of
   * both phase payloads is replayed from `lastAppliedTranslatedServers`.
   *
   * Works mid-turn — the re-bind is a control-channel operation and the only
   * caller is stream-closed recovery, which by definition fires during a
   * turn. On failure the new instance is closed and the field is left
   * pointing at the old one so later apply payloads don't carry a
   * half-bound server; the error propagates to the caller.
   */
  async replaceSessionToolsInstance(): Promise<"replaced" | "skipped-dead"> {
    const conversationId = this.querySession.conversationId;

    if (this._status === "dead" || this.querySession.status === "dead") {
      return "skipped-dead";
    }

    const newInstance = await this.recreateSessionToolsServer();

    try {
      await this.querySession.replaceSdkServer(
        CC_SESSION_TOOLS_SERVER_NAME,
        newInstance,
        this.lastAppliedTranslatedServers,
      );
    } catch (err) {
      logger.error("claude-runtime.session_tools_replace_failed", {
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
      void newInstance.close().catch((closeErr: unknown) => {
        logger.warn(
          "claude-runtime.session_tools_replace_orphan_close_failed",
          {
            conversationId,
            error:
              closeErr instanceof Error ? closeErr.message : String(closeErr),
          },
        );
      });
      throw err;
    }

    const previous = this.sessionToolsInstance;
    this.sessionToolsInstance = newInstance;
    void previous.close().catch((err: unknown) => {
      logger.warn("claude-runtime.session_tools_replace_old_close_failed", {
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    logger.info("claude-runtime.session_tools_replaced", { conversationId });
    return "replaced";
  }

  /**
   * Reactive entry for a broken in-process MCP transport, fired by the query
   * session when a `cc-session-tools` tool call comes back with the
   * SDK-synthesized "Stream closed" error. Routed into the supervisor's
   * turn-scoped state machine (rebind once; a failed rebind or a second close
   * this turn kills/recreates the runtime). The reactive rebind cannot save
   * the already-failed call — the SDK already returned "Stream closed" for it —
   * it repairs the binding so the agent's retry/next call succeeds. Stream-
   * closed signals for any other server are ignored here (the query session's
   * generic threshold is their backstop).
   */
  handleSdkMcpStreamClosed(info: SdkMcpStreamClosedInfo): void {
    if (info.serverName !== CC_SESSION_TOOLS_SERVER_NAME) return;
    this.sessionTools.onStreamClosed(info);
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

    // Late-bound: the runtime is constructed after the query session, so the
    // pump's stream-closed events route through this holder once it's set.
    let streamClosedRecoveryTarget: ClaudeConversationRuntime | null = null;

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
      onSdkMcpStreamClosed: (info) =>
        streamClosedRecoveryTarget?.handleSdkMcpStreamClosed(info),
      // The supervisor owns cc-session-tools recovery + the kill decision, so
      // its stream-closed results are excluded from the generic N=3 threshold.
      supervisedMcpServerName: CC_SESSION_TOOLS_SERVER_NAME,
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
      // Built with the same (projectPath, sessionName, mcpScopeConversationId)
      // the AskUserQuestion tool keys its runtime-state on, so the supervisor's
      // pending-question guard reads the resolver the tool installs.
      isQuestionPending: () =>
        hasActiveQuestionResolver(
          conversationRuntimeKey(
            input.projectPath,
            input.sessionName,
            mcpScopeConversationId,
          ),
        ),
    });
    streamClosedRecoveryTarget = runtime;

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
