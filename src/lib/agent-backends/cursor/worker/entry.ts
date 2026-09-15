import type { CursorCapabilitySnapshot } from "../capability-delivery";
import {
  CURSOR_CREDENTIAL_PREFLIGHT_TIMEOUT_MS,
  CURSOR_WORKER_HANDSHAKE_TIMEOUT_MS,
  CURSOR_WORKER_IDLE_TTL_MS,
  CURSOR_WORKER_PARENT_POLL_INTERVAL_MS,
  CURSOR_WORKER_TERMINATION_GRACE_MS,
} from "./bounds";
import {
  CURSOR_IPC_CODEC_VERSION,
  encodeNativePayload,
  parseParentFrame,
  type CursorParentFrame,
  type CursorPreflightFailureReason,
  type CursorSdkErrorFrameDetail,
  type CursorWorkerFrame,
} from "./ipc";
import type { BackendModelSelection } from "../../schemas";
import { validateCursorWorkerModelSelection } from "./model-selection";
import { createLogger } from "@/lib/logging";
import { CursorWorkerQuestions } from "./question-bridge";
import { CURSOR_NATIVE_MEMORY_INSTRUCTION } from "../native-memory";

const logger = createLogger("cursor-worker");

/**
 * The Cursor worker process (spec D1, D2, D3 layer 2, D9).
 *
 * One worker serves one conversation. It owns the SDK, the credential, and its
 * own lifetime: the parent can ask it to stop, but a parent that dies without
 * asking does not leave it running.
 *
 * The SDK is reached only through {@link CursorWorkerSdk}, injected rather than
 * imported, so every handshake, attach, turn, and teardown path is exercisable
 * in-process. `main.ts` binds the real `@cursor/sdk` implementation.
 */

/** The private fork channel, narrowed to what the worker actually uses. */
export interface CursorWorkerChannel {
  send(frame: CursorWorkerFrame): void;
  onMessage(listener: (value: unknown) => void): void;
  onDisconnect(listener: () => void): void;
}

/**
 * Process-level effects. Injected because the watchdog's whole job is signalling
 * and exiting: a test that could not observe those calls would have to kill its
 * own runner to observe anything.
 */
export interface CursorWorkerProcessControl {
  readonly pid: number;
  processGroupId(): number;
  setUmask(mask: number): void;
  /** Re-read on every poll: a reparented worker reads a different value. */
  parentPid(): number;
  isAlive(pid: number): boolean;
  signalGroup(pgid: number, signal: NodeJS.Signals): void;
  /**
   * Stop the default SIGTERM disposition for the rest of this process's life.
   * The group-wide SIGTERM below would otherwise kill the worker before it can
   * escalate to SIGKILL for descendants that ignored the first signal.
   */
  ignoreTermination(): void;
  exit(code: number): void;
}

export type { CursorWorkerMcpServer } from "./ipc";
import type { CursorWorkerMcpServer } from "./ipc";

/**
 * The create/resume option set the SDK does not persist (D11), passed in full on
 * every attach. `apiKey` is the only authentication path — the worker's
 * environment deliberately carries no `CURSOR_API_KEY` for the SDK to find.
 */
export interface CursorWorkerAttachOptions {
  agents?: CursorCapabilitySnapshot["agents"];
  recoverAbandonedRun?: boolean;
  apiKey: string;
  modelSelection: BackendModelSelection;
  cwd: string;
  storePath: string;
  disallowedTools: readonly string[];
  tools?: readonly never[];
  sandboxEnabled: false;
  autoReview: false;
  settingSources: readonly string[];
  enableAgentRetries: boolean;
  mcpServers: Record<string, CursorWorkerMcpServer>;
}

/**
 * Per-send options (D11): the model, the MCP map, and the force-expiry
 * recovery flag, plus public task progress. The flag is a send option because that is
 * where the SDK exposes it (`LocalSendOptions.force`).
 */
export interface CursorWorkerSendOptions {
  onQuestion?: CursorWorkerQuestions["ask"];
  onTaskUpdate?(update: unknown): void;
  modelSelection: BackendModelSelection;
  mcpServers: Record<string, CursorWorkerMcpServer>;
  forceExpirePersistedRun: boolean;
}

export interface CursorWorkerSendMessage {
  text: string;
  images: readonly { data: string; mimeType: string }[];
}

export interface CursorWorkerRunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
}

export interface CursorWorkerRunResult {
  status: "finished" | "error" | "cancelled";
  error?: { message: string; code?: string };
  usage?: CursorWorkerRunUsage;
}

export interface CursorWorkerRun {
  steer?(text: string): Promise<"complete_delivered" | "revert_to_followup">;
  /** Complete public SDK objects, in delivery order. */
  stream(): AsyncIterable<unknown>;
  wait(): Promise<CursorWorkerRunResult>;
  cancel(): Promise<void>;
}

export interface CursorWorkerAgent {
  readonly agentId: string;
  send(
    message: CursorWorkerSendMessage,
    options: CursorWorkerSendOptions,
  ): Promise<CursorWorkerRun>;
  dispose(): Promise<void>;
}

export interface CursorWorkerSdk {
  /** `Cursor.me({ apiKey })`: rejects with the SDK's typed error taxonomy. */
  verifyCredential(apiKey: string): Promise<void>;
  create(options: CursorWorkerAttachOptions): Promise<CursorWorkerAgent>;
  resume(
    ref: string,
    options: CursorWorkerAttachOptions,
  ): Promise<CursorWorkerAgent>;
}

export interface CursorWorkerDeps {
  channel: CursorWorkerChannel;
  process: CursorWorkerProcessControl;
  /** Deferred so an unauthenticated worker never pays the SDK's load cost. */
  loadSdk(): Promise<CursorWorkerSdk>;
  nodeVersion: string;
  sdkVersion: string;
}

export interface CursorWorkerHandle {
  /**
   * Whether a credential is currently held, awaiting the SDK call it was sent
   * for. A boolean, never the value: this exists so the one-shot lifetime is
   * observable. It reads false everywhere except between a credential frame and
   * the handoff that consumes it.
   */
  hasCredential(): boolean;
  /** Resolves once the worker's termination sequence has finished. */
  readonly stopped: Promise<void>;
}

/** Worker exit codes, distinct so a supervisor log can tell them apart. */
export const CURSOR_WORKER_EXIT_OK = 0;
export const CURSOR_WORKER_EXIT_PREFLIGHT_FAILED = 78;
export const CURSOR_WORKER_EXIT_ORPHANED = 79;
export const CURSOR_WORKER_EXIT_IDLE = 80;

export type CursorWorkerStopReason =
  | "shutdown"
  | "disconnect"
  | "parent_exit"
  | "idle"
  | "preflight_failed";

const EXIT_CODE_BY_REASON: Record<CursorWorkerStopReason, number> = {
  shutdown: CURSOR_WORKER_EXIT_OK,
  disconnect: CURSOR_WORKER_EXIT_ORPHANED,
  parent_exit: CURSOR_WORKER_EXIT_ORPHANED,
  idle: CURSOR_WORKER_EXIT_IDLE,
  preflight_failed: CURSOR_WORKER_EXIT_PREFLIGHT_FAILED,
};

/**
 * The credential's only home in this process, and a deliberately one-shot one
 * (D2: both ends clear their buffers after handoff).
 *
 * There is no read that leaves the key in place: `take` is the only accessor,
 * so every path that uses the credential also consumes it. A worker therefore
 * holds credential material only across the single SDK call it was sent for —
 * the handshake verification, or one `Agent.create`/`Agent.resume` — and the
 * supervisor re-sends a fresh one before each attach. What the SDK retains
 * internally afterwards is the SDK's own business; what this process retains is
 * nothing.
 */
class CredentialVault {
  private key: string | null = null;

  set(key: string): void {
    this.key = key;
  }

  /** Reads and clears in one step. Null when nothing is currently held. */
  take(): string | null {
    const key = this.key;
    this.key = null;
    return key;
  }

  held(): boolean {
    return this.key !== null;
  }

  clear(): void {
    this.key = null;
  }
}

interface WorkerConfig {
  conversationId: string;
  workerId: string;
  cwd: string;
  storePath: string;
  parentPid: number;
  idleTimeoutMs: number;
  parentPollIntervalMs: number;
  terminationGraceMs: number;
}

interface ActiveRun {
  runId: string;
  run: CursorWorkerRun;
  steerRequests: Set<string>;
}

function readProperty(value: unknown, key: string): unknown {
  if (value === null) return undefined;
  if (typeof value !== "object" && typeof value !== "function")
    return undefined;
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function readString(value: unknown, key: string): string | null {
  const read = readProperty(value, key);
  return typeof read === "string" && read.length > 0 ? read : null;
}

/**
 * The SDK's stable error seams, flattened for the wire. Class identity does not
 * survive IPC; name, code, and status do, and they are what the parent's
 * classifier reads.
 */
export function describeSdkError(error: unknown): CursorSdkErrorFrameDetail {
  const status = readProperty(error, "status");
  const message = readString(error, "message");
  return {
    name: readString(error, "name"),
    code: readString(error, "code"),
    status:
      typeof status === "number" && Number.isInteger(status) ? status : null,
    message: message ?? "cursor worker failure with an unreadable message",
  };
}

/**
 * Credential-verification failures, classified by the SDK's stable seams.
 *
 * An unclassified failure is reported as an invalid credential rather than a
 * transient one: preflight exists to gate on the credential, so the fail-closed
 * reading is that the credential did not verify.
 */
function credentialFailureReason(error: unknown): CursorPreflightFailureReason {
  const detail = describeSdkError(error);
  if (detail.name === "NetworkError" || detail.name === "RateLimitError") {
    return "credential_network";
  }
  if (detail.status === 503 || detail.status === 504 || detail.status === 429) {
    return "credential_network";
  }
  if (detail.code === "unavailable" || detail.code === "rate_limit") {
    return "credential_network";
  }
  return "invalid_credential";
}

class TimeoutExpired extends Error {}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutExpired(`bound of ${timeoutMs}ms elapsed`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Start the worker's run loop. Returns immediately; everything else happens on
 * IPC frames and timers.
 */
export function startCursorWorker(deps: CursorWorkerDeps): CursorWorkerHandle {
  // Before anything else, and specifically before the SDK can create a store:
  // every file this process or its children write stays owner-only.
  deps.process.setUmask(0o077);

  const vault = new CredentialVault();
  let config: WorkerConfig | null = null;
  let sdk: CursorWorkerSdk | null = null;
  let agent: CursorWorkerAgent | null = null;
  let issuedRef: string | null = null;
  let activeRun: ActiveRun | null = null;
  let activeQuestions: CursorWorkerQuestions | null = null;
  let ready = false;
  let stopping = false;

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  let parentPoll: ReturnType<typeof setInterval> | null = null;

  let resolveStopped: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  function send(frame: CursorWorkerFrame): void {
    try {
      deps.channel.send(frame);
    } catch {
      // The channel is gone. The disconnect watchdog owns the response; a send
      // that throws must not abort the loop that is already tearing down.
    }
  }

  function clearTimers(): void {
    if (idleTimer !== null) clearTimeout(idleTimer);
    if (handshakeTimer !== null) clearTimeout(handshakeTimer);
    if (parentPoll !== null) clearInterval(parentPoll);
    idleTimer = null;
    handshakeTimer = null;
    parentPoll = null;
  }

  function armIdleTimer(): void {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
    // Exactly one bound governs each phase. While the handshake bound is
    // pending it owns the window, so an idle expiry cannot pre-empt the more
    // specific missing-credential diagnosis.
    if (handshakeTimer !== null || activeRun !== null || stopping) return;
    const idleTimeoutMs = config?.idleTimeoutMs ?? CURSOR_WORKER_IDLE_TTL_MS;
    idleTimer = setTimeout(() => {
      void stop("idle");
    }, idleTimeoutMs);
    idleTimer.unref?.();
  }

  function armHandshakeTimer(): void {
    handshakeTimer = setTimeout(() => {
      // Nothing arrived on the one channel that can carry a credential, so the
      // worker reports the absence itself rather than waiting to be reaped.
      send({
        v: CURSOR_IPC_CODEC_VERSION,
        type: "preflightFailed",
        reason: "missing_credential",
        message: "no credential arrived within the handshake bound",
      });
      void stop("preflight_failed");
    }, CURSOR_WORKER_HANDSHAKE_TIMEOUT_MS);
    handshakeTimer.unref?.();
  }

  function armParentPoll(): void {
    const current = config;
    if (current === null) return;
    if (parentPoll !== null) clearInterval(parentPoll);
    parentPoll = setInterval(() => {
      const alive =
        deps.process.isAlive(current.parentPid) &&
        deps.process.parentPid() === current.parentPid;
      if (!alive) void stop("parent_exit");
    }, current.parentPollIntervalMs);
    parentPoll.unref?.();
  }

  /**
   * Self-termination (D9). Native cancellation and disposal are bounded, then
   * the process group is signalled. SDK shell children can lead separate groups,
   * so cancellation must run while the SDK connection is still available.
   */
  async function stop(reason: CursorWorkerStopReason): Promise<void> {
    if (stopping) return;
    stopping = true;
    activeQuestions?.close();
    clearTimers();

    const graceMs =
      config?.terminationGraceMs ?? CURSOR_WORKER_TERMINATION_GRACE_MS;
    const cancelling = activeRun;
    const disposing = agent;
    agent = null;
    activeRun = null;
    if (cancelling !== null) {
      try {
        await withTimeout(cancelling.run.cancel(), graceMs);
        logger.info("cursor-worker.shutdown_run_cancelled", {
          runId: cancelling.runId,
          reason,
        });
      } catch {
        logger.warn("cursor-worker.shutdown_cancel_unconfirmed", {
          runId: cancelling.runId,
          reason,
        });
      }
    }
    if (disposing !== null) {
      try {
        await withTimeout(disposing.dispose(), graceMs);
      } catch {
        // A disposal that hangs or throws must not stop the escalation below;
        // that escalation is exactly what covers it.
      }
    }
    vault.clear();

    const pgid = deps.process.processGroupId();
    deps.process.ignoreTermination();
    deps.process.signalGroup(pgid, "SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, graceMs);
      timer.unref?.();
    });
    deps.process.signalGroup(pgid, "SIGKILL");

    resolveStopped();
    deps.process.exit(EXIT_CODE_BY_REASON[reason]);
  }

  async function handleInit(
    frame: Extract<CursorParentFrame, { type: "init" }>,
  ): Promise<void> {
    config = {
      conversationId: frame.conversationId,
      workerId: frame.workerId,
      cwd: frame.cwd,
      storePath: frame.storePath,
      parentPid: frame.parentPid,
      idleTimeoutMs: frame.idleTimeoutMs,
      parentPollIntervalMs: frame.parentPollIntervalMs,
      terminationGraceMs: frame.terminationGraceMs,
    };
    // Handshake first: it owns the window until the credential lands, and
    // arming it before the idle timer is what makes that ownership hold.
    armHandshakeTimer();
    armIdleTimer();
    armParentPoll();
  }

  async function handleCredential(
    frame: Extract<CursorParentFrame, { type: "credential" }>,
  ): Promise<void> {
    // The vault is the key's only home from here; the frame is not retained.
    vault.set(frame.apiKey);
    if (handshakeTimer !== null) {
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
      armIdleTimer();
    }

    // After the handshake, a credential frame is fuel for the attach that
    // follows it — not a reason to re-verify. It stays in the vault exactly
    // until that attach consumes it.
    if (ready) return;

    try {
      sdk = await deps.loadSdk();
    } catch {
      // The load error can carry paths and versions but nothing actionable the
      // parent cannot already read from static preflight, so only the class
      // crosses.
      send({
        v: CURSOR_IPC_CODEC_VERSION,
        type: "preflightFailed",
        reason: "sdk_load_failed",
        message: "the Cursor SDK could not be loaded in the worker",
      });
      await stop("preflight_failed");
      return;
    }

    // Verification consumes the handshake credential. Whatever the outcome,
    // nothing in this process holds it once the call returns: an attach needs a
    // fresh one, which is the supervisor's job to send.
    const handshakeKey = vault.take();
    if (handshakeKey === null) {
      send({
        v: CURSOR_IPC_CODEC_VERSION,
        type: "preflightFailed",
        reason: "missing_credential",
        message: "the credential frame carried no usable key",
      });
      await stop("preflight_failed");
      return;
    }

    try {
      await withTimeout(
        sdk.verifyCredential(handshakeKey),
        CURSOR_CREDENTIAL_PREFLIGHT_TIMEOUT_MS,
      );
    } catch (error) {
      const reason =
        error instanceof TimeoutExpired
          ? "credential_timeout"
          : credentialFailureReason(error);
      send({
        v: CURSOR_IPC_CODEC_VERSION,
        type: "preflightFailed",
        reason,
        // The verification response can echo the key back in a message body, so
        // only the classification crosses — never the SDK's own text.
        message: `cursor credential verification failed (${reason})`,
      });
      await stop("preflight_failed");
      return;
    }

    ready = true;
    send({
      v: CURSOR_IPC_CODEC_VERSION,
      type: "ready",
      pid: deps.process.pid,
      pgid: deps.process.processGroupId(),
      nodeVersion: deps.nodeVersion,
      sdkVersion: deps.sdkVersion,
    });
  }

  function attachOptions(
    frame: Extract<CursorParentFrame, { type: "attachAgent" }>,
    apiKey: string,
    current: WorkerConfig,
    modelSelection: BackendModelSelection,
  ): CursorWorkerAttachOptions {
    return {
      apiKey,
      modelSelection,
      cwd: current.cwd,
      storePath: current.storePath,
      disallowedTools: frame.disallowedTools,
      ...(frame.tools !== undefined ? { tools: frame.tools } : {}),
      sandboxEnabled: frame.sandboxEnabled,
      autoReview: frame.autoReview,
      settingSources: frame.settingSources,
      enableAgentRetries: frame.enableAgentRetries,
      mcpServers: frame.mcpServers,
      agents: frame.agents,
      ...(frame.recoverAbandonedRun !== undefined
        ? { recoverAbandonedRun: frame.recoverAbandonedRun }
        : {}),
    };
  }

  async function handleAttach(
    frame: Extract<CursorParentFrame, { type: "attachAgent" }>,
  ): Promise<void> {
    const current = config;
    const loaded = sdk;
    if (current === null || loaded === null || !ready) {
      send({
        v: CURSOR_IPC_CODEC_VERSION,
        type: "attachResult",
        outcome: "failed",
        ref: null,
        error: {
          name: "CursorWorkerNotReady",
          code: "worker_not_ready",
          status: null,
          message: "attach arrived before the worker completed its handshake",
        },
      });
      return;
    }

    // Consumed, not read: the handshake credential is long gone, so this attach
    // runs on the one the supervisor sent immediately before it, and holds it
    // only for the duration of the create/resume call below.
    const apiKey = vault.take();
    if (apiKey === null) {
      send({
        v: CURSOR_IPC_CODEC_VERSION,
        type: "attachResult",
        outcome: "failed",
        ref: null,
        error: {
          name: "CursorCredentialUnavailable",
          code: "credential_absent",
          status: null,
          message: "attach arrived with no credential in hand",
        },
      });
      return;
    }

    const modelSelection = validateCursorWorkerModelSelection(
      frame.modelSelection,
    );
    if (!modelSelection.valid) {
      send({
        v: CURSOR_IPC_CODEC_VERSION,
        type: "attachResult",
        outcome: "failed",
        ref: null,
        error: modelSelection.error,
      });
      return;
    }

    const options = attachOptions(
      frame,
      apiKey,
      current,
      modelSelection.selection,
    );
    try {
      agent =
        frame.mode === "resume" && frame.ref !== null
          ? await loaded.resume(frame.ref, options)
          : await loaded.create(options);
    } catch (error) {
      send({
        v: CURSOR_IPC_CODEC_VERSION,
        type: "attachResult",
        outcome: "failed",
        ref: null,
        error: describeSdkError(error),
      });
      return;
    }

    issueRef(agent.agentId, null);
    send({
      v: CURSOR_IPC_CODEC_VERSION,
      type: "attachResult",
      outcome: "attached",
      ref: agent.agentId,
      error: null,
    });
  }

  /** Eager ref persistence (D8), emitted once per distinct ref. */
  function issueRef(ref: string, runId: string | null): void {
    if (issuedRef === ref) return;
    issuedRef = ref;
    send({ v: CURSOR_IPC_CODEC_VERSION, type: "refIssued", runId, ref });
  }

  function forwardEvent(
    runId: string,
    eventIndex: number,
    event: unknown,
  ): void {
    const eventType = readString(event, "type") ?? "unknown";
    const encoded = encodeNativePayload(eventType, event);
    if (!encoded.ok) {
      send({
        v: CURSOR_IPC_CODEC_VERSION,
        type: "nativeEventRejected",
        runId,
        eventIndex,
        eventType: encoded.eventType,
        violation: encoded.violation,
        byteLength: encoded.byteLength,
        sha256: encoded.sha256,
      });
      return;
    }
    send({
      v: CURSOR_IPC_CODEC_VERSION,
      type: "nativeEvent",
      runId,
      eventIndex,
      eventType,
      payload: encoded.payload,
    });
  }

  function sendUsage(runId: string, usage: CursorWorkerRunUsage): void {
    send({
      v: CURSOR_IPC_CODEC_VERSION,
      type: "usage",
      runId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      totalTokens: usage.totalTokens,
      ...(usage.reasoningTokens !== undefined
        ? { reasoningTokens: usage.reasoningTokens }
        : {}),
    });
  }

  async function handleStartTurn(
    frame: Extract<CursorParentFrame, { type: "startTurn" }>,
  ): Promise<void> {
    const current = agent;
    if (current === null) {
      send({
        v: CURSOR_IPC_CODEC_VERSION,
        type: "turnSettled",
        runId: frame.runId,
        outcome: "failed",
        error: {
          name: "CursorWorkerNotAttached",
          code: "worker_not_attached",
          status: null,
          message: "a turn was started before an agent was attached",
        },
      });
      return;
    }

    const modelSelection = validateCursorWorkerModelSelection(
      frame.modelSelection,
    );
    if (!modelSelection.valid) {
      send({
        v: CURSOR_IPC_CODEC_VERSION,
        type: "turnSettled",
        runId: frame.runId,
        outcome: "failed",
        error: modelSelection.error,
      });
      return;
    }

    let eventIndex = 0;
    let forwarding = true;
    const forward = (event: unknown): void => {
      if (!forwarding || stopping) return;
      // The earliest provable receipt (D6): the agent answered on this run.
      if (eventIndex === 0)
        send({
          v: CURSOR_IPC_CODEC_VERSION,
          type: "inputAccepted",
          runId: frame.runId,
        });
      const ref = readString(event, "agent_id");
      if (ref !== null) issueRef(ref, frame.runId);
      forwardEvent(frame.runId, eventIndex++, event);
      armIdleTimer();
    };
    let run: CursorWorkerRun;
    const questions = new CursorWorkerQuestions(frame.runId, send);
    activeQuestions = questions;
    try {
      logger.info("cursor-worker.native_memory_policy", {
        runId: frame.runId,
        mechanism: "none",
        instructionDelivery: "user-message",
        effectiveState: "unknown",
      });
      run = await current.send(
        {
          text: `${CURSOR_NATIVE_MEMORY_INSTRUCTION}\n\n${frame.promptText}`,
          images: frame.images,
        },
        // Per-send options carry the model, the MCP map, and the force-expiry
        // recovery flag; the rest of the policy was established at attach and
        // is retained by the agent.
        {
          modelSelection: modelSelection.selection,
          mcpServers: frame.mcpServers,
          forceExpirePersistedRun: frame.forceExpirePersistedRun,
          ...(frame.allowQuestions
            ? {
                onQuestion: (
                  items: import("@/lib/conversations/schemas").AskQuestionItem[],
                  toolCallId?: string,
                ) => questions.ask(items, toolCallId),
              }
            : {}),
          onTaskUpdate: (update) =>
            forward({ type: "cursor_task_delta", update }),
        },
      );
    } catch (error) {
      questions.close();
      forwarding = false;
      send({
        v: CURSOR_IPC_CODEC_VERSION,
        type: "turnSettled",
        runId: frame.runId,
        outcome: "failed",
        error: describeSdkError(error),
      });
      return;
    }

    activeRun = { runId: frame.runId, run, steerRequests: new Set() };
    armIdleTimer();
    try {
      for await (const event of run.stream()) {
        forward(event);
      }
    } catch (error) {
      questions.close();
      forwarding = false;
      activeRun = null;
      armIdleTimer();
      send({
        v: CURSOR_IPC_CODEC_VERSION,
        type: "turnSettled",
        runId: frame.runId,
        outcome: "failed",
        error: describeSdkError(error),
      });
      return;
    }

    let result: CursorWorkerRunResult;
    try {
      result = await run.wait();
    } catch (error) {
      questions.close();
      forwarding = false;
      activeRun = null;
      armIdleTimer();
      send({
        v: CURSOR_IPC_CODEC_VERSION,
        type: "turnSettled",
        runId: frame.runId,
        outcome: "failed",
        error: describeSdkError(error),
      });
      return;
    }
    forwarding = false;
    questions.close();
    activeRun = null;
    armIdleTimer();

    if (result.usage !== undefined) sendUsage(frame.runId, result.usage);
    send({
      v: CURSOR_IPC_CODEC_VERSION,
      type: "turnSettled",
      runId: frame.runId,
      outcome:
        result.status === "finished"
          ? "completed"
          : result.status === "cancelled"
            ? "aborted"
            : "failed",
      error:
        result.error === undefined
          ? null
          : {
              name: null,
              code: result.error.code ?? null,
              status: null,
              message: result.error.message,
            },
    });
  }

  async function handleSteer(
    frame: Extract<CursorParentFrame, { type: "steer" }>,
  ): Promise<void> {
    const current = activeRun;
    const reply = (
      outcome: "complete_delivered" | "revert_to_followup" | "uncertain",
    ) => {
      logger.info("cursor-worker.steer_settled", {
        runId: frame.runId,
        requestId: frame.requestId,
        outcome,
      });
      send({
        v: CURSOR_IPC_CODEC_VERSION,
        type: "steerResult",
        runId: frame.runId,
        requestId: frame.requestId,
        outcome,
      });
    };
    if (
      stopping ||
      !current ||
      current.runId !== frame.runId ||
      !current.run.steer
    ) {
      reply("revert_to_followup");
      return;
    }
    if (current.steerRequests.has(frame.requestId)) return;
    current.steerRequests.add(frame.requestId);
    try {
      reply(await current.run.steer(frame.text));
    } catch {
      reply("uncertain");
    }
  }

  async function handleCancel(
    frame: Extract<CursorParentFrame, { type: "cancel" }>,
  ): Promise<void> {
    if (activeQuestions?.runId === frame.runId) activeQuestions.close();
    const current = activeRun;
    if (current === null || current.runId !== frame.runId) {
      send({
        v: CURSOR_IPC_CODEC_VERSION,
        type: "cancelResult",
        runId: frame.runId,
        outcome: "not_active",
        message: null,
      });
      return;
    }
    try {
      await current.run.cancel();
      send({
        v: CURSOR_IPC_CODEC_VERSION,
        type: "cancelResult",
        runId: frame.runId,
        outcome: "cancelled",
        message: null,
      });
    } catch (error) {
      send({
        v: CURSOR_IPC_CODEC_VERSION,
        type: "cancelResult",
        runId: frame.runId,
        outcome: "failed",
        message: describeSdkError(error).message,
      });
    }
  }

  async function dispatch(frame: CursorParentFrame): Promise<void> {
    armIdleTimer();
    switch (frame.type) {
      case "init":
        return handleInit(frame);
      case "credential":
        return handleCredential(frame);
      case "attachAgent":
        return handleAttach(frame);
      case "startTurn":
        return handleStartTurn(frame);
      case "steer":
        return handleSteer(frame);
      case "questionReply":
        activeQuestions?.answer(frame.runId, frame.requestId, frame.reply);
        return;
      case "cancel":
        return handleCancel(frame);
      case "shutdown":
        return stop("shutdown");
    }
  }

  deps.channel.onMessage((value) => {
    const parsed = parseParentFrame(value);
    if (!parsed.ok) {
      // A frame the codec rejects is bounded diagnostics, never payload: the
      // rejection names the reason and, only when it is a known discriminant,
      // the frame type.
      send({
        v: CURSOR_IPC_CODEC_VERSION,
        type: "fatal",
        code: `protocol_${parsed.reason}`,
        message: `rejected a parent frame (${parsed.frameType ?? "unknown type"})`,
      });
      return;
    }
    void dispatch(parsed.frame).catch((error: unknown) => {
      send({
        v: CURSOR_IPC_CODEC_VERSION,
        type: "fatal",
        code: "worker_unhandled",
        message: describeSdkError(error).message,
      });
    });
  });

  deps.channel.onDisconnect(() => {
    void stop("disconnect");
  });

  // The pre-handshake window has bounds too: a parent that dies between spawn
  // and `init` has already been replaced by pid 1 as this worker's parent.
  const bootParentPid = deps.process.parentPid();
  parentPoll = setInterval(() => {
    if (config !== null) return;
    if (deps.process.parentPid() !== bootParentPid) void stop("parent_exit");
  }, CURSOR_WORKER_PARENT_POLL_INTERVAL_MS);
  parentPoll.unref?.();
  armIdleTimer();

  return {
    hasCredential: () => vault.held(),
    stopped,
  };
}
