import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getGlobalSingleton } from "./global-singleton";
import type { DevServerEntry } from "./dev-server-registry";

// Mock tailscale
vi.mock("./tailscale", () => ({
  unregister: vi.fn().mockResolvedValue(undefined),
}));

// Mock sse-broadcaster
vi.mock("./sse-broadcaster", () => ({
  broadcast: vi.fn(),
}));

// Mock dev-server-registry — provide isPortAlive mock
const mockIsPortAlive = vi.fn<(port: number) => Promise<boolean>>();
vi.mock("./dev-server-registry", () => ({
  isPortAlive: (...args: [number]) => mockIsPortAlive(...args),
}));

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
    status: "running",
    port: 3000,
    remoteUrl: "https://host:3000",
    startedAt: new Date().toISOString(),
    errorMessage: null,
    recentOutput: [],
    _process: null,
    _startupTimer: null,
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
    mockIsPortAlive.mockResolvedValue(false);

    const entry = createMockEntry({ port: 3000, status: "running" });
    reg.set("/proj::s1::web", entry);

    liveness.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(entry.status).toBe("stopped");
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "dev-server-status",
        serverName: "web",
        status: "stopped",
      }),
    );
  });

  it("does not transition alive servers", async () => {
    const reg = getRegistryMap();
    mockIsPortAlive.mockResolvedValue(true);

    const entry = createMockEntry({ port: 3000, status: "running" });
    reg.set("/proj::s1::web", entry);

    liveness.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(entry.status).toBe("running");
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
});
