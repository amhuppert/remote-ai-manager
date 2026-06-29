import { describe, it, expect, vi } from "vitest";
import {
  createDevServerReconciler,
  type DevServerReconciliationDeps,
} from "./reconciliation";
import type { PortOwnershipInput, PortOwnershipResult } from "./port-ownership";
import type { DevServerEntry } from "./registry";

const PROJECT = "/proj";
const SESSION = "s1";
const WORKTREE = "/tmp/wt";

function key(serverName: string): string {
  return `${PROJECT}::${SESSION}::${WORKTREE}::${serverName}`;
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
    ownedByThisSession: true,
    ownerPid: 1234,
    logFilePath: `${WORKTREE}/.cc/dev-server-logs/nextjs.log`,
    _process: null,
    _pid: 1234,
    _logStream: null,
    _stdoutRemainder: "",
    _stderrRemainder: "",
    ...overrides,
  };
}

interface DepsBundle {
  registry: Map<string, DevServerEntry>;
  deps: DevServerReconciliationDeps;
  classifyPortOwnership: ReturnType<
    typeof vi.fn<(input: PortOwnershipInput) => Promise<PortOwnershipResult>>
  >;
  broadcast: ReturnType<typeof vi.fn>;
}

function bundle(
  overrides: {
    classifyPortOwnership?: (
      input: PortOwnershipInput,
    ) => Promise<PortOwnershipResult>;
  } = {},
): DepsBundle {
  const registry = new Map<string, DevServerEntry>();
  const classifyPortOwnership = vi.fn<
    (input: PortOwnershipInput) => Promise<PortOwnershipResult>
  >(
    overrides.classifyPortOwnership ??
      (async () => ({ status: "available" }) as const),
  );
  const broadcast = vi.fn();
  const deps: DevServerReconciliationDeps = {
    classifyPortOwnership,
    broadcast,
    getRegistry: () => registry,
  };
  return {
    registry,
    deps,
    classifyPortOwnership,
    broadcast,
  };
}

describe("createDevServerReconciler.reconcile", () => {
  describe("no adoption of external listeners", () => {
    it("does NOT create a registry entry for an unmanaged listener in range", async () => {
      const { registry, deps, broadcast, classifyPortOwnership } = bundle({
        classifyPortOwnership: async () => ({
          status: "owned",
          pid: 5001,
          cwd: WORKTREE,
        }),
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

      expect(registry.get(key("nextjs"))).toBeUndefined();
      expect(broadcast).not.toHaveBeenCalled();
      // No port-ownership scan triggered when there's no existing entry.
      expect(classifyPortOwnership).not.toHaveBeenCalled();
    });
  });

  describe("stale registry handling", () => {
    it("transitions a running entry to stopped when its port is no longer alive", async () => {
      const { registry, deps, broadcast } = bundle({
        classifyPortOwnership: async () => ({ status: "available" }),
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
        expect.objectContaining({
          type: "dev-server-status",
          status: "stopped",
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
});
