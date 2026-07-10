/**
 * Claude ConversationBackendRuntime — wraps the Anthropic query() lifecycle
 * behind the backend-neutral conversation runtime interface.
 */

import type {
  CanUseTool,
  McpServerConfig,
  Settings,
} from "@anthropic-ai/claude-agent-sdk";

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
  type TurnResult,
} from "./query-session";
import { getWaitableInFlightTaskIds } from "./background-task-tracker";
import {
  isUndeliveredQuerySessionError,
  isSessionDiedMidTurnError,
} from "./query-session-errors";
import { buildClaudePromptBlocks } from "./build-prompt-blocks";
import { createCanUseTool } from "./native-tooling";
import { buildChildEnv } from "@/lib/shared/child-env";
import { buildSessionEnvContract } from "@/lib/agent-gateway/session-env";
import { getCachedInstanceToken } from "@/lib/agent-gateway/token";
import { getServerBaseUrl } from "@/lib/agent-gateway/server-url";
import { getConfigDirPath } from "@/lib/config/loader";
import { createLogger } from "@/lib/logging";
import {
  claudeModelSchema,
  claudeEffortLevelSchema,
} from "@/lib/agent-backends/schemas";
import { type McpDiscoveredTool } from "@/lib/mcp/schemas";
import { translatePortableMcpToClaude } from "../mcp-translation";
import { createPortableMcpFilterLookup } from "@/lib/mcp/portable-mcp-filter";
import { composeClaudeAgentCanUseTool } from "@/lib/agent-capabilities/claude-agent-suppression";
import { backendCapabilities } from "@/lib/agent-backends/capabilities-descriptor";

const logger = createLogger("claude:conversation-runtime");

/**
 * Default hard ceiling for the background-task wait barrier. Decoupled from the
 * 5-minute idle TTL (which is suppressed while waitable tasks are in flight) so
 * a long-running build/test can settle without the wait timing out prematurely.
 */
const DEFAULT_BACKGROUND_TASK_WAIT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Idle TTL for workflow-lane sessions. Graph-workflow inter-iteration gaps
 * (validation, scheduling) routinely exceed QuerySession's 5-minute default,
 * which killed lane subprocesses (and their children, e.g. dev servers)
 * between iterations. 60 minutes covers real gaps while still bounding the
 * subprocess leak for completed/halted lanes, which have no deterministic
 * close today (`idleTtlMs: 0` would disable the timer entirely and leak a
 * live subprocess per lane until session deletion).
 */
const WORKFLOW_LANE_IDLE_TTL_MS = 60 * 60 * 1000;

/**
 * Workflow-lane conversations (identified by a workflow execution id on the
 * create input) get the lane TTL; interactive conversations return undefined
 * and fall through to QuerySession's 5-minute default.
 */
export function resolveIdleTtlMs(
  workflowExecutionId: string | undefined,
): number | undefined {
  return workflowExecutionId !== undefined
    ? WORKFLOW_LANE_IDLE_TTL_MS
    : undefined;
}

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
  readonly alignmentVersion: number | null;

  private _status: "alive" | "dead" = "alive";
  private querySession: QuerySession;
  private readonly onPortableMcpApplied: (
    config: PortableMcpConfig | null,
  ) => void;
  private readonly onCapabilityConfigApplied: (
    config: ClaudeRuntimeCapabilityConfig,
  ) => Promise<void>;

  constructor(
    querySession: QuerySession,
    opts: {
      modelId?: string;
      reasoningEffort?: string;
      outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
      alignmentVersion?: number | null;
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
    },
  ) {
    this.querySession = querySession;
    this.modelId = opts.modelId;
    this.reasoningEffort = opts.reasoningEffort;
    this.outputFormat = opts.outputFormat;
    this.alignmentVersion = opts.alignmentVersion ?? null;
    this.onPortableMcpApplied = opts.onPortableMcpApplied ?? (() => {});
    this.onCapabilityConfigApplied =
      opts.onCapabilityConfigApplied ?? (async () => {});

    logger.info("claude-runtime.created", {
      conversationId: querySession.conversationId,
      modelId: opts.modelId,
    });
  }

  get isTurnActive(): boolean {
    return this.querySession.isTurnActive;
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
   * Pre-turn readiness contract. External MCP servers reach the SDK statically
   * at runtime creation, so a reused turn has no in-process rebind to perform —
   * the runtime is always ready.
   */
  async prepareForTurnStart(): Promise<ReadyResult> {
    return { status: "ready" };
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
        compacted: turnResult.compacted,
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
        compacted: false,
        error: wasAborted ? null : errorMsg,
      };
    }
  }

  async queueUserInput(input: ConversationQueuedUserInput): Promise<void> {
    const conversationId = this.querySession.conversationId;

    // Gate live delivery on the session being able to accept input. A dead
    // session cannot accept input, so reject (rather than silently resolve) —
    // the caller leaves the queue row pending for next-turn drain.
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

    // Resolution is gated on the session's persistent input channel being
    // consumed by the SDK: that is the live input-acceptance signal. A
    // rejection (tagged promptNotDelivered — the session died before
    // consuming it) propagates so the caller leaves the row pending.
    await this.querySession.queueUserInput(input.content);
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

    // The live SDK server set is fixed at runtime creation (static
    // `mcpServers`), so a changed server list only takes effect on the next
    // runtime. The tool-level enable/disable filter, however, is read live
    // through `onPortableMcpApplied`, so tool policy changes apply immediately
    // to `canUseTool`.
    this.onPortableMcpApplied(config);

    logger.info("claude-runtime.mcp_applied", {
      conversationId: this.querySession.conversationId,
      serverCount: Object.keys(servers).length,
    });

    return {
      disposition: "deferred_to_next_turn",
      droppedServerIds: rejectedServers,
      droppedFields: rejectedFields,
      errors: errorsByServer,
    };
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
          compacted: turnResult.compacted,
          error: turnResult.error,
        },
      });
    },
  };
}

// ============================================================
// Claude Conversation Backend Factory
// ============================================================

const claudeConversationBackendFactory = {
  backend: "claude" as AgentBackendId,

  async createRuntime(
    input: ConversationBackendCreateInput,
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

    // Mutable portable-config holder — reflects the resolver's current
    // effective output. Updated by applyPortableMcpConfig on successful apply.
    // The filter lookup reads from it live, so tool-policy changes take effect
    // in canUseTool without rebuilding the callback.
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

    // Build the external MCP servers config from tooling overrides and pass it
    // to the SDK statically at creation. External (non-CC) MCP servers are the
    // only servers CC binds now — there is no in-process CC server to merge.
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

    const idleTtlMs = resolveIdleTtlMs(input.workflowExecutionId);

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
      mcpServers: translatedServers,
      canUseTool: canUseTool as never,
      env: buildSessionEnvContract({
        baseEnv: buildChildEnv(),
        serverUrl: getServerBaseUrl(),
        apiToken: getCachedInstanceToken(),
        project: input.projectName,
        session: input.sessionName,
        conversationId: input.conversationId,
        configDir: getConfigDirPath(),
        ...(input.workflowExecutionId !== undefined
          ? { workflowExecutionId: input.workflowExecutionId }
          : {}),
        ...(input.workflowContextId !== undefined
          ? { workflowContextId: input.workflowContextId }
          : {}),
      }) as Record<string, string>,
      maxTurns: undefined,
      plugins: [],
      settingSources: ["user", "project", "local"],
      disallowedTools: ["AskUserQuestion"],
      outputFormat: input.outputFormat,
      externalTurnHandler,
      onBackgroundTasksLost: input.onBackgroundTasksLost,
      ...(idleTtlMs !== undefined ? { idleTtlMs } : {}),
      ...(initialSettings ? { settings: initialSettings } : {}),
    };

    const querySession = createQuerySession(sessionOptions);

    const runtime = new ClaudeConversationRuntime(querySession, {
      modelId: input.modelId,
      reasoningEffort: input.reasoningEffort,
      outputFormat: input.outputFormat,
      alignmentVersion: input.alignmentVersion ?? null,
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

    logger.info("claude-runtime.initial_mcp_set", {
      conversationId: input.conversationId,
      serverCount: Object.keys(translatedServers).length,
    });

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
