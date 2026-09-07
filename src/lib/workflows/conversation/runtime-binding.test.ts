import { runtimeConfigurationFixture } from "./testing/runtime-configuration-fixture";
import { describe, expect, it, vi } from "vitest";
import { ManagedConversationRuntime } from "./runtime-binding";
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
