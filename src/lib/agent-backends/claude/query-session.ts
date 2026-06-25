/**
 * QuerySession — owns a single long-lived SDK subprocess and its message pump.
 *
 * Manages creation, background message routing, per-turn prompt delivery, and teardown.
 * Each conversation gets at most one QuerySession at a time.
 */

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  Query,
  SDKMessage,
  SDKUserMessage,
  SDKAssistantMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKSystemMessage,
  CanUseTool,
  Options,
  Settings,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  MessageContentBlock,
  ToolResultMetrics,
} from "@/lib/conversations/schemas";
import type { EffortLevel } from "@/lib/agent-backends/schemas";
import {
  captureTraceContext,
  createLogger,
  runAsTrace,
  type TraceContext,
} from "@/lib/logging";
import {
  extractContextTokens,
  extractContextWindow,
} from "@/lib/conversations/context-fill";
import { parseToolResultMetrics } from "@/lib/conversations/parse-tool-result";
import {
  QUERY_SESSION_ERROR_CODES,
  tagQuerySessionError,
} from "./query-session-errors";
import {
  emptyBackgroundTaskState,
  applyTaskMessage,
  getWaitableInFlightTaskIds,
  type BackgroundTaskState,
} from "./background-task-tracker";

// Prevent nested session detection when CC runs inside Claude Code
import "@/lib/shared/sdk-env";

const logger = createLogger("query-session");

// ============================================================
// Types
// ============================================================

interface TurnOptions {
  /** When true, AskUserQuestion tool is denied (used by autonomous callers) */
  autonomous?: boolean;
}

export interface TurnResult {
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

/**
 * Result of a bounded wait for the session's waitable background tasks to
 * settle (drain the in-flight set with no turn active) or for the wait's hard
 * maximum duration to elapse. Never indicates a rejection — a timeout is
 * reported via `timedOut: true`, never thrown.
 */
export interface BackgroundWaitOutcome {
  /** Waitable in-flight task ids captured at the moment the wait began. */
  waitedTaskIds: string[];
  /** The `waitedTaskIds` that had drained from the waitable set by resolution. */
  settledTaskIds: string[];
  /** True when the hard maximum wait duration elapsed before the set drained. */
  timedOut: boolean;
  /** Wall-clock duration from the call to resolution. */
  durationMs: number;
}

type TurnEmit = (event: string, data: unknown) => void;
type SetMcpServersResult = Awaited<ReturnType<Query["setMcpServers"]>>;
export type McpMutationSource =
  | "runtime"
  | "replace_sdk_server_drop"
  | "replace_sdk_server_add";

/**
 * Details of a tool_result the SDK synthesized because its connection to an
 * MCP server was broken ("Stream closed"). `serverName` is parsed from the
 * `mcp__<server>__<tool>` tool name.
 */
export interface SdkMcpStreamClosedInfo {
  serverName: string;
  toolName: string;
  consecutiveCount: number;
}

export function shouldAlertMissingSupervisedServerMutation(input: {
  source: McpMutationSource;
  supervisedMcpServerName: string | undefined;
  serverKeys: readonly string[];
}): boolean {
  if (input.supervisedMcpServerName === undefined) return false;
  if (input.serverKeys.includes(input.supervisedMcpServerName)) return false;
  return input.source !== "replace_sdk_server_drop";
}

export interface QuerySession {
  /** Current health status */
  readonly status: "alive" | "dead";

  /** The conversation ID this session belongs to */
  readonly conversationId: string;

  /** The SDK Query object (for streamInput from queueMessage) */
  readonly query: Query;

  /** The current turn options (read by canUseTool) */
  readonly currentTurnOptions: TurnOptions | null;

  /** True while a turn (caller-initiated or virtual) is currently in flight. */
  readonly isTurnActive: boolean;

  /** Model this session was created with */
  readonly model: string | undefined;

  /** Effort level this session was created with */
  readonly effort: string | undefined;

  /** Output format this session was created with (for structured output) */
  readonly outputFormat:
    | { type: "json_schema"; schema: Record<string, unknown> }
    | undefined;

  /**
   * Live in-flight background-task state, derived from the SDK `task_*`
   * lifecycle messages (and their originating tool results). Passively tracked;
   * the implementer agent is not required to call any tool or emit any signal.
   */
  readonly backgroundTaskState: BackgroundTaskState;

  /**
   * Resolve when the waitable in-flight background-task set has drained AND no
   * turn is active, or when `timeoutMs` elapses (whichever comes first).
   *
   * Bounded and non-rejecting: a timeout resolves with `timedOut: true`; it
   * never rejects and never waits indefinitely. Failed/stopped tasks settle in
   * the tracker, so a failing background task also ends the wait. If the
   * subprocess dies while waiting, the wait resolves (`timedOut: false`) so a
   * dead session never hangs a waiter.
   */
  awaitBackgroundTaskSettlement(
    timeoutMs: number,
  ): Promise<BackgroundWaitOutcome>;

  /** Send a prompt and wait for the turn to complete */
  sendPrompt(
    prompt: string | MessageContentBlock[],
    emit: TurnEmit,
    options?: TurnOptions,
  ): Promise<TurnResult>;

  /** Apply MCP servers and update the session-owned active MCP config. */
  setMcpServers(
    mcpServers: Record<string, unknown>,
  ): Promise<SetMcpServersResult>;

  /**
   * Atomically re-bind an in-process (`type: "sdk"`) MCP server to a fresh
   * instance. The SDK's `setMcpServers` diffs sdk servers by NAME only — a
   * same-name instance swap in a single call is a silent no-op — so the only
   * working rebind is two sequential calls: drop the name (SDK disconnects
   * the old transport), then re-add it with the fresh instance. Both phases
   * run in one serialized MCP mutation so no other config apply can
   * interleave. The re-add result is verified: the name must appear in
   * `added` and not in `errors`, otherwise this rejects.
   *
   * `baseServers` is the current non-sdk server map to carry through both
   * phases (the sdk entry is stripped from the drop phase if present).
   */
  replaceSdkServer(
    serverName: string,
    instance: unknown,
    baseServers: Record<string, unknown>,
  ): Promise<SetMcpServersResult>;

  /**
   * Cancel the idle TTL timer because the caller is about to send a new turn.
   * Must be invoked at the moment the runtime is acquired for a new turn —
   * before any pre-turn pipeline work (state reads, MCP discovery, capability
   * cascades) that could otherwise outlast the remaining idle budget and let
   * the timer close the subprocess mid-prep. No-op on a dead session.
   */
  notifyTurnStarting(): void;

  /**
   * Force-terminate the subprocess because in-process MCP recovery for a
   * supervised server (`cc-session-tools`) is unrecoverable this turn. Kills
   * the live turn with a tagged `SDK_PIPE_BROKEN` error and closes the
   * subprocess, so the actor's get-or-create path builds a fresh (resumed)
   * runtime on the next prompt. This is the session-tools supervisor's own
   * kill decision and supersedes the generic consecutive-stream-closed
   * threshold (which never fires for the supervised server). No-op if dead.
   */
  forceTerminate(reason: string): void;

  /** Terminate the subprocess and clean up all resources */
  close(): void;
}

export interface QuerySessionOptions {
  conversationId: string;
  cwd: string;
  model: string | undefined;
  effort: EffortLevel | undefined;
  systemPrompt: {
    type: "preset";
    preset: "claude_code";
    append: string | undefined;
  };
  resume: string | undefined;
  forkSession: boolean | undefined;
  resumeSessionAt?: string | undefined;
  mcpServers: Record<string, unknown>;
  canUseTool: CanUseTool;
  env: Record<string, string | undefined>;
  maxTurns: number | undefined;
  plugins: Array<{ type: "local"; path: string }>;
  settingSources: Array<"user" | "project" | "local">;
  disallowedTools: string[];
  /** Idle TTL in ms — session is closed after this much inactivity (default: 5 min) */
  idleTtlMs?: number;
  /** MCP keepalive interval in ms — pings MCP servers between turns to prevent
   *  the SDK's transport inactivity timeout from closing the stream (default: 30s) */
  mcpKeepaliveIntervalMs?: number;
  /** Structured output format — enforced by the SDK at generation time */
  outputFormat?: {
    type: "json_schema";
    schema: Record<string, unknown>;
  };
  /**
   * Initial SDK Settings object passed to `Options.settings`. The Claude
   * factory builds this from the translated capability config so the SDK
   * applies plugin/skill overrides natively at session start instead of
   * relying on a post-hoc `applyFlagSettings` call.
   */
  settings?: Settings;
  /**
   * Optional handler for "virtual turns" — SDK message sequences that arrive
   * between caller-initiated prompts (e.g. Claude Code's background-task
   * auto-continuation feature). When a message arrives while pendingTurn is
   * null, the pump synthesizes a PendingTurn backed by this handler so the
   * message sequence is accumulated and resolved through the normal pipeline.
   */
  externalTurnHandler?: {
    emit: TurnEmit;
    onComplete: (result: TurnResult) => void;
  };
  /**
   * Fired when a tool_result arrives whose content is the SDK-synthesized
   * "Stream closed" error for an MCP tool — the SDK's transport to that
   * server is broken and the tool handler never ran. Fired only below the
   * pipe-broken escalation threshold so a listener can attempt recovery
   * (e.g. re-binding an in-process server via `replaceSdkServer`) before the
   * session is killed. Must not throw; errors are swallowed and logged.
   */
  onSdkMcpStreamClosed?: (info: SdkMcpStreamClosedInfo) => void;
  /**
   * Name of the in-process MCP server whose recovery is owned by an external
   * supervisor (`cc-session-tools`). A "Stream closed" tool_result for this
   * server is routed to `onSdkMcpStreamClosed` but EXCLUDED from the generic
   * consecutive-stream-closed pipe-broken threshold — the supervisor owns the
   * rebind and the kill decision, so the generic N=3 escalation must never
   * race it (the original incident). Stream-closed results for any other
   * server still feed the generic threshold (the backstop for non-supervised
   * servers, § honest external recovery).
   */
  supervisedMcpServerName?: string;
}

// ============================================================
// Internal state for a pending turn
// ============================================================

interface PendingTurn {
  resolve: (result: TurnResult) => void;
  reject: (error: Error) => void;
  emit: TurnEmit;
  sessionId: string | null;
  costUsd: number | null;
  durationMs: number | null;
  numTurns: number | null;
  contextTokens: number | null;
  contextWindow: number | null;
  contentBlocks: MessageContentBlock[];
  /** Map from tool_use.id → tool name, for parsing tool_result metrics. */
  toolNamesById: Map<string, string>;
  structuredOutput?: unknown;
  /**
   * Snapshot of the caller's trace context at sendPrompt time. The pump uses
   * this as the parent for each `sdk:turn:<conversationId>` wrap so downstream
   * emit/log work folds into the originating request's Speedscope group.
   */
  traceContext: TraceContext | null;
}

// ============================================================
// Internal state for a pending settlement waiter
// ============================================================

interface BackgroundWaiter {
  /** Waitable in-flight task ids captured when the wait began. */
  waitedTaskIds: string[];
  /** Wall-clock start (Date.now) so the outcome can report elapsed time. */
  startedAt: number;
  /** Hard-timeout timer; cleared when the waiter resolves normally. */
  timer: ReturnType<typeof setTimeout> | null;
  resolve: (outcome: BackgroundWaitOutcome) => void;
}

// ============================================================
// Factory
// ============================================================

/**
 * Create a new QuerySession that owns a long-lived SDK subprocess.
 *
 * The first prompt is delivered via an async generator (hanging generator pattern).
 * Subsequent prompts are delivered via streamInput().
 */
export function createQuerySession(options: QuerySessionOptions): QuerySession {
  const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const DEFAULT_MCP_KEEPALIVE_MS = 30_000; // 30 seconds
  const TOOL_RESULT_STREAM_CLOSED_THRESHOLD = 3;
  // Hard ceiling on any mcpServerStatus() probe. A hung probe must not block
  // the caller or (via keepaliveInFlight) permanently suppress future ticks.
  const MCP_STATUS_TIMEOUT_MS = 2_000;
  const idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  const mcpKeepaliveMs =
    options.mcpKeepaliveIntervalMs ?? DEFAULT_MCP_KEEPALIVE_MS;

  let status: "alive" | "dead" = "alive";
  let pendingTurn: PendingTurn | null = null;
  let currentTurnOptions: TurnOptions | null = null;
  let isFirstPrompt = true;
  let firstPromptResolve: ((msg: SDKUserMessage) => void) | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let mcpKeepaliveTimer: ReturnType<typeof setInterval> | null = null;
  const stderrChunks: string[] = [];
  let awaitingSubsequentPromptDelivery = false;
  let activeMcpServers: Record<string, unknown> = options.mcpServers;
  let mcpMutationQueue: Promise<unknown> = Promise.resolve();
  // Re-entrancy guard on the keepalive status probe. Without it, a slow probe
  // lets the keepalive interval queue concurrent ticks. The probe is bounded
  // (MCP_STATUS_TIMEOUT_MS) so the flag always clears — a hung probe can no
  // longer permanently suppress future ticks.
  let keepaliveInFlight = false;
  let consecutiveStreamClosedCount = 0;
  let backgroundTaskState = emptyBackgroundTaskState();
  const backgroundWaiters = new Set<BackgroundWaiter>();

  // The hanging generator: yields the first user message, then hangs forever.
  // This keeps the SDK subprocess alive indefinitely.
  async function* hangingGenerator(): AsyncGenerator<SDKUserMessage> {
    const firstMessage = await new Promise<SDKUserMessage>((resolve) => {
      firstPromptResolve = resolve;
    });
    yield firstMessage;
    // Hang forever — subsequent messages come via streamInput()
    await new Promise<void>(() => {});
  }

  // Create the SDK query with the hanging generator
  const sdkOptions: Options = {
    cwd: options.cwd,
    model: options.model ?? undefined,
    ...(options.effort ? { effort: options.effort as Options["effort"] } : {}),
    systemPrompt: options.systemPrompt,
    settingSources: options.settingSources,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    disallowedTools: options.disallowedTools,
    ...(options.plugins.length > 0 ? { plugins: options.plugins } : {}),
    ...(options.settings ? { settings: options.settings } : {}),
    ...(options.outputFormat ? { outputFormat: options.outputFormat } : {}),
    maxTurns: options.maxTurns,
    resume: options.resume,
    forkSession: options.forkSession,
    resumeSessionAt: options.resumeSessionAt,
    persistSession: true,
    env: options.env as Record<string, string>,
    mcpServers: options.mcpServers as Record<string, never>,
    strictMcpConfig: true,
    canUseTool: options.canUseTool,
    stderr: (data: string) => {
      stderrChunks.push(data);
    },
  };

  const q: Query = sdkQuery({
    prompt: hangingGenerator(),
    options: sdkOptions,
  });

  // Register in the session registry
  const session: QuerySession = {
    get status() {
      return status;
    },
    get conversationId() {
      return options.conversationId;
    },
    get query() {
      return q;
    },
    get currentTurnOptions() {
      return currentTurnOptions;
    },
    get isTurnActive() {
      return pendingTurn !== null;
    },
    get model() {
      return options.model;
    },
    get effort() {
      return options.effort;
    },
    get outputFormat() {
      return options.outputFormat;
    },
    get backgroundTaskState() {
      return backgroundTaskState;
    },
    awaitBackgroundTaskSettlement,
    sendPrompt,
    setMcpServers,
    replaceSdkServer,
    notifyTurnStarting,
    forceTerminate,
    close,
  };

  logger.info("query-session.created", {
    conversationId: options.conversationId,
    cwd: options.cwd,
    resume: !!options.resume,
  });

  // Start the background message pump
  void runPump();

  syncMcpKeepaliveTimer();

  return session;

  // ------------------------------------------------------------------
  // MCP config ownership
  // ------------------------------------------------------------------

  function mcpServerCount(mcpServers: Record<string, unknown>): number {
    return Object.keys(mcpServers).length;
  }

  /**
   * Phase 0 instrumentation: record every live MCP mutation so the root-cause
   * of in-process transport breakage can be settled empirically. Unexpected
   * payloads that drop the supervised server name (`cc-session-tools`) would
   * DISCONNECT the in-process server (the SDK diffs sdk servers by name), so
   * they are flagged at error level for correlation with stream-closed events.
   * The intentional drop phase of `replaceSdkServer` is telemetry only.
   */
  function logMcpMutation(
    source: McpMutationSource,
    serverKeys: string[],
  ): void {
    const supervised = options.supervisedMcpServerName;
    const includesCcSessionTools =
      supervised !== undefined && serverKeys.includes(supervised);
    logger.info("query-session.mcp_mutation", {
      conversationId: options.conversationId,
      source,
      serverKeys,
      includesCcSessionTools,
    });
    if (
      shouldAlertMissingSupervisedServerMutation({
        source,
        supervisedMcpServerName: supervised,
        serverKeys,
      })
    ) {
      logger.error("query-session.mcp_mutation_missing_supervised_server", {
        conversationId: options.conversationId,
        source,
        serverKeys,
        supervisedMcpServerName: supervised,
      });
    }
  }

  function hasActiveMcpServers(): boolean {
    return mcpServerCount(activeMcpServers) > 0;
  }

  function clearMcpKeepaliveTimer(): void {
    if (!mcpKeepaliveTimer) return;
    clearInterval(mcpKeepaliveTimer);
    mcpKeepaliveTimer = null;
  }

  function syncMcpKeepaliveTimer(): void {
    const shouldRun =
      status === "alive" && mcpKeepaliveMs > 0 && hasActiveMcpServers();

    if (!shouldRun) {
      clearMcpKeepaliveTimer();
      return;
    }

    if (mcpKeepaliveTimer) return;

    // The ping itself counts as transport activity, so it prevents the SDK's
    // idle timeout from closing the stream even during long-running turns.
    mcpKeepaliveTimer = setInterval(() => {
      if (status !== "alive") return;
      if (keepaliveInFlight) return;
      keepaliveInFlight = true;
      void mcpKeepaliveTick().finally(() => {
        keepaliveInFlight = false;
      });
    }, mcpKeepaliveMs);
  }

  function enqueueMcpMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = mcpMutationQueue.then(operation, operation);
    mcpMutationQueue = run.catch(() => undefined);
    return run;
  }

  async function applyMcpServers(
    mcpServers: Record<string, unknown>,
    source: McpMutationSource,
  ): Promise<SetMcpServersResult> {
    return enqueueMcpMutation(async () => {
      if (status === "dead") {
        throw new Error("QuerySession closed");
      }

      const serverKeys = Object.keys(mcpServers);
      const serverCount = serverKeys.length;
      logMcpMutation(source, serverKeys);
      try {
        const result = await q.setMcpServers(
          mcpServers as Record<string, never>,
        );
        activeMcpServers = mcpServers;
        syncMcpKeepaliveTimer();

        logger.info("query-session.mcp_servers_updated", {
          conversationId: options.conversationId,
          source,
          serverCount,
          added: result.added,
          removed: result.removed,
          errors: result.errors,
        });
        if (Object.keys(result.errors).length > 0) {
          logger.error("query-session.mcp_servers_connect_errors", {
            conversationId: options.conversationId,
            source,
            errors: result.errors,
          });
        }

        return result;
      } catch (err) {
        logger.error("query-session.mcp_servers_update_failed", {
          conversationId: options.conversationId,
          source,
          serverCount,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    });
  }

  async function setMcpServers(
    mcpServers: Record<string, unknown>,
  ): Promise<SetMcpServersResult> {
    return applyMcpServers(mcpServers, "runtime");
  }

  async function replaceSdkServer(
    serverName: string,
    instance: unknown,
    baseServers: Record<string, unknown>,
  ): Promise<SetMcpServersResult> {
    return enqueueMcpMutation(async () => {
      if (status === "dead") {
        throw new Error("QuerySession closed");
      }

      const withoutServer = { ...baseServers };
      delete withoutServer[serverName];
      logMcpMutation("replace_sdk_server_drop", Object.keys(withoutServer));
      await q.setMcpServers(withoutServer as Record<string, never>);

      const merged = {
        ...withoutServer,
        [serverName]: { type: "sdk", name: serverName, instance },
      };
      logMcpMutation("replace_sdk_server_add", Object.keys(merged));
      const result = await q.setMcpServers(merged as Record<string, never>);

      const connectError = result.errors[serverName];
      if (connectError !== undefined) {
        logger.error("query-session.sdk_server_replace_failed", {
          conversationId: options.conversationId,
          serverName,
          error: connectError,
        });
        throw new Error(
          `SDK MCP server "${serverName}" failed to connect on re-bind: ${connectError}`,
        );
      }
      if (!result.added.includes(serverName)) {
        logger.error("query-session.sdk_server_replace_not_rebound", {
          conversationId: options.conversationId,
          serverName,
          added: result.added,
        });
        throw new Error(
          `SDK MCP server "${serverName}" was not re-bound: setMcpServers reported success without adding it`,
        );
      }

      activeMcpServers = merged;
      syncMcpKeepaliveTimer();

      logger.info("query-session.sdk_server_replaced", {
        conversationId: options.conversationId,
        serverName,
      });

      return result;
    });
  }

  // ------------------------------------------------------------------
  // sendPrompt
  // ------------------------------------------------------------------

  async function sendPrompt(
    prompt: string | MessageContentBlock[],
    emit: TurnEmit,
    turnOptions?: TurnOptions,
  ): Promise<TurnResult> {
    if (status === "dead") {
      throw createPromptNotDeliveredError();
    }

    // Clear idle timer — a new prompt has arrived. Keepalive keeps ticking
    // through the turn to prevent transport idle timeouts during long turns.
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }

    currentTurnOptions = turnOptions ?? null;

    logger.debug("query-session.turn_start", {
      conversationId: options.conversationId,
      isFirstPrompt,
    });

    const callerTraceContext = captureTraceContext();
    return new Promise<TurnResult>((resolve, reject) => {
      pendingTurn = {
        resolve,
        reject,
        emit,
        sessionId: null,
        costUsd: null,
        durationMs: null,
        numTurns: null,
        contextTokens: null,
        contextWindow: null,
        contentBlocks: [],
        toolNamesById: new Map(),
        traceContext: callerTraceContext,
      };

      if (isFirstPrompt) {
        // Deliver via the hanging generator
        isFirstPrompt = false;
        const userMessage = buildUserMessage(prompt);
        if (firstPromptResolve) {
          firstPromptResolve(userMessage);
          firstPromptResolve = null;
        }
      } else {
        void sendSubsequentPrompt(prompt);
      }
    });
  }

  // ------------------------------------------------------------------
  // notifyTurnStarting
  // ------------------------------------------------------------------

  function notifyTurnStarting(): void {
    if (status === "dead") return;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  // ------------------------------------------------------------------
  // awaitBackgroundTaskSettlement
  // ------------------------------------------------------------------

  /** Tasks from `waitedTaskIds` that have drained from the live waitable set. */
  function settledFrom(waitedTaskIds: string[]): string[] {
    const inFlight = new Set(getWaitableInFlightTaskIds(backgroundTaskState));
    return waitedTaskIds.filter((id) => !inFlight.has(id));
  }

  function resolveWaiter(waiter: BackgroundWaiter, timedOut: boolean): void {
    if (!backgroundWaiters.has(waiter)) return;
    backgroundWaiters.delete(waiter);
    if (waiter.timer) {
      clearTimeout(waiter.timer);
      waiter.timer = null;
    }
    waiter.resolve({
      waitedTaskIds: waiter.waitedTaskIds,
      settledTaskIds: settledFrom(waiter.waitedTaskIds),
      timedOut,
      durationMs: Date.now() - waiter.startedAt,
    });
  }

  /**
   * Resolve every pending waiter whose condition is now satisfied: the waitable
   * in-flight set is empty AND no turn is active. Invoked at the end of
   * `processMessage` so both "task settled" (tracker update) and "turn finished"
   * (pendingTurn cleared on `result`) wake the waiters through the same pump.
   */
  function checkBackgroundTaskWaiters(): void {
    if (backgroundWaiters.size === 0) return;
    const settled =
      getWaitableInFlightTaskIds(backgroundTaskState).length === 0;
    if (!settled || pendingTurn !== null) return;
    for (const waiter of [...backgroundWaiters]) {
      resolveWaiter(waiter, false);
    }
  }

  /**
   * Resolve every pending settlement waiter because the subprocess is dying.
   * Reports whatever has settled and never flags a timeout, so a dead session
   * never hangs a waiter (Req 4.4). Reached by both `close()` and the
   * pump-internal death path (`markDead`); the `resolveWaiter` membership guard
   * makes the second caller a no-op.
   */
  function resolveWaitersOnDeath(): void {
    for (const waiter of [...backgroundWaiters]) {
      resolveWaiter(waiter, false);
    }
  }

  function awaitBackgroundTaskSettlement(
    timeoutMs: number,
  ): Promise<BackgroundWaitOutcome> {
    const waitedTaskIds = getWaitableInFlightTaskIds(backgroundTaskState);
    const startedAt = Date.now();

    return new Promise<BackgroundWaitOutcome>((resolve) => {
      const waiter: BackgroundWaiter = {
        waitedTaskIds,
        startedAt,
        timer: null,
        resolve,
      };

      // Already drained and no turn active — resolve on the next microtask so
      // the returned promise is consistently asynchronous.
      if (waitedTaskIds.length === 0 && pendingTurn === null) {
        resolve({
          waitedTaskIds,
          settledTaskIds: [],
          timedOut: false,
          durationMs: Date.now() - startedAt,
        });
        return;
      }

      backgroundWaiters.add(waiter);
      logger.debug("query-session.background_wait_started", {
        conversationId: options.conversationId,
        waitedTaskIds,
        timeoutMs,
      });

      waiter.timer = setTimeout(() => {
        logger.info("query-session.background_wait_timeout", {
          conversationId: options.conversationId,
          waitedTaskIds,
          timeoutMs,
        });
        resolveWaiter(waiter, true);
      }, timeoutMs);
    });
  }

  // ------------------------------------------------------------------
  // close
  // ------------------------------------------------------------------

  function close(): void {
    // Clear idle timer and MCP keepalive
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    clearMcpKeepaliveTimer();

    // Resolve any pending settlement waiters so a dead subprocess never hangs a
    // waiter. Report whatever has settled; never flag this as a timeout.
    resolveWaitersOnDeath();

    // Reject any pending turn
    if (pendingTurn) {
      const turn = pendingTurn;
      pendingTurn = null;
      currentTurnOptions = null;
      awaitingSubsequentPromptDelivery = false;
      turn.reject(new Error("QuerySession closed while turn was in progress"));
    }

    if (status === "dead") return; // idempotent

    status = "dead";

    logger.info("query-session.closed", {
      conversationId: options.conversationId,
    });

    // Close the SDK subprocess
    try {
      q.close();
    } catch {
      // best-effort
    }
  }

  // ------------------------------------------------------------------
  // Background message pump
  // ------------------------------------------------------------------

  async function runPump(): Promise<void> {
    try {
      for await (const message of q) {
        const parent = pendingTurn?.traceContext ?? null;
        runAsTrace(
          `sdk:turn:${options.conversationId}`,
          () => processMessage(message),
          parent,
        );
      }
      // Generator completed normally (subprocess exited cleanly)
      if (status === "alive") {
        markDead("pump_completed");
        let rejectError: Error;
        if (awaitingSubsequentPromptDelivery) {
          rejectError = createPromptNotDeliveredError();
        } else if (pendingTurn !== null) {
          rejectError = tagQuerySessionError(
            new Error("QuerySession ended before the turn completed"),
            QUERY_SESSION_ERROR_CODES.sessionDiedMidTurn,
          );
        } else {
          rejectError = new Error(
            "QuerySession ended before the turn completed",
          );
        }
        rejectPendingTurn(rejectError);
      }
    } catch (err) {
      if (status === "alive") {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const stderr =
          stderrChunks.length > 0 ? stderrChunks.join("") : undefined;
        logger.error("query-session.pump_error", {
          conversationId: options.conversationId,
          error: errorMsg,
          ...(stderr ? { stderr } : {}),
        });
        markDead("pump_error");

        // Reject pending turn with stderr attached
        const rejectError = err instanceof Error ? err : new Error(String(err));
        if (stderr) {
          (rejectError as Error & { stderr: string }).stderr = stderr;
        }
        rejectPendingTurn(
          awaitingSubsequentPromptDelivery
            ? tagQuerySessionError(
                rejectError,
                QUERY_SESSION_ERROR_CODES.promptNotDelivered,
              )
            : tagQuerySessionError(
                rejectError,
                QUERY_SESSION_ERROR_CODES.sessionDiedMidTurn,
              ),
        );
      }
    }
  }

  function markDead(reason: string): void {
    if (status === "dead") return;
    status = "dead";
    logger.info("query-session.dead", {
      conversationId: options.conversationId,
      reason,
    });
    // Pump-internal deaths (clean exit / pump_error) reach here without going
    // through close(); resolve pending settlement waiters so they unwind
    // promptly (timedOut: false) instead of hanging until the hard timeout.
    resolveWaitersOnDeath();
  }

  async function sendSubsequentPrompt(
    prompt: string | MessageContentBlock[],
  ): Promise<void> {
    awaitingSubsequentPromptDelivery = true;

    try {
      if (status === "dead") {
        throw createPromptNotDeliveredError();
      }

      // Pre-turn MCP health probe. The supervised in-process server's real
      // pre-turn guarantee is the actor-level forced rebind; this is a bounded
      // backstop that fails fast (throws → undelivered → actor recreates a
      // resumed runtime) rather than delivering the prompt into a runtime whose
      // supervised transport is definitively failed. It never recovers in-query.
      await assertPreTurnMcpHealthy();

      const userMessage = buildUserMessage(prompt);
      await q.streamInput(wrapAsIterable(userMessage));
      awaitingSubsequentPromptDelivery = false;
    } catch (err) {
      awaitingSubsequentPromptDelivery = false;

      const baseError = err instanceof Error ? err : new Error(String(err));
      const error = tagQuerySessionError(
        baseError,
        QUERY_SESSION_ERROR_CODES.promptNotDelivered,
      );

      logger.error("query-session.stream_input_error", {
        conversationId: options.conversationId,
        error: error.message,
      });

      if (status === "alive") {
        markDead("stream_input_error");
      }

      rejectPendingTurn(error);

      try {
        q.close();
      } catch {
        // best-effort
      }
    }
  }

  // ------------------------------------------------------------------
  // Pipe-broken escalation
  // ------------------------------------------------------------------

  function notifySdkMcpStreamClosed(
    toolName: string | undefined,
    consecutiveCount: number,
  ): void {
    if (!options.onSdkMcpStreamClosed || toolName === undefined) return;
    const serverName = parseMcpServerName(toolName);
    if (serverName === null) return;
    try {
      options.onSdkMcpStreamClosed({ serverName, toolName, consecutiveCount });
    } catch (err) {
      logger.warn("query-session.stream_closed_callback_failed", {
        conversationId: options.conversationId,
        toolName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function escalatePipeBroken(
    reason: "tool_result_pipe_broken",
    count: number,
  ): void {
    if (status === "dead") return;
    logger.error("query-session.pipe_broken", {
      conversationId: options.conversationId,
      reason,
      count,
    });
    markDead(reason);
    const taggedError = tagQuerySessionError(
      new Error(
        `SDK pipe broken: ${reason} after ${count} consecutive failures`,
      ),
      QUERY_SESSION_ERROR_CODES.sdkPipeBroken,
    );
    rejectPendingTurn(taggedError);
    try {
      q.close();
    } catch {
      // best-effort
    }
  }

  function forceTerminate(reason: string): void {
    if (status === "dead") return;
    logger.error("query-session.force_terminate", {
      conversationId: options.conversationId,
      reason,
    });
    markDead("force_terminate");
    const taggedError = tagQuerySessionError(
      new Error(`Session force-terminated: ${reason}`),
      QUERY_SESSION_ERROR_CODES.sdkPipeBroken,
    );
    rejectPendingTurn(taggedError);
    try {
      q.close();
    } catch {
      // best-effort
    }
  }

  // ------------------------------------------------------------------
  // MCP health — bounded, telemetry-grade probe (no in-query recovery)
  // ------------------------------------------------------------------

  function findFailedServers(
    statuses: Awaited<ReturnType<typeof q.mcpServerStatus>>,
  ): string[] {
    return statuses.filter((s) => s.status === "failed").map((s) => s.name);
  }

  type StatusProbe =
    | { kind: "ok"; statuses: Awaited<ReturnType<typeof q.mcpServerStatus>> }
    | { kind: "timeout" }
    | { kind: "error"; error: string };

  /**
   * Race `mcpServerStatus()` against a hard timeout so a hung probe always
   * settles. This is the fix for the `keepaliveInFlight`-never-resets bug — the
   * caller's `.finally` flag reset can only run if the probe completes.
   * `mcpServerStatus()` is treated as a weak/telemetry signal, never recovery-
   * grade: a `failed` entry is reported, never silently reconnected.
   */
  async function statusWithTimeout(timeoutMs: number): Promise<StatusProbe> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const TIMEOUT = Symbol("status_timeout");
    try {
      const statuses = await Promise.race([
        q.mcpServerStatus(),
        new Promise<typeof TIMEOUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
        }),
      ]);
      if (statuses === TIMEOUT) return { kind: "timeout" };
      return { kind: "ok", statuses };
    } catch (err) {
      return {
        kind: "error",
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Between-turn keepalive: the ping itself counts as transport activity (it
   * prevents the SDK's idle timeout from closing the stream during long turns)
   * and records health telemetry. v1 takes NO recovery action on a bare status
   * failure — recovery for the supervised in-process server is owned by the
   * external supervisor (pre-turn forced rebind + reactive state machine).
   */
  async function mcpKeepaliveTick(): Promise<void> {
    const probe = await statusWithTimeout(MCP_STATUS_TIMEOUT_MS);
    if (status !== "alive") return;
    if (probe.kind === "timeout") {
      logger.warn("query-session.mcp_status_timeout", {
        conversationId: options.conversationId,
        trigger: "keepalive",
        timeoutMs: MCP_STATUS_TIMEOUT_MS,
      });
      return;
    }
    if (probe.kind === "error") {
      logger.warn("query-session.mcp_keepalive_status_error", {
        conversationId: options.conversationId,
        error: probe.error,
      });
      return;
    }
    const failed = findFailedServers(probe.statuses);
    if (failed.length > 0) {
      logger.warn("query-session.mcp_keepalive_unhealthy", {
        conversationId: options.conversationId,
        failedServers: failed,
      });
    }
  }

  /**
   * Pre-turn MCP health backstop. Bounded and weak: a timeout/probe-error never
   * blocks delivery (the actor-level forced rebind is the real guarantee). Only
   * a DEFINITIVE failed status for the supervised server fails fast — throw so
   * `sendSubsequentPrompt` kills the session (tagged undelivered) and the actor
   * recreates a resumed runtime, rather than delivering into a broken transport.
   * Other failed servers are telemetry only; their backstop is the generic
   * mid-turn stream-closed threshold (§ honest external recovery).
   */
  async function assertPreTurnMcpHealthy(): Promise<void> {
    if (!hasActiveMcpServers()) return;
    const probe = await statusWithTimeout(MCP_STATUS_TIMEOUT_MS);
    if (status !== "alive") return;
    if (probe.kind === "timeout") {
      logger.warn("query-session.mcp_status_timeout", {
        conversationId: options.conversationId,
        trigger: "pre_turn",
        timeoutMs: MCP_STATUS_TIMEOUT_MS,
      });
      return;
    }
    if (probe.kind === "error") {
      logger.warn("query-session.mcp_pre_turn_status_error", {
        conversationId: options.conversationId,
        error: probe.error,
      });
      return;
    }
    const failed = findFailedServers(probe.statuses);
    if (failed.length === 0) return;

    const supervised = options.supervisedMcpServerName;
    const supervisedFailed =
      supervised !== undefined && failed.includes(supervised);
    logger.warn("query-session.mcp_pre_turn_unhealthy", {
      conversationId: options.conversationId,
      failedServers: failed,
      supervisedFailed,
    });
    if (!supervisedFailed) return;
    throw new Error(
      `Pre-turn MCP health check failed: supervised server "${supervised}" reported failed`,
    );
  }

  // ------------------------------------------------------------------
  // Message processing
  // ------------------------------------------------------------------

  function processMessage(message: SDKMessage): void {
    // Run after every path (early returns included) so both "task settled"
    // (tracker update) and "turn finished" (pendingTurn cleared on `result`)
    // wake the settlement waiters through the same pump.
    processMessageBody(message);
    checkBackgroundTaskWaiters();
  }

  function processMessageBody(message: SDKMessage): void {
    // Ingest background-task lifecycle BEFORE the idle-discard branch so a task
    // started/settled between turns is still tracked. applyTaskMessage ignores
    // non-task messages by returning the state unchanged. The per-turn
    // tool-name map lets a `task_started` resolve its originating tool (the
    // assistant tool_use is processed before task_started, so the name is
    // already recorded); when no turn is active the map is undefined and the
    // task defaults to waitable.
    backgroundTaskState = applyTaskMessage(backgroundTaskState, message, {
      toolNamesById: pendingTurn?.toolNamesById,
    });

    if (!pendingTurn) {
      if (!options.externalTurnHandler) {
        // Between turns — log and discard
        logger.debug("query-session.idle_message", {
          conversationId: options.conversationId,
          type: message.type,
        });
        return;
      }

      const handler = options.externalTurnHandler;
      const externalTurn: PendingTurn = {
        resolve: handler.onComplete,
        reject: (err: Error) => {
          logger.warn("query-session.virtual_turn_rejected", {
            conversationId: options.conversationId,
            error: err.message,
          });
          // The machine is in `externalExecuting`; without a completion it
          // wedges there with persisted status 'running'. Deliver the rejection
          // as a terminal result through the same handler the `result` path
          // uses so the external turn handler still emits
          // EXTERNAL_TURN_COMPLETED and the conversation settles back to idle.
          // The rejection fires inside session teardown (pump death, close);
          // a throwing handler must not escape and skip the remaining cleanup
          // (status = "dead", subprocess close).
          try {
            handler.onComplete(
              buildTurnResult(externalTurn, {
                error: err.message,
                aborted: false,
              }),
            );
          } catch (completionErr) {
            logger.error("query-session.virtual_turn_completion_failed", {
              conversationId: options.conversationId,
              error:
                completionErr instanceof Error
                  ? completionErr.message
                  : String(completionErr),
            });
          }
        },
        emit: handler.emit,
        sessionId: null,
        costUsd: null,
        durationMs: null,
        numTurns: null,
        contextTokens: null,
        contextWindow: null,
        contentBlocks: [],
        toolNamesById: new Map(),
        traceContext: null,
      };
      pendingTurn = externalTurn;

      logger.info("query-session.external_turn_started", {
        conversationId: options.conversationId,
        firstMessageType: message.type,
      });
    }

    const turn = pendingTurn;

    // Forward to turn's emit callback
    turn.emit("__raw_message", message);

    switch (message.type) {
      case "system": {
        const sysMsg = message as SDKSystemMessage;
        if (sysMsg.subtype === "init") {
          turn.sessionId = sysMsg.session_id;
        }
        break;
      }

      case "assistant": {
        awaitingSubsequentPromptDelivery = false;
        const asstMsg = message as SDKAssistantMessage;
        turn.sessionId = asstMsg.session_id;

        for (const block of asstMsg.message.content) {
          if (block.type === "text" && "text" in block) {
            const textBlock: MessageContentBlock = {
              type: "text",
              text: block.text,
            };
            turn.contentBlocks.push(textBlock);
          } else if (block.type === "tool_use" && "name" in block) {
            const toolBlock: MessageContentBlock = {
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: block.input as Record<string, unknown> | undefined,
            };
            turn.contentBlocks.push(toolBlock);
            turn.toolNamesById.set(block.id, block.name);
          }
        }

        // Track context window usage
        const contextTokens = extractContextTokens(asstMsg.message.usage);
        if (contextTokens > 0) {
          turn.contextTokens = contextTokens;
        }
        break;
      }

      case "user": {
        const userMsg = message as SDKUserMessage;
        const content = userMsg.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              block != null &&
              typeof block === "object" &&
              "type" in block &&
              block.type === "tool_result" &&
              "tool_use_id" in block &&
              typeof block.tool_use_id === "string"
            ) {
              const resultBlock = buildToolResultBlock(
                block as SdkToolResultBlock,
                turn.toolNamesById,
              );
              turn.contentBlocks.push(resultBlock);
              if (isStreamClosedToolResult(resultBlock)) {
                const toolName = turn.toolNamesById.get(
                  resultBlock.tool_use_id,
                );
                const serverName = toolName
                  ? parseMcpServerName(toolName)
                  : null;
                const isSupervised =
                  serverName !== null &&
                  serverName === options.supervisedMcpServerName;

                if (isSupervised) {
                  // The supervised in-process server owns its own recovery and
                  // kill decision via the external supervisor, so it is
                  // EXCLUDED from the generic consecutive-stream-closed
                  // threshold. Feeding it into that counter would let the
                  // generic N=3 kill race the supervisor's rebind — the
                  // original incident. Leave consecutiveStreamClosedCount
                  // untouched (neither bump nor reset): it tracks only
                  // non-supervised servers.
                  logger.warn("query-session.stream_closed_tool_result", {
                    conversationId: options.conversationId,
                    toolUseId: resultBlock.tool_use_id,
                    toolName,
                    supervised: true,
                    contentPreview: previewLogContent(resultBlock.content),
                  });
                  notifySdkMcpStreamClosed(toolName, 0);
                  continue;
                }

                consecutiveStreamClosedCount += 1;
                logger.warn("query-session.stream_closed_tool_result", {
                  conversationId: options.conversationId,
                  toolUseId: resultBlock.tool_use_id,
                  toolName,
                  consecutiveCount: consecutiveStreamClosedCount,
                  contentPreview: previewLogContent(resultBlock.content),
                });
                if (
                  consecutiveStreamClosedCount >=
                  TOOL_RESULT_STREAM_CLOSED_THRESHOLD
                ) {
                  escalatePipeBroken(
                    "tool_result_pipe_broken",
                    consecutiveStreamClosedCount,
                  );
                  return;
                }
                notifySdkMcpStreamClosed(
                  toolName,
                  consecutiveStreamClosedCount,
                );
              } else {
                consecutiveStreamClosedCount = 0;
              }
            }
          }
        }
        break;
      }

      case "result": {
        awaitingSubsequentPromptDelivery = false;
        const resultMsg = message as SDKResultSuccess | SDKResultError;
        turn.sessionId = resultMsg.session_id;
        turn.costUsd = resultMsg.total_cost_usd;
        turn.durationMs = resultMsg.duration_ms;
        turn.numTurns = resultMsg.num_turns;

        const contextWindow = extractContextWindow(resultMsg.modelUsage);
        if (contextWindow != null) {
          turn.contextWindow = contextWindow;
        }

        let error: string | null = null;
        if (resultMsg.subtype === "success" && !resultMsg.is_error) {
          turn.structuredOutput = (
            resultMsg as SDKResultSuccess
          ).structured_output;
        } else {
          error = extractResultMessageError(resultMsg);
        }

        // Resolve the turn promise
        const result: TurnResult = buildTurnResult(turn, {
          error,
          aborted: false,
        });

        const resolve = turn.resolve;
        pendingTurn = null;
        currentTurnOptions = null;

        logger.debug("query-session.turn_complete", {
          conversationId: options.conversationId,
          costUsd: result.costUsd,
          numTurns: result.numTurns,
        });

        resolve(result);

        // Start idle TTL timer — close session if no new prompt arrives. Do not
        // arm it while waitable background tasks are in flight, so a background
        // task's auto-continuation can still arrive past the default idle
        // window. The timer arms normally once the last waitable task settles
        // (its final virtual turn's `result`).
        if (
          idleTtlMs > 0 &&
          status === "alive" &&
          getWaitableInFlightTaskIds(backgroundTaskState).length === 0
        ) {
          idleTimer = setTimeout(() => {
            if (status === "alive" && !pendingTurn) {
              logger.info("query-session.idle_timeout", {
                conversationId: options.conversationId,
                idleTtlMs,
              });
              close();
            }
          }, idleTtlMs);
        }

        break;
      }

      default:
        // Other message types (user/tool_result, stream_event, etc.)
        // Already forwarded via emit above
        break;
    }
  }

  function rejectPendingTurn(error: Error): void {
    if (!pendingTurn) return;
    const turn = pendingTurn;
    pendingTurn = null;
    currentTurnOptions = null;
    awaitingSubsequentPromptDelivery = false;
    turn.reject(error);
  }

  function createPromptNotDeliveredError(): Error {
    return tagQuerySessionError(
      new Error("QuerySession died before prompt delivery"),
      QUERY_SESSION_ERROR_CODES.promptNotDelivered,
    );
  }
}

// ============================================================
// Helpers
// ============================================================

/**
 * Recover a human-readable error from a terminal `result` message.
 *
 * The SDK reports some failures — notably an inaccessible model — as a
 * `subtype: "success"` result with `is_error: true`, carrying the message in
 * `result` and omitting `structured_output`. Treating those as successful
 * turns surfaces the absent structured output downstream as a misleading
 * schema-validation failure ("$ must be object"), so the caller classifies
 * them as errors and recovers the real message from `result` here. Genuine
 * error subtypes carry their detail in `errors`.
 */
function extractResultMessageError(
  resultMsg: SDKResultSuccess | SDKResultError,
): string {
  if (resultMsg.subtype === "success") {
    const text = resultMsg.result?.trim();
    return text && text.length > 0 ? text : "Error during execution";
  }
  return resultMsg.errors?.length > 0
    ? resultMsg.errors.join("; ")
    : "Error during execution";
}

/**
 * Assemble a `TurnResult` from a pending turn's accumulated state. Used by both
 * terminal paths — the normal `result` message and the rejection that delivers
 * a virtual turn's completion when the subprocess dies mid-turn.
 */
function buildTurnResult(
  turn: PendingTurn,
  outcome: { error: string | null; aborted: boolean },
): TurnResult {
  return {
    sessionId: turn.sessionId,
    costUsd: turn.costUsd,
    durationMs: turn.durationMs,
    numTurns: turn.numTurns,
    contextTokens: turn.contextTokens,
    contextWindow: turn.contextWindow,
    contentBlocks: turn.contentBlocks,
    structuredOutput: turn.structuredOutput,
    aborted: outcome.aborted,
    error: outcome.error,
  };
}

interface SdkToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  is_error?: boolean;
  content?:
    | string
    | Array<{ type: string; text?: string; [k: string]: unknown }>;
}

type ToolResultContentBlock = Extract<
  MessageContentBlock,
  { type: "tool_result" }
>;

function extractToolResultText(
  content: SdkToolResultBlock["content"],
): string | undefined {
  if (typeof content === "string") return content || undefined;
  if (!Array.isArray(content)) return undefined;
  const textParts: string[] = [];
  for (const block of content) {
    if (
      block != null &&
      typeof block === "object" &&
      block.type === "text" &&
      typeof block.text === "string"
    ) {
      textParts.push(block.text);
    }
  }
  return textParts.length > 0 ? textParts.join("\n") : undefined;
}

/** Parse the server name out of an `mcp__<server>__<tool>` tool name. */
function parseMcpServerName(toolName: string): string | null {
  const match = /^mcp__(.+?)__/.exec(toolName);
  return match?.[1] ?? null;
}

function isStreamClosedToolResult(
  block: MessageContentBlock,
): block is ToolResultContentBlock & { isError: true; content: string } {
  return (
    block.type === "tool_result" &&
    block.isError === true &&
    typeof block.content === "string" &&
    block.content.includes("Stream closed")
  );
}

function previewLogContent(content: unknown): string | undefined {
  if (typeof content !== "string") return undefined;
  return content.length > 500 ? content.slice(0, 500) : content;
}

function buildToolResultBlock(
  block: SdkToolResultBlock,
  toolNamesById: Map<string, string>,
): MessageContentBlock {
  const text = extractToolResultText(block.content);
  const toolName = toolNamesById.get(block.tool_use_id);
  const metrics: ToolResultMetrics = toolName
    ? parseToolResultMetrics(toolName, text)
    : {};
  return {
    type: "tool_result",
    tool_use_id: block.tool_use_id,
    ...(text ? { content: text } : {}),
    ...(block.is_error ? { isError: true } : {}),
    ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
  };
}

function buildUserMessage(
  prompt: string | MessageContentBlock[],
): SDKUserMessage {
  if (typeof prompt === "string") {
    return {
      type: "user",
      session_id: "",
      message: {
        role: "user",
        content: [{ type: "text", text: prompt }],
      },
      parent_tool_use_id: null,
    } as SDKUserMessage;
  }

  // Convert CC's MessageContentBlock[] to Anthropic API content format
  const apiContent = prompt.map((block) => {
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
  });

  return {
    type: "user",
    session_id: "",
    message: {
      role: "user",
      content: apiContent,
    },
    parent_tool_use_id: null,
  } as SDKUserMessage;
}

async function* wrapAsIterable(
  msg: SDKUserMessage,
): AsyncGenerator<SDKUserMessage> {
  yield msg;
}
