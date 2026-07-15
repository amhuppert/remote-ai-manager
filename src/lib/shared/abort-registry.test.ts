import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  _resetAbortRegistryForTesting,
  abortHandle,
  getAbortHandle,
  registerAbortHandle,
  releaseAbortHandle,
  unregisterAbortHandle,
} from "./abort-registry";

afterEach(() => {
  _resetAbortRegistryForTesting();
});

describe("shared abort registry", () => {
  it("registers and retrieves a controller by scoped key", () => {
    const controller = new AbortController();
    registerAbortHandle("conversation:c1", controller);
    expect(getAbortHandle("conversation:c1")).toBe(controller);
    expect(getAbortHandle("conversation:other")).toBeNull();
  });

  it("scopes are independent namespaces — the same id under two scopes holds two handles", () => {
    const conversation = new AbortController();
    const run = new AbortController();
    registerAbortHandle("conversation:x", conversation);
    registerAbortHandle("agent-run:x", run);
    expect(getAbortHandle("conversation:x")).toBe(conversation);
    expect(getAbortHandle("agent-run:x")).toBe(run);
  });

  it("abortHandle aborts and removes a live controller, reporting true", () => {
    const controller = new AbortController();
    registerAbortHandle("workflow:w1", controller);

    expect(abortHandle("workflow:w1")).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(getAbortHandle("workflow:w1")).toBeNull();
  });

  it("abortHandle reports false when no controller is registered", () => {
    expect(abortHandle("workflow:none")).toBe(false);
  });

  it("unregisterAbortHandle is compare-and-delete: a stale controller cannot strip a replacement", () => {
    const stale = new AbortController();
    const replacement = new AbortController();
    registerAbortHandle("conversation:c1", stale);
    registerAbortHandle("conversation:c1", replacement);

    expect(unregisterAbortHandle("conversation:c1", stale)).toBe(false);
    expect(getAbortHandle("conversation:c1")).toBe(replacement);

    expect(unregisterAbortHandle("conversation:c1", replacement)).toBe(true);
    expect(getAbortHandle("conversation:c1")).toBeNull();
  });

  it("releaseAbortHandle removes without aborting", () => {
    const controller = new AbortController();
    registerAbortHandle("agent-run:r1", controller);

    releaseAbortHandle("agent-run:r1");

    expect(controller.signal.aborted).toBe(false);
    expect(getAbortHandle("agent-run:r1")).toBeNull();
  });

  it("an aborted-but-retained handle stays observable until released (collab stop pattern)", () => {
    const controller = new AbortController();
    registerAbortHandle("workflow:w2", controller);

    // Signal without removing — the slice observes the aborted signal between
    // rounds through the still-registered handle.
    getAbortHandle("workflow:w2")?.abort();

    expect(getAbortHandle("workflow:w2")?.signal.aborted).toBe(true);
    releaseAbortHandle("workflow:w2");
    expect(getAbortHandle("workflow:w2")).toBeNull();
  });
});
