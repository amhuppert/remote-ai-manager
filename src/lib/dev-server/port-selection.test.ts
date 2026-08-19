import { describe, it, expect, vi } from "vitest";
import {
  createPortSelectionService,
  type PortSelectionDeps,
} from "./port-selection";
import {
  createPortOwnershipService,
  type PortOwnershipInput,
  type PortOwnershipResult,
  type PortOwnershipDeps,
  type ScanRangeMatch,
} from "./port-ownership";

type ClassifyFn = (input: PortOwnershipInput) => Promise<PortOwnershipResult>;

function classifyByMap(map: Record<number, PortOwnershipResult>): ClassifyFn {
  return async ({ port }) => {
    const result = map[port];
    if (!result) return { status: "available" };
    return result;
  };
}

/**
 * Deps whose batched scan and per-port classification agree, as the production
 * port-ownership service's two entry points do: the scan reports the lowest
 * in-range listener the map marks as owned by this worktree.
 */
function depsFrom(map: Record<number, PortOwnershipResult>): PortSelectionDeps {
  return {
    classifyPort: vi.fn(classifyByMap(map)),
    findOwnedListenerInRange: vi.fn(
      async ({ basePort, rangeSize }): Promise<ScanRangeMatch> => {
        for (let offset = 0; offset < rangeSize; offset++) {
          const port = basePort + offset;
          const result = map[port];
          if (result?.status === "owned") {
            return { status: "owned", port, pid: result.pid, cwd: result.cwd };
          }
        }
        return { status: "none" };
      },
    ),
  };
}

describe("createPortSelectionService.selectPort", () => {
  describe("unmanaged listener detection", () => {
    it("returns unmanaged-detected when an owned listener exists in range", async () => {
      const deps = depsFrom({
        3000: { status: "available" },
        3001: { status: "available" },
        3002: { status: "available" },
        3003: { status: "available" },
        3004: { status: "owned", pid: 555, cwd: "/wt" },
      });
      const service = createPortSelectionService(deps);

      const result = await service.selectPort({
        basePort: 3000,
        worktreePath: "/wt",
      });

      expect(result).toEqual({
        status: "unmanaged-detected",
        port: 3004,
        pid: 555,
        cwd: "/wt",
      });
    });

    it("returns the lowest owned port when multiple owned ports exist", async () => {
      const deps = depsFrom({
        3000: { status: "conflict", pid: 1, cwd: "/other" },
        3002: { status: "owned", pid: 2, cwd: "/wt" },
        3005: { status: "owned", pid: 3, cwd: "/wt" },
      });
      const service = createPortSelectionService(deps);

      const result = await service.selectPort({
        basePort: 3000,
        worktreePath: "/wt",
      });

      expect(result.status).toBe("unmanaged-detected");
      if (result.status === "unmanaged-detected") {
        expect(result.port).toBe(3002);
        expect(result.pid).toBe(2);
      }
    });

    it("ignores other-worktree conflicts when reporting unmanaged listener", async () => {
      const deps = depsFrom({
        3000: { status: "conflict", pid: 100, cwd: "/other" },
        3001: { status: "available" },
        3002: { status: "available" },
        3003: { status: "available" },
        3004: { status: "owned", pid: 200, cwd: "/wt/app" },
      });
      const service = createPortSelectionService(deps);

      const result = await service.selectPort({
        basePort: 3000,
        worktreePath: "/wt",
      });

      expect(result.status).toBe("unmanaged-detected");
      if (result.status === "unmanaged-detected") {
        expect(result.port).toBe(3004);
        expect(result.cwd).toBe("/wt/app");
      }
    });
  });

  describe("available-port fallback", () => {
    it("selects the first available port when no owned port exists", async () => {
      const deps = depsFrom({
        3000: { status: "conflict", pid: 1, cwd: "/other" },
        3001: { status: "available" },
      });
      const service = createPortSelectionService(deps);

      const result = await service.selectPort({
        basePort: 3000,
        worktreePath: "/wt",
      });

      expect(result).toEqual({
        status: "selected",
        port: 3001,
      });
    });

    it("selects the base port when it is free and nothing is owned", async () => {
      const deps = depsFrom({});
      const service = createPortSelectionService(deps);

      const result = await service.selectPort({
        basePort: 3000,
        worktreePath: "/wt",
      });

      expect(result).toEqual({
        status: "selected",
        port: 3000,
      });
    });

    it("does not select a port whose ownership is unknown", async () => {
      const deps = depsFrom({
        3000: { status: "unknown", reason: "cwd_unresolved" },
        3001: { status: "available" },
      });
      const service = createPortSelectionService(deps);

      const result = await service.selectPort({
        basePort: 3000,
        worktreePath: "/wt",
      });

      expect(result.status).toBe("selected");
      if (result.status === "selected") {
        expect(result.port).toBe(3001);
      }
    });
  });

  describe("exhaustion", () => {
    it("returns exhausted with diagnostics when every port in range is unavailable", async () => {
      const conflicts: Record<number, PortOwnershipResult> = {};
      for (let p = 3000; p < 3000 + 5; p++) {
        conflicts[p] = { status: "conflict", pid: p, cwd: `/other/${p}` };
      }
      const deps = depsFrom(conflicts);
      const service = createPortSelectionService(deps);

      const result = await service.selectPort({
        basePort: 3000,
        worktreePath: "/wt",
        maxAttempts: 5,
      });

      expect(result.status).toBe("exhausted");
      if (result.status === "exhausted") {
        expect(result.diagnostics).toHaveLength(5);
        expect(result.diagnostics[0]).toMatchObject({
          port: 3000,
          status: "conflict",
        });
        expect(result.diagnostics[4]).toMatchObject({
          port: 3004,
          status: "conflict",
        });
      }
    });

    it("treats only unknown listeners as exhausted with reasons captured", async () => {
      const unknowns: Record<number, PortOwnershipResult> = {};
      for (let p = 3000; p < 3000 + 3; p++) {
        unknowns[p] = { status: "unknown", reason: "cwd_unresolved" };
      }
      const deps = depsFrom(unknowns);
      const service = createPortSelectionService(deps);

      const result = await service.selectPort({
        basePort: 3000,
        worktreePath: "/wt",
        maxAttempts: 3,
      });

      expect(result.status).toBe("exhausted");
      if (result.status === "exhausted") {
        expect(result.diagnostics).toHaveLength(3);
        for (const d of result.diagnostics) {
          expect(d.status).toBe("unknown");
          expect(d.reason).toBe("cwd_unresolved");
        }
      }
    });
  });

  describe("passes allowedCwd through to ownership classification", () => {
    it("forwards allowedCwd on every check", async () => {
      const classify = vi.fn<PortSelectionDeps["classifyPort"]>(
        async () => ({ status: "available" }) as const,
      );
      const scan = vi.fn<PortSelectionDeps["findOwnedListenerInRange"]>(
        async () => ({ status: "none" }) as const,
      );
      const deps: PortSelectionDeps = {
        classifyPort: classify,
        findOwnedListenerInRange: scan,
      };
      const service = createPortSelectionService(deps);

      await service.selectPort({
        basePort: 3000,
        worktreePath: "/wt",
        allowedCwd: "/custom/app",
        maxAttempts: 2,
      });

      expect(classify.mock.calls.length).toBeGreaterThan(0);
      for (const [arg] of classify.mock.calls) {
        expect(arg.allowedCwd).toBe("/custom/app");
        expect(arg.worktreePath).toBe("/wt");
      }
      expect(scan).toHaveBeenCalledWith({
        basePort: 3000,
        rangeSize: 2,
        worktreePath: "/wt",
        allowedCwd: "/custom/app",
      });
    });
  });

  describe("cost of selecting a port", () => {
    it("classifies at most a couple of ports when the base port is free", async () => {
      let calls = 0;
      const deps: PortSelectionDeps = {
        classifyPort: async () => {
          calls++;
          return { status: "available" };
        },
        findOwnedListenerInRange: async () => ({ status: "none" }),
      };
      const service = createPortSelectionService(deps);

      const result = await service.selectPort({
        basePort: 3000,
        worktreePath: "/w",
        maxAttempts: 100,
      });

      // Each classification spawns `lsof`/`ss` (~75ms). Selecting a free base
      // port must cost a bounded number of them, not one per port in range.
      expect(result).toEqual({ status: "selected", port: 3000 });
      expect(calls).toBeLessThanOrEqual(2);
    });

    it("selects the base port when the only in-range listener belongs to another worktree", async () => {
      const deps = depsFrom({
        3040: { status: "conflict", pid: 900, cwd: "/elsewhere" },
      });
      const service = createPortSelectionService(deps);

      const result = await service.selectPort({
        basePort: 3000,
        worktreePath: "/wt",
        maxAttempts: 100,
      });

      expect(result).toEqual({ status: "selected", port: 3000 });
    });

    it("bind-probes the port it selects", async () => {
      const probed: number[] = [];
      const ownershipDeps: PortOwnershipDeps = {
        listListeningPids: async () => [],
        listAllListeningPorts: async () => new Map(),
        getProcessCwd: async () => null,
        realpath: async (p) => p,
        probePortBindable: async (port) => {
          probed.push(port);
          return { bindable: true };
        },
      };
      const ownership = createPortOwnershipService(ownershipDeps);
      const service = createPortSelectionService({
        classifyPort: ownership.classifyPort,
        findOwnedListenerInRange: ownership.findOwnedListenerInRange,
      });

      const result = await service.selectPort({
        basePort: 3000,
        worktreePath: "/wt",
        maxAttempts: 100,
      });

      // The bind probe is the only signal that catches root-owned listeners
      // (tailscaled under `tailscale serve`) that `lsof` cannot see, so the
      // selected port must still be probed — and only it.
      expect(result).toEqual({ status: "selected", port: 3000 });
      expect(probed).toEqual([3000]);
    });
  });
});
