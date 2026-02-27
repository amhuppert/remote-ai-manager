import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DevServerEntry } from "./dev-server-registry";

// Mock tailscale
vi.mock("./tailscale", () => ({
  unregister: vi.fn().mockResolvedValue(undefined),
}));

// Mock sse-broadcaster
vi.mock("./sse-broadcaster", () => ({
  broadcast: vi.fn(),
}));

// Mock dev-server-registry (only imported for type)
vi.mock("./dev-server-registry", () => ({}));

import { broadcast } from "./sse-broadcaster";
import * as liveness from "./dev-server-liveness";

function createMockEntry(
  overrides: Partial<DevServerEntry> = {},
): DevServerEntry {
  return {
    serverName: "web",
    projectPath: "/proj",
    sessionName: "s1",
    command: "sleep 60",
    pid: 99999,
    status: "running",
    port: 3000,
    remoteUrl: "https://host:3000",
    startedAt: new Date().toISOString(),
    errorMessage: null,
    recentOutput: [],
    adopted: false,
    _process: null,
    _startupTimer: null,
    ...overrides,
  };
}

function getRegistryMap(): Map<string, DevServerEntry> {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g["__cc_dev_servers"]) {
    g["__cc_dev_servers"] = new Map<string, DevServerEntry>();
  }
  return g["__cc_dev_servers"] as Map<string, DevServerEntry>;
}

describe("LivenessPoller", () => {
  beforeEach(() => {
    liveness._resetForTesting();
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

  it("detects dead process and transitions to stopped", () => {
    const reg = getRegistryMap();
    // PID 1 always exists, but a very high PID likely doesn't
    // Use a mock approach: we mock process.kill to throw ESRCH
    const killSpy = vi
      .spyOn(process, "kill")
      .mockImplementation((_pid, signal) => {
        if (signal === 0) {
          const err = new Error("no such process") as NodeJS.ErrnoException;
          err.code = "ESRCH";
          throw err;
        }
        return true;
      });

    const entry = createMockEntry({ pid: 12345, status: "running" });
    reg.set("/proj::s1::web", entry);

    liveness.start();
    vi.advanceTimersByTime(5_000);

    expect(entry.status).toBe("stopped");
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "dev-server-status",
        serverName: "web",
        status: "stopped",
      }),
    );

    killSpy.mockRestore();
  });

  it("does not transition alive processes", () => {
    const reg = getRegistryMap();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const entry = createMockEntry({ pid: 12345, status: "running" });
    reg.set("/proj::s1::web", entry);

    liveness.start();
    vi.advanceTimersByTime(5_000);

    expect(entry.status).toBe("running");

    killSpy.mockRestore();
  });

  it("auto-stops when registry empties", () => {
    const reg = getRegistryMap();
    const entry = createMockEntry({ pid: 12345, status: "stopped" });
    reg.set("/proj::s1::web", entry);

    liveness.start();
    vi.advanceTimersByTime(5_000);

    // The poller should have auto-stopped since no active servers
    // Verify by checking that further ticks don't cause errors
    vi.advanceTimersByTime(10_000);
  });
});
