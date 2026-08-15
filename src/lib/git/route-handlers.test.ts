import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGitRouteHandlers, type GitRouteDeps } from "./route-handlers";
import { sessionStateSchema, type SessionState } from "@/lib/sessions/schemas";
import type { BackgroundJob } from "@/lib/jobs/schemas";
import type { SessionDiff } from "./schemas";

const EMPTY_DIFF: SessionDiff = {
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
};

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return sessionStateSchema.parse({
    sessionName: "s1",
    worktreePath: "/repo/.worktrees/s1",
    branchName: "csm/s1",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
}

function makeJob(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    jobId: "job-1",
    jobType: "merge",
    status: "ready-to-land",
    projectName: "proj",
    sessionName: "s1",
    branchName: "csm/s1",
    startedAt: "2026-01-01T00:00:00.000Z",
    parkedRef: "refs/cc-merges/job-1",
    preparedSha: "prepared-sha",
    expectedTargetSha: "target-sha",
    resolutionContext: "intent notes",
    executionId: "workflow-execution-1",
    finalPublish: true,
    // Every merge-family dispatch stamps this, so a job a re-entry route reads
    // back carries it too.
    finalizeSessionOnPublish: true,
    candidateValidation: {
      validationRef: "validation-1",
      validatedSha: "validated-sha",
      validatedTreeHash: "validated-tree",
      commandIdentity: "./validate.sh",
      outcome: "pass",
    },
    ...overrides,
  };
}

function routeContext(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function postRequest(body: unknown): Request {
  return new Request("http://cc.test/api", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeDeps(overrides: Partial<GitRouteDeps> = {}): GitRouteDeps {
  return {
    resolveProjectPath: vi.fn().mockResolvedValue("/repo"),
    getSession: vi.fn().mockResolvedValue(makeSession()),
    getActiveGraphWorkflowExecution: vi.fn().mockResolvedValue(null),
    computeDiff: vi.fn().mockResolvedValue(EMPTY_DIFF),
    getCommitLog: vi.fn().mockResolvedValue([]),
    getCommitDiff: vi.fn().mockResolvedValue(EMPTY_DIFF),
    resolveMergeTarget: vi
      .fn()
      .mockResolvedValue({ targetBranch: "main", targetWorktreePath: null }),
    dispatchCommitJob: vi
      .fn()
      .mockReturnValue({ ok: true, value: { jobId: "job-1" } }),
    dispatchMergeJob: vi
      .fn()
      .mockReturnValue({ ok: true, value: { jobId: "job-1" } }),
    dispatchResolveConflictsJob: vi
      .fn()
      .mockReturnValue({ ok: true, value: { jobId: "job-1" } }),
    getJob: vi.fn().mockReturnValue(undefined),
    gitClient: {
      git: vi.fn().mockResolvedValue({ stdout: "prepared-sha\n", stderr: "" }),
    },
    ...overrides,
  };
}

const sessionParams = { name: "proj", session: "s1" };

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("getSessionDiff", () => {
  it("404s when the project is unknown", async () => {
    const deps = makeDeps({
      resolveProjectPath: vi.fn().mockResolvedValue(null),
    });
    const handlers = createGitRouteHandlers(deps);
    const res = await handlers.getSessionDiff(
      new Request("http://cc.test"),
      routeContext(sessionParams),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Project not found" });
  });

  it("404s when the session is unknown", async () => {
    const deps = makeDeps({ getSession: vi.fn().mockResolvedValue(null) });
    const handlers = createGitRouteHandlers(deps);
    const res = await handlers.getSessionDiff(
      new Request("http://cc.test"),
      routeContext(sessionParams),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Session not found" });
  });

  it("returns the computed diff for the session worktree", async () => {
    const diff: SessionDiff = {
      files: [{ filePath: "a.txt", additions: 1, deletions: 0, hunks: [] }],
      totalAdditions: 1,
      totalDeletions: 0,
    };
    const computeDiff = vi.fn().mockResolvedValue(diff);
    const handlers = createGitRouteHandlers(makeDeps({ computeDiff }));
    const res = await handlers.getSessionDiff(
      new Request("http://cc.test"),
      routeContext(sessionParams),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(diff);
    expect(computeDiff).toHaveBeenCalledWith("/repo/.worktrees/s1");
  });

  it("500s with the error message when the diff fails", async () => {
    const handlers = createGitRouteHandlers(
      makeDeps({ computeDiff: vi.fn().mockRejectedValue(new Error("boom")) }),
    );
    const res = await handlers.getSessionDiff(
      new Request("http://cc.test"),
      routeContext(sessionParams),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "boom" });
  });
});

describe("getMainWorktreeDiff", () => {
  it("404s when the project is unknown", async () => {
    const handlers = createGitRouteHandlers(
      makeDeps({ resolveProjectPath: vi.fn().mockResolvedValue(null) }),
    );
    const res = await handlers.getMainWorktreeDiff(
      new Request("http://cc.test"),
      routeContext({ name: "proj" }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Project not found" });
  });

  it("diffs the project root worktree", async () => {
    const computeDiff = vi.fn().mockResolvedValue(EMPTY_DIFF);
    const handlers = createGitRouteHandlers(makeDeps({ computeDiff }));
    const res = await handlers.getMainWorktreeDiff(
      new Request("http://cc.test"),
      routeContext({ name: "proj" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(EMPTY_DIFF);
    expect(computeDiff).toHaveBeenCalledWith("/repo");
  });
});

describe("listSessionCommits", () => {
  it("returns the commit log for the session's target branch", async () => {
    const commits = [{ hash: "abc" }];
    const getCommitLog = vi.fn().mockResolvedValue(commits);
    const handlers = createGitRouteHandlers(makeDeps({ getCommitLog }));
    const res = await handlers.listSessionCommits(
      new Request("http://cc.test"),
      routeContext(sessionParams),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ commits });
    expect(getCommitLog).toHaveBeenCalledWith("/repo/.worktrees/s1", "main");
  });

  it("500s with a fallback message on non-Error failure", async () => {
    const handlers = createGitRouteHandlers(
      makeDeps({ getCommitLog: vi.fn().mockRejectedValue("nope") }),
    );
    const res = await handlers.listSessionCommits(
      new Request("http://cc.test"),
      routeContext(sessionParams),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Failed to fetch commits" });
  });
});

describe("getSessionCommitDiff", () => {
  it("400s when the commit hash is missing", async () => {
    const handlers = createGitRouteHandlers(makeDeps());
    const res = await handlers.getSessionCommitDiff(
      new Request("http://cc.test"),
      routeContext(sessionParams),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Commit hash is required" });
  });

  it("returns the per-commit diff", async () => {
    const getCommitDiff = vi.fn().mockResolvedValue(EMPTY_DIFF);
    const handlers = createGitRouteHandlers(makeDeps({ getCommitDiff }));
    const res = await handlers.getSessionCommitDiff(
      new Request("http://cc.test"),
      routeContext({ ...sessionParams, hash: "abc123" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(EMPTY_DIFF);
    expect(getCommitDiff).toHaveBeenCalledWith(
      "/repo/.worktrees/s1",
      "abc123",
      "main",
    );
  });
});

describe("commitSession", () => {
  it("400s on an invalid body", async () => {
    const handlers = createGitRouteHandlers(makeDeps());
    const res = await handlers.commitSession(
      postRequest({}),
      routeContext(sessionParams),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "Commit message is required",
    });
  });

  it("409s for a finished session", async () => {
    const handlers = createGitRouteHandlers(
      makeDeps({
        getSession: vi.fn().mockResolvedValue(makeSession({ finished: true })),
      }),
    );
    const res = await handlers.commitSession(
      postRequest({ message: "msg" }),
      routeContext(sessionParams),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Session is finished and read-only",
      code: "SESSION_FINISHED",
    });
  });

  it("dispatches the commit job and returns 202", async () => {
    const dispatchCommitJob = vi
      .fn()
      .mockReturnValue({ ok: true, value: { jobId: "job-9" } });
    const handlers = createGitRouteHandlers(makeDeps({ dispatchCommitJob }));
    const res = await handlers.commitSession(
      postRequest({ message: "commit msg" }),
      routeContext(sessionParams),
    );
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({
      jobId: "job-9",
      jobType: "commit",
      branchName: "csm/s1",
    });
    expect(typeof body.startedAt).toBe("string");
    expect(dispatchCommitJob).toHaveBeenCalledWith({
      projectPath: "/repo",
      projectName: "proj",
      sessionName: "s1",
      worktreePath: "/repo/.worktrees/s1",
      branchName: "csm/s1",
      message: "commit msg",
      targetBranch: "main",
    });
  });

  it("409s when the session is busy", async () => {
    const handlers = createGitRouteHandlers(
      makeDeps({
        dispatchCommitJob: vi
          .fn()
          .mockReturnValue({ ok: false, error: "SESSION_BUSY" }),
      }),
    );
    const res = await handlers.commitSession(
      postRequest({ message: "msg" }),
      routeContext(sessionParams),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Session is busy",
      code: "SESSION_BUSY",
    });
  });
});

describe("mergeSession", () => {
  /**
   * Session delivery follows the lease (R13). The route's advisory check is the
   * first of two — the publish actor repeats it under the project lock — so what
   * it must get right is exactly which runs block and what act clears them.
   *
   * The blockers below are the runs that still hold the session's lease; each
   * one names the canonical remedy for its own state, because a refusal that
   * tells an operator to "complete" a halted run names an act that state does
   * not admit.
   */
  const RESUMABLE_HALT = {
    type: "circuit_breaker",
    contextId: "context-implement",
    condition: "retry_exhaustion",
    summary: null,
  } as const;
  const NON_RESUMABLE_HALT = {
    type: "recovery_error",
    message: "unrecoverable",
  } as const;

  /**
   * Exactly the record the gate reads, taken from the dependency signature —
   * every lease-relevant field is spelled out on every row. A partial fixture
   * would let `abandonment: undefined` read as "abandoned" and quietly turn a
   * blocking case green.
   */
  type DeliveryRecord = NonNullable<
    Awaited<ReturnType<GitRouteDeps["getActiveGraphWorkflowExecution"]>>
  >;

  function activeRecord(
    overrides: Partial<DeliveryRecord> & Pick<DeliveryRecord, "status">,
  ): DeliveryRecord {
    return {
      id: "execution-1",
      haltReason: null,
      abandonment: null,
      definitionApproval: null,
      ...overrides,
    };
  }

  const blockers = [
    {
      label: "running",
      execution: activeRecord({ status: "running" }),
      remedy: "inspect_or_pause",
      sentence: "Complete or abort it before merging this session.",
    },
    {
      label: "resumably halted",
      execution: activeRecord({
        status: "halted",
        haltReason: RESUMABLE_HALT,
      }),
      remedy: "resume_or_abandon",
      sentence: "Resume or abandon it before merging this session.",
    },
  ] as const;

  for (const blocker of blockers) {
    it(`refuses the merge while a ${blocker.label} execution holds the lease, naming its remedy`, async () => {
      const dispatchMergeJob = vi
        .fn()
        .mockReturnValue({ ok: true, value: { jobId: "job-2" } });
      const deps = makeDeps({
        dispatchMergeJob,
        getActiveGraphWorkflowExecution: vi
          .fn()
          .mockResolvedValue(blocker.execution),
      });
      const handlers = createGitRouteHandlers(deps);

      const res = await handlers.mergeSession(
        postRequest({ autoResolve: true }),
        routeContext(sessionParams),
      );

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: `Graph workflow execution execution-1 is ${blocker.execution.status}. ${blocker.sentence}`,
        code: "GRAPH_WORKFLOW_ACTIVE",
        details: {
          executionId: "execution-1",
          status: blocker.execution.status,
          remedy: blocker.remedy,
        },
      });
      expect(dispatchMergeJob).not.toHaveBeenCalled();
    });
  }

  /**
   * History never blocks delivery (R13.2), including the halts a status-only
   * gate refused forever with no act available to clear them.
   */
  const historical = [
    { label: "completed", execution: activeRecord({ status: "completed" }) },
    { label: "aborted", execution: activeRecord({ status: "aborted" }) },
    {
      label: "non-resumably halted",
      execution: activeRecord({
        status: "halted",
        haltReason: NON_RESUMABLE_HALT,
      }),
    },
    {
      label: "abandoned resumable halt",
      execution: activeRecord({
        status: "halted",
        haltReason: RESUMABLE_HALT,
        abandonment: {
          abandonedAt: "2026-01-02T00:00:00Z",
          actor: { kind: "human" },
          reason: "superseded",
        },
      }),
    },
  ] as const;

  for (const run of historical) {
    it(`admits the merge once the ${run.label} execution has released the lease`, async () => {
      const dispatchMergeJob = vi
        .fn()
        .mockReturnValue({ ok: true, value: { jobId: "job-2" } });
      const handlers = createGitRouteHandlers(
        makeDeps({
          dispatchMergeJob,
          getActiveGraphWorkflowExecution: vi
            .fn()
            .mockResolvedValue(run.execution),
        }),
      );

      const res = await handlers.mergeSession(
        postRequest({ autoResolve: true }),
        routeContext(sessionParams),
      );

      expect(res.status).toBe(202);
      expect(dispatchMergeJob).toHaveBeenCalled();
    });
  }

  it("admits the merge after the blocking halted run is abandoned", async () => {
    // R13.1 end to end: the same run, before and after the abandon act.
    const halted = activeRecord({
      status: "halted",
      haltReason: RESUMABLE_HALT,
    });
    const dispatchMergeJob = vi
      .fn()
      .mockReturnValue({ ok: true, value: { jobId: "job-2" } });
    const getActiveGraphWorkflowExecution = vi
      .fn()
      .mockResolvedValueOnce(halted)
      .mockResolvedValueOnce({
        ...halted,
        abandonment: {
          abandonedAt: "2026-01-02T00:00:00Z",
          actor: { kind: "human" },
          reason: "superseded",
        },
      });
    const handlers = createGitRouteHandlers(
      makeDeps({ dispatchMergeJob, getActiveGraphWorkflowExecution }),
    );

    const refused = await handlers.mergeSession(
      postRequest({ autoResolve: true }),
      routeContext(sessionParams),
    );
    expect(refused.status).toBe(409);
    expect((await refused.json()).details.executionId).toBe("execution-1");
    expect(dispatchMergeJob).not.toHaveBeenCalled();

    const admitted = await handlers.mergeSession(
      postRequest({ autoResolve: true }),
      routeContext(sessionParams),
    );
    expect(admitted.status).toBe(202);
    expect(dispatchMergeJob).toHaveBeenCalledTimes(1);
  });

  it("400s on an invalid body", async () => {
    const handlers = createGitRouteHandlers(makeDeps());
    const res = await handlers.mergeSession(
      postRequest({}),
      routeContext(sessionParams),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "autoResolve flag is required",
    });
  });

  it("dispatches the merge job toward the resolved target", async () => {
    const dispatchMergeJob = vi
      .fn()
      .mockReturnValue({ ok: true, value: { jobId: "job-2" } });
    const resolveMergeTarget = vi.fn().mockResolvedValue({
      targetBranch: "csm/parent",
      targetWorktreePath: "/repo/.worktrees/parent",
    });
    const handlers = createGitRouteHandlers(
      makeDeps({ dispatchMergeJob, resolveMergeTarget }),
    );
    const res = await handlers.mergeSession(
      postRequest({ autoResolve: true }),
      routeContext(sessionParams),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      jobId: "job-2",
      jobType: "merge",
      branchName: "csm/s1",
    });
    expect(dispatchMergeJob).toHaveBeenCalledWith({
      projectPath: "/repo",
      projectName: "proj",
      sessionName: "s1",
      worktreePath: "/repo/.worktrees/s1",
      branchName: "csm/s1",
      message: "Merge csm/s1 into csm/parent",
      autoResolve: true,
      targetBranch: "csm/parent",
      targetWorktreePath: "/repo/.worktrees/parent",
    });
  });

  it("409s when a job is already running", async () => {
    const handlers = createGitRouteHandlers(
      makeDeps({
        dispatchMergeJob: vi
          .fn()
          .mockReturnValue({ ok: false, error: "JOB_ALREADY_RUNNING" }),
      }),
    );
    const res = await handlers.mergeSession(
      postRequest({ autoResolve: false }),
      routeContext(sessionParams),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "A job is already running for this session",
      code: "JOB_ALREADY_RUNNING",
    });
  });

  it("renders a merge-association refusal with the structured refusal envelope", async () => {
    const reason =
      "Session hosts spec execution spec-exec-1 in definition review; the delivery gate cannot evaluate it.";
    const instruction =
      "Start the execution or abandon it in Spec Studio, then retry the merge.";
    const handlers = createGitRouteHandlers(
      makeDeps({
        dispatchMergeJob: vi.fn().mockReturnValue({
          ok: false,
          error: { code: "MERGE_ASSOCIATION_REFUSED", reason, instruction },
        }),
      }),
    );
    const res = await handlers.mergeSession(
      postRequest({ autoResolve: false }),
      routeContext(sessionParams),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: reason,
      code: "MERGE_ASSOCIATION_REFUSED",
      unmetConditions: [reason],
      instruction,
    });
  });
});

describe("resolveSessionConflicts", () => {
  it("400s on an invalid body", async () => {
    const handlers = createGitRouteHandlers(makeDeps());
    const res = await handlers.resolveSessionConflicts(
      postRequest({ decisions: "not-an-array" }),
      routeContext(sessionParams),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid request body" });
  });

  it("dispatches with decisions and the prior job's resolution context and provenance", async () => {
    const dispatchResolveConflictsJob = vi
      .fn()
      .mockReturnValue({ ok: true, value: { jobId: "job-3" } });
    const handlers = createGitRouteHandlers(
      makeDeps({
        dispatchResolveConflictsJob,
        getJob: vi.fn().mockReturnValue(makeJob({ status: "conflicts" })),
      }),
    );
    const decisions = [{ file: "a.txt", decision: "approved" as const }];
    const res = await handlers.resolveSessionConflicts(
      postRequest({ decisions }),
      routeContext(sessionParams),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      jobId: "job-3",
      jobType: "resolve-conflicts",
    });
    expect(dispatchResolveConflictsJob).toHaveBeenCalledWith({
      projectPath: "/repo",
      projectName: "proj",
      sessionName: "s1",
      worktreePath: "/repo/.worktrees/s1",
      branchName: "csm/s1",
      mergeMessage: "Merge csm/s1 into main",
      decisions,
      targetBranch: "main",
      targetWorktreePath: undefined,
      resolutionContext: "intent notes",
      executionId: "workflow-execution-1",
      finalPublish: true,
      finalizeSessionOnPublish: true,
      candidateValidation: {
        validationRef: "validation-1",
        validatedSha: "validated-sha",
        validatedTreeHash: "validated-tree",
        commandIdentity: "./validate.sh",
        outcome: "pass",
      },
    });
  });

  /**
   * Re-entry continues the SAME merge, so whether its publish finalizes the
   * session is the prior job's fact, not the route's assumption. A graph lane
   * merge retried here is still the workflow's own work: treating it as
   * session-finalizing would false-block the engine's next launch and point the
   * session delivery gate at the workflow's own Current run.
   */
  it("carries a graph lane merge's non-finalizing fact into the retry", async () => {
    const dispatchResolveConflictsJob = vi
      .fn()
      .mockReturnValue({ ok: true, value: { jobId: "job-3" } });
    const handlers = createGitRouteHandlers(
      makeDeps({
        dispatchResolveConflictsJob,
        getJob: vi.fn().mockReturnValue(
          makeJob({
            status: "conflicts",
            finalizeSessionOnPublish: false,
          }),
        ),
      }),
    );

    const res = await handlers.resolveSessionConflicts(
      postRequest({ decisions: [] }),
      routeContext(sessionParams),
    );

    expect(res.status).toBe(202);
    expect(dispatchResolveConflictsJob).toHaveBeenCalledWith(
      expect.objectContaining({ finalizeSessionOnPublish: false }),
    );
  });

  it("leaves a user-driven merge's retry session-finalizing", async () => {
    const dispatchResolveConflictsJob = vi
      .fn()
      .mockReturnValue({ ok: true, value: { jobId: "job-3" } });
    const handlers = createGitRouteHandlers(
      makeDeps({
        dispatchResolveConflictsJob,
        getJob: vi.fn().mockReturnValue(
          makeJob({
            status: "conflicts",
            finalizeSessionOnPublish: true,
          }),
        ),
      }),
    );

    await handlers.resolveSessionConflicts(
      postRequest({ decisions: [] }),
      routeContext(sessionParams),
    );

    expect(dispatchResolveConflictsJob).toHaveBeenCalledWith(
      expect.objectContaining({ finalizeSessionOnPublish: true }),
    );
  });
});

describe("landSession", () => {
  it("404s when no prepared merge exists", async () => {
    const handlers = createGitRouteHandlers(makeDeps());
    const res = await handlers.landSession(
      new Request("http://cc.test"),
      routeContext(sessionParams),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "No prepared merge for this session",
    });
  });

  it("409s when the job is not ready to land", async () => {
    const handlers = createGitRouteHandlers(
      makeDeps({
        getJob: vi.fn().mockReturnValue(makeJob({ status: "running" })),
      }),
    );
    const res = await handlers.landSession(
      new Request("http://cc.test"),
      routeContext(sessionParams),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Job is not ready to land (status: running)",
      code: "JOB_NOT_READY_TO_LAND",
    });
  });

  it("409s when the prepared SHA is missing from the job", async () => {
    const handlers = createGitRouteHandlers(
      makeDeps({
        getJob: vi.fn().mockReturnValue(makeJob({ preparedSha: undefined })),
      }),
    );
    const res = await handlers.landSession(
      new Request("http://cc.test"),
      routeContext(sessionParams),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PREPARED_SHA_MISSING");
  });

  it("409s when the expected target SHA is missing from the job", async () => {
    const handlers = createGitRouteHandlers(
      makeDeps({
        getJob: vi
          .fn()
          .mockReturnValue(makeJob({ expectedTargetSha: undefined })),
      }),
    );
    const res = await handlers.landSession(
      new Request("http://cc.test"),
      routeContext(sessionParams),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("EXPECTED_TARGET_SHA_MISSING");
  });

  it("409s when the parked ref no longer matches the prepared commit", async () => {
    const handlers = createGitRouteHandlers(
      makeDeps({
        gitClient: {
          git: vi.fn().mockResolvedValue({ stdout: "other-sha\n", stderr: "" }),
        },
        getJob: vi.fn().mockReturnValue(makeJob()),
      }),
    );
    const res = await handlers.landSession(
      new Request("http://cc.test"),
      routeContext(sessionParams),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("PARKED_REF_MISSING");
  });

  it("verifies the parked ref via git and dispatches a land merge job", async () => {
    const git = vi
      .fn()
      .mockResolvedValue({ stdout: "prepared-sha\n", stderr: "" });
    const dispatchMergeJob = vi
      .fn()
      .mockReturnValue({ ok: true, value: { jobId: "job-4" } });
    const handlers = createGitRouteHandlers(
      makeDeps({
        gitClient: { git },
        dispatchMergeJob,
        getJob: vi.fn().mockReturnValue(makeJob()),
      }),
    );
    const res = await handlers.landSession(
      new Request("http://cc.test"),
      routeContext(sessionParams),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      jobId: "job-4",
      jobType: "merge",
    });
    expect(git).toHaveBeenCalledWith(
      ["rev-parse", "--verify", "refs/cc-merges/job-1"],
      "/repo",
    );
    expect(dispatchMergeJob).toHaveBeenCalledWith(
      expect.objectContaining({
        entryMode: "land",
        preparedSha: "prepared-sha",
        expectedTargetSha: "target-sha",
        parkedRef: "refs/cc-merges/job-1",
        resolutionContext: "intent notes",
        executionId: "workflow-execution-1",
        finalPublish: true,
        candidateValidation: {
          validationRef: "validation-1",
          validatedSha: "validated-sha",
          validatedTreeHash: "validated-tree",
          commandIdentity: "./validate.sh",
          outcome: "pass",
        },
        finalizeSessionOnPublish: true,
      }),
    );
  });

  /** Landing a graph-owned parked candidate is still the workflow's own work. */
  it("carries a graph lane merge's non-finalizing fact into the land job", async () => {
    const dispatchMergeJob = vi
      .fn()
      .mockReturnValue({ ok: true, value: { jobId: "job-4" } });
    const handlers = createGitRouteHandlers(
      makeDeps({
        dispatchMergeJob,
        getJob: vi
          .fn()
          .mockReturnValue(makeJob({ finalizeSessionOnPublish: false })),
      }),
    );

    const res = await handlers.landSession(
      new Request("http://cc.test"),
      routeContext(sessionParams),
    );

    expect(res.status).toBe(202);
    expect(dispatchMergeJob).toHaveBeenCalledWith(
      expect.objectContaining({ finalizeSessionOnPublish: false }),
    );
  });
});

describe("discardSession", () => {
  it("dispatches a discard merge job for the parked commit", async () => {
    const dispatchMergeJob = vi
      .fn()
      .mockReturnValue({ ok: true, value: { jobId: "job-5" } });
    const handlers = createGitRouteHandlers(
      makeDeps({
        dispatchMergeJob,
        getJob: vi.fn().mockReturnValue(makeJob()),
      }),
    );
    const res = await handlers.discardSession(
      new Request("http://cc.test"),
      routeContext(sessionParams),
    );
    expect(res.status).toBe(202);
    expect(dispatchMergeJob).toHaveBeenCalledWith(
      expect.objectContaining({
        entryMode: "discard",
        preparedSha: "prepared-sha",
        parkedRef: "refs/cc-merges/job-1",
        message: "Discard prepared merge for csm/s1",
      }),
    );
  });

  it("409s when the job is not ready to land", async () => {
    const handlers = createGitRouteHandlers(
      makeDeps({
        getJob: vi.fn().mockReturnValue(makeJob({ status: "completed" })),
      }),
    );
    const res = await handlers.discardSession(
      new Request("http://cc.test"),
      routeContext(sessionParams),
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("JOB_NOT_READY_TO_LAND");
  });
});
