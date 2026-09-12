import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationTarget } from "@/lib/conversations/conversation-target";
import { CURSOR_PHASE1_POLICY } from "../policy";
import type {
  CursorWorkerCloseOutcome,
  CursorWorkerExitInfo,
  CursorWorkerSession,
  CursorWorkerStartResult,
  CursorWorkerTransport,
} from "../worker-port";
import { CURSOR_IPC_CODEC_VERSION } from "./ipc";
import type { CursorParentFrame, CursorWorkerFrame } from "./ipc";
import type {
  CursorProcessHost,
  CursorSpawnRequest,
  CursorSpawnedProcess,
} from "./process-host";
import {
  createCursorWorkerSupervisor,
  type CursorSupervisorDeps,
} from "./supervisor";

/**
 * Supervisor behavior with the operating system injected: spawn contract,
 * credential handoff, the verified teardown ladder, the ownership guard, idle
 * reaping, and registry lifetime.
 *
 * The host fake models the kernel behaviors the ladder actually turns on — a
 * group that dies on SIGTERM, one that only dies on SIGKILL, one that survives
 * both, and a pid whose start time no longer matches — because those states are
 * the decisions under test.
 */

const API_KEY = "cursor-key-sentinel-4f2b9c";
const CONVERSATION_ID = "conv-1";
const WORKTREE = "/work/tree";
const STORE_PATH = "/state/cursor/conv-1";

const TARGET: ConversationTarget = {
  scope: "session",
  projectName: "command-center",
  sessionName: "cursor-session",
  conversationId: CONVERSATION_ID,
};

const BOUNDS = {
  readyTimeoutMs: 2_000,
  cancelGraceMs: 200,
  exitGraceMs: 300,
  termGraceMs: 200,
  killConfirmMs: 200,
  probeIntervalMs: 10,
  idleTtlMs: 5_000,
};

class FakeSpawnedProcess implements CursorSpawnedProcess {
  readonly sent: CursorParentFrame[] = [];
  private messageListeners: ((value: unknown) => void)[] = [];
  private exitListeners: ((
    code: number | null,
    signal: string | null,
  ) => void)[] = [];
  private errorListeners: ((error: Error) => void)[] = [];
  disconnected = false;
  running = true;
  /** Whether a `shutdown` frame makes this worker exit on its own. */
  autoExitOnShutdown = true;

  constructor(readonly pid: number) {}

  send(frame: CursorParentFrame): void {
    if (!this.running) throw new Error("channel closed");
    this.sent.push(frame);
    if (frame.type === "shutdown" && this.autoExitOnShutdown) {
      this.exit(0, null);
    }
  }

  onMessage(listener: (value: unknown) => void): void {
    this.messageListeners.push(listener);
  }

  onExit(listener: (code: number | null, signal: string | null) => void): void {
    this.exitListeners.push(listener);
  }

  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  emit(frame: CursorWorkerFrame | unknown): void {
    for (const listener of this.messageListeners) listener(frame);
  }

  fail(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }

  exit(code: number | null, signal: string | null): void {
    if (!this.running) return;
    this.running = false;
    this.onExited?.();
    for (const listener of this.exitListeners) listener(code, signal);
  }

  /** Set by the host so an exiting worker takes its group with it. */
  onExited: (() => void) | null = null;

  ofType<TType extends CursorParentFrame["type"]>(
    type: TType,
  ): Extract<CursorParentFrame, { type: TType }>[] {
    return this.sent.filter(
      (frame): frame is Extract<CursorParentFrame, { type: TType }> =>
        frame.type === type,
    );
  }
}

class FakeProcessHost implements CursorProcessHost {
  readonly requests: CursorSpawnRequest[] = [];
  readonly processes: FakeSpawnedProcess[] = [];
  readonly signals: { pgid: number; signal: NodeJS.Signals }[] = [];
  private readonly aliveGroups = new Set<number>();
  private readonly ticksByPid = new Map<number, string | null>();
  spawnError: Error | null = null;
  nextPid = 5000;
  /** A group that ignores SIGTERM, as a wedged SDK child would. */
  ignoreSigterm = false;
  /** A group that survives even SIGKILL — the unverifiable-cleanup case. */
  undead = false;
  /** Descendants outlive the leader, as a reparented tool process would. */
  leaveGroupAlive = false;

  spawn(request: CursorSpawnRequest): CursorSpawnedProcess {
    if (this.spawnError !== null) throw this.spawnError;
    this.requests.push(request);
    const pid = this.nextPid;
    this.nextPid += 1;
    const child = new FakeSpawnedProcess(pid);
    // A worker that exits normally takes its group with it (its own watchdog
    // signals the group), and its pid stops being readable.
    child.onExited = () => {
      this.ticksByPid.set(pid, null);
      if (!this.leaveGroupAlive) this.aliveGroups.delete(pid);
    };
    this.processes.push(child);
    this.aliveGroups.add(pid);
    this.ticksByPid.set(pid, `${pid}00`);
    return child;
  }

  processGroupId(pid: number): number | null {
    // Every spawned worker leads its own group, so pgid === pid.
    return this.ticksByPid.has(pid) ? pid : null;
  }

  async startTicks(pid: number): Promise<string | null> {
    return this.ticksByPid.get(pid) ?? null;
  }

  isGroupAlive(pgid: number): boolean {
    return this.aliveGroups.has(pgid);
  }

  signalGroup(pgid: number, signal: NodeJS.Signals): void {
    this.signals.push({ pgid, signal });
    if (this.undead) return;
    if (signal === "SIGTERM" && this.ignoreSigterm) return;
    this.aliveGroups.delete(pgid);
    const child = this.processes.find((entry) => entry.pid === pgid);
    child?.exit(null, signal);
  }

  /** Simulate pid reuse: the pid lives on with a different process behind it. */
  recyclePid(pid: number): void {
    this.ticksByPid.set(pid, "999999");
  }

  /** Simulate a host where process identity cannot be read at all. */
  hideIdentity(pid: number): void {
    this.ticksByPid.set(pid, null);
  }

  last(): FakeSpawnedProcess {
    const child = this.processes.at(-1);
    if (child === undefined) throw new Error("nothing was spawned");
    return child;
  }
}

const PREFLIGHT_DIAGNOSTICS = {
  sdkPackage: "@cursor/sdk",
  requiredSdkVersion: "1.0.28",
  installedSdkVersion: "1.0.28",
  platformPackage: "@cursor/sdk-linux-x64",
  installedPlatformVersion: "1.0.28",
  host: "linux-x64",
  nodeVersion: "v22.14.0",
  requiredNodeVersion: ">=22.13",
  model: "composer-2.5",
};

const MODEL_SELECTION = {
  modelId: "composer-2.5",
  parameters: {},
} as const;

interface Harness {
  host: FakeProcessHost;
  transport: CursorWorkerTransport;
  ownerToken: object;
  frames: CursorWorkerFrame[];
  exits: CursorWorkerExitInfo[];
  credentialReads: number;
  preflightModels: string[];
}

function createHarness(overrides: Partial<CursorSupervisorDeps> = {}): Harness {
  const host = new FakeProcessHost();
  const harness: Harness = {
    host,
    ownerToken: {},
    frames: [],
    exits: [],
    credentialReads: 0,
    preflightModels: [],
    transport: createCursorWorkerSupervisor({
      host,
      runStaticPreflight: async (input) => {
        harness.preflightModels.push(input.model);
        return { ok: true, diagnostics: PREFLIGHT_DIAGNOSTICS };
      },
      readCredential: () => {
        harness.credentialReads += 1;
        return API_KEY;
      },
      workerScriptPath: () => "/app/dist/cursor-worker/worker.mjs",
      workerExecArgv: () => [],
      buildChildEnv: () => ({
        PATH: "/usr/bin",
        CURSOR_API_KEY: API_KEY,
        CC_SESSION: "stale-ambient",
      }),
      getServerUrl: () => "http://127.0.0.1:3000",
      getApiToken: () => "token",
      getConfigDir: () => "/home/alex/.command-center",
      newWorkerId: () => "worker-1",
      bounds: BOUNDS,
      ...overrides,
    }),
  };
  return harness;
}

function startInput(harness: Harness) {
  return {
    conversationId: CONVERSATION_ID,
    target: TARGET,
    cwd: WORKTREE,
    storePath: STORE_PATH,
    modelSelection: MODEL_SELECTION,
    ownerToken: harness.ownerToken,
    onFrame: (frame: CursorWorkerFrame) => harness.frames.push(frame),
    onExit: (info: CursorWorkerExitInfo) => harness.exits.push(info),
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function readyFrame(pid: number): CursorWorkerFrame {
  return {
    v: CURSOR_IPC_CODEC_VERSION,
    type: "ready",
    pid,
    pgid: pid,
    nodeVersion: "v22.14.0",
    sdkVersion: "1.0.28",
  };
}

/** Start a worker and drive its handshake to `ready`. */
async function startReady(harness: Harness): Promise<CursorWorkerSession> {
  const pending = harness.transport.start(startInput(harness));
  await settle();
  const child = harness.host.last();
  child.emit(readyFrame(child.pid));
  const result = await pending;
  if (result.kind !== "ready") {
    throw new Error(`expected a ready worker, got ${result.kind}`);
  }
  return result.session;
}

it("withholds CC identity from generic tasks and disables every isolated tool on the wire", async () => {
  const harness = createHarness();
  const pending = harness.transport.start({
    ...startInput(harness),
    target: null,
    executionProfile: "isolated-one-shot",
  });
  await settle();
  expect(harness.host.requests).toHaveLength(1);
  const child = harness.host.last();
  child.emit(readyFrame(child.pid));
  const result = await pending;
  expect(result.kind).toBe("ready");
  if (result.kind !== "ready") return;
  expect(harness.host.requests[0]?.env.CC_SESSION ?? "").toBe("");
  expect(harness.host.requests[0]?.env.CC_API_TOKEN ?? "").toBe("");
  result.session.attach({
    mode: "create",
    ref: null,
    modelSelection: MODEL_SELECTION,
    mcpServers: {},
  });
  expect(child.ofType("attachAgent")[0]).toHaveProperty("tools", []);
  await result.session.close();
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("cursor worker spawn contract", () => {
  it("excludes the credential from the worker environment and argv", async () => {
    const harness = createHarness();
    await startReady(harness);

    const [request] = harness.host.requests;
    expect(request).toBeDefined();
    expect(request?.env.CURSOR_API_KEY).toBeUndefined();
    expect(Object.values(request?.env ?? {})).not.toContain(API_KEY);
    expect(JSON.stringify(request)).not.toContain(API_KEY);
    expect(request?.execArgv).toStrictEqual([]);
  });

  it("builds the worker environment from the session env contract", async () => {
    const harness = createHarness();
    await startReady(harness);

    const env = harness.host.requests[0]?.env ?? {};
    expect(env.CC_CONVERSATION_ID).toBe(CONVERSATION_ID);
    expect(env.CC_LOG_FILE).toBe(
      `/home/alex/.command-center/logs/cursor-workers/${CONVERSATION_ID}.log`,
    );
    expect(env.CC_PROJECT).toBe("command-center");
    expect(env.CC_SESSION).toBe("cursor-session");
    expect(env.CC_SERVER_URL).toBe("http://127.0.0.1:3000");
    expect(env.PATH).toContain("/home/alex/.command-center/bin");
  });

  it("withholds every ambient credential from the worker, not only the Cursor key", async () => {
    // The worker runs an agent with unsandboxed shell and MCP tools, and every
    // one of those children inherits this environment. Excluding CURSOR_API_KEY
    // alone would hand the server's other credentials to the model.
    const harness = createHarness({
      buildChildEnv: () => ({
        PATH: "/usr/bin",
        HOME: "/home/alex",
        CURSOR_API_KEY: API_KEY,
        OPENAI_API_KEY: "sk-ambient-openai",
        GITHUB_TOKEN: "ghp-ambient-github",
        AWS_SECRET_ACCESS_KEY: "aws-ambient-secret",
      }),
    });
    await startReady(harness);

    const env = harness.host.requests[0]?.env ?? {};
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(Object.values(env)).not.toContain("sk-ambient-openai");
    expect(Object.values(env)).not.toContain("ghp-ambient-github");
    expect(Object.values(env)).not.toContain("aws-ambient-secret");
    // The variables the agent needs are untouched, and Command Center's own
    // callback credential is re-supplied by the session contract rather than
    // inherited — stripping must not sever the agent from cctl.
    expect(env.PATH).toContain("/usr/bin");
    expect(env.HOME).toBe("/home/alex");
    expect(env.CC_API_TOKEN).toBe("token");
  });

  it("spawns in the conversation worktree and hands the credential over IPC", async () => {
    const harness = createHarness();
    await startReady(harness);

    expect(harness.host.requests[0]?.cwd).toBe(WORKTREE);
    const child = harness.host.last();
    expect(child.sent.map((frame) => frame.type)).toStrictEqual([
      "init",
      "credential",
    ]);
    expect(child.ofType("credential")[0]?.apiKey).toBe(API_KEY);
    const init = child.ofType("init")[0];
    expect(init?.cwd).toBe(WORKTREE);
    expect(init?.storePath).toBe(STORE_PATH);
    expect(init?.parentPid).toBe(process.pid);
  });

  it("re-reads the credential for every spawn instead of caching it", async () => {
    const harness = createHarness();
    const first = await startReady(harness);
    expect(harness.credentialReads).toBe(1);

    await first.close();
    await startReady(harness);
    expect(harness.credentialReads).toBe(2);
  });

  it("runs the static runtime preflight before every spawn", async () => {
    const harness = createHarness();
    const first = await startReady(harness);
    await first.close();
    await startReady(harness);

    // Per start, not once per process: package drift and a Node change between
    // conversations are exactly what layer 1 exists to catch (D3).
    expect(harness.preflightModels).toStrictEqual([
      "composer-2.5",
      "composer-2.5",
    ]);
  });

  it("refuses to spawn when the static runtime preflight fails", async () => {
    const harness = createHarness({
      runStaticPreflight: async () => ({
        ok: false,
        code: "sdk_version_mismatch",
        message: "@cursor/sdk 1.1.0 is installed but only 1.0.28 is tested.",
        diagnostics: { ...PREFLIGHT_DIAGNOSTICS, installedSdkVersion: "1.1.0" },
      }),
    });
    const result = await harness.transport.start(startInput(harness));

    expect(result.kind).toBe("runtime_preflight_failed");
    if (result.kind === "runtime_preflight_failed") {
      expect(result.code).toBe("sdk_version_mismatch");
      expect(result.diagnostics.installedSdkVersion).toBe("1.1.0");
    }
    // Fail closed before anything exists: no process, and the credential is
    // not even read, let alone sent.
    expect(harness.host.requests).toHaveLength(0);
    expect(harness.credentialReads).toBe(0);
    expect(harness.transport.find(CONVERSATION_ID)).toBeNull();
  });

  it("refuses to spawn when no credential is configured", async () => {
    const harness = createHarness({ readCredential: () => null });
    const result = await harness.transport.start(startInput(harness));

    expect(result).toStrictEqual({
      kind: "preflight_failed",
      reason: "missing_credential",
      message: expect.stringContaining("CURSOR_API_KEY"),
    });
    expect(harness.host.requests).toHaveLength(0);
    expect(harness.transport.find(CONVERSATION_ID)).toBeNull();
  });

  it("reports a worker preflight failure and registers nothing", async () => {
    const harness = createHarness();
    const pending = harness.transport.start(startInput(harness));
    await settle();
    const child = harness.host.last();
    child.emit({
      v: CURSOR_IPC_CODEC_VERSION,
      type: "preflightFailed",
      reason: "invalid_credential",
      message: "credential rejected",
    });
    await vi.advanceTimersByTimeAsync(BOUNDS.exitGraceMs * 3);
    const result: CursorWorkerStartResult = await pending;

    expect(result.kind).toBe("preflight_failed");
    if (result.kind === "preflight_failed") {
      expect(result.reason).toBe("invalid_credential");
    }
    expect(harness.transport.find(CONVERSATION_ID)).toBeNull();
    expect(child.running).toBe(false);
  });

  it("reports a spawn failure without registering a worker", async () => {
    const harness = createHarness();
    harness.host.spawnError = new Error("EACCES");
    const result = await harness.transport.start(startInput(harness));

    expect(result.kind).toBe("spawn_failed");
    expect(harness.transport.find(CONVERSATION_ID)).toBeNull();
  });

  it("keeps one worker per conversation", async () => {
    const harness = createHarness();
    const session = await startReady(harness);

    const again = await harness.transport.start(startInput(harness));
    expect(again.kind).toBe("already_active");
    if (again.kind === "already_active") {
      expect(again.session).toBe(session);
    }
    expect(harness.host.processes).toHaveLength(1);
    expect(harness.transport.find(CONVERSATION_ID)).toBe(session);
  });

  it("refuses to reuse a conversation worker bound to a different parameter selection", async () => {
    const harness = createHarness();
    const session = await startReady(harness);

    const changed = await harness.transport.start({
      ...startInput(harness),
      modelSelection: {
        modelId: MODEL_SELECTION.modelId,
        parameters: { effort: "high" },
      },
    });

    expect(changed).toMatchObject({
      kind: "binding_mismatch",
      message: expect.stringContaining("different model selection"),
    });
    expect(harness.host.processes).toHaveLength(1);
    expect(harness.transport.find(CONVERSATION_ID)).toBe(session);
    expect(harness.preflightModels).toStrictEqual([MODEL_SELECTION.modelId]);
  });

  it("reserves the conversation while a worker starts and refuses a concurrent different selection", async () => {
    const harness = createHarness();
    const firstPending = harness.transport.start(startInput(harness));
    const secondPending = harness.transport.start({
      ...startInput(harness),
      modelSelection: {
        modelId: MODEL_SELECTION.modelId,
        parameters: { effort: "high" },
      },
    });

    await settle();
    for (const child of harness.host.processes) {
      child.emit(readyFrame(child.pid));
    }
    const [first, second] = await Promise.all([firstPending, secondPending]);

    expect(first.kind).toBe("ready");
    expect(second).toMatchObject({
      kind: "binding_mismatch",
      message: expect.stringContaining("different model selection"),
    });
    expect(harness.host.processes).toHaveLength(1);
  });

  it("shares one in-flight start for concurrent identical selections", async () => {
    const harness = createHarness();
    const firstPending = harness.transport.start(startInput(harness));
    const secondPending = harness.transport.start(startInput(harness));

    await settle();
    for (const child of harness.host.processes) {
      child.emit(readyFrame(child.pid));
    }
    const [first, second] = await Promise.all([firstPending, secondPending]);

    expect(first.kind).toBe("ready");
    expect(second.kind).toBe("already_active");
    if (first.kind === "ready" && second.kind === "already_active") {
      expect(second.session).toBe(first.session);
    }
    expect(harness.host.processes).toHaveLength(1);
  });

  it("refuses to share an in-flight worker with a different runtime owner", async () => {
    const harness = createHarness();
    const firstPending = harness.transport.start(startInput(harness));
    const secondPending = harness.transport.start({
      ...startInput(harness),
      ownerToken: {},
    });

    await settle();
    for (const child of harness.host.processes) {
      child.emit(readyFrame(child.pid));
    }
    const [first, second] = await Promise.all([firstPending, secondPending]);

    expect(first.kind).toBe("ready");
    expect(second).toMatchObject({
      kind: "binding_mismatch",
      message: expect.stringContaining("different runtime owner"),
    });
    expect(harness.host.processes).toHaveLength(1);
  });

  it("reuses a conversation worker when parameter insertion order is the only difference", async () => {
    const harness = createHarness();
    const pending = harness.transport.start({
      ...startInput(harness),
      modelSelection: {
        modelId: MODEL_SELECTION.modelId,
        parameters: { effort: "high", context: "max" },
      },
    });
    await settle();
    const child = harness.host.last();
    child.emit(readyFrame(child.pid));
    const first = await pending;
    if (first.kind !== "ready") {
      throw new Error(`expected a ready worker, got ${first.kind}`);
    }

    const again = await harness.transport.start({
      ...startInput(harness),
      modelSelection: {
        modelId: MODEL_SELECTION.modelId,
        parameters: { context: "max", effort: "high" },
      },
    });

    expect(again.kind).toBe("already_active");
    if (again.kind === "already_active") {
      expect(again.session).toBe(first.session);
    }
    expect(harness.host.processes).toHaveLength(1);
  });
});

describe("cursor worker attach and turn framing", () => {
  it("passes the full Phase 1 policy on create and again on resume", async () => {
    const harness = createHarness();
    const session = await startReady(harness);

    session.attach({
      mode: "create",
      ref: null,
      modelSelection: MODEL_SELECTION,
      mcpServers: {},
    });
    session.attach({
      mode: "resume",
      ref: "agent-ref-1",
      recoverAbandonedRun: true,
      modelSelection: MODEL_SELECTION,
      mcpServers: {
        fixture: { command: "node", args: ["mcp.mjs"], env: {} },
      },
    });

    const attaches = harness.host.last().ofType("attachAgent");
    expect(attaches).toHaveLength(2);
    for (const frame of attaches) {
      expect(frame.disallowedTools).toStrictEqual([
        ...CURSOR_PHASE1_POLICY.disallowedTools,
      ]);
      expect(frame.sandboxEnabled).toBe(false);
      expect(frame.autoReview).toBe(false);
      expect(frame.settingSources).toStrictEqual([]);
      expect(frame.enableAgentRetries).toBe(
        CURSOR_PHASE1_POLICY.enableAgentRetries,
      );
    }
    expect(attaches[0]?.mode).toBe("create");
    expect(attaches[0]?.recoverAbandonedRun).toBeUndefined();
    expect(attaches[1]?.recoverAbandonedRun).toBe(true);
    expect(attaches[1]?.ref).toBe("agent-ref-1");
    expect(attaches[1]?.mcpServers.fixture).toMatchObject({ command: "node" });
  });

  it("fuels each attach with a freshly read credential", async () => {
    const harness = createHarness();
    const session = await startReady(harness);
    const child = harness.host.last();
    expect(harness.credentialReads).toBe(1);

    session.attach({
      mode: "create",
      ref: null,
      modelSelection: MODEL_SELECTION,
      mcpServers: {},
    });
    session.attach({
      mode: "resume",
      ref: "agent-ref-1",
      modelSelection: MODEL_SELECTION,
      mcpServers: {},
    });

    // The worker consumed the handshake credential during verification, so each
    // attach carries its own — read from the server environment at that moment,
    // never from a cached copy.
    expect(harness.credentialReads).toBe(3);
    expect(child.sent.map((frame) => frame.type)).toStrictEqual([
      "init",
      "credential",
      "credential",
      "attachAgent",
      "credential",
      "attachAgent",
    ]);
    for (const frame of child.ofType("credential")) {
      expect(frame.apiKey).toBe(API_KEY);
    }
  });

  it("refuses an attach when the credential is no longer configured", async () => {
    let available = true;
    const harness = createHarness({
      readCredential: () => (available ? API_KEY : null),
    });
    const session = await startReady(harness);
    const child = harness.host.last();
    available = false;

    session.attach({
      mode: "create",
      ref: null,
      modelSelection: MODEL_SELECTION,
      mcpServers: {},
    });

    expect(child.ofType("attachAgent")).toHaveLength(0);
    // The caller waits on one settlement channel, so the refusal arrives there
    // rather than as an attach that never answers.
    const [failure] = harness.frames.filter(
      (frame) => frame.type === "attachResult",
    );
    expect(failure?.type === "attachResult" && failure.error?.code).toBe(
      "credential_absent",
    );
  });

  it("forwards worker frames to the caller in arrival order", async () => {
    const harness = createHarness();
    await startReady(harness);
    const child = harness.host.last();

    child.emit({
      v: CURSOR_IPC_CODEC_VERSION,
      type: "inputAccepted",
      runId: "run-1",
    });
    child.emit({
      v: CURSOR_IPC_CODEC_VERSION,
      type: "turnSettled",
      runId: "run-1",
      outcome: "completed",
      error: null,
    });
    // An unparsable frame is dropped rather than forwarded as if it were real.
    child.emit({ garbage: true });

    expect(harness.frames.map((frame) => frame.type)).toStrictEqual([
      "ready",
      "inputAccepted",
      "turnSettled",
    ]);
  });
});

describe("cursor worker teardown ladder", () => {
  it("cancels the active run, shuts down, and verifies without signalling", async () => {
    const harness = createHarness();
    const session = await startReady(harness);
    const child = harness.host.last();
    session.startTurn({
      runId: "run-1",
      promptText: "hi",
      images: [],
      structuredOutputInstruction: null,
      modelSelection: MODEL_SELECTION,
      mcpServers: {},
      forceExpirePersistedRun: false,
    });

    const closing = session.close();
    await settle();
    expect(child.ofType("cancel")[0]?.runId).toBe("run-1");
    child.emit({
      v: CURSOR_IPC_CODEC_VERSION,
      type: "cancelResult",
      runId: "run-1",
      outcome: "cancelled",
      message: null,
    });
    await vi.advanceTimersByTimeAsync(BOUNDS.exitGraceMs);
    const outcome = await closing;

    expect(outcome).toStrictEqual({ kind: "verified", escalation: "orderly" });
    expect(harness.host.signals).toHaveLength(0);
    expect(child.ofType("shutdown")).toHaveLength(1);
    expect(harness.transport.find(CONVERSATION_ID)).toBeNull();
  });

  it("escalates to the process group when the worker will not exit", async () => {
    const harness = createHarness();
    const session = await startReady(harness);
    harness.host.last().autoExitOnShutdown = false;

    const closing = session.close();
    await vi.advanceTimersByTimeAsync(
      BOUNDS.cancelGraceMs + BOUNDS.exitGraceMs + BOUNDS.termGraceMs + 100,
    );
    const outcome = await closing;

    expect(outcome).toStrictEqual({ kind: "verified", escalation: "sigterm" });
    expect(harness.host.signals).toStrictEqual([
      { pgid: 5000, signal: "SIGTERM" },
    ]);
    expect(harness.transport.find(CONVERSATION_ID)).toBeNull();
  });

  it("escalates to SIGKILL when the group ignores SIGTERM", async () => {
    const harness = createHarness();
    const session = await startReady(harness);
    harness.host.last().autoExitOnShutdown = false;
    harness.host.ignoreSigterm = true;

    const closing = session.close();
    await vi.advanceTimersByTimeAsync(
      BOUNDS.cancelGraceMs +
        BOUNDS.exitGraceMs +
        BOUNDS.termGraceMs +
        BOUNDS.killConfirmMs +
        100,
    );
    const outcome = await closing;

    expect(outcome).toStrictEqual({ kind: "verified", escalation: "sigkill" });
    expect(harness.host.signals.map((entry) => entry.signal)).toStrictEqual([
      "SIGTERM",
      "SIGKILL",
    ]);
  });

  it("records a bounded cleanup failure when the group survives SIGKILL", async () => {
    const harness = createHarness();
    const session = await startReady(harness);
    harness.host.last().autoExitOnShutdown = false;
    harness.host.undead = true;

    const closing = session.close();
    await vi.advanceTimersByTimeAsync(
      BOUNDS.cancelGraceMs +
        BOUNDS.exitGraceMs +
        BOUNDS.termGraceMs +
        BOUNDS.killConfirmMs +
        500,
    );
    const outcome: CursorWorkerCloseOutcome = await closing;

    expect(outcome.kind).toBe("cleanup_failed");
    if (outcome.kind === "cleanup_failed") {
      expect(outcome.reason).toBe("group_survived");
    }
    // The registry clears on a recorded failure too: a caller that waited must
    // not be told to keep waiting on a worker nothing can prove anything about.
    expect(harness.transport.find(CONVERSATION_ID)).toBeNull();
  });

  it("escalates when the worker exits but its group survives it", async () => {
    const harness = createHarness();
    const session = await startReady(harness);
    // Descendants the SDK reparented outlive the worker, so an observed exit is
    // not on its own proof that no supervised process remains.
    harness.host.leaveGroupAlive = true;

    const closing = session.close();
    await vi.advanceTimersByTimeAsync(BOUNDS.exitGraceMs + BOUNDS.termGraceMs);
    const outcome = await closing;

    expect(outcome).toStrictEqual({ kind: "verified", escalation: "sigterm" });
    expect(harness.host.signals).toStrictEqual([
      { pgid: 5000, signal: "SIGTERM" },
    ]);
  });

  it("refuses to signal a pid whose recorded identity no longer matches", async () => {
    const harness = createHarness();
    const session = await startReady(harness);
    harness.host.last().autoExitOnShutdown = false;
    // The worker died and its pid was handed to something else.
    harness.host.recyclePid(5000);

    const closing = session.close();
    await vi.advanceTimersByTimeAsync(
      BOUNDS.cancelGraceMs + BOUNDS.exitGraceMs + BOUNDS.termGraceMs + 500,
    );
    const outcome: CursorWorkerCloseOutcome = await closing;

    expect(harness.host.signals).toHaveLength(0);
    expect(outcome.kind).toBe("cleanup_failed");
    if (outcome.kind === "cleanup_failed") {
      expect(outcome.reason).toBe("ownership_unverified");
    }
  });

  it("refuses to signal when process identity cannot be read at all", async () => {
    const harness = createHarness();
    const session = await startReady(harness);
    harness.host.last().autoExitOnShutdown = false;
    harness.host.hideIdentity(5000);

    const closing = session.close();
    await vi.advanceTimersByTimeAsync(
      BOUNDS.cancelGraceMs + BOUNDS.exitGraceMs + BOUNDS.termGraceMs + 500,
    );
    const outcome: CursorWorkerCloseOutcome = await closing;

    expect(harness.host.signals).toHaveLength(0);
    expect(outcome.kind).toBe("cleanup_failed");
  });

  it("settles repeated closes identically without a second teardown", async () => {
    const harness = createHarness();
    const session = await startReady(harness);
    const child = harness.host.last();

    const first = session.close();
    const second = session.close();
    await vi.advanceTimersByTimeAsync(BOUNDS.exitGraceMs * 2);
    const [a, b] = await Promise.all([first, second]);

    expect(a).toStrictEqual(b);
    expect(child.ofType("shutdown")).toHaveLength(1);
    expect(harness.host.signals).toHaveLength(0);

    // A close after settlement replays the recorded outcome.
    await expect(session.close()).resolves.toStrictEqual(a);
    expect(child.ofType("shutdown")).toHaveLength(1);
  });

  it("closes every live worker on closeAll", async () => {
    const harness = createHarness();
    await startReady(harness);
    const second = harness.transport.start({
      ...startInput(harness),
      conversationId: "conv-2",
    });
    await settle();
    const secondChild = harness.host.last();
    secondChild.emit(readyFrame(secondChild.pid));
    await second;

    const closing = harness.transport.closeAll();
    await vi.advanceTimersByTimeAsync(BOUNDS.exitGraceMs * 2);
    await closing;

    expect(harness.transport.find(CONVERSATION_ID)).toBeNull();
    expect(harness.transport.find("conv-2")).toBeNull();
  });

  it("waits for an in-flight start and closes its worker before closeAll settles", async () => {
    const harness = createHarness();
    const starting = harness.transport.start(startInput(harness));
    await settle();
    const child = harness.host.last();

    let closeSettled = false;
    const closing = harness.transport.closeAll().then(() => {
      closeSettled = true;
    });
    await settle();
    const settledBeforeReady = closeSettled;

    child.emit(readyFrame(child.pid));
    const started = await starting;
    await closing;
    const workerSurvivedClose =
      harness.transport.find(CONVERSATION_ID) !== null;
    if (started.kind === "ready" && workerSurvivedClose) {
      await started.session.close();
    }

    expect(settledBeforeReady).toBe(false);
    expect(workerSurvivedClose).toBe(false);
    expect(child.running).toBe(false);
  });
});

describe("cursor worker registry lifetime", () => {
  it("reaps a worker that goes idle past its bound", async () => {
    const harness = createHarness();
    await startReady(harness);
    const child = harness.host.last();

    await vi.advanceTimersByTimeAsync(BOUNDS.idleTtlMs - 1);
    expect(harness.transport.find(CONVERSATION_ID)).not.toBeNull();

    await vi.advanceTimersByTimeAsync(1 + BOUNDS.exitGraceMs * 2);
    expect(child.ofType("shutdown")).toHaveLength(1);
    expect(harness.transport.find(CONVERSATION_ID)).toBeNull();
  });

  it("keeps a worker whose conversation is still active", async () => {
    const harness = createHarness();
    const session = await startReady(harness);
    const child = harness.host.last();

    await vi.advanceTimersByTimeAsync(BOUNDS.idleTtlMs - 1);
    session.startTurn({
      runId: "run-1",
      promptText: "hi",
      images: [],
      structuredOutputInstruction: null,
      modelSelection: MODEL_SELECTION,
      mcpServers: {},
      forceExpirePersistedRun: false,
    });
    await vi.advanceTimersByTimeAsync(BOUNDS.idleTtlMs - 1);
    child.emit({
      v: CURSOR_IPC_CODEC_VERSION,
      type: "inputAccepted",
      runId: "run-1",
    });
    await vi.advanceTimersByTimeAsync(BOUNDS.idleTtlMs - 1);

    expect(harness.transport.find(CONVERSATION_ID)).not.toBeNull();
    expect(child.ofType("shutdown")).toHaveLength(0);
  });

  it("clears the registry and reports an unexpected worker exit", async () => {
    const harness = createHarness();
    await startReady(harness);
    const child = harness.host.last();

    child.exit(1, null);
    await settle();

    expect(harness.transport.find(CONVERSATION_ID)).toBeNull();
    expect(harness.exits).toStrictEqual([
      {
        conversationId: CONVERSATION_ID,
        workerId: "worker-1",
        pid: child.pid,
        code: 1,
        signal: null,
        expected: false,
      },
    ]);
  });

  it("reports a close-driven exit as expected", async () => {
    const harness = createHarness();
    const session = await startReady(harness);

    const closing = session.close();
    await vi.advanceTimersByTimeAsync(BOUNDS.exitGraceMs);
    await closing;

    expect(harness.exits.map((info) => info.expected)).toStrictEqual([true]);
  });

  it("settles close for a worker that already died", async () => {
    const harness = createHarness();
    const session = await startReady(harness);
    harness.host.last().exit(0, null);
    await settle();

    const outcome = await session.close();
    expect(outcome.kind).toBe("verified");
    expect(harness.host.signals).toHaveLength(0);
  });
});
