import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { sessionStateSchema } from "@/lib/sessions/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type { TaskRunResult } from "@/lib/workflows/conversation/execute-workflow-task-run";
import {
  createConversationCommandService,
  type ConversationCommandDeps,
  type RunCommandInput,
} from "./service";

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return sessionStateSchema.parse({
    sessionName: "my-session",
    worktreePath: "/tmp/worktrees/my-session",
    branchName: "csm/my-session",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

const emptyUsage = {
  costUsd: null,
  durationMs: null,
  contextTokens: null,
  contextWindowMax: null,
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
};

const structuredResult: TaskRunResult = {
  kind: "structured",
  structuredOutput: { message: "Add eligibility checks" },
  text: "",
  usage: emptyUsage,
  backendRef: null,
};

function makeDeps(
  overrides: Partial<ConversationCommandDeps> = {},
): ConversationCommandDeps {
  return {
    getSession: vi.fn(async () => makeSession()),
    hasActiveJob: vi.fn(() => false),
    hasUncommittedChanges: vi.fn(async () => true),
    collectChangeSummary: vi.fn(async () => " M src/index.ts"),
    resolveMergeTarget: vi.fn(async () => ({
      targetBranch: "main",
      targetWorktreePath: null,
    })),
    executeWorkflowTaskRun: vi.fn(async () => structuredResult),
    dispatchCommitJob: vi.fn(() => ({
      ok: true as const,
      value: { jobId: "job-commit-1" },
    })),
    dispatchMergeJob: vi.fn(() => ({
      ok: true as const,
      value: { jobId: "job-merge-1" },
    })),
    appendNotice: vi.fn(async () => {}),
    ...overrides,
  };
}

function makeInput(overrides: Partial<RunCommandInput> = {}): RunCommandInput {
  return {
    projectPath: "/tmp/projects/demo",
    projectName: "demo",
    sessionName: "my-session",
    conversationId: "conv-1",
    parsed: { command: "commit", hint: "" },
    ...overrides,
  };
}

function expectNoAgentOrDispatch(deps: ConversationCommandDeps): void {
  expect(deps.executeWorkflowTaskRun).not.toHaveBeenCalled();
  expect(deps.dispatchCommitJob).not.toHaveBeenCalled();
  expect(deps.dispatchMergeJob).not.toHaveBeenCalled();
}

describe("createConversationCommandService eligibility matrix", () => {
  describe.each(["commit", "merge"] as const)("/%s", (command) => {
    it("rejects with no-session when the conversation has no session worktree", async () => {
      const deps = makeDeps();
      const service = createConversationCommandService(deps);

      const outcome = await service.run(
        makeInput({ sessionName: null, parsed: { command, hint: "" } }),
      );

      expect(outcome).toEqual({ status: "rejected", reason: "no-session" });
      expect(deps.getSession).not.toHaveBeenCalled();
      expect(deps.appendNotice).toHaveBeenCalledTimes(1);
      expect(vi.mocked(deps.appendNotice).mock.calls[0]?.[0]?.text).toMatch(
        /no session worktree/i,
      );
      expectNoAgentOrDispatch(deps);
    });

    it("rejects with no-session when the session lookup fails", async () => {
      const deps = makeDeps({ getSession: vi.fn(async () => null) });
      const service = createConversationCommandService(deps);

      const outcome = await service.run(
        makeInput({ parsed: { command, hint: "" } }),
      );

      expect(outcome).toEqual({ status: "rejected", reason: "no-session" });
      expect(deps.appendNotice).toHaveBeenCalledTimes(1);
      expectNoAgentOrDispatch(deps);
    });

    it("rejects with session-finished for a finished session", async () => {
      const deps = makeDeps({
        getSession: vi.fn(async () => makeSession({ finished: true })),
      });
      const service = createConversationCommandService(deps);

      const outcome = await service.run(
        makeInput({ parsed: { command, hint: "" } }),
      );

      expect(outcome).toEqual({
        status: "rejected",
        reason: "session-finished",
      });
      expect(deps.appendNotice).toHaveBeenCalledTimes(1);
      expect(vi.mocked(deps.appendNotice).mock.calls[0]?.[0]?.text).toMatch(
        /finished/i,
      );
      expectNoAgentOrDispatch(deps);
    });

    it("rejects with job-active when a background job is already running", async () => {
      const deps = makeDeps({ hasActiveJob: vi.fn(() => true) });
      const service = createConversationCommandService(deps);

      const outcome = await service.run(
        makeInput({ parsed: { command, hint: "" } }),
      );

      expect(outcome).toEqual({ status: "rejected", reason: "job-active" });
      expect(deps.appendNotice).toHaveBeenCalledTimes(1);
      expect(vi.mocked(deps.appendNotice).mock.calls[0]?.[0]?.text).toMatch(
        /already running/i,
      );
      expectNoAgentOrDispatch(deps);
    });

    it("checks finished before active job (ordering)", async () => {
      const deps = makeDeps({
        getSession: vi.fn(async () => makeSession({ finished: true })),
        hasActiveJob: vi.fn(() => true),
      });
      const service = createConversationCommandService(deps);

      const outcome = await service.run(
        makeInput({ parsed: { command, hint: "" } }),
      );

      expect(outcome).toEqual({
        status: "rejected",
        reason: "session-finished",
      });
      expect(deps.hasActiveJob).not.toHaveBeenCalled();
    });
  });

  it("rejects /commit with no-changes when the worktree is clean", async () => {
    const deps = makeDeps({
      hasUncommittedChanges: vi.fn(async () => false),
    });
    const service = createConversationCommandService(deps);

    const outcome = await service.run(
      makeInput({ parsed: { command: "commit", hint: "" } }),
    );

    expect(outcome).toEqual({ status: "rejected", reason: "no-changes" });
    expect(deps.appendNotice).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.appendNotice).mock.calls[0]?.[0]?.text).toMatch(
      /no uncommitted changes/i,
    );
    expectNoAgentOrDispatch(deps);
  });

  it("does not require uncommitted changes for /merge", async () => {
    const deps = makeDeps({
      hasUncommittedChanges: vi.fn(async () => false),
    });
    const service = createConversationCommandService(deps);

    const outcome = await service.run(
      makeInput({ parsed: { command: "merge", hint: "" } }),
    );

    expect(outcome).toEqual({
      status: "dispatched",
      jobId: "job-merge-1",
      usedFallback: false,
    });
    expect(deps.hasUncommittedChanges).not.toHaveBeenCalled();
  });

  it("checks active job before uncommitted changes for /commit (ordering)", async () => {
    const deps = makeDeps({
      hasActiveJob: vi.fn(() => true),
      hasUncommittedChanges: vi.fn(async () => false),
    });
    const service = createConversationCommandService(deps);

    const outcome = await service.run(
      makeInput({ parsed: { command: "commit", hint: "" } }),
    );

    expect(outcome).toEqual({ status: "rejected", reason: "job-active" });
    expect(deps.hasUncommittedChanges).not.toHaveBeenCalled();
  });

  it("addresses rejection notices to the originating conversation", async () => {
    const deps = makeDeps({ hasActiveJob: vi.fn(() => true) });
    const service = createConversationCommandService(deps);

    await service.run(makeInput({ parsed: { command: "commit", hint: "" } }));

    expect(deps.appendNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: "conv-1",
        projectName: "demo",
        sessionName: "my-session",
      }),
    );
  });
});

describe("createConversationCommandService eligible path", () => {
  it("dispatches a commit job with the generated message", async () => {
    const deps = makeDeps();
    const service = createConversationCommandService(deps);

    const outcome = await service.run(
      makeInput({ parsed: { command: "commit", hint: "focus on API" } }),
    );

    expect(outcome).toEqual({
      status: "dispatched",
      jobId: "job-commit-1",
      usedFallback: false,
    });
    expect(deps.executeWorkflowTaskRun).toHaveBeenCalledTimes(1);
    expect(deps.dispatchCommitJob).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: "/tmp/projects/demo",
        projectName: "demo",
        sessionName: "my-session",
        worktreePath: "/tmp/worktrees/my-session",
        branchName: "csm/my-session",
        message: "Add eligibility checks",
        targetBranch: "main",
      }),
    );
    expect(deps.dispatchMergeJob).not.toHaveBeenCalled();
    expect(deps.appendNotice).not.toHaveBeenCalled();
  });

  it("dispatches a merge job with autoResolve and the resolved target", async () => {
    const deps = makeDeps({
      resolveMergeTarget: vi.fn(async () => ({
        targetBranch: "csm/parent",
        targetWorktreePath: "/tmp/worktrees/parent",
      })),
    });
    const service = createConversationCommandService(deps);

    const outcome = await service.run(
      makeInput({ parsed: { command: "merge", hint: "" } }),
    );

    expect(outcome).toEqual({
      status: "dispatched",
      jobId: "job-merge-1",
      usedFallback: false,
    });
    expect(deps.dispatchMergeJob).toHaveBeenCalledWith(
      expect.objectContaining({
        autoResolve: true,
        targetBranch: "csm/parent",
        targetWorktreePath: "/tmp/worktrees/parent",
        message: "Add eligibility checks",
      }),
    );
    expect(deps.dispatchCommitJob).not.toHaveBeenCalled();
  });

  it("runs the generation turn in the same conversation with the structured-output contract, hint, and change summary", async () => {
    const deps = makeDeps({
      collectChangeSummary: vi.fn(async () => " M src/api/routes.ts"),
    });
    const service = createConversationCommandService(deps);

    await service.run(
      makeInput({ parsed: { command: "commit", hint: "focus on API" } }),
    );

    expect(deps.executeWorkflowTaskRun).toHaveBeenCalledTimes(1);
    const taskRunInput = vi.mocked(deps.executeWorkflowTaskRun).mock
      .calls[0]?.[0];
    expect(taskRunInput).toMatchObject({
      projectPath: "/tmp/projects/demo",
      sessionName: "my-session",
      conversationId: "conv-1",
      kind: "task_run",
      outputFormat: { type: "json_schema", schema: expect.any(Object) },
    });
    expect(taskRunInput?.prompt).toContain("focus on API");
    expect(taskRunInput?.prompt).toContain(" M src/api/routes.ts");
  });

  it("resolves the message before dispatching (generation precedes any git operation)", async () => {
    const deps = makeDeps();
    const service = createConversationCommandService(deps);

    await service.run(makeInput({ parsed: { command: "commit", hint: "" } }));

    const generationOrder = vi.mocked(deps.executeWorkflowTaskRun).mock
      .invocationCallOrder[0];
    const dispatchOrder = vi.mocked(deps.dispatchCommitJob).mock
      .invocationCallOrder[0];
    expect(generationOrder).toBeDefined();
    expect(dispatchOrder).toBeDefined();
    expect(generationOrder!).toBeLessThan(dispatchOrder!);
  });

  it("falls back to the default message and appends a notice when generation fails", async () => {
    const deps = makeDeps({
      executeWorkflowTaskRun: vi.fn(async () => ({
        kind: "error" as const,
        error: "backend unreachable",
        aborted: false,
        usage: emptyUsage,
        backendRef: null,
      })),
    });
    const service = createConversationCommandService(deps);

    const outcome = await service.run(
      makeInput({ parsed: { command: "commit", hint: "" } }),
    );

    expect(outcome).toEqual({
      status: "dispatched",
      jobId: "job-commit-1",
      usedFallback: true,
    });
    expect(deps.dispatchCommitJob).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Changes from session my-session" }),
    );
    expect(deps.appendNotice).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.appendNotice).mock.calls[0]?.[0]?.text).toMatch(
      /default/i,
    );
  });

  it("falls back to the default message when the generation turn throws", async () => {
    const deps = makeDeps({
      executeWorkflowTaskRun: vi.fn(async () => {
        throw new Error("conversation lock unavailable");
      }),
    });
    const service = createConversationCommandService(deps);

    const outcome = await service.run(
      makeInput({ parsed: { command: "commit", hint: "" } }),
    );

    expect(outcome).toEqual({
      status: "dispatched",
      jobId: "job-commit-1",
      usedFallback: true,
    });
    expect(deps.dispatchCommitJob).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Changes from session my-session" }),
    );
    expect(deps.appendNotice).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.appendNotice).mock.calls[0]?.[0]?.text).toMatch(
      /default/i,
    );
  });

  it("falls back without a generation turn when collecting the change summary throws", async () => {
    const deps = makeDeps({
      collectChangeSummary: vi.fn(async () => {
        throw new Error("git diff failed");
      }),
    });
    const service = createConversationCommandService(deps);

    const outcome = await service.run(
      makeInput({ parsed: { command: "commit", hint: "" } }),
    );

    expect(outcome).toEqual({
      status: "dispatched",
      jobId: "job-commit-1",
      usedFallback: true,
    });
    expect(deps.executeWorkflowTaskRun).not.toHaveBeenCalled();
    expect(deps.dispatchCommitJob).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Changes from session my-session" }),
    );
    expect(deps.appendNotice).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.appendNotice).mock.calls[0]?.[0]?.text).toMatch(
      /default/i,
    );
  });

  it("rejects /merge with dispatch-failed when the merge target cannot be resolved", async () => {
    const deps = makeDeps({
      resolveMergeTarget: vi.fn(async () => {
        throw new Error("target branch missing");
      }),
    });
    const service = createConversationCommandService(deps);

    const outcome = await service.run(
      makeInput({ parsed: { command: "merge", hint: "" } }),
    );

    expect(outcome).toEqual({
      status: "rejected",
      reason: "dispatch-failed",
    });
    expect(deps.executeWorkflowTaskRun).not.toHaveBeenCalled();
    expect(deps.dispatchMergeJob).not.toHaveBeenCalled();
    expect(deps.appendNotice).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.appendNotice).mock.calls[0]?.[0]?.text).toMatch(
      /merge target/i,
    );
  });

  it("rejects with dispatch-failed and appends a notice when dispatch loses the race", async () => {
    const deps = makeDeps({
      dispatchCommitJob: vi.fn(() => ({
        ok: false as const,
        error: "JOB_ALREADY_RUNNING" as const,
      })),
    });
    const service = createConversationCommandService(deps);

    const outcome = await service.run(
      makeInput({ parsed: { command: "commit", hint: "" } }),
    );

    expect(outcome).toEqual({
      status: "rejected",
      reason: "dispatch-failed",
    });
    expect(deps.appendNotice).toHaveBeenCalledTimes(1);
  });
});

describe("rejection notice SSE scoping", () => {
  it("uses noticeSessionName for the no-session notice so project-scoped clients receive the broadcast", async () => {
    const deps = makeDeps();
    const service = createConversationCommandService(deps);

    await service.run(
      makeInput({
        sessionName: null,
        noticeSessionName: "__project__",
        parsed: { command: "commit", hint: "" },
      }),
    );

    expect(deps.appendNotice).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.appendNotice).mock.calls[0]?.[0]?.sessionName).toBe(
      "__project__",
    );
  });

  it("falls back to an empty sessionName when no scope info is available", async () => {
    const deps = makeDeps();
    const service = createConversationCommandService(deps);

    await service.run(
      makeInput({ sessionName: null, parsed: { command: "merge", hint: "" } }),
    );

    expect(vi.mocked(deps.appendNotice).mock.calls[0]?.[0]?.sessionName).toBe(
      "",
    );
  });
});
