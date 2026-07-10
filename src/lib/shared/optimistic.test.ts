import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionState } from "@/lib/sessions/schemas";
import { executeOptimisticWorkflow, type OptimisticDeps } from "./optimistic";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionName: "fix-login-bug",
    worktreePath: "/projects/repo/.worktrees/fix-login-bug",
    branchName: "csm/fix-login-bug",
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    archived: false,
    finished: false,
    conversations: [
      {
        id: "conv-1",
        scope: "session",
        name: "fix-login-bug 1",
        transcriptPath: null,
        status: "new",
        promptCount: 0,
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
        source: "cc",
        summary: null,
        archived: false,
        totalCostUsd: null,
        totalDurationMs: null,
        totalTurns: null,
        pendingQuestionId: null,
        pendingQuestions: null,
        pendingPromptText: null,
        forkedFrom: null,
        role: null,
        activeTurnSource: null,
        contextTokens: null,
        contextWindowMax: null,
        debugMode: null,
        machineSnapshot: null,
        agentBackend: "claude" as const,
        backendRef: null,
        unread: false,
        lastSeenAlignmentVersion: null,
        pendingAgentNotices: [],
        pendingQueue: [],
      },
    ],
    source: "cc",
    creationMode: "optimistic",
    tddEnabled: true,
    targetBranch: "main",
    parentSessionName: null,
    graphWorkflowExecution: null,
    referenceDocuments: [],
    ...overrides,
  };
}

function createTestDeps(
  overrides: Partial<OptimisticDeps> = {},
): OptimisticDeps {
  return {
    executePromptStream: vi
      .fn()
      .mockResolvedValue({ conversationId: "conv-1" }),
    dispatchMergeJob: vi
      .fn()
      .mockReturnValue({ ok: true, value: { jobId: "job-1" } }),
    createNotification: vi.fn(),
    ...overrides,
  };
}

const baseParams = {
  projectPath: "/projects/repo",
  projectName: "repo",
  session: makeSession(),
  instructions: "Fix the login bug",
};

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.useRealTimers();
});

// ===========================================================================
// Tests
// ===========================================================================

describe("executeOptimisticWorkflow", () => {
  it("calls executePromptStream with the session's first conversation", async () => {
    const deps = createTestDeps();
    await executeOptimisticWorkflow(baseParams, deps);

    expect(deps.executePromptStream).toHaveBeenCalledTimes(1);
    const [projectPath, session, promptText, emit, conversationId] = (
      deps.executePromptStream as ReturnType<typeof vi.fn>
    ).mock.calls[0]!;
    expect(projectPath).toBe("/projects/repo");
    expect(conversationId).toBe("conv-1");
    // The autonomous directive now rides on the prompt, not a session objective
    expect(promptText).toContain("Complete the following task autonomously");
    expect(promptText).toContain("Fix the login bug");
    // The session is passed through plain (no objective field)
    expect(session.sessionName).toBe("fix-login-bug");
    // emit should be a function (no-op)
    expect(typeof emit).toBe("function");
  });

  it("passes autonomous: true option to executePromptStream", async () => {
    const deps = createTestDeps();
    await executeOptimisticWorkflow(baseParams, deps);

    const args = (deps.executePromptStream as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    // 8th argument (index 7) should be the options object with autonomous flag
    const options = args[7];
    expect(options).toEqual({ autonomous: true });
  });

  it("does not mutate the original session object", async () => {
    const deps = createTestDeps();
    const session = makeSession();
    const snapshot = structuredClone(session);

    await executeOptimisticWorkflow({ ...baseParams, session }, deps);

    expect(session).toEqual(snapshot);
  });

  it("dispatches merge job with autoResolve on successful prompt", async () => {
    const deps = createTestDeps();
    await executeOptimisticWorkflow(baseParams, deps);

    expect(deps.dispatchMergeJob).toHaveBeenCalledTimes(1);
    expect(deps.dispatchMergeJob).toHaveBeenCalledWith({
      projectPath: "/projects/repo",
      projectName: "repo",
      sessionName: "fix-login-bug",
      worktreePath: "/projects/repo/.worktrees/fix-login-bug",
      branchName: "csm/fix-login-bug",
      message: "Optimistic: Fix the login bug",
      autoResolve: true,
      targetBranch: "main",
    });
  });

  it("creates failure notification when prompt execution fails", async () => {
    const deps = createTestDeps({
      executePromptStream: vi
        .fn()
        .mockRejectedValue(new Error("SDK connection error")),
    });

    await executeOptimisticWorkflow(baseParams, deps);

    expect(deps.dispatchMergeJob).not.toHaveBeenCalled();
    expect(deps.createNotification).toHaveBeenCalledTimes(1);
    expect(deps.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "merge-failed",
        title: "Optimistic task failed",
        message: expect.stringContaining("SDK connection error"),
        projectName: "repo",
        sessionName: "fix-login-bug",
        branchName: "csm/fix-login-bug",
      }),
    );
  });

  it("never throws even when prompt execution fails", async () => {
    const deps = createTestDeps({
      executePromptStream: vi
        .fn()
        .mockRejectedValue(new Error("catastrophic error")),
    });

    // Should not throw
    await expect(
      executeOptimisticWorkflow(baseParams, deps),
    ).resolves.toBeUndefined();
  });

  it("never throws even when notification creation fails", async () => {
    const deps = createTestDeps({
      executePromptStream: vi.fn().mockRejectedValue(new Error("prompt error")),
      createNotification: vi.fn().mockImplementation(() => {
        throw new Error("DB error");
      }),
    });

    await expect(
      executeOptimisticWorkflow(baseParams, deps),
    ).resolves.toBeUndefined();
  });

  it("does not dispatch merge when prompt fails", async () => {
    const deps = createTestDeps({
      executePromptStream: vi.fn().mockRejectedValue(new Error("timeout")),
    });

    await executeOptimisticWorkflow(baseParams, deps);

    expect(deps.dispatchMergeJob).not.toHaveBeenCalled();
  });

  it("prepends autonomous directive to the kickoff prompt", async () => {
    const deps = createTestDeps();
    await executeOptimisticWorkflow(baseParams, deps);

    const promptArg = (deps.executePromptStream as ReturnType<typeof vi.fn>)
      .mock.calls[0]![2];
    expect(promptArg).toMatch(/^Complete the following task autonomously/);
    expect(promptArg).toContain("Do not ask the user any questions");
    expect(promptArg).toContain("Begin work immediately");
    expect(promptArg).toContain("Fix the login bug");
  });

  it("uses no-op emitter that does not throw", async () => {
    const deps = createTestDeps();
    await executeOptimisticWorkflow(baseParams, deps);

    const emit = (deps.executePromptStream as ReturnType<typeof vi.fn>).mock
      .calls[0]![3];
    // Calling the emitter should be safe (no-op)
    expect(() => emit("any-event", { data: "test" })).not.toThrow();
  });
});
