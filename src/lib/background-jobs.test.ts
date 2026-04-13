import { describe, it, expect, vi, beforeEach } from "vitest";
import { fromPromise } from "xstate";
import {
  dispatchMergeJob,
  dispatchCommitJob,
  dispatchResolveConflictsJob,
  getJob,
  getActiveJobs,
  getConflictAnalysis,
  _resetForTesting,
} from "./background-jobs";
import { mergeMachine } from "./workflows/merge/machine";
import { commitMachine } from "./workflows/commit/machine";
import type {
  CheckUncommittedInput,
  CheckUncommittedOutput,
  CommitChangesInput,
  CommitChangesOutput,
  MergeMainInput,
  MergeMainOutput,
  ResolveConflictsInput,
  ResolveConflictsOutput,
  AnalyzeConflictsInput,
  AnalyzeConflictsOutput,
  RunValidationInput,
  RunValidationOutput,
  FixValidationInput,
  FixValidationOutput,
  SquashMergeInput,
  SquashMergeOutput,
} from "./workflows/merge/actors";
import type { JobStatusEvent } from "@/types";

// ============================================================
// Only notification-db is vi.mock()'d — legitimate DB dependency
// ============================================================

vi.mock("./notification-db");

// ============================================================
// Actor mock fns — injected via mergeMachine.provide()
// ============================================================

const mockCheckUncommitted = vi.fn();
const mockCommitChangesActor = vi.fn();
const mockMergeMain = vi.fn();
const mockResolveConflictsActor = vi.fn();
const mockAnalyzeConflictsActor = vi.fn();
const mockRunValidation = vi.fn();
const mockFixValidation = vi.fn();
const mockSquashMergeActor = vi.fn();

/** Test machine: real merge machine with mock actors */
const testMachine = mergeMachine.provide({
  actors: {
    checkUncommitted: fromPromise<
      CheckUncommittedOutput,
      CheckUncommittedInput
    >(async ({ input }) => mockCheckUncommitted(input)),
    commitChanges: fromPromise<CommitChangesOutput, CommitChangesInput>(
      async ({ input }) => mockCommitChangesActor(input),
    ),
    mergeMain: fromPromise<MergeMainOutput, MergeMainInput>(async ({ input }) =>
      mockMergeMain(input),
    ),
    resolveConflicts: fromPromise<
      ResolveConflictsOutput,
      ResolveConflictsInput
    >(async ({ input }) => mockResolveConflictsActor(input)),
    analyzeConflicts: fromPromise<
      AnalyzeConflictsOutput,
      AnalyzeConflictsInput
    >(async ({ input }) => mockAnalyzeConflictsActor(input)),
    runValidation: fromPromise<void, RunValidationInput>(async ({ input }) =>
      mockRunValidation(input),
    ),
    fixValidation: fromPromise<FixValidationOutput, FixValidationInput>(
      async ({ input }) => mockFixValidation(input),
    ),
    squashMerge: fromPromise<SquashMergeOutput, SquashMergeInput>(
      async ({ input }) => mockSquashMergeActor(input),
    ),
  },
});

/** Test machine: real commit machine with mock actors */
const testCommitMachine = commitMachine.provide({
  actors: {
    commitChanges: fromPromise<CommitChangesOutput, CommitChangesInput>(
      async ({ input }) => mockCommitChangesActor(input),
    ),
    runValidation: fromPromise<RunValidationOutput, RunValidationInput>(
      async ({ input }) => mockRunValidation(input),
    ),
    fixValidation: fromPromise<FixValidationOutput, FixValidationInput>(
      async ({ input }) => mockFixValidation(input),
    ),
    checkUncommitted: fromPromise<
      CheckUncommittedOutput,
      CheckUncommittedInput
    >(async ({ input }) => mockCheckUncommitted(input)),
  },
});

// ============================================================
// Injected deps — no vi.mock needed
// ============================================================

const mockBroadcast = vi.fn();
const mockAcquireSessionLock = vi.fn();

// ============================================================
// Helpers
// ============================================================

/** Let the fire-and-forget background promise settle */
async function settle(ms = 50): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

const BASE_MERGE_PARAMS = {
  projectPath: "/projects/foo",
  projectName: "foo",
  sessionName: "my-session",
  worktreePath: "/projects/foo/.worktrees/my-session",
  branchName: "csm/my-session",
  message: "Merge my-session into main",
  autoResolve: false,
  broadcast: mockBroadcast,
  acquireSessionLock: mockAcquireSessionLock,
  machine: testMachine,
};

const BASE_COMMIT_PARAMS = {
  projectPath: "/projects/foo",
  projectName: "foo",
  sessionName: "my-session",
  worktreePath: "/projects/foo/.worktrees/my-session",
  branchName: "csm/my-session",
  message: "chore: update deps",
  broadcast: mockBroadcast,
  acquireSessionLock: mockAcquireSessionLock,
  machine: testCommitMachine,
};

const BASE_RESOLVE_PARAMS = {
  projectPath: "/projects/foo",
  projectName: "foo",
  sessionName: "my-session",
  worktreePath: "/projects/foo/.worktrees/my-session",
  branchName: "csm/my-session",
  mergeMessage: "Merge my-session into main",
  broadcast: mockBroadcast,
  acquireSessionLock: mockAcquireSessionLock,
  machine: testMachine,
};

/** Extract the most recent broadcast call's event */
function lastBroadcast(): JobStatusEvent {
  const calls = mockBroadcast.mock.calls;
  return calls[calls.length - 1]![0] as JobStatusEvent;
}

/** Extract broadcast at a given index */
function broadcastAt(index: number): JobStatusEvent {
  return mockBroadcast.mock.calls[index]![0] as JobStatusEvent;
}

// ============================================================
// Test Suite
// ============================================================

describe("background-jobs", () => {
  let releaseSession: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Let any background XState actors from previous tests complete
    await settle();
    vi.clearAllMocks();
    _resetForTesting();

    releaseSession = vi.fn();

    // Default: session lock acquired successfully
    mockAcquireSessionLock.mockReturnValue(releaseSession);
    // Default: no uncommitted changes
    mockCheckUncommitted.mockResolvedValue({ hasChanges: false });
    // Default: analyze conflicts returns empty analysis
    mockAnalyzeConflictsActor.mockResolvedValue({
      status: "analyzed" as const,
      conflicts: [],
    });
    // Default: pre-merge validation passes
    mockRunValidation.mockResolvedValue(undefined);
    // Default: fix validation succeeds
    mockFixValidation.mockResolvedValue({ status: "fixed" as const });
  });

  // ----------------------------------------------------------
  // dispatchMergeJob
  // ----------------------------------------------------------
  describe("dispatchMergeJob", () => {
    it("returns ok with jobId when no active job", () => {
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockSquashMergeActor.mockResolvedValue({ mergeHash: "abc123" });

      const result = dispatchMergeJob(BASE_MERGE_PARAMS);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.jobId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
      }
    });

    it("returns error when job already running", () => {
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockSquashMergeActor.mockResolvedValue({ mergeHash: "abc123" });

      const first = dispatchMergeJob(BASE_MERGE_PARAMS);
      expect(first.ok).toBe(true);

      const second = dispatchMergeJob(BASE_MERGE_PARAMS);
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.error).toBe("JOB_ALREADY_RUNNING");
      }
    });

    it("clean merge: merging → validating → squash → completed broadcast", async () => {
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockSquashMergeActor.mockResolvedValue({ mergeHash: "abc123" });

      const result = dispatchMergeJob(BASE_MERGE_PARAMS);
      expect(result.ok).toBe(true);

      await settle();

      // Verify actors were invoked with correct inputs
      expect(mockMergeMain).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreePath: BASE_MERGE_PARAMS.worktreePath,
        }),
      );
      expect(mockSquashMergeActor).toHaveBeenCalledWith(
        expect.objectContaining({
          projectPath: BASE_MERGE_PARAMS.projectPath,
          branchName: BASE_MERGE_PARAMS.branchName,
          message: BASE_MERGE_PARAMS.message,
        }),
      );

      // Broadcast lifecycle
      expect(broadcastAt(0).status).toBe("running");
      const last = lastBroadcast();
      expect(last.status).toBe("completed");
      expect(last.mergeHash).toBe("abc123");
      expect(last.jobType).toBe("merge");

      // Job registry
      const job = getJob(
        BASE_MERGE_PARAMS.projectPath,
        BASE_MERGE_PARAMS.sessionName,
      );
      expect(job?.status).toBe("completed");
      expect(job?.mergeHash).toBe("abc123");
      expect(job?.completedAt).toBeDefined();

      // Session lock released
      expect(releaseSession).toHaveBeenCalled();
    });

    it("phase 0: commits uncommitted changes before merging main", async () => {
      mockCheckUncommitted.mockResolvedValue({ hasChanges: true });
      mockCommitChangesActor.mockResolvedValue({ hash: "phase0hash" });
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockSquashMergeActor.mockResolvedValue({ mergeHash: "abc123" });

      const result = dispatchMergeJob(BASE_MERGE_PARAMS);
      expect(result.ok).toBe(true);

      await settle();

      expect(mockCommitChangesActor).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreePath: BASE_MERGE_PARAMS.worktreePath,
          message: "WIP: uncommitted changes",
          skipHooks: true,
        }),
      );
      expect(mockMergeMain).toHaveBeenCalled();

      // Verify ordering: commit before merge
      const commitOrder = mockCommitChangesActor.mock.invocationCallOrder[0]!;
      const mergeOrder = mockMergeMain.mock.invocationCallOrder[0]!;
      expect(commitOrder).toBeLessThan(mergeOrder);

      expect(lastBroadcast().status).toBe("completed");
    });

    it("phase 0: skips commit when no uncommitted changes", async () => {
      mockCheckUncommitted.mockResolvedValue({ hasChanges: false });
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockSquashMergeActor.mockResolvedValue({ mergeHash: "abc123" });

      dispatchMergeJob(BASE_MERGE_PARAMS);
      await settle();

      expect(mockCommitChangesActor).not.toHaveBeenCalled();
      expect(mockMergeMain).toHaveBeenCalled();
    });

    it("phase 0: commit failure causes job to fail", async () => {
      mockCheckUncommitted.mockResolvedValue({ hasChanges: true });
      mockCommitChangesActor.mockRejectedValue(
        new Error("pre-commit hook failed"),
      );

      const result = dispatchMergeJob(BASE_MERGE_PARAMS);
      expect(result.ok).toBe(true);

      await settle();

      expect(mockMergeMain).not.toHaveBeenCalled();

      const last = lastBroadcast();
      expect(last.status).toBe("failed");
      expect(last.errorMessage).toContain("pre-commit hook failed");

      expect(releaseSession).toHaveBeenCalled();
    });

    it("conflict merge with auto-resolve: resolves → commit → squash → completed", async () => {
      mockMergeMain.mockResolvedValue({
        status: "conflicts",
        conflictFiles: ["file1.ts", "file2.ts"],
      });
      mockResolveConflictsActor.mockResolvedValue({
        status: "resolved",
        conflicts: [
          {
            file: "file1.ts",
            description: "import conflict",
            resolution: "kept both",
            rationale: "both needed",
          },
          {
            file: "file2.ts",
            description: "function conflict",
            resolution: "merged logic",
            rationale: "combined functionality",
          },
        ],
      });
      mockCommitChangesActor.mockResolvedValue({ hash: "resolve123" });
      mockSquashMergeActor.mockResolvedValue({ mergeHash: "merge456" });

      const result = dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        autoResolve: true,
      });
      expect(result.ok).toBe(true);

      await settle();

      expect(mockResolveConflictsActor).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreePath: BASE_MERGE_PARAMS.worktreePath,
        }),
      );
      expect(mockCommitChangesActor).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreePath: BASE_MERGE_PARAMS.worktreePath,
          message: "resolve merge conflicts",
          skipHooks: true,
        }),
      );
      expect(mockRunValidation).toHaveBeenCalledWith(
        expect.objectContaining({
          projectPath: BASE_MERGE_PARAMS.projectPath,
          worktreePath: BASE_MERGE_PARAMS.worktreePath,
          sessionName: BASE_MERGE_PARAMS.sessionName,
          branchName: BASE_MERGE_PARAMS.branchName,
          timeoutMs: 300_000,
        }),
      );
      expect(mockSquashMergeActor).toHaveBeenCalled();

      const last = lastBroadcast();
      expect(last.status).toBe("completed");
      expect(last.mergeHash).toBe("merge456");

      const analysis = getConflictAnalysis(
        BASE_MERGE_PARAMS.projectPath,
        BASE_MERGE_PARAMS.sessionName,
      );
      expect(analysis).toBeDefined();
      expect(analysis?.conflicts).toHaveLength(2);

      expect(releaseSession).toHaveBeenCalled();
    });

    it("conflict merge without auto-resolve: conflicts broadcast", async () => {
      mockMergeMain.mockResolvedValue({
        status: "conflicts",
        conflictFiles: ["file1.ts"],
      });

      const result = dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        autoResolve: false,
      });
      expect(result.ok).toBe(true);

      await settle();

      expect(mockResolveConflictsActor).not.toHaveBeenCalled();

      const last = lastBroadcast();
      expect(last.status).toBe("conflicts");
      expect(last.conflictFiles).toEqual(["file1.ts"]);
      expect(last.conflictCount).toBe(1);

      const job = getJob(
        BASE_MERGE_PARAMS.projectPath,
        BASE_MERGE_PARAMS.sessionName,
      );
      expect(job?.status).toBe("conflicts");
      expect(job?.conflictFiles).toEqual(["file1.ts"]);

      expect(releaseSession).toHaveBeenCalled();
    });

    it("auto-resolve failure falls back to conflicts status", async () => {
      mockMergeMain.mockResolvedValue({
        status: "conflicts",
        conflictFiles: ["file1.ts", "file2.ts"],
      });
      mockResolveConflictsActor.mockResolvedValue({
        status: "failed",
        conflicts: [],
        partialConflicts: [
          {
            file: "file1.ts",
            description: "partial",
            resolution: "partial",
            rationale: "partial",
          },
        ],
      });

      const result = dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        autoResolve: true,
      });
      expect(result.ok).toBe(true);

      await settle();

      const last = lastBroadcast();
      expect(last.status).toBe("conflicts");
      expect(last.conflictFiles).toEqual(["file1.ts", "file2.ts"]);

      const analysis = getConflictAnalysis(
        BASE_MERGE_PARAMS.projectPath,
        BASE_MERGE_PARAMS.sessionName,
      );
      expect(analysis).toBeDefined();
      expect(analysis?.conflicts).toHaveLength(1);

      expect(releaseSession).toHaveBeenCalled();
    });

    it("merge pipeline error → failed broadcast", async () => {
      mockMergeMain.mockRejectedValue(
        new Error("git merge failed unexpectedly"),
      );

      const result = dispatchMergeJob(BASE_MERGE_PARAMS);
      expect(result.ok).toBe(true);

      await settle();

      const last = lastBroadcast();
      expect(last.status).toBe("failed");
      expect(last.errorMessage).toContain("git merge failed unexpectedly");

      const job = getJob(
        BASE_MERGE_PARAMS.projectPath,
        BASE_MERGE_PARAMS.sessionName,
      );
      expect(job?.status).toBe("failed");
      expect(job?.completedAt).toBeDefined();

      expect(releaseSession).toHaveBeenCalled();
    });

    it("merge pipeline includes gitOutput in error message", async () => {
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      const err = new Error("Commit failed") as Error & {
        gitOutput?: string;
      };
      err.gitOutput = "husky - pre-commit script failed (code 1)";
      mockSquashMergeActor.mockRejectedValue(err);

      dispatchMergeJob(BASE_MERGE_PARAMS);
      await settle();

      const job = getJob(
        BASE_MERGE_PARAMS.projectPath,
        BASE_MERGE_PARAMS.sessionName,
      );
      expect(job?.errorMessage).toContain("Commit failed");
      expect(job?.errorMessage).toContain("pre-commit script failed");
    });

    it("pre-merge validation is called before squash merge", async () => {
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockSquashMergeActor.mockResolvedValue({ mergeHash: "abc123" });

      dispatchMergeJob(BASE_MERGE_PARAMS);
      await settle();

      expect(mockRunValidation).toHaveBeenCalledWith(
        expect.objectContaining({
          projectPath: BASE_MERGE_PARAMS.projectPath,
          worktreePath: BASE_MERGE_PARAMS.worktreePath,
          sessionName: BASE_MERGE_PARAMS.sessionName,
          branchName: BASE_MERGE_PARAMS.branchName,
          timeoutMs: 300_000,
        }),
      );

      const validationOrder = mockRunValidation.mock.invocationCallOrder[0]!;
      const squashOrder = mockSquashMergeActor.mock.invocationCallOrder[0]!;
      expect(validationOrder).toBeLessThan(squashOrder);
    });

    it("failed pre-merge validation blocks squash merge", async () => {
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      const err = new Error("Pre-merge validation failed") as Error & {
        gitOutput?: string;
      };
      err.gitOutput = "lint errors found";
      mockRunValidation.mockRejectedValue(err);

      dispatchMergeJob(BASE_MERGE_PARAMS);
      await settle();

      expect(mockSquashMergeActor).not.toHaveBeenCalled();

      const last = lastBroadcast();
      expect(last.status).toBe("failed");
      expect(last.errorMessage).toContain("Pre-merge validation failed");
      expect(last.errorMessage).toContain("lint errors found");
    });

    it("session lock failure returns SESSION_BUSY error", () => {
      mockAcquireSessionLock.mockImplementation(() => {
        throw new Error("Session is busy");
      });

      const result = dispatchMergeJob(BASE_MERGE_PARAMS);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe("SESSION_BUSY");
      }
    });
  });

  // ----------------------------------------------------------
  // dispatchCommitJob
  // ----------------------------------------------------------
  describe("dispatchCommitJob", () => {
    it("successful commit → completed broadcast", async () => {
      mockCommitChangesActor.mockResolvedValue({ hash: "commit789" });

      const result = dispatchCommitJob(BASE_COMMIT_PARAMS);
      expect(result.ok).toBe(true);

      await settle();

      expect(mockCommitChangesActor).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreePath: BASE_COMMIT_PARAMS.worktreePath,
          message: BASE_COMMIT_PARAMS.message,
          skipHooks: true,
        }),
      );

      const last = lastBroadcast();
      expect(last.status).toBe("completed");
      expect(last.commitHash).toBe("commit789");
      expect(last.jobType).toBe("commit");

      const job = getJob(
        BASE_COMMIT_PARAMS.projectPath,
        BASE_COMMIT_PARAMS.sessionName,
      );
      expect(job?.status).toBe("completed");
      expect(job?.commitHash).toBe("commit789");

      expect(releaseSession).toHaveBeenCalled();
    });

    it("failed commit → failed broadcast", async () => {
      const err = new Error("No uncommitted changes to commit");
      mockCommitChangesActor.mockRejectedValue(err);

      const result = dispatchCommitJob(BASE_COMMIT_PARAMS);
      expect(result.ok).toBe(true);

      await settle();

      const last = lastBroadcast();
      expect(last.status).toBe("failed");
      expect(last.errorMessage).toContain("No uncommitted changes to commit");

      expect(releaseSession).toHaveBeenCalled();
    });

    it("failed commit includes gitOutput in errorMessage", async () => {
      const err = new Error("Commit failed") as Error & {
        gitOutput?: string;
      };
      err.gitOutput = "pre-commit hook failed: lint errors";
      mockCommitChangesActor.mockRejectedValue(err);

      const result = dispatchCommitJob(BASE_COMMIT_PARAMS);
      expect(result.ok).toBe(true);

      await settle();

      const job = getJob(
        BASE_COMMIT_PARAMS.projectPath,
        BASE_COMMIT_PARAMS.sessionName,
      );
      expect(job?.errorMessage).toContain("pre-commit hook failed");
    });

    it("commit + validation passes → completed with phases", async () => {
      mockCommitChangesActor.mockResolvedValue({ hash: "commit789" });
      // mockRunValidation already defaults to resolving (undefined)

      const result = dispatchCommitJob(BASE_COMMIT_PARAMS);
      expect(result.ok).toBe(true);

      await settle();

      // Verify both commit and validation actors were called
      expect(mockCommitChangesActor).toHaveBeenCalled();
      expect(mockRunValidation).toHaveBeenCalledWith(
        expect.objectContaining({
          projectPath: BASE_COMMIT_PARAMS.projectPath,
          worktreePath: BASE_COMMIT_PARAMS.worktreePath,
        }),
      );

      // Verify phases were broadcast (committing, validating)
      const phaseEvents = mockBroadcast.mock.calls
        .map((c) => (c[0] as JobStatusEvent).phase)
        .filter(Boolean);
      expect(phaseEvents).toContain("committing");
      expect(phaseEvents).toContain("validating");

      const last = lastBroadcast();
      expect(last.status).toBe("completed");
      expect(last.commitHash).toBe("commit789");
    });

    it("validation fails → fix → re-validate → completed", async () => {
      mockCommitChangesActor.mockResolvedValue({ hash: "commit789" });
      mockRunValidation
        .mockRejectedValueOnce(new Error("lint errors"))
        .mockResolvedValueOnce(undefined);
      mockFixValidation.mockResolvedValue({
        status: "fixed" as const,
      });
      mockCheckUncommitted.mockResolvedValue({ hasChanges: true });

      const result = dispatchCommitJob(BASE_COMMIT_PARAMS);
      expect(result.ok).toBe(true);

      await settle();

      expect(mockFixValidation).toHaveBeenCalled();
      expect(mockCheckUncommitted).toHaveBeenCalled();

      // commitChanges called twice: user commit + fix commit
      expect(mockCommitChangesActor).toHaveBeenCalledTimes(2);
      // runValidation called twice: initial + re-validate
      expect(mockRunValidation).toHaveBeenCalledTimes(2);

      const last = lastBroadcast();
      expect(last.status).toBe("completed");
      expect(last.commitHash).toBe("commit789");
    });

    it("validation fails → max retries → failed", async () => {
      mockCommitChangesActor.mockResolvedValue({ hash: "commit789" });
      mockRunValidation.mockRejectedValue(new Error("lint errors"));
      mockFixValidation.mockResolvedValue({
        status: "fixed" as const,
      });
      mockCheckUncommitted.mockResolvedValue({ hasChanges: true });

      const result = dispatchCommitJob(BASE_COMMIT_PARAMS);
      expect(result.ok).toBe(true);

      await settle();

      const last = lastBroadcast();
      expect(last.status).toBe("failed");
    });

    it("commitHash present even when validation fails permanently", async () => {
      mockCommitChangesActor.mockResolvedValue({ hash: "commit789" });
      mockRunValidation.mockRejectedValue(new Error("lint errors"));
      mockFixValidation.mockResolvedValue({
        status: "failed" as const,
      });

      const result = dispatchCommitJob(BASE_COMMIT_PARAMS);
      expect(result.ok).toBe(true);

      await settle();

      const job = getJob(
        BASE_COMMIT_PARAMS.projectPath,
        BASE_COMMIT_PARAMS.sessionName,
      );
      expect(job?.status).toBe("failed");
      expect(job?.commitHash).toBe("commit789");
    });
  });

  // ----------------------------------------------------------
  // Lock lifecycle
  // ----------------------------------------------------------
  describe("lock lifecycle", () => {
    it("session lock is always released even when pipeline throws", async () => {
      mockMergeMain.mockRejectedValue(new Error("unexpected"));

      dispatchMergeJob(BASE_MERGE_PARAMS);
      await settle();

      expect(releaseSession).toHaveBeenCalledTimes(1);
    });

    it("session lock is always released on commit failure", async () => {
      mockCommitChangesActor.mockRejectedValue(new Error("commit failed"));

      dispatchCommitJob(BASE_COMMIT_PARAMS);
      await settle();

      expect(releaseSession).toHaveBeenCalledTimes(1);
    });
  });

  // ----------------------------------------------------------
  // Stale job timeout recovery
  // ----------------------------------------------------------
  describe("stale job timeout recovery", () => {
    it("force-transitions stale running job and allows new dispatch", async () => {
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockSquashMergeActor.mockResolvedValue({ mergeHash: "abc" });

      const first = dispatchMergeJob(BASE_MERGE_PARAMS);
      expect(first.ok).toBe(true);

      // Manually make the job stale by backdating startedAt
      const job = getJob(
        BASE_MERGE_PARAMS.projectPath,
        BASE_MERGE_PARAMS.sessionName,
      );
      expect(job).toBeDefined();
      job!.startedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();

      // New dispatch should succeed because the old job is stale
      mockAcquireSessionLock.mockReturnValue(vi.fn());
      const second = dispatchMergeJob(BASE_MERGE_PARAMS);
      expect(second.ok).toBe(true);
    });
  });

  // ----------------------------------------------------------
  // dispatchResolveConflictsJob
  // ----------------------------------------------------------
  describe("dispatchResolveConflictsJob", () => {
    it("successful resolution → commit → squash merge → completed", async () => {
      mockResolveConflictsActor.mockResolvedValue({
        status: "resolved",
        conflicts: [
          {
            file: "file1.ts",
            description: "conflict",
            resolution: "resolved",
            rationale: "reason",
          },
        ],
      });
      mockCommitChangesActor.mockResolvedValue({ hash: "resolve_hash" });
      mockSquashMergeActor.mockResolvedValue({ mergeHash: "squash_hash" });

      const result = dispatchResolveConflictsJob(BASE_RESOLVE_PARAMS);
      expect(result.ok).toBe(true);

      await settle();

      expect(mockResolveConflictsActor).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreePath: BASE_RESOLVE_PARAMS.worktreePath,
        }),
      );
      expect(mockCommitChangesActor).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreePath: BASE_RESOLVE_PARAMS.worktreePath,
          message: "resolve merge conflicts",
          skipHooks: true,
        }),
      );
      expect(mockRunValidation).toHaveBeenCalled();
      expect(mockSquashMergeActor).toHaveBeenCalledWith(
        expect.objectContaining({
          projectPath: BASE_RESOLVE_PARAMS.projectPath,
          branchName: BASE_RESOLVE_PARAMS.branchName,
          message: BASE_RESOLVE_PARAMS.mergeMessage,
        }),
      );

      const last = lastBroadcast();
      expect(last.status).toBe("completed");
      expect(last.mergeHash).toBe("squash_hash");
      expect(last.jobType).toBe("resolve-conflicts");

      const analysis = getConflictAnalysis(
        BASE_RESOLVE_PARAMS.projectPath,
        BASE_RESOLVE_PARAMS.sessionName,
      );
      expect(analysis?.conflicts).toHaveLength(1);

      expect(releaseSession).toHaveBeenCalled();
    });

    it("resolution failure → conflicts broadcast", async () => {
      mockResolveConflictsActor.mockResolvedValue({
        status: "failed",
        conflicts: [],
        partialConflicts: [
          {
            file: "a.ts",
            description: "d",
            resolution: "r",
            rationale: "r",
          },
        ],
      });

      const result = dispatchResolveConflictsJob(BASE_RESOLVE_PARAMS);
      expect(result.ok).toBe(true);

      await settle();

      const last = lastBroadcast();
      expect(last.status).toBe("conflicts");

      expect(releaseSession).toHaveBeenCalled();
    });

    it("passes decisions to resolveConflicts actor", async () => {
      mockResolveConflictsActor.mockResolvedValue({
        status: "resolved",
        conflicts: [],
      });
      mockCommitChangesActor.mockResolvedValue({ hash: "h" });
      mockSquashMergeActor.mockResolvedValue({ mergeHash: "m" });

      const decisions = [
        { file: "file1.ts", decision: "approved" as const },
        {
          file: "file2.ts",
          decision: "rejected" as const,
          feedback: "use theirs",
        },
      ];

      dispatchResolveConflictsJob({ ...BASE_RESOLVE_PARAMS, decisions });
      await settle();

      expect(mockResolveConflictsActor).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreePath: BASE_RESOLVE_PARAMS.worktreePath,
          decisions,
        }),
      );
    });

    it("pre-merge validation is called in resolve-conflicts job", async () => {
      mockResolveConflictsActor.mockResolvedValue({
        status: "resolved",
        conflicts: [],
      });
      mockCommitChangesActor.mockResolvedValue({ hash: "h" });
      mockSquashMergeActor.mockResolvedValue({ mergeHash: "m" });

      dispatchResolveConflictsJob(BASE_RESOLVE_PARAMS);
      await settle();

      expect(mockRunValidation).toHaveBeenCalledWith(
        expect.objectContaining({
          projectPath: BASE_RESOLVE_PARAMS.projectPath,
          worktreePath: BASE_RESOLVE_PARAMS.worktreePath,
          sessionName: BASE_RESOLVE_PARAMS.sessionName,
          branchName: BASE_RESOLVE_PARAMS.branchName,
        }),
      );

      const validationOrder = mockRunValidation.mock.invocationCallOrder[0]!;
      const squashOrder = mockSquashMergeActor.mock.invocationCallOrder[0]!;
      expect(validationOrder).toBeLessThan(squashOrder);
    });

    it("failed validation in resolve-conflicts blocks squash", async () => {
      mockResolveConflictsActor.mockResolvedValue({
        status: "resolved",
        conflicts: [],
      });
      mockCommitChangesActor.mockResolvedValue({ hash: "h" });
      mockRunValidation.mockRejectedValue(
        new Error("Pre-merge validation failed"),
      );

      dispatchResolveConflictsJob(BASE_RESOLVE_PARAMS);
      await settle();

      expect(mockSquashMergeActor).not.toHaveBeenCalled();
      const last = lastBroadcast();
      expect(last.status).toBe("failed");
      expect(last.errorMessage).toContain("Pre-merge validation failed");
    });

    it("error in pipeline → failed broadcast", async () => {
      mockResolveConflictsActor.mockRejectedValue(
        new Error("SDK connection failed"),
      );

      dispatchResolveConflictsJob(BASE_RESOLVE_PARAMS);
      await settle();

      const last = lastBroadcast();
      expect(last.status).toBe("failed");
      expect(last.errorMessage).toContain("SDK connection failed");

      expect(releaseSession).toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // getJob / getConflictAnalysis
  // ----------------------------------------------------------
  describe("getJob and getConflictAnalysis", () => {
    it("getJob returns undefined for unknown session", () => {
      const job = getJob("/unknown", "unknown-session");
      expect(job).toBeUndefined();
    });

    it("getConflictAnalysis returns undefined when no analysis stored", () => {
      const analysis = getConflictAnalysis("/unknown", "unknown-session");
      expect(analysis).toBeUndefined();
    });

    it("getJob returns the job after dispatch", () => {
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockSquashMergeActor.mockResolvedValue({ mergeHash: "abc" });

      dispatchMergeJob(BASE_MERGE_PARAMS);

      const job = getJob(
        BASE_MERGE_PARAMS.projectPath,
        BASE_MERGE_PARAMS.sessionName,
      );
      expect(job).toBeDefined();
      expect(job?.jobType).toBe("merge");
      expect(job?.status).toBe("running");
    });
  });

  // ----------------------------------------------------------
  // targetBranch threading
  // ----------------------------------------------------------
  describe("targetBranch threading", () => {
    it("dispatchMergeJob passes targetBranch and targetWorktreePath to MergeInput", async () => {
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockSquashMergeActor.mockResolvedValue({ mergeHash: "abc123" });

      const result = dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        targetBranch: "csm/parent-branch",
        targetWorktreePath: "/projects/foo/.worktrees/parent",
      });
      expect(result.ok).toBe(true);

      await settle();

      // mergeMain actor should receive targetBranch
      expect(mockMergeMain).toHaveBeenCalledWith(
        expect.objectContaining({
          targetBranch: "csm/parent-branch",
        }),
      );
      // squashMerge actor should receive targetBranch and targetWorktreePath
      expect(mockSquashMergeActor).toHaveBeenCalledWith(
        expect.objectContaining({
          targetBranch: "csm/parent-branch",
          targetWorktreePath: "/projects/foo/.worktrees/parent",
        }),
      );
    });

    it("dispatchResolveConflictsJob passes targetBranch and targetWorktreePath to MergeInput", async () => {
      mockResolveConflictsActor.mockResolvedValue({
        status: "resolved",
        conflicts: [],
      });
      mockCommitChangesActor.mockResolvedValue({ hash: "h" });
      mockSquashMergeActor.mockResolvedValue({ mergeHash: "m" });

      const result = dispatchResolveConflictsJob({
        ...BASE_RESOLVE_PARAMS,
        targetBranch: "csm/parent-branch",
        targetWorktreePath: "/projects/foo/.worktrees/parent",
      });
      expect(result.ok).toBe(true);

      await settle();

      expect(mockSquashMergeActor).toHaveBeenCalledWith(
        expect.objectContaining({
          targetBranch: "csm/parent-branch",
          targetWorktreePath: "/projects/foo/.worktrees/parent",
        }),
      );
    });

    it("stores targetBranch on the registered BackgroundJob", () => {
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockSquashMergeActor.mockResolvedValue({ mergeHash: "abc" });

      dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        targetBranch: "csm/parent-branch",
      });

      const job = getJob(
        BASE_MERGE_PARAMS.projectPath,
        BASE_MERGE_PARAMS.sessionName,
      );
      expect(job?.targetBranch).toBe("csm/parent-branch");
    });

    it("defaults targetBranch to undefined on job when not provided", () => {
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockSquashMergeActor.mockResolvedValue({ mergeHash: "abc" });

      dispatchMergeJob(BASE_MERGE_PARAMS);

      const job = getJob(
        BASE_MERGE_PARAMS.projectPath,
        BASE_MERGE_PARAMS.sessionName,
      );
      expect(job?.targetBranch).toBeUndefined();
    });

    it("notification message includes target branch for merge completion", async () => {
      const { createNotification: mockCreateNotification } =
        await import("./notification-db");
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockSquashMergeActor.mockResolvedValue({ mergeHash: "abc123" });

      dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        targetBranch: "csm/parent-branch",
      });
      await settle();

      expect(mockCreateNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("csm/parent-branch"),
        }),
      );
    });

    it("notification message includes target branch for conflicts", async () => {
      const { createNotification: mockCreateNotification } =
        await import("./notification-db");
      mockMergeMain.mockResolvedValue({
        status: "conflicts",
        conflictFiles: ["file1.ts"],
      });

      dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        autoResolve: false,
        targetBranch: "csm/parent-branch",
      });
      await settle();

      expect(mockCreateNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("csm/parent-branch"),
        }),
      );
    });
  });

  // ----------------------------------------------------------
  // _resetForTesting
  // ----------------------------------------------------------
  describe("_resetForTesting", () => {
    it("clears all jobs and analyses", () => {
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockSquashMergeActor.mockResolvedValue({ mergeHash: "abc" });

      dispatchMergeJob(BASE_MERGE_PARAMS);
      expect(
        getJob(BASE_MERGE_PARAMS.projectPath, BASE_MERGE_PARAMS.sessionName),
      ).toBeDefined();

      _resetForTesting();

      expect(
        getJob(BASE_MERGE_PARAMS.projectPath, BASE_MERGE_PARAMS.sessionName),
      ).toBeUndefined();
    });
  });

  describe("getActiveJobs", () => {
    it("returns only running jobs from the registry", async () => {
      // Dispatch a merge job (stays running because actors block)
      let resolveActor: (() => void) | undefined;
      mockCheckUncommitted.mockReturnValue(
        new Promise<{ hasChanges: boolean }>((resolve) => {
          resolveActor = () => resolve({ hasChanges: false });
        }),
      );
      mockAcquireSessionLock.mockReturnValue(() => {});

      dispatchMergeJob(BASE_MERGE_PARAMS);

      const active = getActiveJobs();
      expect(active).toHaveLength(1);
      expect(active[0]?.status).toBe("running");

      // Clean up — resolve the blocked actor
      resolveActor?.();
      await settle();
    });

    it("returns empty array when no jobs are running", () => {
      expect(getActiveJobs()).toHaveLength(0);
    });
  });
});
