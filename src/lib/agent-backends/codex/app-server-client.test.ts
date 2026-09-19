import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCodexAppServerClient,
  type AppServerClientOptions,
  type AppServerProcess,
  type AppServerProcessHost,
} from "./app-server-client";
import type { AppServerFrame } from "./app-server-protocol";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class FakeProcess implements AppServerProcess {
  readonly pid = 8123;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly written: unknown[] = [];
  autoExit = true;
  alive = true;
  ticks: string | null = "start-1";
  signalExit: NodeJS.Signals | null = "SIGTERM";
  private exitListeners = new Set<
    (code: number | null, signal: string | null) => void
  >();
  private errorListeners = new Set<(error: Error) => void>();
  readonly stdin = new Writable({
    write: (chunk: Buffer, _encoding, callback) => {
      this.written.push(JSON.parse(chunk.toString()));
      callback();
    },
    final: (callback) => {
      if (this.autoExit) this.exit(0, null);
      callback();
    },
  });
  onExit(listener: (code: number | null, signal: string | null) => void) {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }
  onError(listener: (error: Error) => void) {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }
  frame(value: unknown) {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }
  exit(code: number | null, signal: string | null) {
    this.alive = false;
    this.stdout.end();
    this.stderr.end();
    for (const listener of this.exitListeners) listener(code, signal);
  }
}
function fixture(
  overrides: Partial<AppServerClientOptions> = {},
  limits: {
    queuedBytes?: number;
    recordBytes?: number;
    stderrBytes?: number;
  } = {},
) {
  const child = new FakeProcess();
  const frames: AppServerFrame[] = [];
  const failures: Error[] = [];
  const signals: NodeJS.Signals[] = [];
  const spawn = vi.fn<AppServerProcessHost["spawn"]>(() => child);
  const host: AppServerProcessHost = {
    spawn,
    processGroupId: () => child.pid,
    startTicks: async () => child.ticks,
    isGroupAlive: () => child.alive,
    observeChildren: async () => async () => true,
    signalGroup: (_pgid, signal) => {
      signals.push(signal);
      if (child.signalExit === signal) child.exit(null, signal);
    },
  };
  const client = createCodexAppServerClient(
    {
      cwd: "/worktree",
      env: {},
      onFrame: async (frame) => {
        frames.push(frame);
      },
      onFailure: (error) => {
        failures.push(error);
      },
      ...overrides,
    },
    {
      host,
      limits: {
        requestTimeoutMs: 20,
        exitGraceMs: 10,
        termGraceMs: 10,
        killGraceMs: 10,
        ...limits,
      },
    },
  );
  return { client, child, frames, failures, signals, host, spawn };
}

async function tick() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
afterEach(() => {
  vi.useRealTimers();
});

describe("Codex app-server client", () => {
  it("applies effective configuration to the process that serves catalog requests", async () => {
    const config = {
      skills: { config: [{ name: "wait-what", enabled: true }] },
    };
    const { client, spawn } = fixture({ config });
    expect(spawn).toHaveBeenCalledWith({ cwd: "/worktree", env: {}, config });
    await client.close();
  });

  it("settles responses while archival is stalled and preserves wire order", async () => {
    const hold = deferred<void>();
    const archived: string[] = [];
    const { client, child } = fixture({
      onFrame: async (frame) => {
        archived.push(frame.raw);
        await hold.promise;
      },
    });
    child.frame({ method: "future/additive", params: {} });
    const result = client.request("turn/steer", {});
    child.frame({ id: 1, result: { turnId: "t" } });
    await expect(result).resolves.toEqual({ turnId: "t" });
    expect(archived).toHaveLength(1);
    hold.resolve();
    await client.flush();
    expect(archived.map((raw) => JSON.parse(raw))).toEqual([
      { method: "future/additive", params: {} },
      { id: 1, result: { turnId: "t" } },
    ]);
    await client.close();
  });

  it("answers a server request with a colliding ID without settling an outbound request", async () => {
    const { client, child } = fixture();
    const result = client.request("initialize", {});
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    child.frame({ id: 1, method: "unknown/request", params: {} });
    await tick();
    expect(settled).toBe(false);
    expect(child.written).toContainEqual({
      id: 1,
      error: { code: -32601, message: "Unsupported Codex app-server request" },
    });
    child.frame({ id: 1, result: {} });
    await result;
    await client.close();
  });

  it("holds content behind acceptance while still observing terminal lifecycle and response", async () => {
    const observed: string[] = [];
    const { client, child, frames } = fixture({
      onNotification: (message) => {
        observed.push(message.method);
      },
    });
    const barrier = client.barrier();
    const result = client.request("turn/steer", {});
    child.frame({
      method: "turn/completed",
      params: { threadId: "th", turn: { id: "t", status: "completed" } },
    });
    child.frame({ id: 1, result: { turnId: "t" } });
    await expect(result).resolves.toEqual({ turnId: "t" });
    expect(observed).toEqual(["turn/completed"]);
    expect(frames).toEqual([]);
    barrier.release();
    await client.flush();
    expect(frames).toHaveLength(2);
    await client.close();
  });

  it("enforces one shared byte limit for barriers and slow archival", async () => {
    const { client, child, failures } = fixture({}, { queuedBytes: 40 });
    client.barrier();
    child.frame({ method: "a" });
    child.frame({ method: "b" });
    child.frame({ method: "c" });
    await tick();
    expect(failures).toContainEqual(
      expect.objectContaining({ code: "queue_limit" }),
    );
    await expect(client.request("turn/start", {})).rejects.toMatchObject({
      requestMayHaveBeenWritten: false,
    });
    await client.close();
  });

  it("counts in-flight archival against the queue limit", async () => {
    const hold = deferred<void>();
    const { client, child, failures } = fixture(
      { onFrame: async () => hold.promise },
      { queuedBytes: 25 },
    );
    child.frame({ method: "a" });
    child.frame({ method: "b" });
    expect(failures).toContainEqual(
      expect.objectContaining({ code: "queue_limit" }),
    );
    hold.resolve();
    await client.close();
  });

  it("continuously drains stderr with a byte-bounded retained tail", async () => {
    const { client, child } = fixture({}, { stderrBytes: 8 });
    child.stderr.write("old-noise");
    child.stderr.write("12345678");
    expect(client.stderrTail).toBe("12345678");
    await client.close();
  });

  it("reports written request timeout as uncertain", async () => {
    vi.useFakeTimers();
    const { client } = fixture();
    const result = client.request("turn/steer", {});
    const assertion = expect(result).rejects.toMatchObject({
      requestMayHaveBeenWritten: true,
    });
    await vi.advanceTimersByTimeAsync(21);
    await assertion;
    await client.close();
  });

  it("releases buffered terminal evidence after a lost steer acknowledgement", async () => {
    vi.useFakeTimers();
    const { client, child, frames, failures } = fixture();
    const barrier = client.barrier();
    const acknowledgement = client.request("turn/steer", {
      threadId: "thread",
      expectedTurnId: "turn",
      input: [],
    });
    const uncertain = expect(acknowledgement).rejects.toMatchObject({
      requestMayHaveBeenWritten: true,
    });
    child.frame({
      method: "item/completed",
      params: {
        threadId: "thread",
        turnId: "turn",
        item: { id: "answer", type: "agentMessage", text: "delivered" },
      },
    });
    child.frame({
      method: "turn/completed",
      params: { threadId: "thread", turn: { id: "turn", status: "completed" } },
    });
    await vi.advanceTimersByTimeAsync(21);
    await uncertain;
    barrier.release();
    await client.flush();
    expect(frames).toHaveLength(2);
    expect(failures).toEqual([]);
    await client.close();
  });

  it("retains correlated RPC refusal evidence without retrying", async () => {
    const { client, child } = fixture();
    const result = client.request("turn/steer", {});
    child.frame({ id: 1, error: { code: -32600, message: "No active turn" } });
    await expect(result).rejects.toMatchObject({
      requestMayHaveBeenWritten: true,
      rpcError: { code: -32600, message: "No active turn" },
    });
    expect(child.written).toHaveLength(1);
    await client.close();
  });

  it("archives complete buffered records after a disconnect and uncertain acceptance", async () => {
    const { client, child, frames } = fixture();
    const barrier = client.barrier();
    const pending = client.request("turn/steer", {});
    child.frame({ method: "item/completed", params: { marker: "received" } });
    child.frame({ method: "future/additive", params: {} });
    child.exit(null, "SIGKILL");
    await expect(pending).rejects.toMatchObject({
      requestMayHaveBeenWritten: true,
    });
    barrier.release();
    await expect(client.flush()).rejects.toMatchObject({
      code: "connection_closed",
    });
    await client.close();
    expect(
      frames.map(
        (frame) =>
          frame.message.kind === "notification" && frame.message.method,
      ),
    ).toEqual(["item/completed", "future/additive"]);
  });

  it("bounds disconnect cleanup when the archive consumer never settles", async () => {
    vi.useFakeTimers();
    const hold = deferred<void>();
    const { client, child } = fixture({ onFrame: () => hold.promise });
    child.frame({ method: "future/additive" });
    child.exit(null, "SIGKILL");
    const closed = client.close();
    await vi.advanceTimersByTimeAsync(50);
    await closed;
    await expect(client.flush()).rejects.toMatchObject({
      code: "connection_closed",
    });
    hold.resolve();
  });

  it("rejects outstanding written requests on abrupt exit and blocks unsafe cleanup", async () => {
    const { client, child, failures } = fixture();
    child.frame({
      method: "turn/started",
      params: { threadId: "th", turn: { id: "t", status: "inProgress" } },
    });
    const result = client.request("turn/steer", {});
    child.exit(null, "SIGKILL");
    await expect(result).rejects.toMatchObject({
      requestMayHaveBeenWritten: true,
    });
    await expect(client.close()).rejects.toMatchObject({
      code: "cleanup_unverified",
    });
    expect(failures).toContainEqual(
      expect.objectContaining({ code: "cleanup_unverified" }),
    );
  });

  it("escalates an identity-owned group to TERM then KILL with bounded cleanup", async () => {
    vi.useFakeTimers();
    const { client, child, signals } = fixture();
    child.autoExit = false;
    child.signalExit = "SIGKILL";
    const closed = client.close();
    await vi.advanceTimersByTimeAsync(50);
    await closed;
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("refuses signalling a recycled process identity", async () => {
    vi.useFakeTimers();
    const { client, child, signals } = fixture();
    await tick();
    child.ticks = "replacement";
    child.autoExit = false;
    const assertion = expect(client.close()).rejects.toMatchObject({
      code: "cleanup_unverified",
    });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
    expect(signals).toEqual([]);
  });

  it("treats active-turn escalation as unverified even when its owned group exits", async () => {
    vi.useFakeTimers();
    const { client, child } = fixture();
    child.frame({
      method: "turn/started",
      params: { threadId: "th", turn: { id: "t", status: "inProgress" } },
    });
    child.autoExit = false;
    const assertion = expect(client.close()).rejects.toMatchObject({
      code: "cleanup_unverified",
    });
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it("suppresses later projection after an acceptance archive failure", async () => {
    const { client, child, frames, failures } = fixture();
    const barrier = client.barrier();
    child.frame({ method: "item/completed", params: {} });
    barrier.fail(new Error("archive failed"));
    await tick();
    expect(frames).toEqual([]);
    expect(failures).toContainEqual(
      expect.objectContaining({ code: "consumer_failed" }),
    );
    await client.close();
  });
  it("keeps unknown start errors conservative when the server then crashes", async () => {
    const { client, child } = fixture();
    const result = client.request("turn/start", {});
    child.frame({
      id: 1,
      error: { code: -32603, message: "Internal failure after dispatch" },
    });
    await expect(result).rejects.toMatchObject({
      requestMayHaveBeenWritten: true,
    });
    child.exit(null, "SIGKILL");
    await expect(client.close()).rejects.toMatchObject({
      code: "cleanup_unverified",
    });
  });

  it("does not restore active status when a start response follows completion", async () => {
    const { client, child } = fixture();
    const result = client.request("turn/start", {});
    child.frame({
      method: "turn/completed",
      params: { threadId: "th", turn: { id: "t", status: "completed" } },
    });
    child.frame({ id: 1, result: { turn: { id: "t", status: "inProgress" } } });
    await result;
    child.exit(null, "SIGKILL");
    await client.close();
  });

  it("fails malformed lifecycle frames and rejects written requests without leaking payload text", async () => {
    const { client, child, failures } = fixture();
    const result = client.request("turn/steer", {});
    child.frame({
      method: "turn/completed",
      params: { privateText: "SECRET_MARKER" },
    });
    await expect(result).rejects.toMatchObject({
      requestMayHaveBeenWritten: true,
    });
    expect(failures).toContainEqual(
      expect.objectContaining({ code: "protocol_error" }),
    );
    expect(JSON.stringify(failures)).not.toContain("SECRET_MARKER");
    await client.close();
  });

  it("rejects flush waiters and drops unreleased barriers on explicit close", async () => {
    const { client, child } = fixture();
    client.barrier();
    child.frame({ method: "future/additive" });
    const flushing = client.flush();
    const assertion = expect(flushing).rejects.toMatchObject({
      code: "connection_closed",
    });
    await client.close();
    await assertion;
  });

  it("clears server-request deadlines when the connection closes", async () => {
    vi.useFakeTimers();
    const never = deferred<{ result: unknown }>();
    const { client, child } = fixture({ onServerRequest: () => never.promise });
    child.frame({
      id: "server-1",
      method: "item/tool/requestUserInput",
      params: {},
    });
    await tick();
    await client.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects pending requests when an unterminated record exceeds the hard bound", async () => {
    const { client, child, failures } = fixture({}, { recordBytes: 64 });
    const result = client.request("initialize", {});
    child.stdout.write(Buffer.alloc(65, 0x61));
    await expect(result).rejects.toMatchObject({
      requestMayHaveBeenWritten: true,
    });
    expect(failures).toContainEqual(
      expect.objectContaining({
        code: "record_limit",
        evidence: { byteLength: 65, truncated: true },
      }),
    );
    await client.close();
  });

  it("does not let another thread's completion hide an active turn after its start response", async () => {
    const { client, child } = fixture();
    const result = client.request("turn/start", { threadId: "owned-thread" });
    child.frame({
      id: 1,
      result: { turn: { id: "owned-turn", status: "inProgress" } },
    });
    await result;
    child.frame({
      method: "turn/completed",
      params: {
        threadId: "other-thread",
        turn: { id: "other-turn", status: "completed" },
      },
    });
    child.exit(null, "SIGKILL");
    await expect(client.close()).rejects.toMatchObject({
      code: "cleanup_unverified",
    });
  });
});

describe("capture-only app-server cleanup", () => {
  it("does not mistake a completed leader for collected children", async () => {
    const { client, host } = fixture({ captureCleanup: true });
    host.observeChildren = async () => async () => false;
    await expect(client.close()).rejects.toMatchObject({
      code: "cleanup_unverified",
    });
  });
  it("holds when child ownership cannot be observed", async () => {
    const { client, host } = fixture({ captureCleanup: true });
    host.observeChildren = async () => null;
    await expect(client.close()).rejects.toMatchObject({
      code: "cleanup_unverified",
    });
  });
  it("collects children independently of completed turns", async () => {
    const { client, child, host } = fixture({ captureCleanup: true });
    const collected = deferred<boolean>();
    host.observeChildren = async () => () => collected.promise;
    let settled = false;
    const closed = client.close().then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);
    collected.resolve(true);
    await closed;
    expect(child.alive).toBe(false);
  });
  it("fits EOF, TERM and KILL inside three capture seconds", async () => {
    vi.useFakeTimers();
    const { client, child, signals } = fixture({ captureCleanup: true });
    child.autoExit = false;
    child.signalExit = "SIGKILL";
    const closed = client.close();
    await vi.advanceTimersByTimeAsync(999);
    expect(signals).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals).toEqual(["SIGTERM"]);
    await vi.advanceTimersByTimeAsync(1000);
    await closed;
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});

it("capture holds cleanup when a required archive write is still pending", async () => {
  vi.useFakeTimers();
  const held = deferred<void>();
  const { client, child } = fixture({
    captureCleanup: true,
    onFrame: () => held.promise,
  });
  child.frame({ method: "future/additive", params: {} });
  const closed = client.close();
  const verdict = closed.then(
    () => null,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(1001);
  held.resolve();
  expect(await verdict).toMatchObject({ code: "cleanup_unverified" });
});

it.each([true, false])(
  "preserves rejected capture writes across close (capture=%s)",
  async (captureCleanup) => {
    const { client, child, failures } = fixture({
      captureCleanup,
      onFrame: async () => {
        throw new Error("write rejected");
      },
    });
    child.frame({ method: "future/additive", params: {} });
    await vi.waitFor(() =>
      expect(failures).toContainEqual(
        expect.objectContaining({ code: "consumer_failed" }),
      ),
    );
    if (captureCleanup)
      await expect(client.close()).rejects.toMatchObject({
        code: "cleanup_unverified",
      });
    else await expect(client.close()).resolves.toBeUndefined();
  },
);
