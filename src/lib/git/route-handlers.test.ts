import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGitRouteHandlers, type GitRouteDeps } from "./route-handlers";
import { sessionStateSchema, type SessionState } from "@/lib/sessions/schemas";
import { jobRecordSchema } from "@/lib/jobs/schemas";
import type { BackgroundJob, JobRecord } from "@/lib/jobs/schemas";
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
    // Every merge-family dispatch stamps this, so a job a re-entry route reads
    // back carries it too.
    finalizeSessionOnPublish: true,
    ...overrides,
  };
}

/**
 * The durable half of {@link makeJob} — what survives a restart that emptied the
 * in-memory job registry.
 */
function makeJobRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  return jobRecordSchema.parse({
    jobId: "job-persisted",
    jobType: "merge",
    status: "ready-to-land",
    projectName: "proj",
    sessionName: "s1",
    branchName: "csm/s1",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:04:00.000Z",
    parkedRef: "refs/cc-merges/job-persisted",
    preparedSha: "prepared-sha",
    expectedTargetSha: "target-sha",
    resolutionContext: "intent notes",
    finalizeSessionOnPublish: false,
    skipMarkMerged: true,
    ...overrides,
  });
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
    currentRuns: () => [],
    sessionBackgroundWork: () => [],
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
    findLatestJobRecordForSession: vi.fn().mockReturnValue(null),
    abortSessionJob: vi
      .fn()
      .mockReturnValue({ ok: false, error: "NO_ABORTABLE_JOB" }),
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

  it("accepts commits in a merged session", async () => {
    const handlers = createGitRouteHandlers(
      makeDeps({
        getSession: vi.fn().mockResolvedValue(makeSession({ finished: true })),
      }),
    );
    const res = await handlers.commitSession(
      postRequest({ message: "msg" }),
      routeContext(sessionParams),
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      jobId: "job-1",
      jobType: "commit",
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
  it("refuses the merge while one of the session's runs has not finished, naming the run", async () => {
    const dispatchMergeJob = vi
      .fn()
      .mockReturnValue({ ok: true, value: { jobId: "job-2" } });
    const handlers = createGitRouteHandlers(
      makeDeps({
        dispatchMergeJob,
        currentRuns: () => [
          { runId: "run-1", sessionName: "my-session", progress: "running" },
        ],
      }),
    );

    const res = await handlers.mergeSession(
      postRequest({ autoResolve: true }),
      routeContext(sessionParams),
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "RUN_CURRENT",
      details: { runId: "run-1", progress: "running" },
    });
    expect(dispatchMergeJob).not.toHaveBeenCalled();
  });

  it("refuses the merge while a conversation of the session keeps background work running, naming the conversation", async () => {
    const dispatchMergeJob = vi
      .fn()
      .mockReturnValue({ ok: true, value: { jobId: "job-2" } });
    const handlers = createGitRouteHandlers(
      makeDeps({
        dispatchMergeJob,
        sessionBackgroundWork: () => [
          {
            conversationId: "conv-1",
            conversationName: "Suite runner",
            unconfirmed: null,
          },
        ],
      }),
    );

    const res = await handlers.mergeSession(
      postRequest({ autoResolve: true }),
      routeContext(sessionParams),
    );

    expect(res.status).toBe(409);
    const body: unknown = await res.json();
    expect(body).toMatchObject({
      code: "BACKGROUND_WORK_RUNNING",
      details: { conversationId: "conv-1" },
      error: expect.stringContaining('conversation "Suite runner"'),
    });
    expect(dispatchMergeJob).not.toHaveBeenCalled();
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
      conflictFiles: undefined,
      targetBranch: "main",
      resolutionContext: "intent notes",
      finalizeSessionOnPublish: true,
    });
  });

  /**
   * Re-entry continues the SAME merge, so whether its publish finalizes the
   * session is the prior job's fact, not the route's assumption. A graph lane
   * merge retried here is still the workflow's own work: treating it as
   * session-finalizing would false-block the engine's next launch and point the
   * session delivery gate at the workflow's own Current run.
   */
  it("seeds the retry with the conflicted job's conflict files", async () => {
    const dispatchResolveConflictsJob = vi
      .fn()
      .mockReturnValue({ ok: true, value: { jobId: "job-3" } });
    const handlers = createGitRouteHandlers(
      makeDeps({
        dispatchResolveConflictsJob,
        getJob: vi.fn().mockReturnValue(
          makeJob({
            status: "conflicts",
            conflictFiles: ["src/a.ts", "src/b.ts"],
          }),
        ),
      }),
    );

    await handlers.resolveSessionConflicts(
      postRequest({ decisions: [] }),
      routeContext(sessionParams),
    );

    expect(dispatchResolveConflictsJob).toHaveBeenCalledWith(
      expect.objectContaining({ conflictFiles: ["src/a.ts", "src/b.ts"] }),
    );
  });

  it.each([false, true])(
    "preserves the merge's completion options on conflict retry (restarted=%s)",
    async (restarted) => {
      const dispatchResolveConflictsJob = vi
        .fn()
        .mockReturnValue({ ok: true, value: { jobId: "job-3" } });
      const handlers = createGitRouteHandlers(
        makeDeps({
          dispatchResolveConflictsJob,
          getJob: vi.fn().mockReturnValue(
            restarted
              ? undefined
              : makeJob({
                  status: "conflicts",
                  finalizeSessionOnPublish: false,
                  skipMarkMerged: true,
                }),
          ),
          findLatestJobRecordForSession: vi.fn().mockReturnValue(
            makeJobRecord({
              status: "conflicts",
              finalizeSessionOnPublish: false,
              skipMarkMerged: true,
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
        expect.objectContaining({
          finalizeSessionOnPublish: false,
          skipMarkMerged: true,
        }),
      );
    },
  );

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
        finalizeSessionOnPublish: true,
      }),
    );
  });

  /**
   * A restart empties the job registry but leaves the parked commit under
   * `refs/cc-merges/`, so the durable row is what the land re-entry rebuilds its
   * merge input from.
   */
  it("reconstructs a land re-entry from the persisted parked merge when the registry is empty", async () => {
    const dispatchMergeJob = vi
      .fn()
      .mockReturnValue({ ok: true, value: { jobId: "job-6" } });
    const git = vi
      .fn()
      .mockResolvedValue({ stdout: "prepared-sha\n", stderr: "" });
    const findLatestJobRecordForSession = vi
      .fn()
      .mockReturnValue(makeJobRecord());
    const handlers = createGitRouteHandlers(
      makeDeps({
        gitClient: { git },
        dispatchMergeJob,
        getJob: vi.fn().mockReturnValue(undefined),
        findLatestJobRecordForSession,
      }),
    );

    const res = await handlers.landSession(
      new Request("http://cc.test"),
      routeContext(sessionParams),
    );

    expect(res.status).toBe(202);
    expect(findLatestJobRecordForSession).toHaveBeenCalledWith("proj", "s1");
    expect(git).toHaveBeenCalledWith(
      ["rev-parse", "--verify", "refs/cc-merges/job-persisted"],
      "/repo",
    );
    expect(dispatchMergeJob).toHaveBeenCalledWith(
      expect.objectContaining({
        entryMode: "land",
        preparedSha: "prepared-sha",
        expectedTargetSha: "target-sha",
        parkedRef: "refs/cc-merges/job-persisted",
        resolutionContext: "intent notes",
        finalizeSessionOnPublish: false,
        skipMarkMerged: true,
      }),
    );
  });

  /**
   * A land dispatches its own job, so the candidate's row is no longer the
   * session's latest once it has been acted on. Offering it again after a
   * restart would answer for a merge that already landed.
   */
  it("does not resurrect a candidate a later job took the session from", async () => {
    const dispatchMergeJob = vi.fn();
    const git = vi.fn();
    const handlers = createGitRouteHandlers(
      makeDeps({
        gitClient: { git },
        dispatchMergeJob,
        getJob: vi.fn().mockReturnValue(undefined),
        findLatestJobRecordForSession: vi.fn().mockReturnValue(
          makeJobRecord({
            jobId: "job-landed",
            status: "completed",
            mergeHash: "landed-sha",
            parkedRef: undefined,
            preparedSha: undefined,
            expectedTargetSha: undefined,
          }),
        ),
      }),
    );

    const res = await handlers.landSession(
      new Request("http://cc.test"),
      routeContext(sessionParams),
    );

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("JOB_NOT_READY_TO_LAND");
    expect(git).not.toHaveBeenCalled();
    expect(dispatchMergeJob).not.toHaveBeenCalled();
  });

  it("409s when the persisted parked commit no longer exists", async () => {
    const dispatchMergeJob = vi.fn();
    const handlers = createGitRouteHandlers(
      makeDeps({
        gitClient: {
          git: vi.fn().mockRejectedValue(new Error("bad revision")),
        },
        dispatchMergeJob,
        getJob: vi.fn().mockReturnValue(undefined),
        findLatestJobRecordForSession: vi.fn().mockReturnValue(makeJobRecord()),
      }),
    );

    const res = await handlers.landSession(
      new Request("http://cc.test"),
      routeContext(sessionParams),
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error:
        "Parked ref refs/cc-merges/job-persisted no longer resolves to prepared commit prepared-sha — the prepared merge is gone. Run the merge again to prepare a new candidate.",
      code: "PARKED_REF_MISSING",
    });
    expect(dispatchMergeJob).not.toHaveBeenCalled();
  });

  /** The live job wins: a session with a merge running now is not landable. */
  it("does not fall back to a persisted row while the registry holds a job", async () => {
    const findLatestJobRecordForSession = vi
      .fn()
      .mockReturnValue(makeJobRecord());
    const handlers = createGitRouteHandlers(
      makeDeps({
        getJob: vi.fn().mockReturnValue(makeJob({ status: "running" })),
        findLatestJobRecordForSession,
      }),
    );

    const res = await handlers.landSession(
      new Request("http://cc.test"),
      routeContext(sessionParams),
    );

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("JOB_NOT_READY_TO_LAND");
    expect(findLatestJobRecordForSession).not.toHaveBeenCalled();
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
          .mockReturnValue(
            makeJob({ finalizeSessionOnPublish: false, skipMarkMerged: true }),
          ),
      }),
    );

    const res = await handlers.landSession(
      new Request("http://cc.test"),
      routeContext(sessionParams),
    );

    expect(res.status).toBe(202);
    expect(dispatchMergeJob).toHaveBeenCalledWith(
      expect.objectContaining({
        finalizeSessionOnPublish: false,
        skipMarkMerged: true,
      }),
    );
  });
});

describe("re-entering a finalizing merge while background work holds the session (design C5b §5)", () => {
  const holding = [
    {
      conversationId: "conv-1",
      conversationName: "Suite runner",
      unconfirmed: null,
    },
  ];

  it("refuses Land without dispatching, keeping the candidate, and lands the same candidate once the work is stopped", async () => {
    let held = true;
    const candidate = makeJob();
    const getJob = vi.fn().mockReturnValue(candidate);
    const dispatchMergeJob = vi
      .fn()
      .mockReturnValue({ ok: true, value: { jobId: "job-6" } });
    const handlers = createGitRouteHandlers(
      makeDeps({
        dispatchMergeJob,
        getJob,
        sessionBackgroundWork: () => (held ? holding : []),
      }),
    );

    const refused = await handlers.landSession(
      new Request("http://cc.test"),
      routeContext(sessionParams),
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      code: "BACKGROUND_WORK_RUNNING",
      details: { conversationId: "conv-1" },
    });
    expect(dispatchMergeJob).not.toHaveBeenCalled();
    expect(candidate.status).toBe("ready-to-land");

    held = false;
    const landed = await handlers.landSession(
      new Request("http://cc.test"),
      routeContext(sessionParams),
    );
    expect(landed.status).toBe(202);
    expect(dispatchMergeJob).toHaveBeenCalledWith(
      expect.objectContaining({
        entryMode: "land",
        preparedSha: "prepared-sha",
        parkedRef: "refs/cc-merges/job-1",
      }),
    );
  });

  it("lands a graph lane's non-finalizing candidate whatever the session's background work", async () => {
    const dispatchMergeJob = vi
      .fn()
      .mockReturnValue({ ok: true, value: { jobId: "job-7" } });
    const handlers = createGitRouteHandlers(
      makeDeps({
        dispatchMergeJob,
        getJob: vi
          .fn()
          .mockReturnValue(makeJob({ finalizeSessionOnPublish: false })),
        sessionBackgroundWork: () => holding,
      }),
    );

    const res = await handlers.landSession(
      new Request("http://cc.test"),
      routeContext(sessionParams),
    );
    expect(res.status).toBe(202);
  });

  it("refuses a finalizing conflict retry without dispatching, and lets a non-finalizing one through", async () => {
    const dispatchResolveConflictsJob = vi
      .fn()
      .mockReturnValue({ ok: true, value: { jobId: "job-8" } });
    let job = makeJob({ status: "conflicts" });
    const handlers = createGitRouteHandlers(
      makeDeps({
        dispatchResolveConflictsJob,
        getJob: vi.fn(() => job),
        sessionBackgroundWork: () => holding,
      }),
    );
    const decisions = [{ file: "a.txt", decision: "approved" as const }];

    const refused = await handlers.resolveSessionConflicts(
      postRequest({ decisions }),
      routeContext(sessionParams),
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      code: "BACKGROUND_WORK_RUNNING",
    });
    expect(dispatchResolveConflictsJob).not.toHaveBeenCalled();

    job = makeJob({ status: "conflicts", finalizeSessionOnPublish: false });
    const lane = await handlers.resolveSessionConflicts(
      postRequest({ decisions }),
      routeContext(sessionParams),
    );
    expect(lane.status).toBe(202);
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

  it("discards a persisted parked merge after a restart emptied the registry", async () => {
    const dispatchMergeJob = vi
      .fn()
      .mockReturnValue({ ok: true, value: { jobId: "job-7" } });
    const handlers = createGitRouteHandlers(
      makeDeps({
        dispatchMergeJob,
        getJob: vi.fn().mockReturnValue(undefined),
        findLatestJobRecordForSession: vi.fn().mockReturnValue(makeJobRecord()),
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
        parkedRef: "refs/cc-merges/job-persisted",
      }),
    );
  });

  /**
   * Discarding is idempotent cleanup: a vanished ref is the outcome the operator
   * asked for, and refusing would strand the session showing a candidate that
   * cannot be cleared.
   */
  it("still dispatches when the parked ref is already gone", async () => {
    const dispatchMergeJob = vi
      .fn()
      .mockReturnValue({ ok: true, value: { jobId: "job-8" } });
    const handlers = createGitRouteHandlers(
      makeDeps({
        gitClient: {
          git: vi.fn().mockRejectedValue(new Error("bad revision")),
        },
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
      expect.objectContaining({ entryMode: "discard" }),
    );
  });
});

describe("abortSessionMergeJob", () => {
  it("stops the session's running job and reports the job it stopped", async () => {
    const abortSessionJob = vi
      .fn()
      .mockReturnValue({ ok: true, jobId: "job-9", delivery: "stopping" });
    const handlers = createGitRouteHandlers(makeDeps({ abortSessionJob }));

    const res = await handlers.abortSessionMergeJob(
      new Request("http://cc.test", { method: "POST" }),
      routeContext(sessionParams),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      jobId: "job-9",
      delivery: "stopping",
    });
    expect(abortSessionJob).toHaveBeenCalledWith("/repo", "s1");
  });

  it("says the stop was only recorded when the job is past recall", async () => {
    // Answering "stopped" here would tell the operator a merge was cancelled
    // that is at that moment updating the target branch.
    const handlers = createGitRouteHandlers(
      makeDeps({
        abortSessionJob: vi
          .fn()
          .mockReturnValue({ ok: true, jobId: "job-9", delivery: "deferred" }),
      }),
    );

    const res = await handlers.abortSessionMergeJob(
      new Request("http://cc.test", { method: "POST" }),
      routeContext(sessionParams),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.delivery).toBe("deferred");
    expect(body.message).toMatch(/cannot be recalled/i);
  });

  it("404s when the session has no running merge or commit job", async () => {
    const handlers = createGitRouteHandlers(
      makeDeps({
        abortSessionJob: vi
          .fn()
          .mockReturnValue({ ok: false, error: "NO_ABORTABLE_JOB" }),
      }),
    );

    const res = await handlers.abortSessionMergeJob(
      new Request("http://cc.test", { method: "POST" }),
      routeContext(sessionParams),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "No running merge or commit job for this session",
    });
  });

  it("409s when the running job has no live actor to stop", async () => {
    const handlers = createGitRouteHandlers(
      makeDeps({
        abortSessionJob: vi
          .fn()
          .mockReturnValue({ ok: false, error: "JOB_ACTOR_MISSING" }),
      }),
    );

    const res = await handlers.abortSessionMergeJob(
      new Request("http://cc.test", { method: "POST" }),
      routeContext(sessionParams),
    );

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("JOB_ACTOR_MISSING");
  });

  it("404s when the session is unknown", async () => {
    const abortSessionJob = vi.fn();
    const handlers = createGitRouteHandlers(
      makeDeps({
        getSession: vi.fn().mockResolvedValue(null),
        abortSessionJob,
      }),
    );

    const res = await handlers.abortSessionMergeJob(
      new Request("http://cc.test", { method: "POST" }),
      routeContext(sessionParams),
    );

    expect(res.status).toBe(404);
    expect(abortSessionJob).not.toHaveBeenCalled();
  });
});
