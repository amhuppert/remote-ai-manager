import { describe, it, expect, vi } from "vitest";
import {
  createTailscaleServeReconciler,
  type BackendReachableProbeResult,
} from "./tailscale-cleanup";
import type { TailscaleServeRegistration } from "../shared/tailscale";

interface DepOverrides {
  listServeRegistrations?: () => Promise<TailscaleServeRegistration[]>;
  probeBackendReachable?: (
    port: number,
  ) => Promise<BackendReachableProbeResult>;
  unregisterServe?: (port: number) => Promise<void>;
  tailscaleEnabled?: () => Promise<boolean>;
}

function makeDeps(overrides: DepOverrides = {}) {
  return {
    listServeRegistrations: vi
      .fn<() => Promise<TailscaleServeRegistration[]>>()
      .mockResolvedValue([]),
    probeBackendReachable: vi
      .fn<(port: number) => Promise<BackendReachableProbeResult>>()
      .mockResolvedValue({ reachable: false, reason: "ECONNREFUSED" }),
    unregisterServe: vi
      .fn<(port: number) => Promise<void>>()
      .mockResolvedValue(undefined),
    tailscaleEnabled: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    ...overrides,
  };
}

describe("TailscaleServeReconciler.reconcileOrphans", () => {
  it("unregisters CC-shaped serve entries whose backend is unreachable", async () => {
    const deps = makeDeps({
      listServeRegistrations: vi.fn().mockResolvedValue([
        { port: 3001, proxyTarget: "http://localhost:3001" },
        { port: 6007, proxyTarget: "http://localhost:6007" },
      ]),
      probeBackendReachable: vi
        .fn()
        .mockResolvedValue({ reachable: false, reason: "ECONNREFUSED" }),
    });

    const reconciler = createTailscaleServeReconciler(deps);
    const result = await reconciler.reconcileOrphans();

    expect(deps.unregisterServe).toHaveBeenCalledWith(3001);
    expect(deps.unregisterServe).toHaveBeenCalledWith(6007);
    expect(result.removed.sort()).toEqual([3001, 6007]);
    expect(result.retained).toEqual([]);
  });

  it("retains entries whose backend is reachable — the live happy path", async () => {
    const deps = makeDeps({
      listServeRegistrations: vi
        .fn()
        .mockResolvedValue([
          { port: 3001, proxyTarget: "http://localhost:3001" },
        ]),
      probeBackendReachable: vi.fn().mockResolvedValue({ reachable: true }),
    });

    const reconciler = createTailscaleServeReconciler(deps);
    const result = await reconciler.reconcileOrphans();

    expect(deps.unregisterServe).not.toHaveBeenCalled();
    expect(result.removed).toEqual([]);
    expect(result.retained).toEqual([3001]);
  });

  it("does nothing when tailscale is disabled (avoids touching user-owned serves)", async () => {
    const deps = makeDeps({
      tailscaleEnabled: vi.fn().mockResolvedValue(false),
      listServeRegistrations: vi
        .fn()
        .mockResolvedValue([
          { port: 3001, proxyTarget: "http://localhost:3001" },
        ]),
    });

    const reconciler = createTailscaleServeReconciler(deps);
    const result = await reconciler.reconcileOrphans();

    expect(deps.listServeRegistrations).not.toHaveBeenCalled();
    expect(deps.unregisterServe).not.toHaveBeenCalled();
    expect(result.skipped).toBe("disabled");
  });

  it("returns empty result when no serve entries exist", async () => {
    const deps = makeDeps({
      listServeRegistrations: vi.fn().mockResolvedValue([]),
    });

    const reconciler = createTailscaleServeReconciler(deps);
    const result = await reconciler.reconcileOrphans();

    expect(deps.probeBackendReachable).not.toHaveBeenCalled();
    expect(deps.unregisterServe).not.toHaveBeenCalled();
    expect(result.removed).toEqual([]);
    expect(result.retained).toEqual([]);
  });

  it("processes each entry independently — a failed unregister does not block the rest", async () => {
    const deps = makeDeps({
      listServeRegistrations: vi.fn().mockResolvedValue([
        { port: 3001, proxyTarget: "http://localhost:3001" },
        { port: 6007, proxyTarget: "http://localhost:6007" },
      ]),
      probeBackendReachable: vi
        .fn()
        .mockResolvedValue({ reachable: false, reason: "ECONNREFUSED" }),
      unregisterServe: vi.fn().mockImplementation(async (port: number) => {
        if (port === 3001) throw new Error("CLI broke");
      }),
    });

    const reconciler = createTailscaleServeReconciler(deps);
    const result = await reconciler.reconcileOrphans();

    expect(deps.unregisterServe).toHaveBeenCalledWith(3001);
    expect(deps.unregisterServe).toHaveBeenCalledWith(6007);
    // Only the successful removal is reported; the failed one falls into retained
    // so the caller knows reconciliation didn't fully clear the port.
    expect(result.removed).toEqual([6007]);
    expect(result.retained).toEqual([3001]);
  });
});
