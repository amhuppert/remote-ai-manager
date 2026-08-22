import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CURSOR_CREDENTIAL_PREFLIGHT_TIMEOUT_MS,
  CURSOR_WORKER_HANDSHAKE_TIMEOUT_MS,
} from "./bounds";
import {
  CURSOR_WORKER_EXIT_IDLE,
  CURSOR_WORKER_EXIT_ORPHANED,
  CURSOR_WORKER_EXIT_PREFLIGHT_FAILED,
  startCursorWorker,
  type CursorWorkerAgent,
  type CursorWorkerAttachOptions,
  type CursorWorkerDeps,
  type CursorWorkerHandle,
  type CursorWorkerRun,
  type CursorWorkerRunResult,
  type CursorWorkerSdk,
  type CursorWorkerSendMessage,
  type CursorWorkerSendOptions,
} from "./entry";
import { CURSOR_IPC_CODEC_VERSION, decodeNativePayload } from "./ipc";
import type { CursorParentFrame, CursorWorkerFrame } from "./ipc";

/**
 * Worker-process behavior with the SDK, the channel, and every process-level
 * effect injected. The signalling and exit paths are the whole point of the
 * watchdog, so they are observed through the injected control rather than by
 * killing the test runner.
 */

const API_KEY = "cursor-key-sentinel-4f2b9c";

const WORKER_PID = 4242;
const PARENT_PID = 1111;

class FakeChannel {
  readonly sent: CursorWorkerFrame[] = [];
  private messageListener: ((value: unknown) => void) | null = null;
  private disconnectListener: (() => void) | null = null;
  /** Set to make every send throw, as a closed fork channel does. */
  broken = false;

  send(frame: CursorWorkerFrame): void {
    if (this.broken) throw new Error("channel closed");
    this.sent.push(frame);
  }

  onMessage(listener: (value: unknown) => void): void {
    this.messageListener = listener;
  }

  onDisconnect(listener: () => void): void {
    this.disconnectListener = listener;
  }

  emit(value: unknown): void {
    this.messageListener?.(value);
  }

  disconnect(): void {
    this.disconnectListener?.();
  }

  ofType<TType extends CursorWorkerFrame["type"]>(
    type: TType,
  ): Extract<CursorWorkerFrame, { type: TType }>[] {
    return this.sent.filter(
      (frame): frame is Extract<CursorWorkerFrame, { type: TType }> =>
        frame.type === type,
    );
  }
}

class FakeProcessControl {
  readonly pid = WORKER_PID;
  readonly umasks: number[] = [];
  readonly signals: { pgid: number; signal: NodeJS.Signals }[] = [];
  readonly exits: number[] = [];
  terminationIgnored = false;
  livePids = new Set<number>([PARENT_PID]);
  currentParentPid = PARENT_PID;
  /** Ordered log of process effects, so ordering claims are assertable. */
  readonly effects: string[] = [];

  processGroupId(): number {
    return WORKER_PID;
  }

  setUmask(mask: number): void {
    this.umasks.push(mask);
    this.effects.push(`umask:${mask.toString(8)}`);
  }

  parentPid(): number {
    return this.currentParentPid;
  }

  isAlive(pid: number): boolean {
    return this.livePids.has(pid);
  }

  signalGroup(pgid: number, signal: NodeJS.Signals): void {
    this.signals.push({ pgid, signal });
    this.effects.push(`signal:${pgid}:${signal}`);
  }

  ignoreTermination(): void {
    this.terminationIgnored = true;
  }

  exit(code: number): void {
    this.exits.push(code);
    this.effects.push(`exit:${code}`);
  }
}

class FakeRun implements CursorWorkerRun {
  cancelCalls = 0;
  cancelError: unknown = null;

  constructor(
    private readonly events: readonly unknown[],
    private readonly result: CursorWorkerRunResult,
  ) {}

  async *stream(): AsyncIterable<unknown> {
    for (const event of this.events) {
      yield event;
    }
  }

  async wait(): Promise<CursorWorkerRunResult> {
    return this.result;
  }

  async cancel(): Promise<void> {
    this.cancelCalls += 1;
    if (this.cancelError !== null) throw this.cancelError;
  }
}

class FakeAgent implements CursorWorkerAgent {
  readonly sends: {
    message: CursorWorkerSendMessage;
    options: CursorWorkerSendOptions;
  }[] = [];
  disposeCalls = 0;
  disposeBlocks = false;
  run: FakeRun = new FakeRun([], { status: "finished" });

  constructor(readonly agentId: string) {}

  async send(
    message: CursorWorkerSendMessage,
    options: CursorWorkerSendOptions,
  ): Promise<CursorWorkerRun> {
    this.sends.push({ message, options });
    return this.run;
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    if (this.disposeBlocks) await new Promise<void>(() => {});
  }
}

class FakeSdk implements CursorWorkerSdk {
  readonly verifiedKeys: string[] = [];
  readonly creates: CursorWorkerAttachOptions[] = [];
  readonly resumes: { ref: string; options: CursorWorkerAttachOptions }[] = [];
  verifyError: unknown = null;
  verifyHangs = false;
  attachError: unknown = null;
  agent = new FakeAgent("agent-ref-1");

  async verifyCredential(apiKey: string): Promise<void> {
    this.verifiedKeys.push(apiKey);
    if (this.verifyHangs) await new Promise<void>(() => {});
    if (this.verifyError !== null) throw this.verifyError;
  }

  async create(options: CursorWorkerAttachOptions): Promise<CursorWorkerAgent> {
    this.creates.push(options);
    if (this.attachError !== null) throw this.attachError;
    return this.agent;
  }

  async resume(
    ref: string,
    options: CursorWorkerAttachOptions,
  ): Promise<CursorWorkerAgent> {
    this.resumes.push({ ref, options });
    if (this.attachError !== null) throw this.attachError;
    return this.agent;
  }
}

interface Harness {
  channel: FakeChannel;
  control: FakeProcessControl;
  sdk: FakeSdk;
  sdkLoads: number;
  deps: CursorWorkerDeps;
}

function createHarness(
  overrides: { loadSdk?: () => Promise<CursorWorkerSdk> } = {},
): Harness {
  const channel = new FakeChannel();
  const control = new FakeProcessControl();
  const sdk = new FakeSdk();
  const harness: Harness = {
    channel,
    control,
    sdk,
    sdkLoads: 0,
    deps: {
      channel,
      process: control,
      loadSdk: async () => {
        harness.sdkLoads += 1;
        control.effects.push("sdk:load");
        if (overrides.loadSdk !== undefined) return overrides.loadSdk();
        return sdk;
      },
      nodeVersion: "v22.14.0",
      sdkVersion: "1.0.28",
    },
  };
  return harness;
}

const IDLE_TIMEOUT_MS = 30_000;
const PARENT_POLL_MS = 500;
const TERMINATION_GRACE_MS = 1_000;

function initFrame(): CursorParentFrame {
  return {
    v: CURSOR_IPC_CODEC_VERSION,
    type: "init",
    conversationId: "conv-1",
    workerId: "worker-1",
    cwd: "/work/tree",
    storePath: "/state/cursor/conv-1",
    parentPid: PARENT_PID,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
    parentPollIntervalMs: PARENT_POLL_MS,
    terminationGraceMs: TERMINATION_GRACE_MS,
    sdkVersion: "1.0.28",
  };
}

function attachFrame(
  overrides: Partial<Extract<CursorParentFrame, { type: "attachAgent" }>> = {},
): CursorParentFrame {
  return {
    v: CURSOR_IPC_CODEC_VERSION,
    type: "attachAgent",
    mode: "create",
    ref: null,
    model: "composer-2.5",
    disallowedTools: ["askQuestion", "await"],
    sandboxEnabled: false,
    autoReview: false,
    settingSources: [],
    enableAgentRetries: true,
    mcpServers: {
      fixture: { command: "node", args: ["mcp.mjs"], env: { TOKEN: "t" } },
    },
    ...overrides,
  };
}

function startTurnFrame(
  overrides: Partial<Extract<CursorParentFrame, { type: "startTurn" }>> = {},
): CursorParentFrame {
  return {
    v: CURSOR_IPC_CODEC_VERSION,
    type: "startTurn",
    runId: "run-1",
    promptText: "hello",
    images: [],
    structuredOutputInstruction: null,
    model: "composer-2.5",
    mcpServers: {},
    forceExpirePersistedRun: false,
    ...overrides,
  };
}

/** Flush microtasks without moving the clock. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function credentialFrame(): CursorParentFrame {
  return {
    v: CURSOR_IPC_CODEC_VERSION,
    type: "credential",
    apiKey: API_KEY,
  };
}

/** Drive a full handshake and return the harness at `ready`. */
async function handshake(harness: Harness): Promise<CursorWorkerHandle> {
  const handle = startCursorWorker(harness.deps);
  harness.channel.emit(initFrame());
  await settle();
  harness.channel.emit(credentialFrame());
  await settle();
  return handle;
}

/**
 * Attach the way the supervisor does: a fresh credential immediately ahead of
 * the attach that consumes it.
 */
async function attach(
  harness: Harness,
  overrides: Partial<Extract<CursorParentFrame, { type: "attachAgent" }>> = {},
): Promise<void> {
  harness.channel.emit(credentialFrame());
  await settle();
  harness.channel.emit(attachFrame(overrides));
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("cursor worker handshake", () => {
  it("sets a private umask before the SDK is ever loaded", async () => {
    const harness = createHarness();
    await handshake(harness);

    expect(harness.control.umasks).toStrictEqual([0o077]);
    expect(harness.control.effects.indexOf("umask:77")).toBeLessThan(
      harness.control.effects.indexOf("sdk:load"),
    );
  });

  it("verifies the credential through the SDK and reports ready", async () => {
    const harness = createHarness();
    await handshake(harness);

    expect(harness.sdk.verifiedKeys).toStrictEqual([API_KEY]);
    expect(harness.channel.ofType("ready")).toStrictEqual([
      {
        v: CURSOR_IPC_CODEC_VERSION,
        type: "ready",
        pid: WORKER_PID,
        pgid: WORKER_PID,
        nodeVersion: "v22.14.0",
        sdkVersion: "1.0.28",
      },
    ]);
    expect(harness.channel.ofType("preflightFailed")).toHaveLength(0);
  });

  it("reports an invalid credential as its own class and stops", async () => {
    const harness = createHarness();
    harness.sdk.verifyError = Object.assign(new Error("Bad API key"), {
      name: "AuthenticationError",
      code: "unauthenticated",
      status: 401,
    });
    startCursorWorker(harness.deps);
    harness.channel.emit(initFrame());
    await settle();
    harness.channel.emit({
      v: CURSOR_IPC_CODEC_VERSION,
      type: "credential",
      apiKey: API_KEY,
    });
    await vi.advanceTimersByTimeAsync(TERMINATION_GRACE_MS * 2);

    const [failure] = harness.channel.ofType("preflightFailed");
    expect(failure?.reason).toBe("invalid_credential");
    expect(harness.channel.ofType("ready")).toHaveLength(0);
    expect(harness.control.exits).toStrictEqual([
      CURSOR_WORKER_EXIT_PREFLIGHT_FAILED,
    ]);
  });

  it("distinguishes a network failure from an invalid credential", async () => {
    const harness = createHarness();
    harness.sdk.verifyError = Object.assign(new Error("service unavailable"), {
      name: "NetworkError",
      status: 503,
    });
    startCursorWorker(harness.deps);
    harness.channel.emit(initFrame());
    await settle();
    harness.channel.emit({
      v: CURSOR_IPC_CODEC_VERSION,
      type: "credential",
      apiKey: API_KEY,
    });
    await vi.advanceTimersByTimeAsync(TERMINATION_GRACE_MS * 2);

    expect(harness.channel.ofType("preflightFailed")[0]?.reason).toBe(
      "credential_network",
    );
  });

  it("bounds credential verification and reports the timeout", async () => {
    const harness = createHarness();
    harness.sdk.verifyHangs = true;
    startCursorWorker(harness.deps);
    harness.channel.emit(initFrame());
    await settle();
    harness.channel.emit({
      v: CURSOR_IPC_CODEC_VERSION,
      type: "credential",
      apiKey: API_KEY,
    });

    await vi.advanceTimersByTimeAsync(
      CURSOR_CREDENTIAL_PREFLIGHT_TIMEOUT_MS - 1,
    );
    expect(harness.channel.ofType("preflightFailed")).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1 + TERMINATION_GRACE_MS * 2);
    expect(harness.channel.ofType("preflightFailed")[0]?.reason).toBe(
      "credential_timeout",
    );
  });

  it("reports an SDK that cannot be loaded as its own class", async () => {
    const harness = createHarness({
      loadSdk: () => Promise.reject(new Error("missing native asset")),
    });
    startCursorWorker(harness.deps);
    harness.channel.emit(initFrame());
    await settle();
    harness.channel.emit({
      v: CURSOR_IPC_CODEC_VERSION,
      type: "credential",
      apiKey: API_KEY,
    });
    await vi.advanceTimersByTimeAsync(TERMINATION_GRACE_MS * 2);

    expect(harness.channel.ofType("preflightFailed")[0]?.reason).toBe(
      "sdk_load_failed",
    );
  });

  it("reports a credential that never arrives without waiting forever", async () => {
    const harness = createHarness();
    startCursorWorker(harness.deps);
    harness.channel.emit(initFrame());

    await vi.advanceTimersByTimeAsync(CURSOR_WORKER_HANDSHAKE_TIMEOUT_MS + 1);
    await vi.advanceTimersByTimeAsync(TERMINATION_GRACE_MS * 2);

    expect(harness.channel.ofType("preflightFailed")[0]?.reason).toBe(
      "missing_credential",
    );
    expect(harness.sdkLoads).toBe(0);
  });
});

describe("cursor worker attach", () => {
  it("passes the full non-persisted option set on create", async () => {
    const harness = createHarness();
    await handshake(harness);
    await attach(harness);

    expect(harness.sdk.creates).toStrictEqual([
      {
        apiKey: API_KEY,
        model: "composer-2.5",
        cwd: "/work/tree",
        storePath: "/state/cursor/conv-1",
        disallowedTools: ["askQuestion", "await"],
        sandboxEnabled: false,
        autoReview: false,
        settingSources: [],
        enableAgentRetries: true,
        mcpServers: {
          fixture: { command: "node", args: ["mcp.mjs"], env: { TOKEN: "t" } },
        },
      },
    ]);
  });

  it("re-passes the same option set on resume and reports the ref eagerly", async () => {
    const harness = createHarness();
    await handshake(harness);
    await attach(harness, { mode: "resume", ref: "agent-ref-1" });

    expect(harness.sdk.resumes).toHaveLength(1);
    expect(harness.sdk.resumes[0]?.ref).toBe("agent-ref-1");
    expect(harness.sdk.resumes[0]?.options.disallowedTools).toStrictEqual([
      "askQuestion",
      "await",
    ]);
    expect(harness.sdk.resumes[0]?.options.settingSources).toStrictEqual([]);
    expect(harness.sdk.resumes[0]?.options.sandboxEnabled).toBe(false);
    expect(harness.sdk.resumes[0]?.options.autoReview).toBe(false);

    expect(harness.channel.ofType("refIssued")).toStrictEqual([
      {
        v: CURSOR_IPC_CODEC_VERSION,
        type: "refIssued",
        runId: null,
        ref: "agent-ref-1",
      },
    ]);
    expect(harness.channel.ofType("attachResult")[0]?.outcome).toBe("attached");
  });

  it("reports an attach failure with the SDK's stable error seams", async () => {
    const harness = createHarness();
    harness.sdk.attachError = Object.assign(new Error("no such agent"), {
      name: "AgentNotFoundError",
      code: "agent_not_found",
      status: 404,
    });
    await handshake(harness);
    await attach(harness, { mode: "resume", ref: "stale-ref" });

    const [result] = harness.channel.ofType("attachResult");
    expect(result?.outcome).toBe("failed");
    expect(result?.error).toStrictEqual({
      name: "AgentNotFoundError",
      code: "agent_not_found",
      status: 404,
      message: "no such agent",
    });
  });

  it("refuses an attach that arrives before the handshake completes", async () => {
    const harness = createHarness();
    startCursorWorker(harness.deps);
    harness.channel.emit(initFrame());
    await settle();
    harness.channel.emit(attachFrame());
    await settle();

    expect(harness.sdk.creates).toHaveLength(0);
    expect(harness.channel.ofType("attachResult")[0]?.error?.code).toBe(
      "worker_not_ready",
    );
  });

  it("refuses an attach that arrives with no credential in hand", async () => {
    const harness = createHarness();
    await handshake(harness);
    // No credential frame ahead of this attach: the handshake one was consumed
    // by verification and nothing in the worker kept a copy.
    harness.channel.emit(attachFrame());
    await settle();

    expect(harness.sdk.creates).toHaveLength(0);
    expect(harness.channel.ofType("attachResult")[0]?.error?.code).toBe(
      "credential_absent",
    );
  });
});

describe("cursor worker credential lifetime", () => {
  it("clears the credential as soon as verification consumes it", async () => {
    const harness = createHarness();
    const handle = startCursorWorker(harness.deps);
    harness.channel.emit(initFrame());
    await settle();

    harness.channel.emit(credentialFrame());
    await settle();

    expect(harness.sdk.verifiedKeys).toStrictEqual([API_KEY]);
    expect(harness.channel.ofType("ready")).toHaveLength(1);
    // Handed off and gone: the worker holds nothing between the handshake and
    // whatever the supervisor sends next.
    expect(handle.hasCredential()).toBe(false);
  });

  it("clears the credential after a failed verification too", async () => {
    const harness = createHarness();
    harness.sdk.verifyError = Object.assign(new Error("Bad API key"), {
      name: "AuthenticationError",
      status: 401,
    });
    const handle = startCursorWorker(harness.deps);
    harness.channel.emit(initFrame());
    await settle();
    harness.channel.emit(credentialFrame());
    await vi.advanceTimersByTimeAsync(TERMINATION_GRACE_MS * 2);

    expect(handle.hasCredential()).toBe(false);
  });

  it("consumes a fresh credential per attach and clears it at handoff", async () => {
    const harness = createHarness();
    const handle = await handshake(harness);

    harness.channel.emit(credentialFrame());
    await settle();
    // Held only in the window between the frame and the attach it fuels.
    expect(handle.hasCredential()).toBe(true);

    harness.channel.emit(attachFrame());
    await settle();

    expect(harness.sdk.creates[0]?.apiKey).toBe(API_KEY);
    expect(handle.hasCredential()).toBe(false);
  });

  it("clears the credential when the SDK rejects the attach", async () => {
    const harness = createHarness();
    harness.sdk.attachError = Object.assign(new Error("no such agent"), {
      name: "AgentNotFoundError",
      code: "agent_not_found",
    });
    const handle = await handshake(harness);
    await attach(harness, { mode: "resume", ref: "stale-ref" });

    expect(harness.channel.ofType("attachResult")[0]?.outcome).toBe("failed");
    // A failed handoff is still a handoff: the key reached the SDK call, so it
    // is spent either way.
    expect(handle.hasCredential()).toBe(false);
  });

  it("does not re-verify a credential sent after the handshake", async () => {
    const harness = createHarness();
    await handshake(harness);
    await attach(harness);

    // One verification for the handshake, none for the attach: a second
    // `Cursor.me` per attach would be a billable-adjacent call the spec never
    // asks for.
    expect(harness.sdk.verifiedKeys).toStrictEqual([API_KEY]);
    expect(harness.channel.ofType("ready")).toHaveLength(1);
  });
});

describe("cursor worker turns", () => {
  it("streams native events in order and settles the turn", async () => {
    const harness = createHarness();
    harness.sdk.agent.run = new FakeRun(
      [
        { type: "system", agent_id: "agent-ref-1", run_id: "sdk-run" },
        { type: "assistant", agent_id: "agent-ref-1", text: "hi" },
      ],
      {
        status: "finished",
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 1,
          cacheWriteTokens: 2,
          totalTokens: 30,
          reasoningTokens: 4,
        },
      },
    );
    await handshake(harness);
    await attach(harness);
    harness.channel.emit(startTurnFrame());
    await settle();

    expect(harness.channel.ofType("inputAccepted")).toHaveLength(1);
    const events = harness.channel.ofType("nativeEvent");
    expect(events.map((frame) => frame.eventIndex)).toStrictEqual([0, 1]);
    expect(events.map((frame) => frame.eventType)).toStrictEqual([
      "system",
      "assistant",
    ]);
    const decoded = decodeNativePayload("assistant", events[1]?.payload ?? "");
    expect(decoded.ok && decoded.value).toStrictEqual({
      type: "assistant",
      agent_id: "agent-ref-1",
      text: "hi",
    });

    expect(harness.channel.ofType("usage")[0]?.totalTokens).toBe(30);
    expect(harness.channel.ofType("turnSettled")[0]?.outcome).toBe("completed");
  });

  it("carries only the model, MCP map, and force-expiry flag as per-send options", async () => {
    const harness = createHarness();
    await handshake(harness);
    await attach(harness);
    harness.channel.emit(
      startTurnFrame({
        model: "composer-2.5",
        mcpServers: {
          per_send: { command: "node", args: [], env: {} },
        },
      }),
    );
    await settle();

    expect(harness.sdk.agent.sends).toHaveLength(1);
    expect(
      Object.keys(harness.sdk.agent.sends[0]?.options ?? {}).sort(),
    ).toStrictEqual(["forceExpirePersistedRun", "mcpServers", "model"]);
    expect(harness.sdk.agent.sends[0]?.options.model).toBe("composer-2.5");
    expect(harness.sdk.agent.sends[0]?.options.forceExpirePersistedRun).toBe(
      false,
    );
  });

  it("passes the force-expiry recovery flag through to the SDK send", async () => {
    const harness = createHarness();
    await handshake(harness);
    await attach(harness);
    harness.channel.emit(startTurnFrame({ forceExpirePersistedRun: true }));
    await settle();

    expect(harness.sdk.agent.sends[0]?.options.forceExpirePersistedRun).toBe(
      true,
    );
  });

  it("rejects an unencodable native event without echoing it or breaking the run", async () => {
    const cyclic: Record<string, unknown> = {
      type: "tool_call",
      secret: API_KEY,
    };
    cyclic.self = cyclic;
    const harness = createHarness();
    harness.sdk.agent.run = new FakeRun(
      [
        { type: "assistant", text: "before" },
        cyclic,
        { type: "assistant", text: "after" },
      ],
      { status: "finished" },
    );
    await handshake(harness);
    await attach(harness);
    harness.channel.emit(startTurnFrame());
    await settle();

    const [rejected] = harness.channel.ofType("nativeEventRejected");
    expect(rejected?.violation).toBe("cycle");
    expect(rejected?.eventIndex).toBe(1);
    expect(JSON.stringify(rejected)).not.toContain(API_KEY);
    // The run continues: the event after the rejected one still arrives, and
    // the indexes stay monotonic across the gap.
    expect(
      harness.channel.ofType("nativeEvent").map((frame) => frame.eventIndex),
    ).toStrictEqual([0, 2]);
    expect(harness.channel.ofType("turnSettled")[0]?.outcome).toBe("completed");
  });

  it("cancels the active run and reports a non-active cancel distinctly", async () => {
    const harness = createHarness();
    let releaseStream: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    const run = harness.sdk.agent.run;
    // A run that is still streaming when cancel arrives — the only state in
    // which cancellation is meaningful.
    run.stream = async function* () {
      yield { type: "assistant", text: "partial" };
      await gate;
    };
    await handshake(harness);
    await attach(harness);
    harness.channel.emit(startTurnFrame());
    await settle();

    harness.channel.emit({
      v: CURSOR_IPC_CODEC_VERSION,
      type: "cancel",
      runId: "run-1",
    });
    await settle();
    expect(run.cancelCalls).toBe(1);
    expect(harness.channel.ofType("cancelResult")[0]?.outcome).toBe(
      "cancelled",
    );

    releaseStream();
    await settle();

    harness.channel.emit({
      v: CURSOR_IPC_CODEC_VERSION,
      type: "cancel",
      runId: "run-1",
    });
    await settle();
    expect(harness.channel.ofType("cancelResult")[1]?.outcome).toBe(
      "not_active",
    );
  });

  it("never emits the credential on any frame", async () => {
    const harness = createHarness();
    harness.sdk.agent.run = new FakeRun([{ type: "assistant", text: "hi" }], {
      status: "finished",
    });
    await handshake(harness);
    await attach(harness);
    harness.channel.emit(startTurnFrame());
    await settle();

    expect(harness.channel.sent.length).toBeGreaterThan(3);
    expect(JSON.stringify(harness.channel.sent)).not.toContain(API_KEY);
  });
});

describe("cursor worker watchdog", () => {
  it("self-terminates with its process group when the channel disconnects", async () => {
    const harness = createHarness();
    await handshake(harness);
    await attach(harness);

    harness.channel.disconnect();
    await vi.advanceTimersByTimeAsync(TERMINATION_GRACE_MS * 2);

    expect(harness.sdk.agent.disposeCalls).toBe(1);
    expect(harness.control.terminationIgnored).toBe(true);
    expect(harness.control.signals).toStrictEqual([
      { pgid: WORKER_PID, signal: "SIGTERM" },
      { pgid: WORKER_PID, signal: "SIGKILL" },
    ]);
    expect(harness.control.exits).toStrictEqual([CURSOR_WORKER_EXIT_ORPHANED]);
  });

  it("self-terminates when the recorded parent dies while the channel stays open", async () => {
    const harness = createHarness();
    await handshake(harness);
    harness.control.livePids.delete(PARENT_PID);

    await vi.advanceTimersByTimeAsync(PARENT_POLL_MS);
    await vi.advanceTimersByTimeAsync(TERMINATION_GRACE_MS * 2);

    expect(harness.control.signals.map((entry) => entry.signal)).toStrictEqual([
      "SIGTERM",
      "SIGKILL",
    ]);
    expect(harness.control.exits).toStrictEqual([CURSOR_WORKER_EXIT_ORPHANED]);
  });

  it("self-terminates after the idle bound and resets it on each turn event", async () => {
    const harness = createHarness();
    harness.sdk.agent.run = new FakeRun([{ type: "assistant" }], {
      status: "finished",
    });
    await handshake(harness);
    await attach(harness);

    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1);
    expect(harness.control.exits).toHaveLength(0);

    harness.channel.emit(startTurnFrame());
    await settle();
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1);
    expect(harness.control.exits).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1 + TERMINATION_GRACE_MS * 2);
    expect(harness.control.exits).toStrictEqual([CURSOR_WORKER_EXIT_IDLE]);
  });

  it("escalates past a disposal that never returns", async () => {
    const harness = createHarness();
    await handshake(harness);
    await attach(harness);
    harness.sdk.agent.disposeBlocks = true;

    harness.channel.disconnect();
    await vi.advanceTimersByTimeAsync(TERMINATION_GRACE_MS * 3);

    expect(harness.control.signals.map((entry) => entry.signal)).toStrictEqual([
      "SIGTERM",
      "SIGKILL",
    ]);
    expect(harness.control.exits).toStrictEqual([CURSOR_WORKER_EXIT_ORPHANED]);
  });

  it("disposes the agent on an orderly shutdown", async () => {
    const harness = createHarness();
    const handle = await handshake(harness);
    await attach(harness);

    harness.channel.emit({
      v: CURSOR_IPC_CODEC_VERSION,
      type: "shutdown",
      reason: "close",
    });
    await vi.advanceTimersByTimeAsync(TERMINATION_GRACE_MS * 2);
    await handle.stopped;

    expect(handle.hasCredential()).toBe(false);
    expect(harness.sdk.agent.disposeCalls).toBe(1);
    expect(harness.control.exits).toStrictEqual([0]);
  });

  it("clears an unconsumed credential when it terminates", async () => {
    const harness = createHarness();
    const handle = await handshake(harness);
    // A credential that arrived for an attach that never came must not outlive
    // the worker's teardown.
    harness.channel.emit(credentialFrame());
    await settle();
    expect(handle.hasCredential()).toBe(true);

    harness.channel.disconnect();
    await vi.advanceTimersByTimeAsync(TERMINATION_GRACE_MS * 2);
    await handle.stopped;

    expect(handle.hasCredential()).toBe(false);
  });

  it("terminates only once when several triggers fire together", async () => {
    const harness = createHarness();
    await handshake(harness);

    harness.channel.disconnect();
    harness.channel.disconnect();
    harness.control.livePids.delete(PARENT_PID);
    await vi.advanceTimersByTimeAsync(TERMINATION_GRACE_MS * 4);

    expect(harness.control.exits).toHaveLength(1);
    expect(harness.control.signals).toHaveLength(2);
  });
});

describe("cursor worker protocol handling", () => {
  it("rejects an unparsable frame as a bounded protocol error and keeps running", async () => {
    const harness = createHarness();
    await handshake(harness);

    harness.channel.emit({ v: CURSOR_IPC_CODEC_VERSION, type: "startTurn" });
    harness.channel.emit({ v: 99, type: "shutdown", reason: "close" });
    harness.channel.emit({ secret: API_KEY });
    await settle();

    const fatals = harness.channel.ofType("fatal");
    // A frame with no codec version is rejected on the version check before its
    // shape is ever read, which is why the last input reports the same reason.
    expect(fatals.map((frame) => frame.code)).toStrictEqual([
      "protocol_invalid_frame",
      "protocol_unsupported_version",
      "protocol_unsupported_version",
    ]);
    expect(JSON.stringify(fatals)).not.toContain(API_KEY);
    expect(harness.control.exits).toHaveLength(0);
  });

  it("survives a channel that throws on send", async () => {
    const harness = createHarness();
    await handshake(harness);
    harness.channel.broken = true;

    await attach(harness);
    harness.channel.disconnect();
    await vi.advanceTimersByTimeAsync(TERMINATION_GRACE_MS * 2);

    expect(harness.control.exits).toStrictEqual([CURSOR_WORKER_EXIT_ORPHANED]);
  });
});
