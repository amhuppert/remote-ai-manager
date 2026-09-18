import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { createAppServerProcessHost } from "./app-server-client-process";
import {
  APP_SERVER_LIMITS,
  AppServerRecordDecoder,
  AppServerRequestError,
  AppServerTransportError,
  type AppServerId,
} from "./app-server-protocol";
import type {
  AppServerFrame,
  AppServerMessage,
  AppServerRpcError,
} from "./app-server-protocol";

export interface AppServerProcess {
  readonly pid: number;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  onExit(
    listener: (code: number | null, signal: string | null) => void,
  ): () => void;
  onError(listener: (error: Error) => void): () => void;
}
export interface AppServerProcessHost {
  spawn(options: {
    cwd: string;
    env: Record<string, string>;
  }): AppServerProcess;
  processGroupId(pid: number): number | null;
  startTicks(pid: number): Promise<string | null>;
  isGroupAlive(pgid: number): boolean;
  observeChildren?(pid: number): Promise<(() => Promise<boolean>) | null>;
  signalGroup(pgid: number, signal: NodeJS.Signals): void;
}
export interface AppServerClientOptions {
  captureCleanup?: boolean;
  cwd: string;
  env: Record<string, string>;
  /** Lossless archival and normalized content run in one ordered bounded drain. */
  onFrame(frame: AppServerFrame): Promise<void>;
  /** Synchronous lifecycle admission observer; must not persist or project output. */
  onNotification?(
    message: Extract<AppServerMessage, { kind: "notification" }>,
  ): void;
  onServerRequest?(
    message: Extract<AppServerMessage, { kind: "server_request" }>,
  ): Promise<{ result: unknown } | { error: AppServerRpcError }>;
  onFailure(error: Error): void;
}
export interface AppServerBarrier {
  release(): void;
  fail(error: Error): void;
}
export interface AppServerClient {
  request(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  /** Install before sending a steer; release after acceptance persistence. */
  barrier(): AppServerBarrier;
  flush(): Promise<void>;
  close(): Promise<void>;
  readonly stderrTail: string;
}
export interface AppServerClientDependencies {
  host?: AppServerProcessHost;
  limits?: Partial<{
    recordBytes: number;
    queuedBytes: number;
    stderrBytes: number;
    requestTimeoutMs: number;
    exitGraceMs: number;
    termGraceMs: number;
    killGraceMs: number;
  }>;
}
const log = createLogger("codex-app-server");
const turnSchema = z.object({
  threadId: z.string(),
  turn: z.object({
    id: z.string(),
    status: z.enum(["inProgress", "completed", "interrupted", "failed"]),
  }),
});
const MAX_PENDING_REQUESTS = 128;
interface PendingRequest {
  method: string;
  written: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve(value: unknown): void;
  reject(error: AppServerRequestError): void;
}
type QueueEntry =
  | { kind: "frame"; frame: AppServerFrame }
  | { kind: "barrier"; released: boolean };

/** A deadline owns its timer even when the operation settles before the deadline. */
async function bounded<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
        if (signal) {
          aborted = () => resolve(fallback);
          if (signal.aborted) aborted();
          else signal.addEventListener("abort", aborted, { once: true });
        }
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (aborted) signal?.removeEventListener("abort", aborted);
  }
}

export function createCodexAppServerClient(
  options: AppServerClientOptions,
  dependencies: AppServerClientDependencies = {},
): AppServerClient {
  const host = dependencies.host ?? createAppServerProcessHost();
  const limits = {
    ...APP_SERVER_LIMITS,
    ...dependencies.limits,
    ...(options.captureCleanup
      ? { exitGraceMs: 1000, termGraceMs: 1000, killGraceMs: 1000 }
      : {}),
  };
  const child = host.spawn({ cwd: options.cwd, env: options.env });
  const groupId = host.processGroupId(child.pid);
  const identity = bounded(
    host.startTicks(child.pid).catch(() => null),
    limits.exitGraceMs,
    null,
  );
  const pending = new Map<AppServerId, PendingRequest>();
  const serverRequests = new Set<AppServerId>();
  const lifetime = new AbortController();
  const queue: QueueEntry[] = [];
  const flushWaiters = new Set<{
    resolve(): void;
    reject(error: Error): void;
  }>();
  let nextId = 0;
  let queuedBytes = 0;
  let draining = false;
  let closing = false;
  let exited = false;
  let failed: Error | undefined;
  let contentDiscarded = false;
  let captureWriteFailed = false;
  let cleanupFailure: AppServerTransportError | undefined;
  let closePromise: Promise<void> | undefined;
  let stderr = Buffer.alloc(0);
  let activeTurn: { threadId: string; turnId: string } | undefined;
  let expectedThreadId: string | undefined;
  let turnMayBeActive = false;
  let lastTerminalTurnId: string | undefined;
  let resolveExit: () => void = () => {};
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });

  function report(error: Error): void {
    log.error("codex.app_server.failure", {
      code:
        error instanceof AppServerTransportError
          ? error.code
          : "transport_error",
      ...(error instanceof AppServerTransportError ? error.evidence : {}),
    });
    try {
      options.onFailure(error);
    } catch {
      /* Failure observers cannot stop process teardown. */
    }
  }
  function unverified(): AppServerTransportError {
    if (!cleanupFailure) {
      cleanupFailure = new AppServerTransportError(
        "cleanup_unverified",
        "Codex process cleanup could not be verified; inspect surviving commands before resuming. This protection ends at CC restart.",
      );
      report(cleanupFailure);
    }
    return cleanupFailure;
  }
  function rejectPending(message: string): void {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new AppServerRequestError(message, request.written));
    }
    pending.clear();
  }
  function settleFlush(): void {
    if (!contentDiscarded && (queue.length || draining)) return;
    for (const waiter of flushWaiters) {
      if (failed) waiter.reject(failed);
      else waiter.resolve();
    }
    flushWaiters.clear();
  }
  function fail(error: Error): void {
    const discard =
      error instanceof AppServerTransportError &&
      error.code === "consumer_failed";
    if (failed && !discard) return;
    failed ??= error;
    decoder.discard();
    if (discard) {
      captureWriteFailed ||= options.captureCleanup === true;
      contentDiscarded = true;
      queue.length = 0;
      queuedBytes = 0;
    }
    rejectPending(error.message);
    report(error);
    settleFlush();
    // Failure is already surfaced through onFailure; close() retains its typed rejection.
    void close().catch(() => {});
  }
  async function drain(): Promise<void> {
    if (draining || contentDiscarded) return;
    draining = true;
    try {
      while (queue.length && !contentDiscarded) {
        const entry = queue[0];
        if (!entry) break;
        if (entry.kind === "barrier") {
          if (!entry.released) break;
          queue.shift();
          continue;
        }
        await options.onFrame(entry.frame);
        if (contentDiscarded) break;
        queuedBytes -= entry.frame.byteLength;
        queue.shift();
      }
    } catch {
      fail(
        new AppServerTransportError(
          "consumer_failed",
          "Codex app-server archive/content consumer failed",
        ),
      );
    } finally {
      draining = false;
      settleFlush();
    }
  }
  function enqueue(frame: AppServerFrame): void {
    if (failed) return;
    if (queuedBytes + frame.byteLength > limits.queuedBytes) {
      fail(
        new AppServerTransportError(
          "queue_limit",
          "Codex app-server archive/content queue exceeded its byte budget",
          { byteLength: queuedBytes + frame.byteLength, truncated: true },
        ),
      );
      return;
    }
    queuedBytes += frame.byteLength;
    queue.push({ kind: "frame", frame });
    void drain();
  }
  function write(value: unknown): void {
    child.stdin.write(`${JSON.stringify(value)}\n`, (error) => {
      if (error)
        fail(
          new AppServerTransportError(
            "connection_closed",
            "Codex app-server stdin write failed",
          ),
        );
    });
  }
  async function answer(
    message: Extract<AppServerMessage, { kind: "server_request" }>,
  ): Promise<void> {
    if (
      serverRequests.has(message.id) ||
      serverRequests.size >= MAX_PENDING_REQUESTS
    ) {
      fail(
        new AppServerTransportError(
          "protocol_error",
          "Codex app-server server-request limit or duplicate ID",
        ),
      );
      return;
    }
    serverRequests.add(message.id);
    const unsupported = {
      error: { code: -32601, message: "Unsupported Codex app-server request" },
    };
    try {
      const response = options.onServerRequest
        ? await bounded(
            options.onServerRequest(message),
            limits.requestTimeoutMs,
            unsupported,
            lifetime.signal,
          )
        : unsupported;
      if (!closing && !failed && !exited)
        write({ id: message.id, ...response });
    } catch {
      if (!closing && !failed && !exited)
        write({
          id: message.id,
          error: {
            code: -32603,
            message: "Codex app-server request handler failed",
          },
        });
    } finally {
      serverRequests.delete(message.id);
    }
  }
  function observeLifecycle(
    message: Extract<AppServerMessage, { kind: "notification" }>,
  ): void {
    if (
      message.method === "turn/started" ||
      message.method === "turn/completed"
    ) {
      const parsed = turnSchema.safeParse(message.params);
      if (!parsed.success)
        throw new AppServerTransportError(
          "protocol_error",
          "Malformed Codex turn lifecycle notification",
        );
      const { threadId, turn } = parsed.data;
      if (expectedThreadId && threadId !== expectedThreadId) {
        options.onNotification?.(message);
        return;
      }
      if (message.method === "turn/started") {
        if (turn.status !== "inProgress")
          throw new AppServerTransportError(
            "protocol_error",
            "Invalid Codex started turn status",
          );
        activeTurn = { threadId, turnId: turn.id };
        turnMayBeActive = true;
      } else {
        if (turn.status === "inProgress")
          throw new AppServerTransportError(
            "protocol_error",
            "Invalid Codex terminal turn status",
          );
        if (
          !activeTurn ||
          (activeTurn.threadId === threadId && activeTurn.turnId === turn.id)
        ) {
          lastTerminalTurnId = turn.id;
          activeTurn = undefined;
          turnMayBeActive = false;
        }
      }
    }
    options.onNotification?.(message);
  }
  function receive(frame: AppServerFrame): void {
    if (failed) return;
    const message = frame.message;
    if (message.kind === "response") {
      const request = pending.get(message.id);
      if (request) {
        pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) {
          request.reject(
            new AppServerRequestError(
              "Codex app-server rejected the request",
              request.written,
              message.error,
            ),
          );
        } else {
          if (request.method === "turn/start") {
            const parsed = z
              .object({ turn: z.object({ id: z.string() }) })
              .safeParse(message.result);
            if (parsed.success && parsed.data.turn.id !== lastTerminalTurnId) {
              turnMayBeActive = true;
              if (expectedThreadId)
                activeTurn = {
                  threadId: expectedThreadId,
                  turnId: parsed.data.turn.id,
                };
            }
          }
          request.resolve(message.result);
        }
      }
    } else if (message.kind === "server_request") {
      void answer(message);
    } else {
      observeLifecycle(message);
    }
    enqueue(frame);
  }
  const decoder = new AppServerRecordDecoder(receive, limits.recordBytes);
  function onStdout(chunk: Buffer): void {
    if (failed) return;
    try {
      decoder.push(chunk);
    } catch (error) {
      fail(
        error instanceof AppServerTransportError
          ? error
          : new AppServerTransportError(
              "protocol_error",
              "Codex app-server frame dispatch failed",
            ),
      );
    }
  }
  function onStdoutEnd(): void {
    if (failed) return;
    try {
      decoder.finish();
    } catch (error) {
      if (error instanceof Error) fail(error);
    }
  }
  function onStderr(chunk: Buffer): void {
    if (chunk.length >= limits.stderrBytes)
      stderr = Buffer.from(chunk.subarray(chunk.length - limits.stderrBytes));
    else {
      const keep = Math.min(stderr.length, limits.stderrBytes - chunk.length);
      stderr = Buffer.concat([stderr.subarray(stderr.length - keep), chunk]);
    }
  }
  function onStreamError(): void {
    fail(
      new AppServerTransportError(
        "connection_closed",
        "Codex app-server stream failed",
      ),
    );
  }
  const removeError = child.onError(onStreamError);
  const removeExit = child.onExit((code, signal) => {
    exited = true;
    resolveExit();
    rejectPending("Codex app-server exited before responding");
    if (turnMayBeActive && (!closing || code !== 0 || signal !== null))
      unverified();
    if (!closing)
      fail(
        new AppServerTransportError(
          "connection_closed",
          "Codex app-server exited unexpectedly",
        ),
      );
  });
  child.stdout.on("data", onStdout);
  child.stdout.on("end", onStdoutEnd);
  child.stderr.on("data", onStderr);
  child.stdin.on("error", onStreamError);
  child.stdout.on("error", onStreamError);
  child.stderr.on("error", onStreamError);

  async function waitForExit(timeout: number): Promise<boolean> {
    await bounded(exitPromise, timeout, undefined);
    return (
      exited && (groupId === child.pid ? !host.isGroupAlive(groupId) : true)
    );
  }
  async function teardown(): Promise<void> {
    const cleanupStarted = Date.now();
    const remaining = (phase: number, normal: number) =>
      options.captureCleanup
        ? Math.max(0, cleanupStarted + phase * 1000 - Date.now())
        : normal;
    closing = true;
    lifetime.abort();
    rejectPending("Codex app-server connection is closing");
    if (
      !failed &&
      queue.some((entry) => entry.kind === "barrier" && !entry.released)
    ) {
      failed = new AppServerTransportError(
        "connection_closed",
        "Codex app-server closed with an unresolved content barrier",
      );
      contentDiscarded = true;
      queue.length = 0;
      queuedBytes = 0;
      settleFlush();
    }
    const originalIdentity = await identity;
    const children = options.captureCleanup
      ? await bounded(
          host.observeChildren?.(child.pid).catch(() => null) ??
            Promise.resolve(null),
          remaining(1, 1000),
          null,
        )
      : null;
    try {
      // A transport failure can leave complete received frames behind an uncertain
      // input barrier. Give its rejected request and the archive drain a bounded
      // opportunity to settle before destroying streams and retained payloads.
      await bounded(
        flush().catch(() => {}),
        remaining(1, limits.exitGraceMs),
        undefined,
      );
      child.stdin.end();
      let gone = await waitForExit(remaining(1, limits.exitGraceMs));
      for (const [signal, timeout, phase] of [
        ["SIGTERM", limits.termGraceMs, 2],
        ["SIGKILL", limits.killGraceMs, 3],
      ] as const) {
        if (gone) break;
        const currentIdentity = await bounded(
          host.startTicks(child.pid).catch(() => null),
          remaining(phase, limits.exitGraceMs),
          null,
        );
        if (
          groupId !== child.pid ||
          originalIdentity === null ||
          currentIdentity !== originalIdentity ||
          host.processGroupId(child.pid) !== groupId
        )
          throw unverified();
        if (turnMayBeActive) unverified();
        host.signalGroup(groupId, signal);
        gone = await waitForExit(remaining(phase, timeout));
      }
      if (!gone) throw unverified();
      if (
        options.captureCleanup &&
        (!children ||
          !(await bounded(
            children().catch(() => false),
            remaining(3, 1000),
            false,
          )))
      )
        throw unverified();
      if (cleanupFailure) throw cleanupFailure;
    } catch (error) {
      throw error instanceof AppServerTransportError &&
        error.code === "cleanup_unverified"
        ? error
        : unverified();
    } finally {
      decoder.discard();
      const unfinishedCaptureDrain =
        options.captureCleanup &&
        (captureWriteFailed || queue.length > 0 || draining);
      if (queue.length || draining) {
        failed ??= new AppServerTransportError(
          "connection_closed",
          "Codex app-server closed before its content drain finished",
        );
        contentDiscarded = true;
        queue.length = 0;
        queuedBytes = 0;
        settleFlush();
      }
      removeExit();
      removeError();
      child.stdout.off("data", onStdout);
      child.stdout.off("end", onStdoutEnd);
      child.stderr.off("data", onStderr);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      // Destroyed streams cannot deliver new payloads, but keep their error guard until close.
      for (const stream of [child.stdin, child.stdout, child.stderr])
        stream.once("close", () => {
          stream.off("error", onStreamError);
        });
      if (unfinishedCaptureDrain) throw unverified();
    }
  }
  function close(): Promise<void> {
    closePromise ??= teardown();
    return closePromise;
  }
  function flush(): Promise<void> {
    if (contentDiscarded || (!queue.length && !draining))
      return failed ? Promise.reject(failed) : Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      flushWaiters.add({ resolve, reject });
    });
  }

  return {
    request(method, params) {
      if (
        closing ||
        exited ||
        failed ||
        child.stdin.destroyed ||
        child.stdin.writableEnded ||
        pending.size >= MAX_PENDING_REQUESTS
      ) {
        return Promise.reject(
          new AppServerRequestError(
            "Codex app-server cannot admit this request",
            false,
          ),
        );
      }
      let raw: string;
      const id = ++nextId;
      try {
        raw = `${JSON.stringify({ id, method, params })}\n`;
      } catch {
        return Promise.reject(
          new AppServerRequestError(
            "Codex app-server request is not serializable",
            false,
          ),
        );
      }
      if (Buffer.byteLength(raw) > limits.recordBytes)
        return Promise.reject(
          new AppServerRequestError(
            "Codex app-server request exceeds its byte budget",
            false,
          ),
        );
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          const request = pending.get(id);
          if (!request) return;
          pending.delete(id);
          request.reject(
            new AppServerRequestError(
              "Codex app-server request timed out",
              request.written,
            ),
          );
          // Missing acknowledgement does not invalidate already received content.
          // The runtime settles this request as uncertain and releases its barrier.
        }, limits.requestTimeoutMs);
        const request: PendingRequest = {
          method,
          written: false,
          timer,
          resolve,
          reject,
        };
        pending.set(id, request);
        if (method === "turn/start") {
          turnMayBeActive = true;
          const parsed = z.object({ threadId: z.string() }).safeParse(params);
          if (parsed.success) expectedThreadId = parsed.data.threadId;
        }
        // Once write is attempted, even an exception cannot prove no bytes crossed the pipe.
        request.written = true;
        try {
          child.stdin.write(raw, (error) => {
            if (error) onStreamError();
          });
        } catch {
          onStreamError();
        }
      });
    },
    notify(method, params) {
      if (closing || failed || exited)
        throw new AppServerRequestError("Codex app-server is closed", false);
      try {
        write({ method, ...(params === undefined ? {} : { params }) });
      } catch {
        onStreamError();
      }
    },
    barrier() {
      if (failed || closing || exited)
        throw new AppServerRequestError("Codex app-server is closed", false);
      if (
        queue.filter((entry) => entry.kind === "barrier").length >=
        MAX_PENDING_REQUESTS
      ) {
        const error = new AppServerTransportError(
          "queue_limit",
          "Codex acceptance barrier limit exceeded",
        );
        fail(error);
        throw error;
      }
      const entry: QueueEntry = { kind: "barrier", released: false };
      queue.push(entry);
      return {
        release() {
          if (!entry.released) {
            entry.released = true;
            void drain();
          }
        },
        fail() {
          if (!entry.released) {
            entry.released = true;
            fail(
              new AppServerTransportError(
                "consumer_failed",
                "Codex accepted-input archive failed",
              ),
            );
          }
        },
      };
    },
    flush,
    close,
    get stderrTail() {
      return stderr.toString("utf8");
    },
  };
}
