import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import type { SessionState } from "@/lib/sessions/schemas";

import { type ValidationService } from "./service";
import {
  _resetValidationServiceForTesting,
  _validationSingletonHostForTesting,
  createProductionValidationCallerResolver,
  initializeValidationServiceAtStartup,
  installValidationShutdownHooks,
} from "./singleton";
import type { SupervisedSeatWorkplace } from "@/lib/supervision/supervision";

afterEach(() => _resetValidationServiceForTesting());

const T = "2026-08-05T10:00:00.000Z";

function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionName: "session-1",
    worktreePath: "/repo/.worktrees/session-1",
    branchName: "csm/session-1",
    createdAt: T,
    lastActivityAt: T,
    archived: false,
    finished: false,
    conversations: [],
    source: "cc",
    creationMode: "normal",
    tddEnabled: true,
    targetBranch: "main",
    parentSessionName: null,
    referenceDocuments: [],
    ...overrides,
  };
}

describe("createProductionValidationCallerResolver", () => {
  const make = (workplace: SupervisedSeatWorkplace | null = null) =>
    createProductionValidationCallerResolver({
      seatWorkplace: async () => workplace,
      getSession: async () => session(),
      readRepoValidation: async () => null,
    });
  it("resolves a session caller to its session worktree", async () => {
    expect(
      await make().resolveCaller({
        projectPath: "/repo",
        sessionName: "session-1",
        conversationId: "c1",
      }),
    ).toMatchObject({
      kind: "session",
      worktreePath: "/repo/.worktrees/session-1",
      targetBranch: "main",
    });
  });
  it("resolves a project caller to the repo root", async () => {
    expect(
      await make().resolveCaller({
        projectPath: "/repo",
        conversationId: "c1",
      }),
    ).toMatchObject({ kind: "project", worktreePath: "/repo" });
  });
  it("keeps the run seat's frozen command access in its lane", async () => {
    const caller = make({
      projectPath: "/repo",
      sessionName: "session-1",
      contextId: "run.api",
      workplace: {
        kind: "current",
        runId: "run",
        role: "implementer",
        worktreePath: "/repo/lane",
        branch: "csm/lane",
        validationAccess: ["test"],
      },
    });
    expect(
      await caller.resolveCaller({
        projectPath: "/repo",
        sessionName: "session-1",
        conversationId: "seat",
      }),
    ).toMatchObject({
      kind: "run_seat",
      worktreePath: "/repo/lane",
      allowedCommands: ["test"],
      targetBranch: "csm/session-1",
    });
  });
});

describe("globalThis composition state", () => {
  it("survives module re-evaluation so HMR cannot construct a second service", async () => {
    vi.resetModules();
    const first = await import("./singleton");
    const firstHost = first._validationSingletonHostForTesting();

    vi.resetModules();
    const second = await import("./singleton");
    const secondHost = second._validationSingletonHostForTesting();

    expect(second).not.toBe(first);
    expect(secondHost).toBe(firstHost);
    expect(secondHost).toBe(_validationSingletonHostForTesting());
  });
});

function fakeProc() {
  const listeners = new Map<string, Array<() => void>>();
  const kills: Array<{ pid: number; signal: string }> = [];
  return {
    pid: 4321,
    kills,
    once(event: "SIGTERM" | "SIGINT", listener: () => void): unknown {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return this;
    },
    kill(pid: number, signal: NodeJS.Signals): unknown {
      kills.push({ pid, signal });
      return true;
    },
    listenerCount(event: string): number {
      return listeners.get(event)?.length ?? 0;
    },
    emit(event: string): void {
      const list = listeners.get(event) ?? [];
      listeners.set(event, []);
      for (const listener of list) listener();
    },
  };
}

function fakeService(overrides: Partial<ValidationService>): ValidationService {
  return {
    whenReady: async () => {},
    isAvailable: () => true,
    budget: async () => ({
      available: true,
      capacity: { limit: 8, inUse: 0, queueDepth: 0 },
      runs: [],
    }),
    submit: async () => ({
      kind: "invalid",
      reason: "service_unavailable",
      message: "fake",
    }),
    list: async () => ({
      kind: "invalid",
      reason: "service_unavailable",
      message: "fake",
    }),
    submitSystem: async () => ({
      kind: "invalid",
      reason: "service_unavailable",
      message: "fake",
    }),
    waitForCompletion: async (runId) => ({ kind: "cancelled", runId }),
    waitForStatusChange: async () => {},
    poll: () => ({
      status: null,
      position: null,
      result: null,
      requestedScope: null,
      effectiveScope: null,
    }),
    cancel: async () => ({ authorization: "not_found" }),
    cancelSystemOwned: async () => false,
    sweepExpiredLeases: async () => 0,
    shutdown: async () => {},
    ...overrides,
  };
}

describe("initializeValidationServiceAtStartup", () => {
  it("starts the sweep and installs shutdown hooks only after a successful recovery", async () => {
    const proc = fakeProc();
    await initializeValidationServiceAtStartup({
      service: fakeService({}),
      proc,
    });

    const host = _validationSingletonHostForTesting() as {
      sweepTimer: unknown;
      shutdownHooksInstalled: boolean;
    };
    expect(host.sweepTimer).not.toBeNull();
    expect(host.shutdownHooksInstalled).toBe(true);
    expect(proc.listenerCount("SIGTERM")).toBe(1);
  });

  it("starts no sweep and installs no hooks when recovery failed", async () => {
    const proc = fakeProc();
    await initializeValidationServiceAtStartup({
      service: fakeService({ isAvailable: () => false }),
      proc,
    });

    const host = _validationSingletonHostForTesting() as {
      sweepTimer: unknown;
      shutdownHooksInstalled: boolean;
    };
    // Retained rows belong to unverifiable groups; a sweep or shutdown pass
    // over them would terminalize rows without group death.
    expect(host.sweepTimer).toBeNull();
    expect(host.shutdownHooksInstalled).toBe(false);
    expect(proc.listenerCount("SIGTERM")).toBe(0);
    expect(proc.listenerCount("SIGINT")).toBe(0);
  });
});

describe("installValidationShutdownHooks", () => {
  it("shuts the service down before re-raising the signal, and installs only once", async () => {
    const proc = fakeProc();
    let resolveShutdown!: () => void;
    const shutdownCalls: string[] = [];
    const service = fakeService({
      shutdown: () => {
        shutdownCalls.push("shutdown");
        return new Promise<void>((resolve) => {
          resolveShutdown = resolve;
        });
      },
    });

    expect(installValidationShutdownHooks(service, proc)).toBe(true);
    // Module re-evaluation calls install again; it must not double-hook.
    expect(installValidationShutdownHooks(service, proc)).toBe(false);
    expect(proc.listenerCount("SIGTERM")).toBe(1);
    expect(proc.listenerCount("SIGINT")).toBe(1);

    proc.emit("SIGTERM");
    expect(shutdownCalls).toEqual(["shutdown"]);
    // The signal is not re-raised until graceful shutdown settles.
    expect(proc.kills).toEqual([]);

    resolveShutdown();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(proc.kills).toEqual([{ pid: 4321, signal: "SIGTERM" }]);
  });

  it("re-raises even when shutdown rejects", async () => {
    const proc = fakeProc();
    const service = fakeService({
      shutdown: async () => {
        throw new Error("boom");
      },
    });

    installValidationShutdownHooks(service, proc);
    proc.emit("SIGINT");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(proc.kills).toEqual([{ pid: 4321, signal: "SIGINT" }]);
  });
});
