import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getGlobalSingleton } from "../shared/global-singleton";
import type { DevServerEntry } from "./registry";
import * as liveness from "./liveness";
import { setLivenessDeps, type LivenessDeps } from "./liveness";
import { getTraceContext, type TraceContext } from "../logging";
import type { PortOwnershipInput, PortOwnershipResult } from "./port-ownership";

// No vi.mock — use setLivenessDeps for DI

const mockBroadcast = vi.fn();
const mockUnregister = vi.fn().mockResolvedValue(undefined);
const mockClassifyPortOwnership =
  vi.fn<(input: PortOwnershipInput) => Promise<PortOwnershipResult>>();

const mockDeps: LivenessDeps = {
  broadcast: mockBroadcast,
  unregister: mockUnregister,
  classifyPortOwnership: mockClassifyPortOwnership,
};

function createMockEntry(
  overrides: Partial<DevServerEntry> = {},
): DevServerEntry {
  return {
    serverName: "web",
    projectPath: "/proj",
    sessionName: "s1",
    command: "sleep 60",
    status: "running",
    port: 3000,
    remoteUrl: "https://host:3000",
    startedAt: new Date().toISOString(),
    errorMessage: null,
    recentOutput: [],
    worktreePath: "/tmp",
    ownedByThisSession: false,
    ownerPid: null,
    logFilePath: "/tmp/.cc/dev-server-logs/web.log",
    _process: null,
    _pid: null,
    _logStream: null,
    _stdoutRemainder: "",
    _stderrRemainder: "",
    ...overrides,
  };
}

function getRegistryMap(): Map<string, DevServerEntry> {
  return getGlobalSingleton(
    "__cc_dev_servers",
    () => new Map<string, DevServerEntry>(),
  );
}

describe("LivenessPoller", () => {
  beforeEach(() => {
    liveness._resetForTesting();
    setLivenessDeps(mockDeps);
    const reg = getRegistryMap();
    reg.clear();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    liveness._resetForTesting();
    getRegistryMap().clear();
    vi.useRealTimers();
  });

  it("start is idempotent", () => {
    liveness.start();
    liveness.start();
    // No error — second call is a no-op
    liveness.stop();
  });

  it("stop is idempotent", () => {
    liveness.stop();
    liveness.stop();
    // No error
  });

  it("detects dead port and transitions to stopped", async () => {
    const reg = getRegistryMap();
    mockClassifyPortOwnership.mockResolvedValue({ status: "available" });

    const entry = createMockEntry({ port: 3000, status: "running" });
    reg.set("/proj::s1::web", entry);

    liveness.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(entry.status).toBe("stopped");
    expect(mockBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "dev-server-status",
        serverName: "web",
        status: "stopped",
      }),
    );
  });

  it("does not transition alive servers", async () => {
    const reg = getRegistryMap();
    mockClassifyPortOwnership.mockResolvedValue({
      status: "owned",
      pid: 1234,
      cwd: "/tmp",
    });

    const entry = createMockEntry({ port: 3000, status: "running" });
    reg.set("/proj::s1::web", entry);

    liveness.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(entry.status).toBe("running");
  });

  it("does not transition on unknown ownership (treats as still owned for safety)", async () => {
    const reg = getRegistryMap();
    mockClassifyPortOwnership.mockResolvedValue({
      status: "unknown",
      reason: "listener_lookup_failed",
    });

    const entry = createMockEntry({ port: 3000, status: "running" });
    reg.set("/proj::s1::web", entry);

    liveness.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(entry.status).toBe("running");
  });

  it("transitions to stopped when port is now owned by a different worktree", async () => {
    const reg = getRegistryMap();
    mockClassifyPortOwnership.mockResolvedValue({
      status: "conflict",
      pid: 9999,
      cwd: "/var/run/other",
    });

    const entry = createMockEntry({ port: 3000, status: "running" });
    reg.set("/proj::s1::web", entry);

    liveness.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(entry.status).toBe("stopped");
  });

  it("preserves ownerPid metadata when transitioning to stopped on dead port", async () => {
    const reg = getRegistryMap();
    mockClassifyPortOwnership.mockResolvedValue({ status: "available" });

    const entry = createMockEntry({
      port: 3000,
      status: "running",
      ownedByThisSession: true,
      ownerPid: 42424,
    });
    reg.set("/proj::s1::web", entry);

    liveness.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(entry.status).toBe("stopped");
    expect(entry.ownerPid).toBe(42424);
    expect(entry.ownedByThisSession).toBe(false);
    expect(mockBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "dev-server-status",
        status: "stopped",
        ownerPid: 42424,
        ownedByThisSession: false,
        worktreePath: "/tmp",
      }),
    );
  });

  it("auto-stops when registry empties", async () => {
    const reg = getRegistryMap();
    const entry = createMockEntry({ port: 3000, status: "stopped" });
    reg.set("/proj::s1::web", entry);

    liveness.start();
    await vi.advanceTimersByTimeAsync(5_000);

    // The poller should have auto-stopped since no active servers
    // Verify by checking that further ticks don't cause errors
    await vi.advanceTimersByTimeAsync(10_000);
  });

  it("runs each poll cycle inside a poll:dev-server-liveness trace", async () => {
    const reg = getRegistryMap();
    const captured: (TraceContext | undefined)[] = [];
    mockClassifyPortOwnership.mockImplementation(async () => {
      captured.push(getTraceContext());
      return { status: "owned", pid: 1, cwd: "/tmp" };
    });

    const entry = createMockEntry({ port: 3000, status: "running" });
    reg.set("/proj::s1::web", entry);

    liveness.start();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(captured.length).toBeGreaterThanOrEqual(2);
    for (const ctx of captured) {
      expect(ctx?.action).toBe("poll:dev-server-liveness");
      expect(ctx?.traceId).toBeTypeOf("string");
    }
    // Each cycle should mint a fresh traceId.
    const ids = captured.map((c) => c?.traceId).filter(Boolean) as string[];
    expect(new Set(ids).size).toBe(ids.length);
  });
});
