import {
  applyCursorTaskEvent,
  cursorTaskActivity,
  isCursorTaskRunning,
  CURSOR_BACKGROUND_INSTRUCTIONS,
  type CursorTaskState,
} from "./background-tasks";
import type { CursorCapabilityDelivery } from "./capability-delivery";
import type { ConversationTarget } from "@/lib/conversations/conversation-target";
import type { MessageContentBlock } from "@/lib/conversations/message-content-schemas";
import {
  clearLiveOccupancy,
  markLiveCompaction,
} from "@/lib/conversations/live-occupancy";
import { computeEffectiveConfigHash } from "@/lib/mcp/config-hash";
import { createLogger } from "@/lib/logging";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import type {
  ConversationBackendCreateInput,
  ConversationBackendEvent,
  ConversationBackendRuntime,
  ConversationBackendTurnInput,
  ConversationBackendTurnResult,
  ConversationQueuedUserInput,
} from "../conversation";
import {
  InputDeliveryUncertainError,
  type AgentFailureClassification,
} from "../errors";
import { getErrorMessage } from "@/lib/shared/errors";
import type { McpApplyResult, PortableMcpConfig } from "../portable-mcp";
import type { ConversationTokenUsage } from "../schemas";
import type { BackendModelSelection } from "../schemas";
import { appendStructuredOutputInstruction } from "../structured-output-prompt";
import type { FsWritePolicy } from "../task";
import { CURSOR_BACKEND_ID } from "./backend-id";
import { CursorSteering } from "./steering";
import { appendCursorContentDelta } from "./content-deltas";
import { mayForceExpire } from "./continuity";
import {
  assertCursorRuntimePolicy,
  cursorWritePolicyInstructions,
} from "./runtime-policy";
import {
  createCursorFailureClassifier,
  CursorLocalFailure,
} from "./failure-classifier";
import { translateCursorImages } from "./image-input";
import type { PortableMcpToCursorResult } from "./mcp-translation";
import { projectCursorNativeEvent } from "./transcript-projections";
import {
  CURSOR_CANCEL_SETTLE_TIMEOUT_MS,
  CURSOR_ATTACH_TIMEOUT_MS,
  CURSOR_TURN_STALL_TIMEOUT_MS,
} from "./worker/bounds";
import type { CursorWorkerMcpServer } from "./worker/entry";
import { decodeNativePayload, type CursorWorkerFrame } from "./worker/ipc";
import type {
  CursorWorkerSession,
  CursorWorkerStartResult,
  CursorWorkerTransport,
} from "./worker-port";

/**
 * The Cursor `ConversationBackendRuntime` (spec D6, D8, D16, D17, D21).
 *
 * It owns one supervised worker per conversation and translates that worker's
 * frames into the neutral vocabulary: the lossless envelope first, the
 * operational projection second, and exactly one terminal outcome per turn.
 *
 * The worker is reached only through the injected `CursorWorkerTransport`, so
 * acceptance timing, eager ref persistence, event identity, failure
 * disposition, usage assembly, and cancellation are all drivable from a
 * scripted fake without a process existing.
 */

const logger = createLogger("cursor:conversation-runtime");

const failureClassifier = createCursorFailureClassifier();

/**
 * How many run-scoped event keys the resume quarantine remembers. Sized to
 * cover a long conversation's recent history without growing unbounded for the
 * runtime's whole life.
 */
const MAX_SEEN_EVENT_KEYS = 20_000;

export interface CursorConversationRuntimeDeps {
  steerTimeoutMs?: number;
  taskStore?(
    conversationId: string,
  ): import("./background-tasks").CursorTaskStore;
  attachTimeoutMs?: number;
  capabilityDelivery?: CursorCapabilityDelivery;
  transport: CursorWorkerTransport;
  /** Command Center-owned root for this conversation's SDK agent store. */
  storePath(conversationId: string): string;
  /**
   * Resolves and validates the turn's model (D10). The adapter is the
   * validation authority, so an unsupported id fails here — before a worker
   * starts and before a billable turn.
   */
  resolveModel(
    selection: BackendModelSelection,
  ): Promise<
    | { ok: true; selection: BackendModelSelection }
    | { ok: false; message: string }
  >;
  /**
   * Translates the conversation's portable MCP config into the worker's
   * transport and control map, passed on attach and on every send (D18). Injected so the
   * runtime's staging and reapplication logic is drivable without the
   * translator's own field rules being in the way.
   */
  translatePortableMcpToCursor(
    config: PortableMcpConfig,
  ): PortableMcpToCursorResult;
  newRunId(): string;
  now(): number;
  /** Turn inactivity bound; a run silent past it is a bounded typed failure. */
  stallTimeoutMs: number;
  /** How long a cancelled run may take to settle before resolving aborted. */
  cancelSettleTimeoutMs: number;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  const { promise, resolve } = Promise.withResolvers<T>();
  return { promise, resolve };
}

/** How a turn ended. Exactly one of these settles each `sendTurn`. */
type TurnOutcome =
  | { kind: "completed" }
  | { kind: "aborted" }
  | { kind: "failed"; error: unknown };

type AttachOutcome = { ok: true } | { ok: false; error: unknown };

interface ActiveTurn {
  onUserQuestion: ConversationBackendTurnInput["onUserQuestion"];
  questionController: AbortController;
  questionIds: Set<string>;
  mcpConfigHash: string;
  runId: string;
  settlement: Deferred<TurnOutcome>;
  settled: boolean;
  contentBlocks: MessageContentBlock[];
  contentDeltaCount: number;
  /**
   * The LAST assistant text of the turn — Cursor's canonical final response.
   * Reported separately because neutral callers that do not get it fall back
   * to the FIRST text block, which for a multi-step turn is a progress note,
   * not the answer (and would be the value structured output validates).
   */
  finalText: string | null;
  usage: ConversationTokenUsage | null;
  compacted: boolean;
  stallTimer: ReturnType<typeof setTimeout> | null;
  cancelTimer: ReturnType<typeof setTimeout> | null;
  /** Set when the caller aborted; the outcome is aborted regardless of how the
   *  worker reports settlement, and no failure is fabricated for it. */
  aborted: boolean;
}

export class CursorConversationRuntime implements ConversationBackendRuntime {
  readonly backend = CURSOR_BACKEND_ID;
  readonly mcpConfigDelivery = "input-accepted" as const;
  readonly modelSelection: BackendModelSelection;
  readonly outputFormat:
    | { type: "json_schema"; schema: Record<string, unknown> }
    | undefined;

  readonly fsWritePolicy: FsWritePolicy | undefined;

  private _status: "alive" | "dead" = "alive";
  private liveInputBarrier: Promise<void> = Promise.resolve();
  private liveInputArchiveFailure: Error | null = null;
  private readonly conversationId: string;
  private readonly conversationTarget: ConversationTarget;
  private readonly worktreePath: string;
  private readonly sessionInstructions: string[];
  private readonly workflowExecutionId: string | undefined;
  private readonly workflowContextId: string | undefined;
  private readonly workflowCallerConversationId: string | undefined;
  private readonly deps: CursorConversationRuntimeDeps;
  private readonly workerOwnerToken = {};
  private readonly steering: CursorSteering;

  private session: CursorWorkerSession | null = null;
  /** Resolves once the current session's agent is attached; null when none. */
  private attaching: Promise<AttachOutcome> | null = null;
  private pendingAttach: Deferred<AttachOutcome> | null = null;
  private backendRef: string | null;
  /**
   * The MCP config every attach and send is derived from. Staged rather than
   * read live because the SDK receives the map at fixed moments — agent attach
   * and turn dispatch — so a change arriving between them takes effect on the
   * next turn, never on the one already running.
   */
  private stagedPortableMcp: PortableMcpConfig | null;
  private instructionsPending: boolean;
  private activeTurn: ActiveTurn | null = null;
  /**
   * Serializes event delivery: handler N settles before handler N+1 starts, so
   * an async consumer (the actor's transcript append) observes envelope before
   * content and never interleaves two events of the same turn.
   */
  private emitChain: Promise<void> = Promise.resolve();
  private onEvent: ConversationBackendTurnInput["onEvent"] | null = null;
  /** Whether the current `sendTurn` has already reported acceptance. */
  private acceptedThisPrompt = false;
  /**
   * Teardown of a discarded worker, in flight. The supervisor keeps a worker
   * in its registry for the WHOLE ladder and answers `start()` with
   * `already_active` until then, so a new worker cannot be requested until
   * this settles. Never rejects.
   */
  private discarding: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  cleanupFailure: string | null = null;
  /** Run-scoped event keys already projected, for the resume quarantine. */
  private readonly seenEventKeys = new Set<string>();
  private readonly seenEventOrder: string[] = [];
  private tasks: CursorTaskState = [];
  private tasksLoaded = false;
  private taskLedgerFailureNotified = false;
  private readonly taskStore:
    | import("./background-tasks").CursorTaskStore
    | undefined;
  private taskLossInstruction: string | null = null;
  private readonly onBackgroundActivity: ConversationBackendCreateInput["onBackgroundActivity"];

  constructor(
    input: ConversationBackendCreateInput,
    deps: CursorConversationRuntimeDeps,
  ) {
    assertCursorRuntimePolicy(input);
    this.conversationId = input.conversationId;
    this.onBackgroundActivity = input.onBackgroundActivity;
    this.conversationTarget = input.conversationTarget;
    this.worktreePath = input.worktreePath;
    this.sessionInstructions = [
      ...input.sessionInstructions,
      ...cursorWritePolicyInstructions(input.fsWritePolicy),
      CURSOR_BACKGROUND_INSTRUCTIONS,
    ];
    this.workflowExecutionId = input.workflowExecutionId;
    this.workflowContextId = input.workflowContextId;
    this.workflowCallerConversationId = input.workflowCallerConversationId;
    this.modelSelection = input.modelSelection;
    this.outputFormat = input.outputFormat;

    this.fsWritePolicy = input.fsWritePolicy;
    this.backendRef =
      input.persistedRef?.backend === CURSOR_BACKEND_ID
        ? input.persistedRef.ref
        : null;
    this.stagedPortableMcp = input.tooling.portableMcp
      ? structuredClone(input.tooling.portableMcp)
      : null;
    this.instructionsPending = true;
    this.deps = deps;
    this.steering = new CursorSteering(deps.steerTimeoutMs);
    this.taskStore = deps.taskStore?.(input.conversationId);
  }

  get capabilitiesAtCreation() {
    return this.deps.capabilityDelivery?.snapshot.capabilities;
  }

  get status(): "alive" | "dead" {
    return this._status;
  }

  get isTurnActive(): boolean {
    return this.activeTurn !== null;
  }

  async queueUserInput(input: ConversationQueuedUserInput): Promise<void> {
    const turn = this.activeTurn;
    const session = this.session;
    if (
      !turn ||
      turn.settled ||
      turn.aborted ||
      !session ||
      !this.acceptedThisPrompt
    ) {
      throw new Error("Cursor has no running turn ready for steering");
    }
    if (input.content.some((block) => block.type !== "text")) {
      throw new Error(
        "Cursor steering accepts text only; attachments require the next turn",
      );
    }
    const text = input.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n\n");
    if (!text.trim()) throw new Error("Cursor steering requires text");
    const previous = this.liveInputBarrier;
    const barrier = Promise.withResolvers<void>();
    this.liveInputBarrier = previous.then(() => barrier.promise);
    try {
      await previous;
      if (turn.settled || turn.aborted) {
        throw new Error("Cursor turn ended before steering");
      }
      await this.steering.deliver(
        turn.runId,
        (requestId) => session.steer(turn.runId, requestId, text),
        input.signal,
      );
      try {
        await input.onAccepted?.();
      } catch (error) {
        this.liveInputArchiveFailure = new InputDeliveryUncertainError(
          `Accepted input could not be archived: ${getErrorMessage(error)}`,
        );
        // close drains the event chain, so release its suppressed events first.
        barrier.resolve();
        await this.close();
        throw this.liveInputArchiveFailure;
      }
    } finally {
      barrier.resolve();
    }
  }

  async sendTurn(
    input: ConversationBackendTurnInput,
  ): Promise<ConversationBackendTurnResult> {
    const startedAt = this.deps.now();
    this.onEvent = input.onEvent;
    // One prompt, one acceptance: the busy-agent recovery below re-dispatches
    // the SAME prompt on a second run, and queued-delivery accounting counts
    // acceptances, not runs.
    this.acceptedThisPrompt = false;

    // Pre-turn validation, before any worker exists: a refused model or image
    // must cost neither a process nor a billable turn (D10, D15).
    const model = await this.deps.resolveModel(input.modelSelection);
    if (!model.ok) {
      return this.refuse(model.message, startedAt);
    }
    const images = translateCursorImages(input.imageRefs);
    if (!images.ok) {
      return this.refuse(images.message, startedAt);
    }

    if (input.signal.aborted) return this.cancelledBeforeDispatch(startedAt);
    const onAttachAbort = () => {
      void this.close();
    };
    input.signal.addEventListener("abort", onAttachAbort, { once: true });
    let attached: AttachOutcome;
    try {
      attached = await this.ensureAttached(model.selection);
    } finally {
      input.signal.removeEventListener("abort", onAttachAbort);
    }
    if (input.signal.aborted) return this.cancelledBeforeDispatch(startedAt);
    if (!attached.ok) {
      return this.settleWithFailure(attached.error, startedAt);
    }
    const session = this.session;
    if (session === null) {
      return this.settleWithFailure(
        new CursorLocalFailure("worker_exit", "the worker was closed mid-turn"),
        startedAt,
      );
    }

    if (!this.tasksLoaded) {
      this.tasks = (await this.taskStore?.load()) ?? [];
      this.tasksLoaded = true;
      this.loseTasks("runtime_recovery", true);
      await this.emitChain;
    }
    const promptText = this.buildPromptText(input);
    let turn = await this.runOnce(session, input, {
      promptText,
      images: images.images,
      modelSelection: model.selection,
      forceExpirePersistedRun: false,
    });

    // Busy-agent recovery (D12): a persisted run left wedged by a crashed
    // predecessor is the one conflict the SDK's force-expiry option exists
    // for. It is attempted at most once, and only after the active-worker
    // registry has proven no OTHER live worker owns this conversation.
    if (
      isBusyAgentOutcome(turn.outcome) &&
      !turn.state.aborted &&
      mayForceExpire(this.deps.transport, this.conversationId, session.workerId)
    ) {
      logger.info("cursor-runtime.busy_agent_force_expiry", {
        conversationId: this.conversationId,
        workerId: session.workerId,
      });
      turn = await this.runOnce(session, input, {
        promptText,
        images: images.images,
        modelSelection: model.selection,
        forceExpirePersistedRun: true,
      });
    }

    this.instructionsPending = turn.outcome.kind !== "completed";
    if (turn.outcome.kind === "aborted") this.discardSession("turn_cancelled");
    if (this.tasks.some(isCursorTaskRunning)) {
      this.discardSession("provider_tasks_unobserved");
      this.loseTasks("run_ended");
    }
    await this.discarding;
    // Every accepted input and event is durable before the caller sees the result.
    await this.liveInputBarrier;
    await this.emitChain;
    if (this.acceptedThisPrompt)
      await this.deps.capabilityDelivery?.markDelivered();

    if (this.liveInputArchiveFailure !== null) {
      return {
        ...this.settleWithFailure(this.liveInputArchiveFailure, startedAt),
        compacted: turn.state.compacted,
      };
    }
    return this.buildResult(turn.state, turn.outcome, startedAt);
  }

  /**
   * One dispatch-and-settle cycle. Extracted so the busy-agent recovery can
   * re-dispatch without duplicating the abort wiring, the stall bound, or the
   * single-settlement guarantee.
   */
  private async runOnce(
    session: CursorWorkerSession,
    input: ConversationBackendTurnInput,
    dispatch: {
      promptText: string;
      images: readonly { data: string; mimeType: string }[];
      modelSelection: BackendModelSelection;
      forceExpirePersistedRun: boolean;
    },
  ): Promise<{ state: ActiveTurn; outcome: TurnOutcome }> {
    clearLiveOccupancy(this.conversationId);
    const turn: ActiveTurn = {
      onUserQuestion: input.onUserQuestion,
      questionController: new AbortController(),
      questionIds: new Set(),
      mcpConfigHash: computeEffectiveConfigHash(
        this.stagedPortableMcp ?? { servers: [] },
      ),
      runId: this.deps.newRunId(),
      settlement: deferred<TurnOutcome>(),
      settled: false,
      contentBlocks: [],
      contentDeltaCount: 0,
      finalText: null,
      usage: null,
      compacted: false,
      stallTimer: null,
      cancelTimer: null,
      aborted: false,
    };
    this.activeTurn = turn;

    const onAbort = (): void => this.cancelActiveTurn();
    if (input.signal.aborted) {
      // Already cancelled before dispatch: settle without burning a turn.
      this.finishTurn(turn, { kind: "aborted" });
    } else {
      input.signal.addEventListener("abort", onAbort, { once: true });
      this.armStallTimer(turn);
      session.startTurn({
        allowQuestions: input.onUserQuestion !== undefined,
        runId: turn.runId,
        promptText: dispatch.promptText,
        images: dispatch.images,
        structuredOutputInstruction: null,
        modelSelection: dispatch.modelSelection,
        mcpServers: this.mcpServerMap(),
        forceExpirePersistedRun: dispatch.forceExpirePersistedRun,
      });
    }

    const outcome = await turn.settlement.promise;
    input.signal.removeEventListener("abort", onAbort);
    this.clearTurnTimers(turn);
    this.activeTurn = null;
    clearLiveOccupancy(this.conversationId);
    return { state: turn, outcome };
  }

  close(): Promise<void> {
    this.closing ??= this.closeRuntime();
    return this.closing;
  }

  private async closeRuntime(): Promise<void> {
    if (this._status === "dead") return;
    this._status = "dead";
    this.activeTurn?.questionController.abort();
    this.steering.close();
    this.loseTasks("runtime_closed");
    const session = this.session;
    this.session = null;
    this.attaching = null;
    this.pendingAttach?.resolve({
      ok: false,
      error: new CursorLocalFailure(
        "worker_exit",
        "the runtime closed during attach",
      ),
    });
    this.pendingAttach = null;

    // A worker discarded earlier (a stall or a fatal fault) may still be in
    // its teardown ladder, still holding this conversation's worktree as its
    // cwd. `close()` is the boundary lifecycle callers order worktree removal
    // behind (D20), so it has to cover that worker too — not just the one
    // currently installed.
    const discarding = this.discarding;
    this.discarding = null;
    if (discarding !== null) await discarding;

    if (session !== null) {
      const outcome = await session.close();
      if (outcome.kind === "cleanup_failed") {
        this.cleanupFailure = `Cursor worker cleanup failed: ${outcome.reason}`;
        logger.error("cursor-runtime.close_unverified", {
          conversationId: this.conversationId,
          reason: outcome.reason,
        });
      }
    }

    await this.emitChain;

    // A turn still open at this point has no worker left to settle it; it gets
    // the one terminal outcome it is owed rather than never resolving.
    const turn = this.activeTurn;
    if (turn !== null && !turn.settled) {
      this.finishTurn(
        turn,
        turn.aborted
          ? { kind: "aborted" }
          : {
              kind: "failed",
              error: new CursorLocalFailure(
                "worker_exit",
                "the conversation runtime closed while a turn was running",
              ),
            },
      );
    }
  }

  private updateTasks(tasks: CursorTaskState, persist: boolean): void {
    this.tasks = tasks;
    const at = new Date(this.deps.now()).toISOString();
    const handler = this.onEvent;
    this.emitChain = this.emitChain
      .then(async () => {
        try {
          if (persist) await this.taskStore?.save(tasks);
        } catch (error) {
          logger.error("cursor-runtime.task_ledger_failed", {
            conversationId: this.conversationId,
            error: getErrorMessage(error),
          });
          if (!this.taskLedgerFailureNotified) {
            this.taskLedgerFailureNotified = true;
            await handler?.({
              type: "transcript_entry",
              entry: {
                backend: "cursor",
                seq: 0,
                type: "notice",
                raw: {
                  timestamp: at,
                  type: "notice",
                  role: "notice",
                  content: [
                    {
                      type: "text",
                      text: "Cursor provider task accounting could not be saved. Task recovery after restart is unavailable for this run.",
                    },
                  ],
                },
              },
            });
          }
        }
        this.onBackgroundActivity?.(cursorTaskActivity(tasks, at));
      })
      .catch((error) => {
        logger.warn("cursor-runtime.task_activity_handler_failed", {
          conversationId: this.conversationId,
          error: getErrorMessage(error),
        });
      });
  }

  private loseTasks(reason: string, includeLost = false): void {
    const lost = this.tasks.filter(
      (task) =>
        isCursorTaskRunning(task) || (includeLost && task.status === "lost"),
    );
    if (!lost.length) return;
    this.updateTasks(
      this.tasks.map((task) =>
        lost.includes(task) ? { ...task, status: "lost" } : task,
      ),
      true,
    );
    const messages = lost.map(
      (task) =>
        `Cursor provider task ${task.taskId}${task.description ? ` (${task.description})` : ""}: its outcome is unknown (${reason}). Completion can no longer wake the agent. Check its outputs before deciding whether to rerun it.`,
    );
    this.taskLossInstruction = messages.join("\n");
    for (const [index, task] of lost.entries()) {
      this.emit({
        type: "transcript_entry",
        entry: {
          backend: "cursor",
          seq: 0,
          type: "notice",
          raw: {
            id: `cursor-task-loss:${this.conversationId}:${task.taskId}`,
            timestamp: new Date(this.deps.now()).toISOString(),
            type: "notice",
            role: "notice",
            content: [{ type: "text", text: messages[index] }],
          },
        },
      });
    }
    logger.warn("cursor-runtime.tasks_lost", {
      conversationId: this.conversationId,
      reason,
      taskIds: lost.map((task) => task.taskId),
    });
  }

  // ============================================================
  // Worker lifecycle
  // ============================================================

  private async ensureAttached(
    modelSelection: BackendModelSelection,
  ): Promise<AttachOutcome> {
    // A discarded worker still owns the conversation's registry slot until its
    // teardown settles. Waiting here is what turns "discarded" into "gone",
    // so the start below can only ever return a genuinely fresh worker.
    const discarding = this.discarding;
    if (discarding !== null) {
      await discarding;
      if (this.discarding === discarding) this.discarding = null;
    }
    if (this.attaching !== null) return this.attaching;
    this.attaching = this.startAndAttach(modelSelection);
    const outcome = await this.attaching;
    if (!outcome.ok) this.attaching = null;
    return outcome;
  }

  private async startAndAttach(
    modelSelection: BackendModelSelection,
  ): Promise<AttachOutcome> {
    const started = await this.deps.transport.start({
      conversationId: this.conversationId,
      target: this.conversationTarget,
      cwd: this.worktreePath,
      storePath: this.deps.storePath(this.conversationId),
      modelSelection,
      ownerToken: this.workerOwnerToken,
      onFrame: (frame) => this.handleFrame(frame),
      onExit: (info) => this.handleExit(info.expected),
      ...(this.workflowExecutionId !== undefined
        ? { workflowExecutionId: this.workflowExecutionId }
        : {}),
      ...(this.workflowContextId !== undefined
        ? { workflowContextId: this.workflowContextId }
        : {}),
      ...(this.workflowCallerConversationId !== undefined
        ? { workflowCallerConversationId: this.workflowCallerConversationId }
        : {}),
    });

    if (started.kind !== "ready" && started.kind !== "already_active") {
      return { ok: false, error: startFailure(started) };
    }

    if (this._status === "dead") {
      const outcome = await started.session.close();
      if (outcome.kind === "cleanup_failed") {
        this.cleanupFailure = `Cursor worker cleanup failed: ${outcome.reason}`;
        logger.error("cursor-runtime.startup_close_unverified", {
          conversationId: this.conversationId,
          reason: outcome.reason,
        });
      }
      return {
        ok: false,
        error: new CursorLocalFailure(
          "worker_exit",
          "the runtime closed during worker startup",
        ),
      };
    }

    this.session = started.session;
    const settlement = deferred<AttachOutcome>();
    this.pendingAttach = settlement;
    started.session.attach({
      mode: this.backendRef === null ? "create" : "resume",
      ref: this.backendRef,
      ...(this.backendRef !== null
        ? {
            recoverAbandonedRun: mayForceExpire(
              this.deps.transport,
              this.conversationId,
              started.session.workerId,
            ),
          }
        : {}),
      modelSelection,
      // Re-passed on resume, not just on create: the SDK does not persist the
      // MCP map with the agent, so a resumed agent whose attach omitted it
      // would run with no servers at all (D11, D18).
      mcpServers: this.mcpServerMap(),
      agents: this.deps.capabilityDelivery?.snapshot.agents ?? {},
    });
    const timer = setTimeout(() => {
      settlement.resolve({
        ok: false,
        error: new Error("Cursor agent attachment timed out"),
      });
      this.discardSession("attach_timeout");
    }, this.deps.attachTimeoutMs ?? CURSOR_ATTACH_TIMEOUT_MS);
    timer.unref?.();
    try {
      return await settlement.promise;
    } finally {
      clearTimeout(timer);
    }
  }

  // ============================================================
  // Inline MCP configuration (D18)
  // ============================================================

  /**
   * The bridge input map for the next attach or send. Derived on demand from
   * the staged config so a between-turn apply needs no second delivery path.
   */
  private mcpServerMap(): Record<string, CursorWorkerMcpServer> {
    if (this.stagedPortableMcp === null) return {};
    const translated = this.deps.translatePortableMcpToCursor(
      this.stagedPortableMcp,
    );
    if (translated.rejectedServers.length)
      throw new Error(Object.values(translated.errorsByServer).join("; "));
    return translated.servers;
  }

  /**
   * Stage a new MCP config for this conversation.
   *
   * The map is an attach and per-send option, so an applied config reaches the
   * agent on the next turn rather than the running one — `next-turn` semantics,
   * the same disposition Codex reports. A config the inline path cannot express
   * at all is refused outright and the previous one stays in force: a caller
   * that asked for servers and got none is better served by an error than by a
   * conversation that silently lost its tooling.
   */
  async applyPortableMcpConfig(
    config: PortableMcpConfig,
  ): Promise<McpApplyResult> {
    if (this._status === "dead") {
      return {
        disposition: "rejected",
        droppedServerIds: config.servers.map((server) => server.id),
        droppedFields: [],
        errors: { runtime: "the Cursor conversation runtime is closed" },
      };
    }

    const { servers, rejectedServers, rejectedFields, errorsByServer } =
      this.deps.translatePortableMcpToCursor(config);

    if (Object.keys(errorsByServer).length > 0) {
      logger.warn("cursor-runtime.mcp_rejected", {
        conversationId: this.conversationId,
        rejectedCount: rejectedServers.length,
      });
      return {
        disposition: "rejected",
        droppedServerIds: rejectedServers,
        droppedFields: rejectedFields,
        errors: errorsByServer,
      };
    }

    this.stagedPortableMcp = structuredClone(config);
    logger.info("cursor-runtime.mcp_staged", {
      conversationId: this.conversationId,
      serverCount: Object.keys(servers).length,
      rejectedCount: rejectedServers.length,
    });

    return {
      disposition: "deferred_to_next_turn",
      droppedServerIds: rejectedServers,
      droppedFields: rejectedFields,
      errors: errorsByServer,
    };
  }

  /**
   * Drops the current worker and tears it down.
   *
   * Clearing `session` is not enough on its own: the supervisor deregisters a
   * worker only in `onSettled`, at the very end of its teardown ladder, so
   * until that settles `transport.start` still answers `already_active` with
   * THIS worker. The teardown promise is therefore retained and awaited before
   * any new worker is requested (see `ensureAttached`) — otherwise a prompt
   * arriving during the ladder would attach to the worker being killed.
   *
   * The caller here is a timer or a frame handler with nothing to await, so
   * teardown runs in the background; `discarding` is what makes it awaitable
   * by the path that actually needs it.
   */
  private discardSession(reason: string): void {
    this.steering.close();
    const session = this.session;
    this.session = null;
    this.attaching = null;
    this.pendingAttach = null;
    if (session === null) return;

    logger.warn("cursor-runtime.session_discarded", {
      conversationId: this.conversationId,
      workerId: session.workerId,
      reason,
    });
    this.discarding = session.close().then(
      (outcome) => {
        if (outcome.kind === "cleanup_failed") {
          this.cleanupFailure = `Cursor worker cleanup failed: ${outcome.reason}`;
          logger.error("cursor-runtime.discard_unverified", {
            conversationId: this.conversationId,
            workerId: session.workerId,
            reason: outcome.reason,
          });
        }
      },
      (error: unknown) => {
        this.cleanupFailure = "Cursor worker cleanup failed";
        // Swallowed deliberately: a failed teardown is recorded, but the next
        // prompt must still be free to start a fresh worker rather than
        // inheriting a rejection.
        logger.error("cursor-runtime.discard_failed", {
          conversationId: this.conversationId,
          workerId: session.workerId,
          error: getErrorMessage(error),
        });
      },
    );
  }

  private handleExit(expected: boolean): void {
    this.steering.close();
    this.session = null;
    this.attaching = null;

    const attach = this.pendingAttach;
    if (attach !== null) {
      this.pendingAttach = null;
      attach.resolve({
        ok: false,
        error: new CursorLocalFailure(
          "worker_exit",
          "the worker exited before its agent was attached",
        ),
      });
    }

    const turn = this.activeTurn;
    if (turn === null || turn.settled) return;
    if (turn.aborted) {
      this.finishTurn(turn, { kind: "aborted" });
      return;
    }
    logger.warn("cursor-runtime.worker_exit_mid_turn", {
      conversationId: this.conversationId,
      runId: turn.runId,
      expected,
    });
    this.finishTurn(turn, {
      kind: "failed",
      error: new CursorLocalFailure(
        "worker_exit",
        "the Cursor worker exited before the turn settled",
      ),
    });
  }

  // ============================================================
  // Frame handling
  // ============================================================

  private handleFrame(frame: CursorWorkerFrame): void {
    switch (frame.type) {
      case "steerResult":
        this.steering.accept(frame);
        return;
      case "questionRequest":
        this.forRun(frame.runId, (turn) => {
          if (turn.questionIds.has(frame.requestId)) return;
          turn.questionIds.add(frame.requestId);
          const session = this.session;
          if (!session) return;
          this.touch(turn);
          const answer = turn.onUserQuestion
            ? turn.onUserQuestion(
                frame.questions,
                turn.questionController.signal,
              )
            : Promise.resolve({
                status: "unavailable" as const,
                message: "Questions are disabled for this run",
              });
          void answer.then(
            (reply) => {
              if (turn.settled || turn.aborted) return;
              session.answerQuestion(frame.runId, frame.requestId, reply);
              this.touch(turn);
            },
            () => {
              if (turn.settled || turn.aborted) return;
              logger.error("cursor-runtime.question_failed", {
                conversationId: this.conversationId,
                runId: frame.runId,
                requestId: frame.requestId,
              });
              session.answerQuestion(frame.runId, frame.requestId, {
                status: "unavailable",
                message: "The question could not be completed",
              });
            },
          );
        });
        return;
      case "attachResult": {
        const settlement = this.pendingAttach;
        this.pendingAttach = null;
        settlement?.resolve(
          frame.outcome === "attached"
            ? { ok: true }
            : { ok: false, error: sdkError(frame.error) },
        );
        return;
      }
      case "refIssued":
        this.recordRef(frame.ref);
        return;
      case "inputAccepted":
        this.forRun(frame.runId, (turn) => {
          this.touch(turn);
          if (this.acceptedThisPrompt) return;
          this.acceptedThisPrompt = true;
          this.taskLossInstruction = null;
          this.updateTasks([], true);
          this.emit({
            type: "input_accepted",
            mcpConfigHash: turn.mcpConfigHash,
          });
        });
        return;
      case "nativeEvent":
        this.forRun(frame.runId, (turn) => {
          this.touch(turn);
          this.handleNativeEvent(turn, frame);
        });
        return;
      case "nativeEventRejected":
        this.forRun(frame.runId, (turn) => {
          this.touch(turn);
          // Bounded by construction: type, size, and hash identify the event
          // without echoing a byte of the payload the encoder refused (D7).
          const message = `Cursor dropped a native ${frame.eventType} event (${frame.violation}, ${frame.byteLength} bytes, sha256 ${frame.sha256.slice(0, 12)})`;
          logger.warn("cursor-runtime.native_event_rejected", {
            conversationId: this.conversationId,
            runId: frame.runId,
            eventIndex: frame.eventIndex,
            eventType: frame.eventType,
            violation: frame.violation,
            byteLength: frame.byteLength,
          });
          this.emit({ type: "error", message });
        });
        return;
      case "usage":
        this.forRun(frame.runId, (turn) => {
          this.touch(turn);
          const usage = toConversationTokenUsage(frame);
          if (usage === null) {
            logger.warn("cursor-runtime.usage_incomplete", {
              conversationId: this.conversationId,
              runId: frame.runId,
              missingFields: MEASURED_USAGE_FIELDS.filter(
                (field) => frame[field] === null,
              ),
            });
          }
          turn.usage = usage;
        });
        return;
      case "turnSettled":
        this.forRun(frame.runId, (turn) => {
          this.finishTurn(turn, settledOutcome(frame.outcome, frame.error));
        });
        return;
      case "fatal": {
        // A worker-level fault, not a run-level one: it carries no run id, so
        // whatever turn is open owns it. Without this the turn would wait for
        // a settlement the worker will never send.
        const turn = this.activeTurn;
        if (turn === null || turn.settled) return;
        logger.error("cursor-runtime.worker_fatal", {
          conversationId: this.conversationId,
          runId: turn.runId,
          code: frame.code,
        });
        // Same reasoning as a stall: a worker that reported a fatal fault is
        // not fit to serve the next prompt.
        this.discardSession("worker_fatal");
        this.finishTurn(turn, {
          kind: "failed",
          error: sdkError({
            name: "CursorWorkerFatal",
            code: frame.code,
            status: null,
            message: frame.message,
          }),
        });
        return;
      }
      default:
        return;
    }
  }

  private handleNativeEvent(
    turn: ActiveTurn,
    frame: Extract<CursorWorkerFrame, { type: "nativeEvent" }>,
  ): void {
    const decoded = decodeNativePayload(frame.eventType, frame.payload);
    if (!decoded.ok) {
      logger.warn("cursor-runtime.native_event_undecodable", {
        conversationId: this.conversationId,
        runId: frame.runId,
        eventIndex: frame.eventIndex,
        eventType: decoded.eventType,
        violation: decoded.violation,
        byteLength: decoded.byteLength,
      });
      this.emit({
        type: "error",
        message: `Cursor could not decode a native ${decoded.eventType} event (${decoded.violation}, ${decoded.byteLength} bytes)`,
      });
      return;
    }

    // Resume quarantine (D21), which layers ON TOP of the idempotent append
    // rather than replacing it. The append boundary only deduplicates the
    // durable line and its `message-appended` broadcast; the live `content`
    // stream and this turn's `contentBlocks` never pass through it, so a
    // re-delivered frame would otherwise reach consumers twice. Both
    // mechanisms are needed: this one covers the live path within a runtime's
    // life, the derived entry id covers restarts it cannot see.
    if (!this.claimEventKey(frame.runId, frame.eventIndex)) {
      logger.debug("cursor-runtime.duplicate_native_event", {
        conversationId: this.conversationId,
        runId: frame.runId,
        eventIndex: frame.eventIndex,
        eventType: frame.eventType,
      });
      return;
    }

    const projection = projectCursorNativeEvent(
      {
        runId: frame.runId,
        eventIndex: frame.eventIndex,
        eventType: frame.eventType,
        tagged: decoded.tagged,
        decoded: decoded.value,
      },
      {
        conversationId: this.conversationId,
        timestamp: new Date(this.deps.now()).toISOString(),
      },
    );

    // Envelope first, interpretation second: the lossless record is durable
    // before any block derived from it reaches a consumer.
    this.emit({ type: "transcript_entry", entry: projection.entry });
    turn.compacted ||= projection.compacted;
    if (projection.compacted) markLiveCompaction(this.conversationId);
    const tasks = applyCursorTaskEvent(
      this.tasks,
      decoded.value,
      turn.runId,
      new Date(this.deps.now()).toISOString(),
    );
    if (tasks !== this.tasks) {
      const persist =
        tasks.length !== this.tasks.length ||
        tasks.some((task, index) => task.status !== this.tasks[index]?.status);
      if (persist)
        logger.info("cursor-runtime.task_state", {
          conversationId: this.conversationId,
          runId: turn.runId,
          tasks: tasks.map(({ taskId, status }) => ({ taskId, status })),
        });
      this.updateTasks(tasks, persist);
    }
    for (const block of projection.blocks) {
      turn.contentDeltaCount += 1;
      appendCursorContentDelta(turn.contentBlocks, block);
      if (block.type === "text") {
        const latest = turn.contentBlocks.at(-1);
        turn.finalText = latest?.type === "text" ? latest.text : block.text;
      }
      this.emit({ type: "content", block });
    }
  }

  /**
   * Records a run-scoped event key, returning false when it has already been
   * seen. The window is bounded because a long conversation would otherwise
   * accumulate a key per event for the runtime's whole life; beyond it the
   * derived entry id at the idempotent append boundary is still the durable
   * backstop, so eviction costs a duplicate live block at worst, never a
   * duplicate persisted row.
   */
  private claimEventKey(runId: string, eventIndex: number): boolean {
    const key = `${runId}:${eventIndex}`;
    if (this.seenEventKeys.has(key)) return false;
    this.seenEventKeys.add(key);
    this.seenEventOrder.push(key);
    if (this.seenEventOrder.length > MAX_SEEN_EVENT_KEYS) {
      const evicted = this.seenEventOrder.shift();
      if (evicted !== undefined) this.seenEventKeys.delete(evicted);
    }
    return true;
  }

  private recordRef(ref: string): void {
    if (this.backendRef === ref) return;
    this.backendRef = ref;
    // Eager persistence (D8): the neutral event the conversation machine turns
    // into a snapshot write, so a server death mid-turn still leaves a ref the
    // next prompt can resume from.
    this.emit({
      type: "backend_init",
      backendRef: { backend: CURSOR_BACKEND_ID, ref },
    });
  }

  private forRun(runId: string, act: (turn: ActiveTurn) => void): void {
    const turn = this.activeTurn;
    if (turn === null || turn.runId !== runId || turn.settled) return;
    act(turn);
  }

  // ============================================================
  // Turn settlement
  // ============================================================

  private armStallTimer(turn: ActiveTurn): void {
    if (this.deps.stallTimeoutMs <= 0) return;
    turn.stallTimer = setTimeout(() => {
      logger.warn("cursor-runtime.turn_stalled", {
        conversationId: this.conversationId,
        runId: turn.runId,
        stallTimeoutMs: this.deps.stallTimeoutMs,
      });
      // A stalled run leaves a wedged worker behind. Settling the turn is not
      // enough: the next prompt has to resume from the persisted ref in a
      // FRESH worker, so the stalled one is discarded here rather than left
      // installed for the next turn to reuse.
      this.discardSession("stream_stall");
      this.finishTurn(turn, {
        kind: "failed",
        error: new CursorLocalFailure(
          "stream_stall",
          `the Cursor run produced no event for ${this.deps.stallTimeoutMs}ms`,
        ),
      });
    }, this.deps.stallTimeoutMs);
    turn.stallTimer.unref?.();
  }

  /** Any frame for the run restarts its inactivity bound. */
  private touch(turn: ActiveTurn): void {
    if (turn.stallTimer !== null) clearTimeout(turn.stallTimer);
    if (turn.settled || turn.aborted) return;
    this.armStallTimer(turn);
  }

  private cancelActiveTurn(): void {
    const turn = this.activeTurn;
    if (turn === null || turn.settled || turn.aborted) return;
    turn.aborted = true;
    turn.questionController.abort();
    this.clearTurnTimers(turn);
    this.session?.cancel(turn.runId);
    // The worker's own settlement is preferred, but a cancelled turn resolves
    // on its own bound rather than waiting forever for a wedged run.
    turn.cancelTimer = setTimeout(() => {
      this.finishTurn(turn, { kind: "aborted" });
    }, this.deps.cancelSettleTimeoutMs);
    turn.cancelTimer.unref?.();
  }

  private clearTurnTimers(turn: ActiveTurn): void {
    if (turn.stallTimer !== null) clearTimeout(turn.stallTimer);
    if (turn.cancelTimer !== null) clearTimeout(turn.cancelTimer);
    turn.stallTimer = null;
    turn.cancelTimer = null;
  }

  /** The single settlement door: a turn can pass through it exactly once. */
  private finishTurn(turn: ActiveTurn, outcome: TurnOutcome): void {
    if (turn.settled) return;
    turn.questionController.abort();
    turn.settled = true;
    this.clearTurnTimers(turn);
    turn.settlement.resolve(turn.aborted ? { kind: "aborted" } : outcome);
  }

  private emit(event: ConversationBackendEvent): void {
    const handler = this.onEvent;
    if (handler === null) return;
    this.emitChain = this.emitChain
      .then(async () => {
        await this.liveInputBarrier;
        if (this.liveInputArchiveFailure === null) await handler(event);
      })
      .catch((error: unknown) => {
        logger.warn("cursor-runtime.event_handler_failed", {
          conversationId: this.conversationId,
          eventType: event.type,
          error: getErrorMessage(error),
        });
      });
  }

  // ============================================================
  // Result assembly
  // ============================================================

  private cancelledBeforeDispatch(
    startedAt: number,
  ): ConversationBackendTurnResult {
    return {
      backendRef: this.currentRef(),
      costUsd: null,
      durationMs: this.deps.now() - startedAt,
      numTurns: 0,
      contextTokens: null,
      contextWindowMax: null,
      contentBlocks: [],
      aborted: true,
      compacted: false,
      failure: null,
      continuationDisposition: "retain",
      tokenUsage: null,
    };
  }

  private buildResult(
    turn: ActiveTurn,
    outcome: TurnOutcome,
    startedAt: number,
  ): ConversationBackendTurnResult {
    if (turn.contentDeltaCount !== turn.contentBlocks.length) {
      logger.debug("cursor-runtime.content_deltas_coalesced", {
        conversationId: this.conversationId,
        runId: turn.runId,
        deltaCount: turn.contentDeltaCount,
        contentBlockCount: turn.contentBlocks.length,
      });
    }
    if (outcome.kind === "failed") {
      return {
        ...this.failureResult(
          outcome.error,
          turn.contentBlocks,
          startedAt,
          false,
        ),
        compacted: turn.compacted,
      };
    }

    const aborted = outcome.kind === "aborted";
    return {
      backendRef: this.currentRef(),
      costUsd: null,
      durationMs: this.deps.now() - startedAt,
      numTurns: 1,
      contextTokens: null,
      contextWindowMax: null,
      contentBlocks: turn.contentBlocks,
      finalText: turn.finalText,
      aborted,
      compacted: turn.compacted,
      failure: null,
      continuationDisposition: "retain",
      // A cancelled turn's counts are unknowable, so absence is reported
      // rather than a partial figure (D17).
      tokenUsage: aborted ? null : turn.usage,
    };
  }

  private failureResult(
    error: unknown,
    contentBlocks: MessageContentBlock[],
    startedAt: number,
    aborted: boolean,
  ): ConversationBackendTurnResult {
    const { failure, continuationDisposition } =
      failureClassifier.classifyWithContinuation(error);
    if (continuationDisposition === "clear") {
      // The provider says this session no longer exists; keeping the ref would
      // make every later turn retry a continuation the adapter just declared
      // dead.
      this.backendRef = null;
      this.instructionsPending = true;
    }
    logger.warn("cursor-runtime.turn_failed", {
      conversationId: this.conversationId,
      failureKind: failure.kind,
      continuationDisposition,
      retryable: failure.retryable,
    });
    return {
      backendRef:
        continuationDisposition === "clear" ? null : this.currentRef(),
      costUsd: null,
      durationMs: this.deps.now() - startedAt,
      numTurns: 1,
      contextTokens: null,
      contextWindowMax: null,
      contentBlocks,
      aborted,
      compacted: false,
      failure,
      continuationDisposition,
      tokenUsage: null,
    };
  }

  /** A turn refused before dispatch: bounded, typed, and never billable. */
  private refuse(
    message: string,
    startedAt: number,
  ): ConversationBackendTurnResult {
    const failure: AgentFailureClassification = {
      kind: "backend_error",
      message,
      retryable: false,
    };
    logger.warn("cursor-runtime.turn_refused", {
      conversationId: this.conversationId,
      failureKind: failure.kind,
    });
    return {
      backendRef: this.currentRef(),
      costUsd: null,
      durationMs: this.deps.now() - startedAt,
      numTurns: 0,
      contextTokens: null,
      contextWindowMax: null,
      contentBlocks: [],
      aborted: false,
      compacted: false,
      failure,
      continuationDisposition: "retain",
      tokenUsage: null,
    };
  }

  private settleWithFailure(
    error: unknown,
    startedAt: number,
  ): ConversationBackendTurnResult {
    return this.failureResult(error, [], startedAt, false);
  }

  private currentRef(): AgentSessionRef | null {
    return this.backendRef === null
      ? null
      : { backend: CURSOR_BACKEND_ID, ref: this.backendRef };
  }

  // ============================================================
  // Prompt composition
  // ============================================================

  private buildPromptText(input: ConversationBackendTurnInput): string {
    const parts: string[] = [];
    if (input.onUserQuestion) {
      parts.push(
        "For questions that need an answer during this turn, use cc_question on the custom-user-tools MCP server. It waits up to five minutes and returns the user's answers in this run; continue after it returns. One question batch may wait at a time, including questions from subagents. Native askQuestion and await are unavailable. cctl ask remains a separate asynchronous next-turn option: follow its end-turn instruction when using it.",
      );
    }
    const skills = this.deps.capabilityDelivery?.snapshot;
    if (skills && !skills.delivered && skills.catalog)
      parts.push(skills.catalog);
    if (this.instructionsPending && this.sessionInstructions.length > 0) {
      const instructions = this.sessionInstructions.join("\n\n");
      const fenceLength = [...instructions.matchAll(/`+/g)].reduce(
        (length, match) => Math.max(length, match[0].length + 1),
        3,
      );
      const fence = "`".repeat(fenceLength);
      parts.push(`${fence}\n## System Instructions\n${instructions}\n${fence}`);
      logger.info("cursor-runtime.instructions_prepared", {
        conversationId: this.conversationId,
        instructionCount: this.sessionInstructions.length,
        instructionDelivery: "user-message",
      });
    }
    if (this.taskLossInstruction) parts.push(this.taskLossInstruction);
    if (input.syntheticForkSeed) {
      parts.push(input.syntheticForkSeed);
    }
    parts.push(input.promptText);
    const prompt = parts.join("\n\n");

    // Post-validation structured output (D16): the shared instruction is the
    // whole adapter contribution. Extraction, validation, and the bounded
    // repair turn are the shared machinery's, above this seam.
    const schema = input.outputFormat?.schema ?? this.outputFormat?.schema;
    return schema === undefined
      ? prompt
      : appendStructuredOutputInstruction(prompt, schema);
  }
}

/** The counts the neutral record requires; `reasoningTokens` is optional. */
const MEASURED_USAGE_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "totalTokens",
] as const;

/**
 * Maps a usage frame onto the neutral record, or reports it unavailable.
 *
 * The wire accepts nullable counts but `conversationTokenUsageSchema` requires
 * every one of them, deliberately: a partially-known record is not
 * representable because a gap filled with zero reads downstream as a MEASURED
 * fact ("this turn used no input tokens") rather than a missing one. So any
 * null count makes the whole record unavailable instead of fabricating a
 * figure the provider never reported (D17).
 *
 * `reasoningTokens` is optional rather than nullable — absent means the SDK
 * reported none, which is a complete record, not a gap.
 */
function toConversationTokenUsage(
  frame: Extract<CursorWorkerFrame, { type: "usage" }>,
): ConversationTokenUsage | null {
  const {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
  } = frame;
  if (
    inputTokens === null ||
    outputTokens === null ||
    cacheReadTokens === null ||
    cacheWriteTokens === null ||
    totalTokens === null
  ) {
    return null;
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    ...(frame.reasoningTokens !== undefined
      ? { reasoningTokens: frame.reasoningTokens }
      : {}),
  };
}

/**
 * Whether the turn failed on the SDK's busy-agent conflict, read from the
 * same stable seams the classifier uses.
 */
function isBusyAgentOutcome(outcome: TurnOutcome): boolean {
  if (outcome.kind !== "failed") return false;
  const error = outcome.error;
  return (
    Reflect.get(error as object, "name") === "AgentBusyError" ||
    Reflect.get(error as object, "code") === "agent_busy" ||
    Reflect.get(error as object, "status") === 409
  );
}

function settledOutcome(
  outcome: "completed" | "aborted" | "failed",
  error: {
    name: string | null;
    code: string | null;
    status: number | null;
    message: string;
  } | null,
): TurnOutcome {
  if (outcome === "completed") return { kind: "completed" };
  if (outcome === "aborted") return { kind: "aborted" };
  return { kind: "failed", error: sdkError(error) };
}

/**
 * Rehydrates the SDK's stable classification seams — name, code, status — onto
 * a plain error. Class identity does not survive the process boundary, and the
 * classifier reads fields rather than instances for exactly that reason.
 */
function sdkError(
  detail: {
    name: string | null;
    code: string | null;
    status: number | null;
    message: string;
  } | null,
): Error {
  const error = new Error(detail?.message ?? "the Cursor turn failed");
  if (detail === null) return error;
  if (detail.name !== null) error.name = detail.name;
  if (detail.code !== null) Reflect.set(error, "code", detail.code);
  if (detail.status !== null) Reflect.set(error, "status", detail.status);
  return error;
}

function startFailure(
  result: Exclude<
    CursorWorkerStartResult,
    { kind: "ready" | "already_active" }
  >,
): Error {
  switch (result.kind) {
    case "runtime_preflight_failed": {
      const error = new Error(result.message);
      error.name = "CursorRuntimePreflightError";
      Reflect.set(error, "code", result.code);
      return error;
    }
    case "preflight_failed": {
      const error = new Error(result.message);
      error.name = "CursorPreflightError";
      Reflect.set(error, "code", result.reason);
      return error;
    }
    case "binding_mismatch":
      return new CursorLocalFailure("binding_mismatch", result.message);
    case "spawn_failed":
      return new CursorLocalFailure("worker_exit", result.message);
  }
}

/**
 * The bounds a production runtime runs under. Named here rather than defaulted
 * inside the class so a test that shortens them is overriding one declared
 * value, not shadowing a hidden one.
 */
export const CURSOR_RUNTIME_DEFAULT_BOUNDS: Pick<
  CursorConversationRuntimeDeps,
  "stallTimeoutMs" | "cancelSettleTimeoutMs"
> = {
  stallTimeoutMs: CURSOR_TURN_STALL_TIMEOUT_MS,
  cancelSettleTimeoutMs: CURSOR_CANCEL_SETTLE_TIMEOUT_MS,
};
