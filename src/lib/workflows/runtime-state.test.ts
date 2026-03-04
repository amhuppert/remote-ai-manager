import { describe, it, expect, beforeEach } from "vitest";
import {
  registerRuntime,
  getRuntime,
  cleanupRuntime,
  hasRuntime,
  getRegisteredKeys,
  workflowKey,
  _resetForTesting,
} from "./runtime-state";

beforeEach(() => {
  _resetForTesting();
});

describe("workflowKey", () => {
  it("produces a consistent key from project path and session name", () => {
    expect(workflowKey("/projects/foo", "session-1")).toBe(
      "/projects/foo::session-1",
    );
  });
});

describe("registerRuntime / getRuntime", () => {
  it("stores and retrieves runtime state", () => {
    const controller = new AbortController();
    const key = workflowKey("/proj", "sess");

    registerRuntime(key, { abortController: controller });

    const retrieved = getRuntime(key);
    expect(retrieved).toBeDefined();
    expect(retrieved!.abortController).toBe(controller);
  });

  it("returns undefined for unregistered keys", () => {
    expect(getRuntime("nonexistent")).toBeUndefined();
  });

  it("overwrites existing entries on re-registration", () => {
    const key = workflowKey("/proj", "sess");
    const first = new AbortController();
    const second = new AbortController();

    registerRuntime(key, { abortController: first });
    registerRuntime(key, { abortController: second });

    expect(getRuntime(key)!.abortController).toBe(second);
  });
});

describe("cleanupRuntime", () => {
  it("removes runtime state and aborts the controller", () => {
    const controller = new AbortController();
    const key = workflowKey("/proj", "sess");

    registerRuntime(key, { abortController: controller });
    cleanupRuntime(key);

    expect(hasRuntime(key)).toBe(false);
    expect(controller.signal.aborted).toBe(true);
  });

  it("calls releaseLock if provided", () => {
    let lockReleased = false;
    const key = workflowKey("/proj", "sess");

    registerRuntime(key, {
      abortController: new AbortController(),
      releaseLock: () => {
        lockReleased = true;
      },
    });

    cleanupRuntime(key);
    expect(lockReleased).toBe(true);
  });

  it("is a no-op for unknown keys", () => {
    // Should not throw
    cleanupRuntime("nonexistent");
  });
});

describe("hasRuntime", () => {
  it("returns true for registered keys", () => {
    const key = workflowKey("/proj", "sess");
    registerRuntime(key, { abortController: new AbortController() });

    expect(hasRuntime(key)).toBe(true);
  });

  it("returns false for unregistered keys", () => {
    expect(hasRuntime("nope")).toBe(false);
  });
});

describe("getRegisteredKeys", () => {
  it("returns all registered keys", () => {
    registerRuntime("a", { abortController: new AbortController() });
    registerRuntime("b", { abortController: new AbortController() });

    const keys = getRegisteredKeys();
    expect(keys).toContain("a");
    expect(keys).toContain("b");
    expect(keys).toHaveLength(2);
  });

  it("returns empty array when nothing registered", () => {
    expect(getRegisteredKeys()).toEqual([]);
  });
});
