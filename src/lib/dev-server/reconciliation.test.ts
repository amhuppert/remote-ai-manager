import { describe, it, expect, vi } from "vitest";
import {
  createDevServerReconciler,
  type DevServerReconciliationDeps,
} from "./reconciliation";
import type {
  PortOwnershipInput,
  PortOwnershipResult,
  ScanRangeInput,
  ScanRangeMatch,
} from "./port-ownership";
import type { DevServerEntry } from "./registry";

const PROJECT = "/proj";
const SESSION = "s1";
const WORKTREE = "/tmp/wt";

function key(serverName: string): string {
  return `${PROJECT}::${SESSION}::${serverName}`;
}

function makeRunningEntry(
  overrides: Partial<DevServerEntry> = {},
): DevServerEntry {
  return {
    serverName: "nextjs",
    projectPath: PROJECT,
    sessionName: SESSION,
    command: ".cc/dev-servers/nextjs.sh",
    status: "running",
    port: 3000,
    remoteUrl: null,
    startedAt: new Date().toISOString(),
    errorMessage: null,
    recentOutput: [],
    worktreePath: WORKTREE,
    source: "cc-started",
    ownedByThisSession: true,
    ownerPid: 1234,
    _process: null,
    _pid: 1234,
    _startupTimer: null,
    ...overrides,
  };
}

interface DepsBundle {
  registry: Map<string, DevServerEntry>;
  deps: DevServerReconciliationDeps;
  classifyPortOwnership: ReturnType<
    typeof vi.fn<(input: PortOwnershipInput) => Promise<PortOwnershipResult>>
  >;
  findOwnedListenerInRange: ReturnType<
    typeof vi.fn<(input: ScanRangeInput) => Promise<ScanRangeMatch>>
  >;
  resolveScanStrategy: ReturnType<
    typeof vi.fn<
      (serverName: string) => { basePort: number; rangeSize: number } | null
    >
  >;
  broadcast: ReturnType<typeof vi.fn>;
}

function bundle(
  overrides: {
    classifyPortOwnership?: (
      input: PortOwnershipInput,
    ) => Promise<PortOwnershipResult>;
    findOwnedListenerInRange?: (
      input: ScanRangeInput,
    ) => Promise<ScanRangeMatch>;
    resolveScanStrategy?: (
      serverName: string,
    ) => { basePort: number; rangeSize: number } | null;
  } = {},
): DepsBundle {
  const registry = new Map<string, DevServerEntry>();
  const classifyPortOwnership = vi.fn<
    (input: PortOwnershipInput) => Promise<PortOwnershipResult>
  >(
    overrides.classifyPortOwnership ??
      (async () => ({ status: "available" }) as const),
  );
  // Default to a loop over `classifyPortOwnership` so existing tests that
  // only configure classifyPortOwnership keep driving adoption behavior.
  // Production wires this to a batched lookup; the loop here is purely a
  // test convenience.
  const findOwnedListenerInRange = vi.fn<
    (input: ScanRangeInput) => Promise<ScanRangeMatch>
  >(
    overrides.findOwnedListenerInRange ??
      (async ({ basePort, rangeSize, worktreePath, allowedCwd }) => {
        for (let offset = 0; offset < rangeSize; offset++) {
          const port = basePort + offset;
          const result = await classifyPortOwnership({
            port,
            worktreePath,
            ...(allowedCwd !== undefined ? { allowedCwd } : {}),
          });
          if (result.status === "owned") {
            return { status: "owned", port, pid: result.pid, cwd: result.cwd };
          }
        }
        return { status: "none" };
      }),
  );
  const resolveScanStrategy = vi.fn<
    (serverName: string) => { basePort: number; rangeSize: number } | null
  >(overrides.resolveScanStrategy ?? (() => null));
  const broadcast = vi.fn();
  const deps: DevServerReconciliationDeps = {
    classifyPortOwnership,
    findOwnedListenerInRange,
    resolveScanStrategy,
    broadcast,
    getRegistry: () => registry,
  };
  return {
    registry,
    deps,
    classifyPortOwnership,
    findOwnedListenerInRange,
    resolveScanStrategy,
    broadcast,
  };
}

describe("createDevServerReconciler.reconcile", () => {
  describe("external preset discovery", () => {
    it("discovers an externally started preset server when no registry entry exists", async () => {
      const adoptedPort = 3007;
      const { registry, deps, broadcast } = bundle({
        classifyPortOwnership: async ({ port }) => {
          if (port === adoptedPort) {
            return { status: "owned", pid: 5001, cwd: WORKTREE };
          }
          return { status: "available" };
        },
        resolveScanStrategy: (name) =>
          name === "nextjs" ? { basePort: 3000, rangeSize: 100 } : null,
      });

      const reconciler = createDevServerReconciler(deps);
      await reconciler.reconcile({
        projectPath: PROJECT,
        sessionName: SESSION,
        worktreePath: WORKTREE,
        configuredServers: [
          { name: "nextjs", command: ".cc/dev-servers/nextjs.sh" },
        ],
      });

      const entry = registry.get(key("nextjs"));
      expect(entry).toBeDefined();
      expect(entry!.status).toBe("running");
      expect(entry!.port).toBe(adoptedPort);
      expect(entry!.source).toBe("external-adopted");
      expect(entry!.ownedByThisSession).toBe(true);
      expect(entry!.ownerPid).toBe(5001);
      expect(entry!.worktreePath).toBe(WORKTREE);
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "dev-server-status",
          serverName: "nextjs",
          status: "running",
          source: "external-adopted",
          port: adoptedPort,
          ownerPid: 5001,
          ownedByThisSession: true,
          worktreePath: WORKTREE,
        }),
      );
    });

    it("does not adopt when the only matching listener has unknown ownership", async () => {
      const { registry, deps, broadcast } = bundle({
        classifyPortOwnership: async () => ({
          status: "unknown",
          reason: "cwd_unresolved",
        }),
        resolveScanStrategy: () => ({ basePort: 3000, rangeSize: 5 }),
      });

      const reconciler = createDevServerReconciler(deps);
      await reconciler.reconcile({
        projectPath: PROJECT,
        sessionName: SESSION,
        worktreePath: WORKTREE,
        configuredServers: [{ name: "nextjs", command: "x" }],
      });

      expect(registry.get(key("nextjs"))).toBeUndefined();
      expect(broadcast).not.toHaveBeenCalled();
    });

    it("does not adopt a port whose listener belongs to a different worktree", async () => {
      const { registry, deps, broadcast } = bundle({
        classifyPortOwnership: async () => ({
          status: "conflict",
          pid: 9999,
          cwd: "/other/wt",
        }),
        resolveScanStrategy: () => ({ basePort: 3000, rangeSize: 5 }),
      });

      const reconciler = createDevServerReconciler(deps);
      await reconciler.reconcile({
        projectPath: PROJECT,
        sessionName: SESSION,
        worktreePath: WORKTREE,
        configuredServers: [{ name: "nextjs", command: "x" }],
      });

      expect(registry.get(key("nextjs"))).toBeUndefined();
      expect(broadcast).not.toHaveBeenCalled();
    });

    it("skips discovery and registry mutation for servers without a scan strategy", async () => {
      const { registry, deps, classifyPortOwnership } = bundle({
        resolveScanStrategy: () => null,
      });

      const reconciler = createDevServerReconciler(deps);
      await reconciler.reconcile({
        projectPath: PROJECT,
        sessionName: SESSION,
        worktreePath: WORKTREE,
        configuredServers: [{ name: "custom", command: "x" }],
      });

      expect(classifyPortOwnership).not.toHaveBeenCalled();
      expect(registry.get(key("custom"))).toBeUndefined();
    });
  });

  describe("stale registry handling", () => {
    it("transitions a running entry to stopped when its port is no longer alive", async () => {
      const { registry, deps, broadcast } = bundle({
        classifyPortOwnership: async () => ({ status: "available" }),
      });
      registry.set(
        key("nextjs"),
        makeRunningEntry({ port: 3000, source: "cc-started", ownerPid: 42 }),
      );

      const reconciler = createDevServerReconciler(deps);
      await reconciler.reconcile({
        projectPath: PROJECT,
        sessionName: SESSION,
        worktreePath: WORKTREE,
        configuredServers: [{ name: "nextjs", command: "x" }],
      });

      const entry = registry.get(key("nextjs"));
      expect(entry!.status).toBe("stopped");
      expect(entry!.ownedByThisSession).toBe(false);
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "dev-server-status",
          status: "stopped",
          source: "cc-started",
          ownerPid: 42,
          worktreePath: WORKTREE,
        }),
      );
    });

    it("invalidates running state when a wrong-worktree listener now owns the port", async () => {
      const { registry, deps, broadcast } = bundle({
        classifyPortOwnership: async () => ({
          status: "conflict",
          pid: 9001,
          cwd: "/var/run/other",
        }),
      });
      registry.set(
        key("nextjs"),
        makeRunningEntry({ port: 3000, ownerPid: 42 }),
      );

      const reconciler = createDevServerReconciler(deps);
      await reconciler.reconcile({
        projectPath: PROJECT,
        sessionName: SESSION,
        worktreePath: WORKTREE,
        configuredServers: [{ name: "nextjs", command: "x" }],
      });

      const entry = registry.get(key("nextjs"));
      expect(entry!.status).toBe("stopped");
      expect(entry!.ownedByThisSession).toBe(false);
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({ status: "stopped" }),
      );
    });

    it("transitions a running entry to a diagnostic non-running state when ownership cannot be verified", async () => {
      const { registry, deps, broadcast } = bundle({
        classifyPortOwnership: async () => ({
          status: "unknown",
          reason: "listener_lookup_failed",
        }),
      });
      registry.set(
        key("nextjs"),
        makeRunningEntry({ port: 3000, source: "cc-started", ownerPid: 42 }),
      );

      const reconciler = createDevServerReconciler(deps);
      await reconciler.reconcile({
        projectPath: PROJECT,
        sessionName: SESSION,
        worktreePath: WORKTREE,
        configuredServers: [{ name: "nextjs", command: "x" }],
      });

      const entry = registry.get(key("nextjs"));
      expect(entry!.status).not.toBe("running");
      expect(entry!.ownedByThisSession).toBe(false);
      expect(entry!.errorMessage).toMatch(/verif|ownership|unknown/i);
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "dev-server-status",
          serverName: "nextjs",
          worktreePath: WORKTREE,
        }),
      );
      const lastEvent = broadcast.mock.calls.at(-1)?.[0] as
        | { status: string; errorMessage: string | null }
        | undefined;
      expect(lastEvent?.status).not.toBe("running");
      expect(lastEvent?.errorMessage).toMatch(/verif|ownership|unknown/i);
    });

    it("records a diagnostic errorMessage when a conflict transitions a running entry to stopped", async () => {
      const { registry, deps } = bundle({
        classifyPortOwnership: async () => ({
          status: "conflict",
          pid: 7777,
          cwd: "/other/wt",
        }),
      });
      registry.set(key("nextjs"), makeRunningEntry({ port: 3000 }));

      const reconciler = createDevServerReconciler(deps);
      await reconciler.reconcile({
        projectPath: PROJECT,
        sessionName: SESSION,
        worktreePath: WORKTREE,
        configuredServers: [{ name: "nextjs", command: "x" }],
      });

      const entry = registry.get(key("nextjs"));
      expect(entry!.status).toBe("stopped");
      expect(entry!.errorMessage).toMatch(/conflict|other|worktree|owner/i);
    });

    it("leaves a verified-owned running entry untouched", async () => {
      const { registry, deps, broadcast } = bundle({
        classifyPortOwnership: async () => ({
          status: "owned",
          pid: 42,
          cwd: WORKTREE,
        }),
      });
      registry.set(
        key("nextjs"),
        makeRunningEntry({ port: 3000, ownerPid: 42 }),
      );

      const reconciler = createDevServerReconciler(deps);
      await reconciler.reconcile({
        projectPath: PROJECT,
        sessionName: SESSION,
        worktreePath: WORKTREE,
        configuredServers: [{ name: "nextjs", command: "x" }],
      });

      const entry = registry.get(key("nextjs"));
      expect(entry!.status).toBe("running");
      expect(broadcast).not.toHaveBeenCalled();
    });

    it("does not attempt scan-based discovery for an already-running entry", async () => {
      const { registry, deps, classifyPortOwnership, resolveScanStrategy } =
        bundle({
          classifyPortOwnership: async () => ({
            status: "owned",
            pid: 42,
            cwd: WORKTREE,
          }),
          resolveScanStrategy: () => ({ basePort: 3000, rangeSize: 100 }),
        });
      registry.set(key("nextjs"), makeRunningEntry({ port: 3000 }));

      const reconciler = createDevServerReconciler(deps);
      await reconciler.reconcile({
        projectPath: PROJECT,
        sessionName: SESSION,
        worktreePath: WORKTREE,
        configuredServers: [{ name: "nextjs", command: "x" }],
      });

      // Only the port-3000 verification should have run.
      expect(classifyPortOwnership).toHaveBeenCalledTimes(1);
      expect(resolveScanStrategy).not.toHaveBeenCalled();
    });
  });

  describe("starting entries", () => {
    it("does not mutate a starting entry even when no listener is found", async () => {
      const { registry, deps, classifyPortOwnership } = bundle({
        classifyPortOwnership: async () => ({ status: "available" }),
      });
      registry.set(
        key("nextjs"),
        makeRunningEntry({ status: "starting", port: null }),
      );

      const reconciler = createDevServerReconciler(deps);
      await reconciler.reconcile({
        projectPath: PROJECT,
        sessionName: SESSION,
        worktreePath: WORKTREE,
        configuredServers: [{ name: "nextjs", command: "x" }],
      });

      const entry = registry.get(key("nextjs"));
      expect(entry!.status).toBe("starting");
      expect(classifyPortOwnership).not.toHaveBeenCalled();
    });
  });

  describe("explicit per-server scan hint", () => {
    it("uses scanHint passed on the configured server for custom (non-preset) entries", async () => {
      const adoptedPort = 4007;
      const { registry, deps, resolveScanStrategy } = bundle({
        classifyPortOwnership: async ({ port }) => {
          if (port === adoptedPort)
            return { status: "owned", pid: 7001, cwd: WORKTREE };
          return { status: "available" };
        },
        resolveScanStrategy: () => null,
      });

      const reconciler = createDevServerReconciler(deps);
      await reconciler.reconcile({
        projectPath: PROJECT,
        sessionName: SESSION,
        worktreePath: WORKTREE,
        configuredServers: [
          {
            name: "custom-api",
            command: "bun run dev -- --port $PORT",
            scanHint: { basePort: 4000, rangeSize: 50 },
          },
        ],
      });

      const entry = registry.get(key("custom-api"));
      expect(entry).toBeDefined();
      expect(entry!.status).toBe("running");
      expect(entry!.port).toBe(adoptedPort);
      expect(entry!.source).toBe("external-adopted");
      // Per-server hint must win — registry-level fallback should not be consulted.
      expect(resolveScanStrategy).not.toHaveBeenCalled();
    });

    it("does not adopt outside the explicit range even if an owned port exists later", async () => {
      const { registry, deps } = bundle({
        classifyPortOwnership: async ({ port }) => {
          if (port === 4500)
            return { status: "owned", pid: 7002, cwd: WORKTREE };
          return { status: "available" };
        },
        resolveScanStrategy: () => null,
      });

      const reconciler = createDevServerReconciler(deps);
      await reconciler.reconcile({
        projectPath: PROJECT,
        sessionName: SESSION,
        worktreePath: WORKTREE,
        configuredServers: [
          {
            name: "custom-api",
            command: "x",
            scanHint: { basePort: 4000, rangeSize: 50 },
          },
        ],
      });

      expect(registry.get(key("custom-api"))).toBeUndefined();
    });

    it("passes the per-server cwd through to classification as allowedCwd", async () => {
      const { deps, classifyPortOwnership } = bundle({
        classifyPortOwnership: async () => ({ status: "available" }),
        resolveScanStrategy: () => null,
      });

      const reconciler = createDevServerReconciler(deps);
      await reconciler.reconcile({
        projectPath: PROJECT,
        sessionName: SESSION,
        worktreePath: WORKTREE,
        configuredServers: [
          {
            name: "custom-api",
            command: "x",
            cwd: "apps/web",
            scanHint: { basePort: 4000, rangeSize: 2 },
          },
        ],
      });

      expect(classifyPortOwnership).toHaveBeenCalled();
      for (const [arg] of classifyPortOwnership.mock.calls) {
        expect(arg.allowedCwd).toBe("apps/web");
      }
    });
  });

  describe("stopped entries are eligible for adoption", () => {
    it("adopts an externally started server even when a stopped entry already exists", async () => {
      const adoptedPort = 3001;
      const { registry, deps } = bundle({
        classifyPortOwnership: async ({ port }) => {
          if (port === adoptedPort)
            return { status: "owned", pid: 7777, cwd: WORKTREE };
          return { status: "available" };
        },
        resolveScanStrategy: () => ({ basePort: 3000, rangeSize: 5 }),
      });
      registry.set(
        key("nextjs"),
        makeRunningEntry({
          status: "stopped",
          port: 3000,
          source: "cc-started",
          ownerPid: 99,
        }),
      );

      const reconciler = createDevServerReconciler(deps);
      await reconciler.reconcile({
        projectPath: PROJECT,
        sessionName: SESSION,
        worktreePath: WORKTREE,
        configuredServers: [{ name: "nextjs", command: "x" }],
      });

      const entry = registry.get(key("nextjs"));
      expect(entry!.status).toBe("running");
      expect(entry!.port).toBe(adoptedPort);
      expect(entry!.source).toBe("external-adopted");
      expect(entry!.ownerPid).toBe(7777);
    });
  });
});
