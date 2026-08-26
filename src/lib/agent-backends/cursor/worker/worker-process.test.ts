import { execFileSync, fork, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ConversationTarget } from "@/lib/conversations/conversation-target";
import { buildChildEnv } from "@/lib/shared/child-env";
import {
  readProcessArgvSource,
  readProcessEnvironSource,
} from "../acceptance/credential-scan";
import {
  createCursorPackageProbe,
  runCursorStaticPreflight,
} from "../preflight";
import type {
  CursorWorkerExitInfo,
  CursorWorkerStartInput,
} from "../worker-port";
import { CURSOR_IPC_CODEC_VERSION, parseWorkerFrame } from "./ipc";
import type { CursorParentFrame, CursorWorkerFrame } from "./ipc";
import { createCursorProcessHost } from "./process-host";
import { errnoCode, readProcessGroupIdSync } from "./process-identity";
import { createCursorWorkerSupervisor } from "./supervisor";

/**
 * Worker lifetime against real processes.
 *
 * Everything here is a claim about the operating system — a process that exits
 * on its own, a group that outlives its leader, a pid whose identity no longer
 * matches — so nothing here is faked. The spawned worker is the real worker
 * runtime with only the SDK scripted (`testing/stub-worker-main.ts`).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB_WORKER = path.join(HERE, "testing", "stub-worker-main.ts");
/** The child is a plain Node process, so TypeScript needs a loader. */
const STUB_EXEC_ARGV = ["--import", "tsx"];

const API_KEY = "cursor-key-sentinel-9d41c7ab";
const CONVERSATION_ID = "conv-real";
const MODEL_SELECTION = {
  modelId: "composer-2.5",
  parameters: { fast: "true" },
} as const;

const TARGET: ConversationTarget = {
  scope: "session",
  projectName: "command-center",
  sessionName: "cursor-session",
  conversationId: CONVERSATION_ID,
};

const BOUNDS = {
  readyTimeoutMs: 12_000,
  cancelGraceMs: 200,
  exitGraceMs: 800,
  termGraceMs: 800,
  killConfirmMs: 1_500,
  probeIntervalMs: 25,
  idleTtlMs: 60_000,
  workerParentPollIntervalMs: 100,
  workerTerminationGraceMs: 200,
};

/** Groups this file created, killed after each test whatever happened. */
const spawnedGroups = new Set<number>();

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === "EPERM";
  }
}

function isGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === "EPERM";
  }
}

function markedProcessCount(marker: string): number {
  try {
    const found = execFileSync("pgrep", ["-f", marker], { encoding: "utf8" });
    return found.trim().split("\n").filter(Boolean).length;
  } catch {
    // pgrep exits 1 when nothing matches.
    return 0;
  }
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

interface StubOptions {
  mode?: "ok" | "invalid_credential" | "hang";
  ignoreSigterm?: boolean;
  childMarker?: string;
}

function stubEnv(options: StubOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...buildChildEnv() };
  if (options.mode !== undefined) env.CURSOR_STUB_MODE = options.mode;
  if (options.ignoreSigterm === true) env.CURSOR_STUB_IGNORE_SIGTERM = "1";
  if (options.childMarker !== undefined) {
    env.CURSOR_STUB_CHILD_MARKER = options.childMarker;
  }
  return env;
}

interface RawWorker {
  pid: number;
  send(frame: CursorParentFrame): void;
  frames: CursorWorkerFrame[];
  connected(): boolean;
  disconnect(): void;
}

/** Fork the worker directly, without a supervisor between us and it. */
function forkStubWorker(options: StubOptions = {}): RawWorker {
  const child = fork(STUB_WORKER, [], {
    execArgv: STUB_EXEC_ARGV,
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: stubEnv(options),
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error("the stub worker did not start");
  spawnedGroups.add(pid);
  const frames: CursorWorkerFrame[] = [];
  child.on("message", (value: unknown) => {
    // Parsed, not asserted: a frame this test recorded without validating would
    // let a malformed worker reply masquerade as a real one.
    const parsed = parseWorkerFrame(value);
    if (parsed.ok) frames.push(parsed.frame);
  });
  return {
    pid,
    send: (frame) => child.send(frame),
    frames,
    connected: () => child.connected,
    disconnect: () => child.disconnect(),
  };
}

function initFrame(
  overrides: Partial<Extract<CursorParentFrame, { type: "init" }>> = {},
): CursorParentFrame {
  return {
    v: CURSOR_IPC_CODEC_VERSION,
    type: "init",
    conversationId: CONVERSATION_ID,
    workerId: "worker-real",
    cwd: process.cwd(),
    storePath: path.join(process.cwd(), ".cc", "temp", "cursor-store"),
    parentPid: process.pid,
    idleTimeoutMs: 60_000,
    parentPollIntervalMs: 100,
    terminationGraceMs: 200,
    sdkVersion: "1.0.28",
    ...overrides,
  };
}

afterEach(() => {
  for (const pgid of spawnedGroups) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // Already gone, which is the expected case for every passing test.
    }
  }
  spawnedGroups.clear();
});

describe("cursor worker self-termination", () => {
  it("takes its process group with it when the channel disconnects", async () => {
    const marker = `cc-cursor-descendant-${process.pid}-disconnect`;
    const worker = forkStubWorker({ childMarker: marker });
    worker.send(initFrame());
    expect(await waitFor(() => markedProcessCount(marker) > 0, 8_000)).toBe(
      true,
    );
    // The worker leads its own group, which is what makes group-scoped
    // termination observable at all.
    expect(readProcessGroupIdSync(worker.pid)).toBe(worker.pid);

    worker.disconnect();

    expect(await waitFor(() => !isAlive(worker.pid), 5_000)).toBe(true);
    expect(await waitFor(() => !isGroupAlive(worker.pid), 5_000)).toBe(true);
    expect(markedProcessCount(marker)).toBe(0);
  }, 25_000);

  it("self-terminates when its recorded parent dies, channel still open", async () => {
    // A sacrificial stand-in for the server: the worker is told to watch it, so
    // its death is observable without closing the IPC channel this test holds.
    const sacrifice = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60000)"],
      {
        stdio: "ignore",
      },
    );
    const sacrificePid = sacrifice.pid;
    expect(sacrificePid).toBeDefined();

    const worker = forkStubWorker();
    worker.send(
      initFrame({ parentPid: sacrificePid, parentPollIntervalMs: 100 }),
    );
    expect(await waitFor(() => isAlive(worker.pid), 8_000)).toBe(true);

    sacrifice.kill("SIGKILL");
    expect(await waitFor(() => !isAlive(sacrificePid ?? 0), 5_000)).toBe(true);
    // The channel this test owns is untouched: only the polled parent died.
    expect(worker.connected()).toBe(true);

    expect(await waitFor(() => !isAlive(worker.pid), 5_000)).toBe(true);
  }, 25_000);

  it("reaps itself after its own idle bound with no parent action", async () => {
    const worker = forkStubWorker();
    worker.send(initFrame({ idleTimeoutMs: 800 }));
    worker.send({
      v: CURSOR_IPC_CODEC_VERSION,
      type: "credential",
      apiKey: API_KEY,
    });
    expect(
      await waitFor(
        () => worker.frames.some((frame) => frame.type === "ready"),
        10_000,
      ),
    ).toBe(true);

    expect(await waitFor(() => !isAlive(worker.pid), 6_000)).toBe(true);
    expect(
      worker.frames.some((frame) => frame.type === "preflightFailed"),
    ).toBe(false);
  }, 25_000);
});

describe("cursor worker credential lifetime in a real process", () => {
  /**
   * Clearing is proven by behavior across the process boundary rather than by
   * an in-process peek: a worker that no longer holds a credential cannot
   * attach without a fresh one, and that refusal is observable from here.
   */
  it("holds the credential only until the SDK call it was sent for", async () => {
    const worker = forkStubWorker();
    worker.send(initFrame());
    worker.send({
      v: CURSOR_IPC_CODEC_VERSION,
      type: "credential",
      apiKey: API_KEY,
    });
    expect(
      await waitFor(
        () => worker.frames.some((frame) => frame.type === "ready"),
        10_000,
      ),
    ).toBe(true);

    const attachFrame: CursorParentFrame = {
      v: CURSOR_IPC_CODEC_VERSION,
      type: "attachAgent",
      mode: "create",
      ref: null,
      modelSelection: MODEL_SELECTION,
      disallowedTools: ["askQuestion", "await"],
      sandboxEnabled: false,
      autoReview: false,
      settingSources: [],
      enableAgentRetries: true,
      mcpServers: {},
    };
    const attachResults = () =>
      worker.frames.filter((frame) => frame.type === "attachResult");

    // Verification consumed the handshake credential, so this attach has
    // nothing to run on.
    worker.send(attachFrame);
    expect(await waitFor(() => attachResults().length === 1, 5_000)).toBe(true);
    const first = attachResults()[0];
    expect(first?.type === "attachResult" && first.outcome).toBe("failed");
    expect(first?.type === "attachResult" && first.error?.code).toBe(
      "credential_absent",
    );

    // With a fresh one immediately ahead of it — the order the supervisor
    // sends — the same attach succeeds.
    worker.send({
      v: CURSOR_IPC_CODEC_VERSION,
      type: "credential",
      apiKey: API_KEY,
    });
    worker.send(attachFrame);
    expect(await waitFor(() => attachResults().length === 2, 5_000)).toBe(true);
    const second = attachResults()[1];
    expect(second?.type === "attachResult" && second.outcome).toBe("attached");

    // And it was spent by that handoff: the next attach is refused again, so
    // no credential survived in the worker for its lifetime.
    worker.send(attachFrame);
    expect(await waitFor(() => attachResults().length === 3, 5_000)).toBe(true);
    const third = attachResults()[2];
    expect(third?.type === "attachResult" && third.error?.code).toBe(
      "credential_absent",
    );

    expect(JSON.stringify(worker.frames)).not.toContain(API_KEY);
  }, 30_000);
});

interface SupervisorHarness {
  transport: ReturnType<typeof createCursorWorkerSupervisor>;
  frames: CursorWorkerFrame[];
  exits: CursorWorkerExitInfo[];
  startInput: CursorWorkerStartInput;
}

/**
 * The production layer-1 preflight against the really installed packages: this
 * worktree pins @cursor/sdk 1.0.28 with its Linux platform package, so the
 * checks run for real rather than being scripted away.
 */
const realStaticPreflight = (input: { model: string }) =>
  runCursorStaticPreflight(input, {
    packages: createCursorPackageProbe(
      path.join(process.cwd(), "node_modules"),
    ),
    host: { platform: process.platform, arch: process.arch },
    workerNodeVersion: async () => process.version,
  });

function createSupervisorHarness(
  options: StubOptions & {
    scriptPath?: string;
    startTicks?: (pid: number) => Promise<string | null>;
  } = {},
): SupervisorHarness {
  const host = createCursorProcessHost();
  const frames: CursorWorkerFrame[] = [];
  const exits: CursorWorkerExitInfo[] = [];
  const transport = createCursorWorkerSupervisor({
    host:
      options.startTicks === undefined
        ? host
        : { ...host, startTicks: options.startTicks },
    runStaticPreflight: realStaticPreflight,
    readCredential: () => API_KEY,
    workerScriptPath: () => options.scriptPath ?? STUB_WORKER,
    workerExecArgv: () => STUB_EXEC_ARGV,
    buildChildEnv: () => stubEnv(options),
    getServerUrl: () => "http://127.0.0.1:3000",
    getApiToken: () => "token",
    getConfigDir: () => path.join(process.cwd(), ".cc", "temp", "config"),
    newWorkerId: () => "worker-real",
    bounds: BOUNDS,
  });
  return {
    transport,
    frames,
    exits,
    startInput: {
      conversationId: CONVERSATION_ID,
      target: TARGET,
      cwd: process.cwd(),
      storePath: path.join(process.cwd(), ".cc", "temp", "cursor-store"),
      modelSelection: MODEL_SELECTION,
      ownerToken: {},
      onFrame: (frame) => frames.push(frame),
      onExit: (info) => exits.push(info),
    },
  };
}

describe("cursor worker supervisor against real processes", () => {
  it("escalates a wedged worker to a verified group kill", async () => {
    const marker = `cc-cursor-descendant-${process.pid}-wedged`;
    const harness = createSupervisorHarness({
      mode: "hang",
      ignoreSigterm: true,
      childMarker: marker,
    });
    const started = await harness.transport.start(harness.startInput);
    expect(started.kind).toBe("ready");
    if (started.kind !== "ready") return;
    const pid = started.session.pid;
    spawnedGroups.add(pid);
    expect(await waitFor(() => markedProcessCount(marker) > 0, 8_000)).toBe(
      true,
    );

    const outcome = await started.session.close();

    // SIGTERM is ignored by both the worker and its descendant, so only the
    // SIGKILL rung can end this group — and cleanup is reported only after the
    // group is confirmed gone.
    expect(outcome).toStrictEqual({ kind: "verified", escalation: "sigkill" });
    expect(isAlive(pid)).toBe(false);
    expect(isGroupAlive(pid)).toBe(false);
    expect(markedProcessCount(marker)).toBe(0);
    expect(harness.transport.find(CONVERSATION_ID)).toBeNull();
  }, 30_000);

  it("refuses to signal a group whose recorded identity no longer matches", async () => {
    // Pid reuse, staged: the spawn-time read is the real one, and by teardown
    // the pid reads as a different process than the one that was recorded.
    const realHost = createCursorProcessHost();
    let reads = 0;
    const harness = createSupervisorHarness({
      mode: "hang",
      startTicks: async (pid: number) => {
        reads += 1;
        return reads === 1 ? realHost.startTicks(pid) : "999999999";
      },
    });
    const started = await harness.transport.start(harness.startInput);
    expect(started.kind).toBe("ready");
    if (started.kind !== "ready") return;
    const pid = started.session.pid;
    spawnedGroups.add(pid);

    const outcome = await started.session.close();

    expect(outcome.kind).toBe("cleanup_failed");
    if (outcome.kind === "cleanup_failed") {
      expect(outcome.reason).toBe("ownership_unverified");
    }
    // The point of the guard: an unverifiable process is left alone, not shot.
    expect(isAlive(pid)).toBe(true);
  }, 30_000);

  it("tears a cooperative worker down without signalling anything", async () => {
    const harness = createSupervisorHarness({ mode: "ok" });
    const started = await harness.transport.start(harness.startInput);
    expect(started.kind).toBe("ready");
    if (started.kind !== "ready") return;
    const pid = started.session.pid;
    spawnedGroups.add(pid);

    const first = await started.session.close();
    const second = await started.session.close();

    expect(first).toStrictEqual({ kind: "verified", escalation: "orderly" });
    expect(second).toStrictEqual(first);
    expect(isAlive(pid)).toBe(false);
    expect(harness.exits.map((info) => info.expected)).toStrictEqual([true]);
  }, 30_000);

  it("reports a worker script that cannot run as a spawn failure", async () => {
    const harness = createSupervisorHarness({
      scriptPath: path.join(HERE, "testing", "no-such-worker.ts"),
    });
    const started = await harness.transport.start(harness.startInput);

    expect(started.kind).toBe("spawn_failed");
    expect(harness.transport.find(CONVERSATION_ID)).toBeNull();
  }, 30_000);

  it("reports a rejected credential as a preflight failure and leaves nothing running", async () => {
    const harness = createSupervisorHarness({ mode: "invalid_credential" });
    const started = await harness.transport.start(harness.startInput);

    expect(started.kind).toBe("preflight_failed");
    if (started.kind === "preflight_failed") {
      expect(started.reason).toBe("invalid_credential");
    }
    expect(harness.transport.find(CONVERSATION_ID)).toBeNull();
  }, 30_000);
});

describe("cursor worker credential hygiene", () => {
  it("keeps the credential out of the spawned process's argv and environment", async () => {
    const previous = process.env.CURSOR_API_KEY;
    // The ambient value the SDK would otherwise find: `buildChildEnv()` copies
    // the whole server environment, so this is exactly the leak the spawn
    // contract has to remove.
    process.env.CURSOR_API_KEY = API_KEY;
    try {
      const host = createCursorProcessHost();
      const transport = createCursorWorkerSupervisor({
        host,
        runStaticPreflight: realStaticPreflight,
        readCredential: () => process.env.CURSOR_API_KEY ?? null,
        workerScriptPath: () => STUB_WORKER,
        workerExecArgv: () => STUB_EXEC_ARGV,
        buildChildEnv,
        getServerUrl: () => "http://127.0.0.1:3000",
        getApiToken: () => "token",
        getConfigDir: () => path.join(process.cwd(), ".cc", "temp", "config"),
        newWorkerId: () => "worker-real",
        bounds: BOUNDS,
      });
      const frames: CursorWorkerFrame[] = [];
      const started = await transport.start({
        conversationId: CONVERSATION_ID,
        target: TARGET,
        cwd: process.cwd(),
        storePath: path.join(process.cwd(), ".cc", "temp", "cursor-store"),
        modelSelection: MODEL_SELECTION,
        ownerToken: {},
        onFrame: (frame) => frames.push(frame),
        onExit: () => {},
      });
      expect(started.kind).toBe("ready");
      if (started.kind !== "ready") return;
      const pid = started.session.pid;
      spawnedGroups.add(pid);

      // Read the running process's real argv and environment, the two surfaces
      // any same-host process could inspect. An unreadable process reads as
      // empty, which would pass the exclusion vacuously — so emptiness fails.
      const cmdline = await readProcessArgvSource(pid);
      const environ = await readProcessEnvironSource(pid);
      expect(cmdline.records.length).toBeGreaterThan(0);
      expect(environ.records.length).toBeGreaterThan(0);

      expect(cmdline.text).not.toContain(API_KEY);
      expect(environ.text).not.toContain(API_KEY);
      expect(environ.text).not.toContain("CURSOR_API_KEY");
      // Reaching ready proves the worker did receive and verify the credential,
      // so its absence above is exclusion, not a worker that never got one.
      expect(started.session.pid).toBeGreaterThan(0);

      // The attach carries a second credential over the same private channel;
      // neither surface changes, and no frame coming back carries the value.
      started.session.attach({
        mode: "create",
        ref: null,
        modelSelection: MODEL_SELECTION,
        mcpServers: {},
      });
      expect(
        await waitFor(
          () => frames.some((frame) => frame.type === "attachResult"),
          5_000,
        ),
      ).toBe(true);
      expect(
        frames.some(
          (frame) =>
            frame.type === "attachResult" && frame.outcome === "attached",
        ),
      ).toBe(true);
      const environAfterAttach = await readProcessEnvironSource(pid);
      const cmdlineAfterAttach = await readProcessArgvSource(pid);
      expect(environAfterAttach.records.length).toBeGreaterThan(0);
      expect(environAfterAttach.text).not.toContain(API_KEY);
      expect(cmdlineAfterAttach.records.length).toBeGreaterThan(0);
      expect(cmdlineAfterAttach.text).not.toContain(API_KEY);
      expect(JSON.stringify(frames)).not.toContain(API_KEY);

      await started.session.close();
    } finally {
      if (previous === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = previous;
    }
  }, 30_000);
});
