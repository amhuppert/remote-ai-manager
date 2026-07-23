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
  SDKCompactBoundaryMessage,
  CanUseTool,
  Options,
  Settings,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  MessageContentBlock,
  ToolResultMetrics,
} from "@/lib/conversations/schemas";
import type { EffortLevel } from "@/lib/agent-backends/schemas";
import type { BackgroundTasksLostInfo } from "@/lib/agent-backends/conversation";
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
import {
  recordLiveOccupancy,
  markLiveCompaction,
  clearLiveOccupancy,
} from "@/lib/conversations/live-occupancy";
import { parseToolResultMetrics } from "@/lib/conversations/parse-tool-result";
import { mapAssistantContentBlocks } from "./map-content-blocks";
import {
  QUERY_SESSION_ERROR_CODES,
  tagQuerySessionError,
} from "./query-session-errors";
import {
  emptyBackgroundTaskState,
  applyTaskMessage,
  getWaitableInFlightTaskIds,
  demoteTasksToExcluded,
  type BackgroundTaskState,
} from "./background-task-tracker";

// Prevent nested session detection when CC runs inside Claude Code
import "@/lib/shared/sdk-env";
import { getErrorMessage } from "@/lib/shared/errors";
import { mapErrorSubtype } from "./process-message";

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
  finalText?: string;
  structuredOutput?: unknown;
  aborted: boolean;
  /** True when the SDK auto-compacted the context at least once this turn. */
  compacted: boolean;
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

/**
 * The slice of the SDK `Query` surface QuerySession and its consumers actually
 * use: the message pump iterates it, teardown closes it, and the conversation
 * runtime issues these control-plane requests through the `query` getter.
 * Structural (rather than the full `Query` interface) so the conformance
 * suite's fake provider port can implement it without type fictions.
 */
export interface ClaudeSdkQueryPort extends AsyncIterable<SDKMessage> {
  close(): void;
  supportedCommands(): ReturnType<Query["supportedCommands"]>;
  supportedAgents(): ReturnType<Query["supportedAgents"]>;
  mcpServerStatus(): ReturnType<Query["mcpServerStatus"]>;
  applyFlagSettings(
    settings: Parameters<Query["applyFlagSettings"]>[0],
  ): Promise<void>;
  /** Callers ignore the reload response; typed loosely so the real `Query`
   * (which returns the full reload summary) satisfies the port. */
  reloadPlugins(): Promise<unknown>;
}

export type CreateSdkQuery = (args: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => ClaudeSdkQueryPort;

const defaultCreateSdkQuery: CreateSdkQuery = (args) => sdkQuery(args);

let createSdkQueryImpl: CreateSdkQuery = defaultCreateSdkQuery;

/**
 * Test-only provider-port seam: replaces the SDK `query()` call with a fake
 * provider port so the conformance suite can drive the REAL QuerySession pump
 * and Claude runtime without a subprocess. Pass null to restore the SDK.
 */
export function _setSdkQueryForTesting(impl: CreateSdkQuery | null): void {
  createSdkQueryImpl = impl ?? defaultCreateSdkQuery;
}

export interface QuerySession {
  /** Current health status */
  readonly status: "alive" | "dead";

  /** The conversation ID this session belongs to */
  readonly conversationId: string;

  /**
   * The SDK Query object — control-plane requests only (supportedCommands,
   * mcpServerStatus, applyFlagSettings, …). Never use `query.streamInput()`
   * to deliver input: the SDK closes the CLI's stdin when a streamInput
   * iterable completes, dooming the subprocess. Deliver through sendPrompt /
   * queueUserInput, which feed the session's persistent input channel.
   */
  readonly query: ClaudeSdkQueryPort;

  /** The current turn options (read by canUseTool) */
  readonly currentTurnOptions: TurnOptions | null;

  /** True while a turn (caller-initiated or virtual) is currently in flight. */
  readonly isTurnActive: boolean;

  /** Model this session was created with */
  readonly model: string | undefined;

  /** Effort level this session was created with */
  readonly effort: string | undefined;

  /**
   * Live in-flight background-task state, derived from the SDK `task_*`
   * lifecycle messages (and their originating tool results). Passively tracked;
   * the implementer agent is not required to call any tool or emit any signal.
   */
  readonly backgroundTaskState: BackgroundTaskState;

  /**
   * Resolve when every waitable in-flight task captured at the moment the wait
   * began has left the waitable set AND no turn is active, or when `timeoutMs`
   * elapses (whichever comes first). Per-waiter: tasks that start AFTER the
   * wait began (including run-forever watches) do not hold this waiter open.
   *
   * Bounded and non-rejecting: a timeout resolves with `timedOut: true`; it
   * never rejects and never waits indefinitely. Failed/stopped tasks settle in
   * the tracker, so a failing background task also ends the wait. Tasks still
   * running at the timeout are demoted to `excluded` so they never stall a
   * later wait. If the subprocess dies while waiting, the wait resolves
   * (`timedOut: false`) so a dead session never hangs a waiter.
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

  /**
   * Deliver user input into the live session through the persistent input
   * channel (mid-turn queued messages). Resolves once the SDK has consumed
   * the message (its stdin write completed); rejects with a
   * promptNotDelivered-tagged error when the session is dead or dies before
   * consuming it, so the caller can leave the queue row pending.
   */
  queueUserInput(content: string | MessageContentBlock[]): Promise<void>;

  /**
   * Cancel the idle TTL timer because the caller is about to send a new turn.
   * Must be invoked at the moment the runtime is acquired for a new turn —
   * before any pre-turn pipeline work (state reads, MCP discovery, capability
   * cascades) that could otherwise outlast the remaining idle budget and let
   * the timer close the subprocess mid-prep. No-op on a dead session.
   */
  notifyTurnStarting(): void;

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
   * Invoked at most once, when the session reaches `dead` with waitable
   * background tasks still in flight. Those task processes are children of
   * the subprocess — they die with it, and their completion can no longer
   * wake the agent. The caller surfaces the loss to the user and to the
   * conversation's next turn. Excluded (watch-style/demoted) tasks are not
   * reported: they carry no wake-on-complete promise.
   */
  onBackgroundTasksLost?: (info: BackgroundTasksLostInfo) => void;
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
  /** Set true when an SDK compact_boundary is observed during this turn. */
  compacted: boolean;
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
 * All input — every prompt and mid-turn queued user input — is delivered
 * through a single persistent async generator handed to the SDK at creation.
 * `Query.streamInput()` must never be used for delivery: the SDK calls
 * `transport.endInput()` (closing the CLI's stdin) once a streamInput iterable
 * completes, which schedules the subprocess to exit after the in-flight turn
 * and silently drops background-task auto-continuations.
 */
export function createQuerySession(options: QuerySessionOptions): QuerySession {
  const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;

  let status: "alive" | "dead" = "alive";
  let pendingTurn: PendingTurn | null = null;
  let currentTurnOptions: TurnOptions | null = null;
  let isFirstPrompt = true;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const stderrChunks: string[] = [];
  let awaitingSubsequentPromptDelivery = false;
  let backgroundTaskState = emptyBackgroundTaskState();
  const backgroundWaiters = new Set<BackgroundWaiter>();
  // The SDK's `result.total_cost_usd` is CUMULATIVE for the session lineage,
  // while every consumer of `TurnResult.costUsd` (conversation totals, usage
  // accounting) sums per-turn values. Track the last attributed cumulative so
  // each turn carries only its delta. Advanced only when a result is
  // attributed to a turn, so a discarded between-turns segment's cost rides
  // into the next attributed turn instead of vanishing.
  let attributedCostBaseline = 0;
  let attributedCostSessionId: string | null = null;

  // The persistent input channel: the SDK consumes this generator for the
  // session's whole life. It never returns, so the SDK never closes the CLI's
  // stdin; teardown happens exclusively through q.close().
  interface PendingInput {
    msg: SDKUserMessage;
    resolveDelivered: () => void;
    rejectDelivered: (err: Error) => void;
  }
  const inputQueue: PendingInput[] = [];
  let inputWakeup: (() => void) | null = null;
  let inFlightInput: PendingInput | null = null;

  /**
   * Enqueue a message for the SDK to consume from the input channel. Resolves
   * once the SDK has consumed it (its stdin write completed); rejected by
   * rejectPendingInputs when the session dies first.
   */
  function pushInput(msg: SDKUserMessage): Promise<void> {
    const delivered = new Promise<void>((resolve, reject) => {
      inputQueue.push({
        msg,
        resolveDelivered: resolve,
        rejectDelivered: reject,
      });
    });
    if (inputWakeup) {
      const wake = inputWakeup;
      inputWakeup = null;
      wake();
    }
    return delivered;
  }

  async function* inputChannel(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const entry = inputQueue.shift();
      if (!entry) {
        await new Promise<void>((resolve) => {
          inputWakeup = resolve;
        });
        continue;
      }
      inFlightInput = entry;
      yield entry.msg;
      // Control resumes when the SDK requests the next message, i.e. after it
      // finished writing the yielded one to the CLI's stdin.
      inFlightInput = null;
      entry.resolveDelivered();
    }
  }

  /** Reject every undelivered input so no delivery awaiter outlives the session. */
  function rejectPendingInputs(): void {
    const undelivered = inFlightInput
      ? [inFlightInput, ...inputQueue]
      : [...inputQueue];
    inFlightInput = null;
    inputQueue.length = 0;
    for (const entry of undelivered) {
      entry.rejectDelivered(createPromptNotDeliveredError());
    }
  }

  const sdkOptions: Options = {
    cwd: options.cwd,
    model: options.model ?? undefined,
    ...(options.effort ? { effort: options.effort as Options["effort"] } : {}),
    // Surface a summary of the model's reasoning so thinking blocks carry text.
    // On Opus 4.7/4.8 the thinking summary is `omitted` by default; without
    // this, thinking blocks stream empty. Adaptive is already the preset
    // default for supported models — we only opt into the summarized display.
    thinking: { type: "adaptive", display: "summarized" },
    systemPrompt: options.systemPrompt,
    settingSources: options.settingSources,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    disallowedTools: options.disallowedTools,
    ...(options.plugins.length > 0 ? { plugins: options.plugins } : {}),
    ...(options.settings ? { settings: options.settings } : {}),
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

  const q: ClaudeSdkQueryPort = createSdkQueryImpl({
    prompt: inputChannel(),
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
    get backgroundTaskState() {
      return backgroundTaskState;
    },
    awaitBackgroundTaskSettlement,
    sendPrompt,
    queueUserInput,
    notifyTurnStarting,
    close,
  };

  logger.info("query-session.created", {
    conversationId: options.conversationId,
    cwd: options.cwd,
    resume: !!options.resume,
  });

  // Start the background message pump
  void runPump();

  return session;

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

    // Clear idle timer — a new prompt has arrived, so the session is no longer idle.
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
        compacted: false,
        toolNamesById: new Map(),
        traceContext: callerTraceContext,
      };

      if (isFirstPrompt) {
        isFirstPrompt = false;
      } else {
        // Cleared when delivery is observed (channel consumption, or the
        // turn's first assistant/result message); a pump death while still
        // set tags the rejection promptNotDelivered so the caller knows the
        // prompt never reached the CLI and can redeliver.
        awaitingSubsequentPromptDelivery = true;
      }
      pushInput(buildUserMessage(prompt)).then(
        () => {
          awaitingSubsequentPromptDelivery = false;
        },
        () => {
          // Delivery rejection means the session died first; the pump-death
          // path settles the turn.
        },
      );
    });
  }

  // ------------------------------------------------------------------
  // queueUserInput
  // ------------------------------------------------------------------

  async function queueUserInput(
    content: string | MessageContentBlock[],
  ): Promise<void> {
    if (status === "dead") {
      throw createPromptNotDeliveredError();
    }
    await pushInput(buildUserMessage(content));
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
   * Resolve every pending waiter whose condition is now satisfied: all tasks
   * captured at ITS wait begin have left the waitable in-flight set AND no
   * turn is active. Per-waiter, so a task started after the wait began (e.g. a
   * run-forever dev server) never holds an unrelated waiter open. Invoked at
   * the end of `processMessage` so both "task settled" (tracker update) and
   * "turn finished" (pendingTurn cleared on `result`) wake the waiters through
   * the same pump.
   */
  function checkBackgroundTaskWaiters(): void {
    if (backgroundWaiters.size === 0) return;
    if (pendingTurn !== null) return;
    for (const waiter of [...backgroundWaiters]) {
      if (
        settledFrom(waiter.waitedTaskIds).length === waiter.waitedTaskIds.length
      ) {
        resolveWaiter(waiter, false);
      }
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
        // Snapshot the survivors before resolving so the outcome's
        // settledTaskIds reflects what actually settled, then demote them:
        // a task that survived a full wait timeout will not settle on its
        // own and must not hold later barriers open.
        const inFlight = new Set(
          getWaitableInFlightTaskIds(backgroundTaskState),
        );
        const stillInFlight = waiter.waitedTaskIds.filter((id) =>
          inFlight.has(id),
        );
        resolveWaiter(waiter, true);
        if (stillInFlight.length > 0) {
          backgroundTaskState = demoteTasksToExcluded(
            backgroundTaskState,
            stillInFlight,
          );
          logger.info("query-session.background_tasks_demoted", {
            conversationId: options.conversationId,
            taskIds: stillInFlight,
          });
          reconcileIdleTimer();
        }
      }, timeoutMs);
    });
  }

  // ------------------------------------------------------------------
  // idle TTL
  // ------------------------------------------------------------------

  /**
   * Enforce the idle-TTL invariant: the timer is live only while the session
   * is idle-closable — alive, no turn in flight, and no waitable background
   * task in flight (a waitable task's auto-continuation must be able to
   * arrive arbitrarily late, so its subprocess must never be idle-closed).
   *
   * Called after every pumped message and from the wait-timeout demotion
   * path, so all four transitions hold without coordination:
   * - a turn `result` with a drained waitable set arms the timer;
   * - a waitable task starting between turns (or an external turn opening)
   *   DISARMS a previously-armed timer — the timer's arm-time eligibility
   *   check alone is a TOCTOU hole: a timer armed while the set was
   *   momentarily empty would otherwise fire later and kill the task
   *   (incident 2026-07-09, conversation ce3106b6);
   * - a settlement that drains the set between turns with no
   *   auto-continuation following arms the timer, so a
   *   notification-without-continuation never leaks the subprocess;
   * - an already-armed timer is left running while eligibility holds, so
   *   stray between-turn messages do not extend the idle window.
   */
  function reconcileIdleTimer(): void {
    if (idleTtlMs <= 0 || status !== "alive") return;
    const eligible =
      pendingTurn === null &&
      getWaitableInFlightTaskIds(backgroundTaskState).length === 0;
    if (!eligible) {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      return;
    }
    if (idleTimer) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      // Re-check eligibility at fire time — the backstop against any race
      // the reconcile call sites miss. Skipping without re-arming is safe:
      // whichever event made the session ineligible will reconcile again
      // when it drains.
      if (status !== "alive" || pendingTurn !== null) return;
      if (getWaitableInFlightTaskIds(backgroundTaskState).length > 0) return;
      logger.info("query-session.idle_timeout", {
        conversationId: options.conversationId,
        idleTtlMs,
      });
      close();
    }, idleTtlMs);
  }

  // ------------------------------------------------------------------
  // close
  // ------------------------------------------------------------------

  function close(): void {
    // Clear idle timer
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }

    // Resolve any pending settlement waiters so a dead subprocess never hangs a
    // waiter. Report whatever has settled; never flag this as a timeout.
    resolveWaitersOnDeath();
    rejectPendingInputs();

    // Reject any pending turn
    if (pendingTurn) {
      const turn = pendingTurn;
      pendingTurn = null;
      currentTurnOptions = null;
      awaitingSubsequentPromptDelivery = false;
      clearLiveOccupancy(options.conversationId);
      turn.reject(new Error("QuerySession closed while turn was in progress"));
    }

    if (status === "dead") return; // idempotent

    status = "dead";

    logger.info("query-session.closed", {
      conversationId: options.conversationId,
    });

    notifyBackgroundTasksLostIfAny("closed");

    // Close the SDK subprocess
    try {
      q.close();
    } catch {
      // best-effort
    }
  }

  /**
   * Surface waitable tasks that die with the session. Fires at most once —
   * both death paths (`close`, `markDead`) flip `status` before calling, and
   * the second caller returns on the idempotency guard above it.
   */
  function notifyBackgroundTasksLostIfAny(reason: string): void {
    const lostIds = getWaitableInFlightTaskIds(backgroundTaskState);
    if (lostIds.length === 0) return;
    const tasks = lostIds.map((taskId) => ({
      taskId,
      description: backgroundTaskState.tasks.get(taskId)?.description ?? null,
    }));
    logger.warn("query-session.background_tasks_lost", {
      conversationId: options.conversationId,
      reason,
      taskIds: lostIds,
    });
    try {
      options.onBackgroundTasksLost?.({ tasks, reason });
    } catch (err) {
      logger.error("query-session.background_tasks_lost_callback_failed", {
        conversationId: options.conversationId,
        error: getErrorMessage(err),
      });
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
        const errorMsg = getErrorMessage(err);
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
    notifyBackgroundTasksLostIfAny(reason);
    // Pump-internal deaths (clean exit / pump_error) reach here without going
    // through close(); resolve pending settlement waiters so they unwind
    // promptly (timedOut: false) instead of hanging until the hard timeout.
    resolveWaitersOnDeath();
    rejectPendingInputs();
  }

  // ------------------------------------------------------------------
  // Message processing
  // ------------------------------------------------------------------

  function processMessage(message: SDKMessage): void {
    // Run after every path (early returns included) so both "task settled"
    // (tracker update) and "turn finished" (pendingTurn cleared on `result`)
    // wake the settlement waiters through the same pump. The idle-timer
    // reconcile runs last, once the message's full effect on pendingTurn and
    // the waitable set is visible.
    processMessageBody(message);
    checkBackgroundTaskWaiters();
    reconcileIdleTimer();
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
        compacted: false,
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
        if (message.subtype === "compact_boundary") {
          const { compact_metadata } = message as SDKCompactBoundaryMessage;
          turn.compacted = true;
          markLiveCompaction(options.conversationId);
          logger.info("query-session.compact_boundary", {
            conversationId: options.conversationId,
            trigger: compact_metadata.trigger,
            preTokens: compact_metadata.pre_tokens,
            postTokens: compact_metadata.post_tokens,
          });
          break;
        }
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

        for (const block of mapAssistantContentBlocks(
          asstMsg.message.content,
        )) {
          turn.contentBlocks.push(block);
          if (block.type === "tool_use" && block.id) {
            turn.toolNamesById.set(block.id, block.name);
          }
        }

        // Track context window usage
        const contextTokens = extractContextTokens(asstMsg.message.usage);
        if (contextTokens > 0) {
          turn.contextTokens = contextTokens;
          // Publish the same reading to the live-occupancy registry so the
          // mid-turn complete_task gate sees identical semantics to the
          // recorded last-wins value, but observable while the turn is in
          // flight (before a compaction can mask it).
          recordLiveOccupancy(options.conversationId, contextTokens);
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
            }
          }
        }
        break;
      }

      case "result": {
        awaitingSubsequentPromptDelivery = false;
        const resultMsg = message as SDKResultSuccess | SDKResultError;
        turn.sessionId = resultMsg.session_id;
        if (
          attributedCostSessionId !== resultMsg.session_id ||
          resultMsg.total_cost_usd < attributedCostBaseline
        ) {
          // New lineage: fresh/forked session, or a restarted subprocess that
          // resumed the SAME session id with its cumulative reset — the
          // cumulative can only decrease on such a restart, so a drop below
          // the baseline is the lineage boundary.
          attributedCostBaseline = 0;
          attributedCostSessionId = resultMsg.session_id;
        }
        turn.costUsd = Math.max(
          0,
          resultMsg.total_cost_usd - attributedCostBaseline,
        );
        attributedCostBaseline = resultMsg.total_cost_usd;
        turn.durationMs = resultMsg.duration_ms;
        turn.numTurns = resultMsg.num_turns;

        const contextWindow = extractContextWindow(resultMsg.modelUsage);
        if (contextWindow != null) {
          turn.contextWindow = contextWindow;
        }

        let error: string | null = null;
        let finalText: string | undefined;
        if (resultMsg.subtype === "success" && !resultMsg.is_error) {
          turn.structuredOutput = (
            resultMsg as SDKResultSuccess
          ).structured_output;
          finalText =
            typeof resultMsg.result === "string" ? resultMsg.result : undefined;
        } else {
          error = extractResultMessageError(resultMsg);
        }

        // Resolve the turn promise
        const result: TurnResult = buildTurnResult(turn, {
          error,
          aborted: false,
          ...(finalText !== undefined ? { finalText } : {}),
        });

        const resolve = turn.resolve;
        pendingTurn = null;
        currentTurnOptions = null;
        clearLiveOccupancy(options.conversationId);

        logger.debug("query-session.turn_complete", {
          conversationId: options.conversationId,
          costUsd: result.costUsd,
          numTurns: result.numTurns,
          hasFinalText: result.finalText !== undefined,
        });

        resolve(result);

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
    clearLiveOccupancy(options.conversationId);
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
 * them as errors and recovers the real message from `result` here. Error
 * subtypes are mapped from their typed cause so optional detail cannot erase
 * the provider's failure classification.
 */
function extractResultMessageError(
  resultMsg: SDKResultSuccess | SDKResultError,
): string {
  if (resultMsg.subtype === "success") {
    const text = resultMsg.result?.trim();
    return text && text.length > 0 ? text : "Error during execution";
  }
  return mapErrorSubtype(resultMsg);
}

/**
 * Assemble a `TurnResult` from a pending turn's accumulated state. Used by both
 * terminal paths — the normal `result` message and the rejection that delivers
 * a virtual turn's completion when the subprocess dies mid-turn.
 */
function buildTurnResult(
  turn: PendingTurn,
  outcome: { error: string | null; aborted: boolean; finalText?: string },
): TurnResult {
  return {
    sessionId: turn.sessionId,
    costUsd: turn.costUsd,
    durationMs: turn.durationMs,
    numTurns: turn.numTurns,
    contextTokens: turn.contextTokens,
    contextWindow: turn.contextWindow,
    contentBlocks: turn.contentBlocks,
    ...(outcome.finalText !== undefined
      ? { finalText: outcome.finalText }
      : {}),
    structuredOutput: turn.structuredOutput,
    aborted: outcome.aborted,
    compacted: turn.compacted,
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
