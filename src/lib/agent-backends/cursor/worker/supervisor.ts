import { randomUUID } from "node:crypto";
import path from "node:path";
import { getServerBaseUrl } from "@/lib/agent-gateway/server-url";
import {
  buildSessionEnvContract,
  neutralizeAmbientCcEnv,
} from "@/lib/agent-gateway/session-env";
import { getCachedInstanceToken } from "@/lib/agent-gateway/token";
import { getConfigDirPath } from "@/lib/config/loader";
import { createLogger } from "@/lib/logging";
import { buildChildEnv } from "@/lib/shared/child-env";
import { modelSelectionKey } from "../../model-selection";
import { CURSOR_PHASE1_POLICY } from "../policy";
import {
  runProductionCursorPreflight,
  type CursorStaticPreflightResult,
} from "../preflight";
import { CURSOR_SDK_PINNED_VERSION } from "../sdk-pin";
import {
  ambientCredentialKeys,
  withoutAmbientCredentials,
} from "./credential-env";
import type {
  CursorAttachInput,
  CursorTurnInput,
  CursorWorkerCloseOutcome,
  CursorWorkerSession,
  CursorWorkerStartInput,
  CursorWorkerStartResult,
  CursorWorkerTransport,
} from "../worker-port";
import {
  CURSOR_SUPERVISOR_READY_TIMEOUT_MS,
  CURSOR_TEARDOWN_CANCEL_GRACE_MS,
  CURSOR_TEARDOWN_EXIT_GRACE_MS,
  CURSOR_TEARDOWN_KILL_CONFIRM_MS,
  CURSOR_TEARDOWN_PROBE_INTERVAL_MS,
  CURSOR_TEARDOWN_TERM_GRACE_MS,
  CURSOR_WORKER_IDLE_TTL_MS,
  CURSOR_WORKER_PARENT_POLL_INTERVAL_MS,
  CURSOR_WORKER_TERMINATION_GRACE_MS,
} from "./bounds";
import {
  parseWorkerFrame,
  type CursorParentFrame,
  type CursorWorkerFrame,
} from "./ipc";
import {
  createCursorProcessHost,
  type CursorProcessHost,
  type CursorSpawnedProcess,
} from "./process-host";

/**
 * The Cursor worker supervisor (spec D1, D2, D9, D20).
 *
 * It owns three things no other module may: what a worker's environment
 * contains, how the credential reaches it, and when its process is provably
 * gone. Everything else — turns, events, continuity — passes through as frames.
 *
 * The teardown ladder is the reason `close()` returns a promise at all: a
 * caller that deletes the worktree a worker is sitting in has to be able to
 * wait for a verified answer, and a verification that cannot be made is
 * recorded as a bounded failure rather than reported as success.
 */

const logger = createLogger("cursor-worker");

export interface CursorSupervisorBounds {
  /** Spawn to `ready`: process start, SDK load, and credential verification. */
  readyTimeoutMs: number;
  /** Native run cancellation before the shutdown request. */
  cancelGraceMs: number;
  /** Orderly disposal and exit after the shutdown request. */
  exitGraceMs: number;
  /** Post-SIGTERM window before SIGKILL. */
  termGraceMs: number;
  /** Post-SIGKILL window before cleanup is reported unverifiable. */
  killConfirmMs: number;
  probeIntervalMs: number;
  /** Supervisor-side conversation idle eviction. */
  idleTtlMs: number;
  /** Bounds the worker applies to itself, stated here so one side owns them. */
  workerParentPollIntervalMs: number;
  workerTerminationGraceMs: number;
}

const DEFAULT_BOUNDS: CursorSupervisorBounds = {
  readyTimeoutMs: CURSOR_SUPERVISOR_READY_TIMEOUT_MS,
  cancelGraceMs: CURSOR_TEARDOWN_CANCEL_GRACE_MS,
  exitGraceMs: CURSOR_TEARDOWN_EXIT_GRACE_MS,
  termGraceMs: CURSOR_TEARDOWN_TERM_GRACE_MS,
  killConfirmMs: CURSOR_TEARDOWN_KILL_CONFIRM_MS,
  probeIntervalMs: CURSOR_TEARDOWN_PROBE_INTERVAL_MS,
  idleTtlMs: CURSOR_WORKER_IDLE_TTL_MS,
  workerParentPollIntervalMs: CURSOR_WORKER_PARENT_POLL_INTERVAL_MS,
  workerTerminationGraceMs: CURSOR_WORKER_TERMINATION_GRACE_MS,
};

export interface CursorSupervisorDeps {
  host: CursorProcessHost;
  /** Cached installation check, refreshed when the SDK package changes. */
  runStaticPreflight(input: {
    model: string;
  }): Promise<CursorStaticPreflightResult>;
  /** The server's own `CURSOR_API_KEY`, re-read at every spawn (D2). */
  readCredential(): string | null;
  workerScriptPath(): string;
  workerExecArgv(): readonly string[];
  buildChildEnv(): Record<string, string | undefined>;
  getServerUrl(): string | null;
  getApiToken(): string | null;
  getConfigDir(): string;
  newWorkerId(): string;
  bounds?: Partial<CursorSupervisorBounds>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Drop undefined values; a spawn environment is string-valued. */
function toStringEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

type HandshakeOutcome =
  | { kind: "ready" }
  | {
      kind: "preflight_failed";
      frame: Extract<CursorWorkerFrame, { type: "preflightFailed" }>;
    }
  | { kind: "exited" };

class SupervisedWorker implements CursorWorkerSession {
  readonly handshake = deferred<HandshakeOutcome>();
  readonly selectionKey: string;
  readonly ownerToken: object;

  private readonly activeRuns = new Set<string>();
  private readonly cancelWaiters = new Map<string, Deferred<void>>();
  private readonly exitWaiters = new Set<Deferred<void>>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private closing: Promise<CursorWorkerCloseOutcome> | null = null;
  private expectedExit = false;
  private exited = false;

  constructor(
    readonly conversationId: string,
    readonly workerId: string,
    readonly pid: number,
    /** Null when the host could not read it: identity is then unverifiable. */
    private readonly pgid: number | null,
    private readonly child: CursorSpawnedProcess,
    private readonly host: CursorProcessHost,
    private readonly bounds: CursorSupervisorBounds,
    private readonly input: CursorWorkerStartInput,
    /** Re-read per use; this class deliberately has no field to cache it in. */
    private readonly readCredential: () => string | null,
    private readonly onSettled: (worker: SupervisedWorker) => void,
  ) {
    this.selectionKey = modelSelectionKey(input.modelSelection);
    this.ownerToken = input.ownerToken;
    child.onMessage((value) => this.receive(value));
    child.onExit((code, signal) => this.handleExit(code, signal));
    child.onError((error) => {
      logger.warn("cursor-worker.channel_error", {
        conversationId,
        workerId,
        pid,
        message: error.message,
      });
    });
  }

  private receive(value: unknown): void {
    const parsed = parseWorkerFrame(value);
    if (!parsed.ok) {
      // Bounded diagnostics only: an unparsable frame's contents are exactly
      // what must not be echoed anywhere.
      logger.warn("cursor-worker.frame_rejected", {
        conversationId: this.conversationId,
        workerId: this.workerId,
        reason: parsed.reason,
        frameType: parsed.frameType,
      });
      return;
    }
    const frame = parsed.frame;

    switch (frame.type) {
      case "ready":
        this.handshake.resolve({ kind: "ready" });
        break;
      case "preflightFailed":
        this.handshake.resolve({ kind: "preflight_failed", frame });
        break;
      case "turnSettled":
        this.activeRuns.delete(frame.runId);
        break;
      case "cancelResult": {
        this.activeRuns.delete(frame.runId);
        const waiter = this.cancelWaiters.get(frame.runId);
        if (waiter !== undefined) {
          this.cancelWaiters.delete(frame.runId);
          waiter.resolve();
        }
        break;
      }
      default:
        break;
    }

    this.touch();
    this.input.onFrame(frame);
  }

  private handleExit(code: number | null, signal: string | null): void {
    if (this.exited) return;
    this.exited = true;
    this.clearIdleTimer();
    for (const waiter of this.exitWaiters) waiter.resolve();
    this.exitWaiters.clear();
    this.handshake.resolve({ kind: "exited" });

    if (!this.expectedExit) {
      // The registry must not hold a dead worker: the next prompt has to be
      // free to resume from the persisted ref in a fresh one.
      this.onSettled(this);
      logger.warn("cursor-worker.unexpected_exit", {
        conversationId: this.conversationId,
        workerId: this.workerId,
        pid: this.pid,
        code,
        signal,
      });
    }

    this.input.onExit({
      conversationId: this.conversationId,
      workerId: this.workerId,
      pid: this.pid,
      code,
      signal,
      expected: this.expectedExit,
    });
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Any activity in either direction restarts the idle bound. */
  private touch(): void {
    if (this.exited || this.closing !== null) return;
    this.clearIdleTimer();
    if (this.activeRuns.size > 0) return;
    this.idleTimer = setTimeout(() => {
      logger.info("cursor-worker.idle_reaped", {
        conversationId: this.conversationId,
        workerId: this.workerId,
        pid: this.pid,
        idleTtlMs: this.bounds.idleTtlMs,
      });
      void this.close();
    }, this.bounds.idleTtlMs);
    this.idleTimer.unref?.();
  }

  armIdleTimer(): void {
    this.touch();
  }

  send(frame: CursorParentFrame): boolean {
    if (this.exited) return false;
    try {
      this.child.send(frame);
      this.touch();
      return true;
    } catch {
      // The channel closed under us; the exit handler owns the response.
      return false;
    }
  }

  attach(input: CursorAttachInput): void {
    // The worker consumed its handshake credential during verification and
    // holds nothing (D2), so each attach carries its own. Read fresh from the
    // server environment and handed straight to `send`: this supervisor never
    // has a field to keep it in.
    const credential = this.readCredential();
    if (credential === null || credential.length === 0) {
      // The caller is waiting on one settlement channel, so the refusal
      // arrives on it rather than as silence.
      this.input.onFrame({
        type: "attachResult",
        outcome: "failed",
        ref: null,
        error: {
          name: "CursorCredentialUnavailable",
          code: "credential_absent",
          status: null,
          message:
            "CURSOR_API_KEY is not set in the Command Center server environment",
        },
      });
      return;
    }
    this.send({
      type: "credential",
      apiKey: credential,
    });

    // The policy is applied here, not by the caller: D11 requires the full
    // non-persisted option set on every create AND resume, and a caller that
    // could compose it could also forget it.
    this.send({
      type: "attachAgent",
      mode: input.mode,
      ref: input.ref,
      ...(input.recoverAbandonedRun !== undefined
        ? { recoverAbandonedRun: input.recoverAbandonedRun }
        : {}),
      modelSelection: input.modelSelection,
      ...(this.input.executionProfile === "isolated-one-shot"
        ? { tools: [] }
        : {}),
      disallowedTools: [...CURSOR_PHASE1_POLICY.disallowedTools],
      sandboxEnabled: false,
      autoReview: false,
      settingSources: [],
      enableAgentRetries: CURSOR_PHASE1_POLICY.enableAgentRetries,
      mcpServers: input.mcpServers,
      agents: input.agents,
    });
  }

  startTurn(input: CursorTurnInput): void {
    this.activeRuns.add(input.runId);
    this.send({
      type: "startTurn",
      allowQuestions: input.allowQuestions ?? false,
      runId: input.runId,
      promptText: input.promptText,
      images: [...input.images],
      structuredOutputInstruction: input.structuredOutputInstruction,
      modelSelection: input.modelSelection,
      mcpServers: input.mcpServers,
      forceExpirePersistedRun: input.forceExpirePersistedRun,
    });
  }

  cancel(runId: string): void {
    this.send({ type: "cancel", runId });
  }

  steer(runId: string, requestId: string, text: string): void {
    this.send({
      type: "steer",
      runId,
      requestId,
      text,
    });
  }

  answerQuestion(
    runId: string,
    requestId: string,
    reply: import("@/lib/conversations/in-turn-question-schemas").InTurnQuestionReply,
  ): void {
    this.send({
      type: "questionReply",
      runId,
      requestId,
      reply,
    });
  }

  close(): Promise<CursorWorkerCloseOutcome> {
    this.closing ??= this.runTeardown();
    return this.closing;
  }

  private waitForExit(timeoutMs: number): Promise<void> {
    if (this.exited) return Promise.resolve();
    const waiter = deferred<void>();
    this.exitWaiters.add(waiter);
    return Promise.race([waiter.promise, sleep(timeoutMs)]);
  }

  /**
   * The verified teardown ladder (D9): native cancellation, bounded grace,
   * disposal and orderly exit, then process-group escalation,
   * then verification. Only its settlement clears the registry entry.
   */
  private async runTeardown(): Promise<CursorWorkerCloseOutcome> {
    this.expectedExit = true;
    this.clearIdleTimer();

    if (this.activeRuns.size > 0) {
      const pending: Promise<void>[] = [];
      for (const runId of this.activeRuns) {
        const waiter = deferred<void>();
        this.cancelWaiters.set(runId, waiter);
        pending.push(waiter.promise);
        this.cancel(runId);
      }
      await Promise.race([
        Promise.all(pending),
        sleep(this.bounds.cancelGraceMs),
      ]);
    }

    if (!this.exited) {
      this.send({
        type: "shutdown",
        reason: "close",
      });
      await this.waitForExit(this.bounds.exitGraceMs);
    }

    const outcome = await this.verifyGone();
    this.child.disconnect();
    this.onSettled(this);
    if (outcome.kind === "cleanup_failed") {
      logger.error("cursor-worker.cleanup_failed", {
        conversationId: this.conversationId,
        workerId: this.workerId,
        pid: this.pid,
        reason: outcome.reason,
      });
    } else {
      logger.info("cursor-worker.closed", {
        conversationId: this.conversationId,
        workerId: this.workerId,
        pid: this.pid,
        escalation: outcome.escalation,
      });
    }
    return outcome;
  }

  private async groupGoneWithin(timeoutMs: number): Promise<boolean> {
    if (this.pgid === null) return this.exited;
    const deadline = timeoutMs;
    let waited = 0;
    while (waited <= deadline) {
      if (!this.host.isGroupAlive(this.pgid)) return true;
      await sleep(this.bounds.probeIntervalMs);
      waited += this.bounds.probeIntervalMs;
    }
    return !this.host.isGroupAlive(this.pgid);
  }

  private async verifyGone(): Promise<CursorWorkerCloseOutcome> {
    if (await this.groupGoneWithin(0)) {
      return { kind: "verified", escalation: "orderly" };
    }

    if (this.pgid === null) {
      return {
        kind: "cleanup_failed",
        reason: "ownership_unverified",
        message: `worker ${this.workerId} could not be proven to own process group ${this.pgid ?? "unknown"}; no signal was sent`,
      };
    }
    const pgid = this.pgid;

    this.host.signalGroup(pgid, "SIGTERM");
    if (await this.groupGoneWithin(this.bounds.termGraceMs)) {
      return { kind: "verified", escalation: "sigterm" };
    }

    this.host.signalGroup(pgid, "SIGKILL");
    if (await this.groupGoneWithin(this.bounds.killConfirmMs)) {
      return { kind: "verified", escalation: "sigkill" };
    }

    return {
      kind: "cleanup_failed",
      reason: "group_survived",
      message: `process group ${pgid} survived SIGKILL by ${this.bounds.killConfirmMs}ms`,
    };
  }
}

export function createCursorWorkerSupervisor(
  deps: CursorSupervisorDeps,
): CursorWorkerTransport {
  const bounds: CursorSupervisorBounds = { ...DEFAULT_BOUNDS, ...deps.bounds };
  const registry = new Map<string, SupervisedWorker>();
  let acceptingStarts = true;
  let closeAllPromise: Promise<void> | null = null;
  const pendingStarts = new Map<
    string,
    {
      selectionKey: string;
      ownerToken: object;
      promise: Promise<CursorWorkerStartResult>;
    }
  >();

  function release(worker: SupervisedWorker): void {
    const current = registry.get(worker.conversationId);
    if (current === worker) registry.delete(worker.conversationId);
  }

  /**
   * The worker environment (D2). `buildChildEnv()` copies the whole server
   * environment, so removing `CURSOR_API_KEY` is deliberate work, not an
   * omission: it is what defeats the SDK's ambient-credential fallback and
   * makes the explicit `apiKey` option the only authentication path.
   */
  function buildWorkerEnv(
    input: CursorWorkerStartInput,
  ): Record<string, string> {
    // Credential-shaped variables are dropped from the INHERITED environment,
    // before the session contract runs: the contract then re-supplies Command
    // Center's own CC_API_TOKEN from `getApiToken()`, so the agent keeps its
    // cctl callback while the server's ambient credentials stay behind.
    const baseEnv = withoutAmbientCredentials(deps.buildChildEnv());
    const withheld = ambientCredentialKeys(deps.buildChildEnv());
    if (withheld.length > 0) {
      // Names only. Bounded by the host environment's own size.
      logger.debug("cursor-worker.ambient_credentials_withheld", {
        conversationId: input.conversationId,
        keys: withheld,
      });
    }
    const env = toStringEnv(
      input.target === null || input.executionProfile === "isolated-one-shot"
        ? neutralizeAmbientCcEnv(baseEnv)
        : buildSessionEnvContract({
            baseEnv,
            serverUrl: deps.getServerUrl(),
            apiToken: deps.getApiToken(),
            target: input.target,
            configDir: deps.getConfigDir(),
            ...(input.workflowExecutionId !== undefined
              ? { workflowExecutionId: input.workflowExecutionId }
              : {}),
            ...(input.workflowContextId !== undefined
              ? { workflowContextId: input.workflowContextId }
              : {}),
            ...(input.workflowCallerConversationId !== undefined
              ? {
                  workflowCallerConversationId:
                    input.workflowCallerConversationId,
                }
              : {}),
          }),
    );
    delete env.CURSOR_API_KEY;
    env.CC_LOG_FILE = path.join(
      deps.getConfigDir(),
      "logs",
      "cursor-workers",
      `${input.conversationId}.log`,
    );
    return env;
  }

  function bindingMismatch(
    conversationId: string,
    activeModelSelectionKey: string,
    requestedModelSelectionKey: string,
  ): CursorWorkerStartResult {
    logger.warn("cursor-worker.binding_mismatch", {
      conversationId,
      activeModelSelectionKey,
      requestedModelSelectionKey,
    });
    return {
      kind: "binding_mismatch",
      message:
        "A Cursor worker is already active for this conversation under a different model selection.",
    };
  }

  function ownerMismatch(conversationId: string): CursorWorkerStartResult {
    logger.warn("cursor-worker.binding_mismatch", {
      conversationId,
      mismatchKind: "runtime_owner",
    });
    return {
      kind: "binding_mismatch",
      message:
        "A Cursor worker is already active for this conversation under a different runtime owner.",
    };
  }

  async function startReserved(
    input: CursorWorkerStartInput,
  ): Promise<CursorWorkerStartResult> {
    // Layer 1 before layer 2, and both before any process: an unusable SDK
    // installation must not reach the point of handling a credential.
    const runtime = await deps.runStaticPreflight({
      model: input.modelSelection.modelId,
    });
    if (!runtime.ok) {
      logger.warn("cursor-worker.runtime_preflight_failed", {
        conversationId: input.conversationId,
        code: runtime.code,
        installedSdkVersion: runtime.diagnostics.installedSdkVersion,
        host: runtime.diagnostics.host,
        nodeVersion: runtime.diagnostics.nodeVersion,
      });
      return {
        kind: "runtime_preflight_failed",
        code: runtime.code,
        message: runtime.message,
        diagnostics: runtime.diagnostics,
      };
    }

    const credential = deps.readCredential();
    if (credential === null || credential.length === 0) {
      // Fail closed before a process exists: no worker, no state, no billable
      // turn (D3).
      return {
        kind: "preflight_failed",
        reason: "missing_credential",
        message:
          "CURSOR_API_KEY is not set in the Command Center server environment",
      };
    }

    const workerId = deps.newWorkerId();
    let child: CursorSpawnedProcess;
    try {
      child = deps.host.spawn({
        scriptPath: deps.workerScriptPath(),
        execArgv: deps.workerExecArgv(),
        cwd: input.cwd,
        env: buildWorkerEnv(input),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "spawn failed";
      logger.error("cursor-worker.spawn_failed", {
        conversationId: input.conversationId,
        workerId,
        message,
      });
      return { kind: "spawn_failed", message };
    }

    const worker = new SupervisedWorker(
      input.conversationId,
      workerId,
      child.pid,
      deps.host.processGroupId(child.pid),
      child,
      deps.host,
      bounds,
      input,
      deps.readCredential,
      release,
    );

    worker.send({
      type: "init",
      conversationId: input.conversationId,
      workerId,
      cwd: input.cwd,
      storePath: input.storePath,
      parentPid: process.pid,
      idleTimeoutMs: bounds.idleTtlMs,
      parentPollIntervalMs: bounds.workerParentPollIntervalMs,
      terminationGraceMs: bounds.workerTerminationGraceMs,
      sdkVersion: CURSOR_SDK_PINNED_VERSION,
    });
    // The credential's one crossing. Nothing retains it afterwards: the next
    // spawn re-reads the server's environment, which is also what makes
    // rotation-at-restart the whole rotation story.
    worker.send({
      type: "credential",
      apiKey: credential,
    });

    const outcome = await Promise.race([
      worker.handshake.promise,
      sleep(bounds.readyTimeoutMs).then((): HandshakeOutcome | null => null),
    ]);

    if (outcome?.kind === "ready") {
      registry.set(input.conversationId, worker);
      worker.armIdleTimer();
      logger.info("cursor-worker.ready", {
        conversationId: input.conversationId,
        workerId,
        pid: child.pid,
      });
      return { kind: "ready", session: worker };
    }

    await worker.close();

    if (outcome?.kind === "preflight_failed") {
      logger.warn("cursor-worker.preflight_failed", {
        conversationId: input.conversationId,
        workerId,
        reason: outcome.frame.reason,
      });
      return {
        kind: "preflight_failed",
        reason: outcome.frame.reason,
        message: outcome.frame.message,
      };
    }

    const message =
      outcome?.kind === "exited"
        ? `the Cursor worker exited before reporting ready`
        : `the Cursor worker did not report ready within ${bounds.readyTimeoutMs}ms`;
    logger.error("cursor-worker.handshake_failed", {
      conversationId: input.conversationId,
      workerId,
      pid: child.pid,
      message,
    });
    return { kind: "spawn_failed", message };
  }

  async function start(
    input: CursorWorkerStartInput,
  ): Promise<CursorWorkerStartResult> {
    if (!acceptingStarts) {
      return {
        kind: "spawn_failed",
        message: "The Cursor worker supervisor is shutting down.",
      };
    }

    const requestedSelectionKey = modelSelectionKey(input.modelSelection);
    const existing = registry.get(input.conversationId);
    if (existing !== undefined) {
      if (existing.ownerToken !== input.ownerToken) {
        return ownerMismatch(input.conversationId);
      }
      if (existing.selectionKey !== requestedSelectionKey) {
        return bindingMismatch(
          input.conversationId,
          existing.selectionKey,
          requestedSelectionKey,
        );
      }
      return { kind: "already_active", session: existing };
    }

    const pending = pendingStarts.get(input.conversationId);
    if (pending !== undefined) {
      if (pending.ownerToken !== input.ownerToken) {
        return ownerMismatch(input.conversationId);
      }
      if (pending.selectionKey !== requestedSelectionKey) {
        return bindingMismatch(
          input.conversationId,
          pending.selectionKey,
          requestedSelectionKey,
        );
      }
      const result = await pending.promise;
      if (result.kind === "ready" || result.kind === "already_active") {
        return { kind: "already_active", session: result.session };
      }
      return result;
    }

    const promise = Promise.resolve().then(() => startReserved(input));
    pendingStarts.set(input.conversationId, {
      selectionKey: requestedSelectionKey,
      ownerToken: input.ownerToken,
      promise,
    });
    try {
      return await promise;
    } finally {
      const current = pendingStarts.get(input.conversationId);
      if (current?.promise === promise) {
        pendingStarts.delete(input.conversationId);
      }
    }
  }

  async function closeEveryWorker(): Promise<void> {
    const closingRegistered = Promise.all(
      [...registry.values()].map(async (worker) => {
        await worker.close();
      }),
    );
    await Promise.allSettled(
      [...pendingStarts.values()].map((pending) => pending.promise),
    );
    await closingRegistered;
    await Promise.all(
      [...registry.values()].map(async (worker) => {
        await worker.close();
      }),
    );
  }

  function closeAll(): Promise<void> {
    acceptingStarts = false;
    closeAllPromise ??= closeEveryWorker();
    return closeAllPromise;
  }

  return {
    start,
    find: (conversationId) => registry.get(conversationId) ?? null,
    closeAll,
  };
}

/**
 * The worker bundle `bun run build:worker` produces, resolved the way the cctl
 * bundle already is (`instrumentation.node.ts`): from the project root the
 * server runs in. The worker is bundled rather than executed from source
 * because the child is a plain Node process with no TypeScript loader.
 */
export function cursorWorkerScriptPath(): string {
  return path.join(process.cwd(), "dist", "cursor-worker", "worker.mjs");
}

/** The production transport: the real OS, the real bundle, the real key. */
export function createProductionCursorWorkerTransport(): CursorWorkerTransport {
  return createCursorWorkerSupervisor({
    host: createCursorProcessHost(),
    runStaticPreflight: runProductionCursorPreflight,
    // Read per spawn, never cached: rotation takes effect at server restart
    // because the server's own environment is the only source (D2).
    readCredential: () => process.env.CURSOR_API_KEY ?? null,
    workerScriptPath: cursorWorkerScriptPath,
    workerExecArgv: () => [],
    buildChildEnv,
    getServerUrl: getServerBaseUrl,
    getApiToken: getCachedInstanceToken,
    getConfigDir: getConfigDirPath,
    newWorkerId: () => randomUUID(),
  });
}
