import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registerSession,
  getSession,
  unregisterSession,
  closeAllSessions,
  _resetForTesting,
} from "./query-session-registry";

beforeEach(() => {
  _resetForTesting();
});

function makeFakeSession(overrides: Record<string, unknown> = {}) {
  return {
    status: "alive" as const,
    query: { streamInput: vi.fn() },
    close: vi.fn(),
    sendPrompt: vi.fn(),
    ...overrides,
  };
}

describe("query-session-registry", () => {
  it("getSession returns undefined when no session registered", () => {
    expect(getSession("conv-unknown")).toBeUndefined();
  });

  it("registerSession stores session, getSession retrieves it", () => {
    const session = makeFakeSession();
    registerSession("conv-1", session as never);
    expect(getSession("conv-1")).toBe(session);
  });

  it("unregisterSession removes the entry so getSession returns undefined", () => {
    const session = makeFakeSession();
    registerSession("conv-1", session as never);
    unregisterSession("conv-1");
    expect(getSession("conv-1")).toBeUndefined();
  });

  it("unregisterSession is idempotent for unknown ids", () => {
    expect(() => unregisterSession("conv-nonexistent")).not.toThrow();
  });

  it("registering a duplicate conversation ID overwrites the previous entry", () => {
    const session1 = makeFakeSession();
    const session2 = makeFakeSession();
    registerSession("conv-1", session1 as never);
    registerSession("conv-1", session2 as never);
    expect(getSession("conv-1")).toBe(session2);
  });

  it("closeAllSessions calls close on every registered session and clears the registry", () => {
    const s1 = makeFakeSession();
    const s2 = makeFakeSession();
    registerSession("conv-1", s1 as never);
    registerSession("conv-2", s2 as never);

    closeAllSessions();

    expect(s1.close).toHaveBeenCalledTimes(1);
    expect(s2.close).toHaveBeenCalledTimes(1);
    expect(getSession("conv-1")).toBeUndefined();
    expect(getSession("conv-2")).toBeUndefined();
  });

  it("different conversations have independent sessions", () => {
    const s1 = makeFakeSession();
    const s2 = makeFakeSession();
    registerSession("conv-a", s1 as never);
    registerSession("conv-b", s2 as never);

    expect(getSession("conv-a")).toBe(s1);
    expect(getSession("conv-b")).toBe(s2);

    unregisterSession("conv-a");
    expect(getSession("conv-a")).toBeUndefined();
    expect(getSession("conv-b")).toBe(s2);
  });
});
