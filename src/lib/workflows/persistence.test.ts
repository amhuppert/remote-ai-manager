import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  persistWorkflowSnapshot,
  restoreWorkflowSnapshot,
  setPersistenceDeps,
  _resetForTesting,
  type PersistenceDeps,
} from "./persistence";

// No vi.mock — use setPersistenceDeps for DI
const mockMutateSession = vi.fn();
const mockReadState = vi.fn();

const mockDeps: PersistenceDeps = {
  mutateSession: mockMutateSession,
  readState: mockReadState,
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetForTesting();
  setPersistenceDeps(mockDeps);
  vi.useFakeTimers();
});

afterEach(() => {
  _resetForTesting();
  vi.useRealTimers();
});

describe("persistWorkflowSnapshot", () => {
  const fakeSnapshot = {
    value: "running",
    context: { _schemaVersion: 1, projectPath: "/proj" },
    status: "active",
  };

  it("debounces writes by default", () => {
    persistWorkflowSnapshot("/proj", "sess", fakeSnapshot as never);

    // Not called yet (debounced)
    expect(mockMutateSession).not.toHaveBeenCalled();

    // Advance past debounce window
    vi.advanceTimersByTime(600);

    expect(mockMutateSession).toHaveBeenCalledOnce();
    expect(mockMutateSession).toHaveBeenCalledWith(
      "/proj",
      "sess",
      "persistWorkflowSnapshot",
      expect.any(Function),
    );
  });

  it("writes immediately when immediate option is set", () => {
    persistWorkflowSnapshot("/proj", "sess", fakeSnapshot as never, {
      immediate: true,
    });

    expect(mockMutateSession).toHaveBeenCalledOnce();
  });

  it("coalesces rapid calls into a single write", () => {
    persistWorkflowSnapshot("/proj", "sess", fakeSnapshot as never);
    persistWorkflowSnapshot("/proj", "sess", fakeSnapshot as never);
    persistWorkflowSnapshot("/proj", "sess", fakeSnapshot as never);

    vi.advanceTimersByTime(600);

    // Only the last write should have fired
    expect(mockMutateSession).toHaveBeenCalledOnce();
  });

  it("stores snapshot in session.workflow._xstateSnapshot via mutate callback", async () => {
    mockMutateSession.mockImplementation(
      async (_proj, _sess, _label, mutate) => {
        const session = {
          workflow: { status: "running" } as Record<string, unknown>,
        };
        await (mutate as (...args: unknown[]) => Promise<void>)(session, {});
        expect(session.workflow._xstateSnapshot).toBe(fakeSnapshot);
      },
    );

    persistWorkflowSnapshot("/proj", "sess", fakeSnapshot as never, {
      immediate: true,
    });

    // Let the async write complete
    await vi.advanceTimersByTimeAsync(0);
  });

  it("uses custom debounce time", () => {
    persistWorkflowSnapshot("/proj", "sess", fakeSnapshot as never, {
      debounceMs: 1000,
    });

    vi.advanceTimersByTime(600);
    expect(mockMutateSession).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(mockMutateSession).toHaveBeenCalledOnce();
  });
});

describe("restoreWorkflowSnapshot", () => {
  it("returns snapshot when found and schema version matches", async () => {
    const snapshot = {
      value: "running",
      context: { _schemaVersion: 1, projectPath: "/proj" },
    };

    mockReadState.mockResolvedValue({
      projects: {
        "/proj": {
          rootPath: "/proj",
          sessions: {
            sess: {
              sessionName: "sess",
              worktreePath: "/proj/.worktrees/sess",
              branchName: "csm/sess",
              createdAt: "2024-01-01",
              lastActivityAt: "2024-01-01",
              archived: false,
              finished: false,
              conversations: [],
              source: "cc",
              objective: null,
              creationMode: "fast",
              workflow: {
                _xstateSnapshot: snapshot,
                status: "running",
                objective: "test",
                fixPlan: [],
                config: {
                  maxIterations: 20,
                  iterationTimeoutMs: 3600000,
                  contextSoftLimitTokens: 160000,
                  contextHardLimitTokens: 180000,
                  circuitBreaker: {
                    noProgressThreshold: 3,
                    sameErrorThreshold: 5,
                  },
                },
                circuitBreaker: {
                  state: "closed",
                  consecutiveNoProgress: 0,
                  consecutiveSameError: 0,
                  lastErrorPattern: null,
                  lastProgressIteration: 0,
                },
                iterations: [],
                haltReason: null,
                generatingPlan: false,
                createdAt: "2024-01-01",
                startedAt: null,
                completedAt: null,
                totalCostUsd: 0,
                totalDurationMs: 0,
              } as never,
            },
          },
          roadmapItems: [],
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });

    const result = await restoreWorkflowSnapshot("/proj", "sess", 1);
    expect(result).toEqual(snapshot);
  });

  it("returns null when schema version mismatches", async () => {
    const snapshot = {
      value: "running",
      context: { _schemaVersion: 1 },
    };

    mockReadState.mockResolvedValue({
      projects: {
        "/proj": {
          rootPath: "/proj",
          sessions: {
            sess: {
              sessionName: "sess",
              worktreePath: "/w",
              branchName: "b",
              createdAt: "",
              lastActivityAt: "",
              archived: false,
              finished: false,
              conversations: [],
              source: "cc",
              objective: null,
              creationMode: "fast",
              workflow: { _xstateSnapshot: snapshot } as never,
            },
          },
          roadmapItems: [],
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });

    const result = await restoreWorkflowSnapshot("/proj", "sess", 2);
    expect(result).toBeNull();
  });

  it("returns null when project not found", async () => {
    mockReadState.mockResolvedValue({
      projects: {},
      archivedProjects: [],
      pinnedProjects: [],
    });

    const result = await restoreWorkflowSnapshot("/missing", "sess", 1);
    expect(result).toBeNull();
  });

  it("returns null when session has no workflow", async () => {
    mockReadState.mockResolvedValue({
      projects: {
        "/proj": {
          rootPath: "/proj",
          sessions: {
            sess: {
              sessionName: "sess",
              worktreePath: "/w",
              branchName: "b",
              createdAt: "",
              lastActivityAt: "",
              archived: false,
              finished: false,
              conversations: [],
              source: "cc",
              objective: null,
              creationMode: "fast",
              workflow: null,
            },
          },
          roadmapItems: [],
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });

    const result = await restoreWorkflowSnapshot("/proj", "sess", 1);
    expect(result).toBeNull();
  });

  it("returns null when no snapshot stored", async () => {
    mockReadState.mockResolvedValue({
      projects: {
        "/proj": {
          rootPath: "/proj",
          sessions: {
            sess: {
              sessionName: "sess",
              worktreePath: "/w",
              branchName: "b",
              createdAt: "",
              lastActivityAt: "",
              archived: false,
              finished: false,
              conversations: [],
              source: "cc",
              objective: null,
              creationMode: "fast",
              workflow: {
                status: "running",
                objective: "test",
                fixPlan: [],
                config: {} as never,
                circuitBreaker: {} as never,
                iterations: [],
                haltReason: null,
                generatingPlan: false,
                createdAt: "",
                startedAt: null,
                completedAt: null,
                totalCostUsd: 0,
                totalDurationMs: 0,
                currentIterationConversationId: null,
              },
            },
          },
          roadmapItems: [],
        },
      },
      archivedProjects: [],
      pinnedProjects: [],
    });

    const result = await restoreWorkflowSnapshot("/proj", "sess", 1);
    expect(result).toBeNull();
  });

  it("returns null and logs error on read failure", async () => {
    mockReadState.mockRejectedValue(new Error("disk error"));

    const result = await restoreWorkflowSnapshot("/proj", "sess", 1);
    expect(result).toBeNull();
  });
});
