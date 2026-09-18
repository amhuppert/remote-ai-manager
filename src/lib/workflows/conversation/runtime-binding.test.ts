import { runtimeConfigurationFixture } from "./testing/runtime-configuration-fixture";
import { describe, expect, it, vi } from "vitest";
import { ManagedConversationRuntime } from "./runtime-binding";
import { createExternalTurnHandler } from "./external-turn-handler";
import { createMockBackendRuntime } from "./testing/actor-deps-fixture";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(close: () => Promise<void>) {
  const owner = new ManagedConversationRuntime("conv-1");
  const index = new Map<string, ReturnType<typeof createMockBackendRuntime>>();
  const backend = createMockBackendRuntime({ close });
  const incarnation = owner.beginCreation();
  const configuration = runtimeConfigurationFixture({ alignmentVersion: 4 });
  owner.install(incarnation, backend, configuration, {
    register: (id, value) => {
      index.set(id, value);
    },
    unregister: (id, value) => {
      if (index.get(id) === value) index.delete(id);
    },
  });
  return { owner, index, backend, incarnation, configuration };
}

describe("managed conversation backend lifetime", () => {
  it("awaits capture receipts without treating them as unrelated activity", async () => {
    const f = fixture(async () => {});
    const receipt = deferred();
    const epoch = f.owner.activityEpoch;
    f.owner.trackCaptureReceipt("capture", "capture:1", receipt.promise);
    expect(f.owner.hasTrackedWork).toBe(true);
    expect(f.owner.activityEpoch).toBe(epoch);
    let settled = false;
    let closed = false;
    const settling = f.owner.settleOwnedWork().then(() => {
      settled = true;
    });
    const closing = f.owner.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(closed).toBe(false);
    expect(f.index.get("conv-1")).toBe(f.backend);
    receipt.resolve();
    await Promise.all([settling, closing]);
    expect(f.owner.hasTrackedWork).toBe(false);
    expect(f.owner.activityEpoch).toBe(epoch);
  });

  it("retains capture receipt failure across settlement and close retries", async () => {
    const f = fixture(async () => {});
    await expect(
      f.owner.trackCaptureReceipt(
        "capture",
        "capture:2",
        Promise.reject(new Error("disk failed")),
      ),
    ).rejects.toThrow("disk failed");
    await expect(f.owner.settleOwnedWork()).rejects.toThrow("capture:2");
    await expect(f.owner.close()).rejects.toThrow("capture:2");
    f.owner.reconcileClose();
    await expect(f.owner.close()).rejects.toThrow("capture:2");
    expect(f.owner.backend).toBe(f.backend);
    expect(f.index.get("conv-1")).toBe(f.backend);
  });

  it("a successful capture receipt retry clears only its own failure", async () => {
    const f = fixture(async () => {});
    for (const id of ["first", "second"])
      await expect(
        f.owner.trackCaptureReceipt(
          "capture",
          id,
          Promise.reject(new Error(id)),
        ),
      ).rejects.toThrow(id);
    await f.owner.trackCaptureReceipt("capture", "first", Promise.resolve());
    await expect(f.owner.settleOwnedWork()).rejects.toThrow("second");
    await f.owner.trackCaptureReceipt("capture", "second", Promise.resolve());
    await expect(f.owner.settleOwnedWork()).resolves.toBeUndefined();
    f.owner.recordCleanupFailure({
      kind: "cleanup_unverified",
      message: "ordinary cleanup remains unknown",
    });
    await expect(f.owner.close()).rejects.toThrow(
      "ordinary cleanup remains unknown",
    );
  });

  it("awaits receipts appended after the backend already closed", async () => {
    const f = fixture(async () => {});
    await f.owner.close();
    const receipt = deferred();
    f.owner.trackCaptureReceipt("capture", "capture:3", receipt.promise);
    let closed = false;
    const closing = f.owner.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);
    receipt.resolve();
    await closing;
  });

  it("retains cleanup ownership despite close success, reconciliation, and attempted replacement", async () => {
    const close = vi.fn(async () => {});
    const f = fixture(close);
    const failure = {
      kind: "cleanup_unverified",
      message: "Inspect surviving commands; protection ends at restart.",
    } as const;
    f.owner.recordCleanupFailure(failure);
    expect(f.owner.cleanupFailure).toEqual(failure);
    expect(f.owner.recordCleanupFailure(failure)).toBe(false);
    await expect(f.owner.close()).rejects.toThrow("Inspect surviving commands");
    expect(close).toHaveBeenCalledTimes(1);
    expect(f.owner.backend).toBe(f.backend);
    expect(f.index.get("conv-1")).toBe(f.backend);
    f.owner.reconcileClose();
    await expect(f.owner.close()).rejects.toThrow("Inspect surviving commands");
    expect(close).toHaveBeenCalledTimes(2);
    expect(() => f.owner.beginCreation()).toThrow("Inspect surviving commands");
    expect(() =>
      f.owner.install(f.incarnation, f.backend, f.configuration, {
        register() {},
        unregister() {},
      }),
    ).toThrow("Inspect surviving commands");
    expect(f.owner.backend).toBe(f.backend);
  });

  it("joins concurrent closes and keeps the handle indexed until owned work drains", async () => {
    const shutdown = deferred();
    const effect = deferred();
    const close = vi.fn(() => shutdown.promise);
    const f = fixture(close);
    f.owner.track(effect.promise);
    let settled = false;
    const first = f.owner.close();
    const second = f.owner.close();
    void first.then(() => {
      settled = true;
    });
    expect(second).toBe(first);
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
    shutdown.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(f.index.get("conv-1")).toBe(f.backend);
    expect(f.owner.configurationSnapshot?.alignmentVersion).toBe(4);
    effect.resolve();
    await first;
    expect(f.owner.backend).toBeUndefined();
    expect(f.owner.configurationSnapshot).toBeUndefined();
    expect(f.index.size).toBe(0);
    expect(f.owner.isCurrent(f.incarnation)).toBe(false);
  });

  it("holds an immutable copy of creation configuration and exposes detached reads", async () => {
    const f = fixture(async () => {});
    f.configuration.modelSelection.parameters["effort"] = "low";
    const read = f.owner.configurationSnapshot;
    if (!read) throw new Error("Missing managed configuration");
    read.modelSelection.parameters["effort"] = "medium";
    expect(
      f.owner.configurationSnapshot?.modelSelection.parameters["effort"],
    ).toBe("high");
    await f.owner.close();
  });

  it("reports external turn activity and an activity epoch from the installed handler", () => {
    const owner = new ManagedConversationRuntime("conv-1");
    const handler = createExternalTurnHandler(
      { conversationId: "conv-1" },
      { sendToMachine: () => {} },
      { safeAppendTranscriptEntry: async () => {} },
    );
    owner.install(
      owner.beginCreation(),
      createMockBackendRuntime(),
      runtimeConfigurationFixture({ alignmentVersion: 1 }),
      { register() {}, unregister() {} },
      handler,
    );
    expect(owner.externalTurnActive).toBe(false);
    const before = owner.activityEpoch;

    handler({ type: "external_turn_started" });
    expect(owner.externalTurnActive).toBe(true);
    expect(owner.activityEpoch).toBe(before + 1);

    void owner.track(Promise.resolve());
    expect(owner.activityEpoch).toBe(before + 2);
  });

  it("settles the external turn promise through the installed handler, and immediately without one", async () => {
    const owner = new ManagedConversationRuntime("conv-1");
    await expect(owner.externalTurnSettled()).resolves.toBeUndefined();
    const handler = createExternalTurnHandler(
      { conversationId: "conv-1" },
      { sendToMachine: () => {} },
      { safeAppendTranscriptEntry: async () => {} },
    );
    owner.install(
      owner.beginCreation(),
      createMockBackendRuntime(),
      runtimeConfigurationFixture({ alignmentVersion: 1 }),
      { register() {}, unregister() {} },
      handler,
    );
    handler({ type: "external_turn_started" });
    let settled = false;
    void owner.externalTurnSettled().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    await owner.close();
    await Promise.resolve();
    expect(settled).toBe(true);
    expect(owner.externalTurnActive).toBe(false);
  });

  it("retains a failed close and retries only through reconciliation", async () => {
    let fail = true;
    const close = vi.fn(async () => {
      if (fail) throw new Error("worker still alive");
    });
    const f = fixture(close);
    await expect(f.owner.close()).rejects.toThrow("worker still alive");
    await expect(f.owner.close()).rejects.toThrow("worker still alive");
    expect(close).toHaveBeenCalledTimes(1);
    expect(f.owner.backend).toBe(f.backend);
    expect(f.owner.configurationSnapshot?.alignmentVersion).toBe(4);
    fail = false;
    f.owner.reconcileClose();
    await f.owner.close();
    expect(close).toHaveBeenCalledTimes(2);
    expect(f.index.size).toBe(0);
  });
});
