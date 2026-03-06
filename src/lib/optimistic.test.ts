import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionState } from "@/types";
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
        name: "fix-login-bug 1",
        claudeSessionId: null,
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
        forkedFrom: null,
        role: null,
      },
    ],
    source: "cc",
    objective: "Fix the login bug",
    creationMode: "optimistic",
    tddEnabled: true,
    workflow: null,
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
    expect(promptText).toBe("Fix the login bug");
    expect(conversationId).toBe("conv-1");
    // Verify session has autonomous directive in objective
    expect(session.objective).toContain(
      "Complete the following task autonomously",
    );
    expect(session.objective).toContain("Fix the login bug");
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
    const originalObjective = session.objective;

    await executeOptimisticWorkflow({ ...baseParams, session }, deps);

    expect(session.objective).toBe(originalObjective);
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

  it("prepends autonomous directive to session objective", async () => {
    const deps = createTestDeps();
    await executeOptimisticWorkflow(baseParams, deps);

    const sessionArg = (deps.executePromptStream as ReturnType<typeof vi.fn>)
      .mock.calls[0]![1];
    expect(sessionArg.objective).toMatch(
      /^Complete the following task autonomously/,
    );
    expect(sessionArg.objective).toContain("Do not ask the user any questions");
    expect(sessionArg.objective).toContain("Begin work immediately");
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
