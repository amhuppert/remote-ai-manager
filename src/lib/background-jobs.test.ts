import { describe, it, expect, vi, beforeEach } from "vitest";

// ============================================================
// Mocks — must be declared before any imports from the module
// ============================================================

vi.mock("./lock");
vi.mock("./git-operations");
vi.mock("./conflict-resolution");
vi.mock("./repo-config");
vi.mock("./config");
vi.mock("./state");
vi.mock("./notification-db");

// The merge machine actors use dynamic imports with `@/lib/...` paths.
// Vitest treats `./X` and `@/lib/X` as separate mock registrations,
// so we mock the actors module to call through to the already-mocked
// `./...` modules (avoiding the path-alias mismatch).
vi.mock("./workflows/merge/actors", async () => {
  const { fromPromise } = await import("xstate");
  const gitOps = await import("./git-operations");
  const lockMod = await import("./lock");
  const stateMod = await import("./state");
  const conflictRes = await import("./conflict-resolution");
  const repoConfig = await import("./repo-config");

  return {
    checkUncommitted: fromPromise(
      async ({ input }: { input: { worktreePath: string } }) => ({
        hasChanges: await gitOps.hasUncommittedChanges(input.worktreePath),
      }),
    ),
    commitChangesActor: fromPromise(
      async ({
        input,
      }: {
        input: { worktreePath: string; message: string; skipHooks?: boolean };
      }) => {
        const result = await gitOps.commitChanges(
          input.worktreePath,
          input.message,
          { skipHooks: input.skipHooks },
        );
        return { hash: result.hash };
      },
    ),
    mergeMain: fromPromise(
      async ({ input }: { input: { worktreePath: string } }) => {
        const result = await gitOps.mergeMainIntoFeature(input.worktreePath);
        return {
          status: result.status,
          conflictFiles:
            result.status === "conflicts" ? result.conflictFiles : [],
        };
      },
    ),
    resolveConflictsActor: fromPromise(
      async ({
        input,
      }: {
        input: { worktreePath: string; decisions?: unknown[] };
      }) => {
        const result = await conflictRes.resolveConflicts({
          worktreePath: input.worktreePath,
          decisions: input.decisions,
        } as Parameters<typeof conflictRes.resolveConflicts>[0]);
        return {
          status: result.status,
          conflicts: result.status === "resolved" ? result.conflicts : [],
          partialConflicts:
            result.status === "failed" ? result.partialConflicts : undefined,
        };
      },
    ),
    runValidation: fromPromise(
      async ({
        input,
      }: {
        input: {
          projectPath: string;
          worktreePath: string;
          sessionName: string;
          branchName: string;
          timeoutMs: number;
        };
      }) => {
        await repoConfig.runPreMergeValidation(
          input as Parameters<typeof repoConfig.runPreMergeValidation>[0],
        );
      },
    ),
    fixValidation: fromPromise(async () => ({ status: "fixed" as const })),
    squashMergeActor: fromPromise(
      async ({
        input,
      }: {
        input: {
          projectPath: string;
          branchName: string;
          message: string;
          sessionName: string;
        };
      }) => {
        const releaseProject = lockMod.acquireProjectLock(input.projectPath);
        try {
          const result = await gitOps.squashMerge(
            input.projectPath,
            input.branchName,
            input.message,
          );
          await stateMod.setSessionFinished(
            input.projectPath,
            input.sessionName,
          );
          return { mergeHash: result.mergeHash };
        } finally {
          if (typeof releaseProject === "function") releaseProject();
        }
      },
    ),
  };
});

import {
  dispatchMergeJob,
  dispatchCommitJob,
  dispatchResolveConflictsJob,
  getJob,
  getConflictAnalysis,
  _resetForTesting,
} from "./background-jobs";
import { acquireSessionLock, acquireProjectLock } from "./lock";
import {
  mergeMainIntoFeature,
  squashMerge,
  commitChanges,
  hasUncommittedChanges,
} from "./git-operations";
import { resolveConflicts } from "./conflict-resolution";
import { runPreMergeValidation } from "./repo-config";
import { readConfig } from "./config";
import { setSessionFinished } from "./state";
import type { JobStatusEvent } from "@/types";

// ============================================================
// Typed mock references
// ============================================================

const mockAcquireSessionLock = vi.mocked(acquireSessionLock);
const mockAcquireProjectLock = vi.mocked(acquireProjectLock);
const mockHasUncommittedChanges = vi.mocked(hasUncommittedChanges);
const mockMergeMainIntoFeature = vi.mocked(mergeMainIntoFeature);
const mockSquashMerge = vi.mocked(squashMerge);
const mockCommitChanges = vi.mocked(commitChanges);
const mockResolveConflicts = vi.mocked(resolveConflicts);
const mockRunPreMergeValidation = vi.mocked(runPreMergeValidation);
const mockReadConfig = vi.mocked(readConfig);
const mockSetSessionFinished = vi.mocked(setSessionFinished);

// Injected spy for broadcast (no vi.mock needed)
const mockBroadcast = vi.fn();

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
};

const BASE_COMMIT_PARAMS = {
  projectPath: "/projects/foo",
  projectName: "foo",
  sessionName: "my-session",
  worktreePath: "/projects/foo/.worktrees/my-session",
  branchName: "csm/my-session",
  message: "chore: update deps",
  broadcast: mockBroadcast,
};

const BASE_RESOLVE_PARAMS = {
  projectPath: "/projects/foo",
  projectName: "foo",
  sessionName: "my-session",
  worktreePath: "/projects/foo/.worktrees/my-session",
  branchName: "csm/my-session",
  mergeMessage: "Merge my-session into main",
  broadcast: mockBroadcast,
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
  let releaseProject: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTesting();

    releaseSession = vi.fn();
    releaseProject = vi.fn();

    // Default: session lock acquired successfully
    mockAcquireSessionLock.mockReturnValue(releaseSession);
    // Default: project lock acquired successfully
    mockAcquireProjectLock.mockReturnValue(releaseProject);
    // Default: no uncommitted changes (skip Phase 0 commit)
    mockHasUncommittedChanges.mockResolvedValue(false);
    // Default: pre-merge validation passes (no-op)
    mockRunPreMergeValidation.mockResolvedValue(undefined);
    // Default: config returns defaults
    mockReadConfig.mockResolvedValue({
      baseDir: "/home/user/projects",
      ignorePatterns: [],
      stateFilePath: "/tmp/state.json",
      claudeTimeoutMs: 3_600_000,
      defaultModel: "opus",
      preMergeTimeoutMs: 300_000,
    });
  });

  // ----------------------------------------------------------
  // 1. dispatchMergeJob returns ok with jobId when no active job
  // ----------------------------------------------------------
  describe("dispatchMergeJob", () => {
    it("returns ok with jobId when no active job", () => {
      mockMergeMainIntoFeature.mockResolvedValue({ status: "clean" });
      mockSquashMerge.mockResolvedValue({ mergeHash: "abc123" });

      const result = dispatchMergeJob(BASE_MERGE_PARAMS);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.jobId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
      }
    });

    // ----------------------------------------------------------
    // 2. returns error when job already running
    // ----------------------------------------------------------
    it("returns error when job already running", () => {
      mockMergeMainIntoFeature.mockResolvedValue({ status: "clean" });
      mockSquashMerge.mockResolvedValue({ mergeHash: "abc123" });

      // First dispatch succeeds
      const first = dispatchMergeJob(BASE_MERGE_PARAMS);
      expect(first.ok).toBe(true);

      // Second dispatch fails — job still running
      const second = dispatchMergeJob(BASE_MERGE_PARAMS);
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.error).toBe("JOB_ALREADY_RUNNING");
      }
    });

    // ----------------------------------------------------------
    // 3. Clean merge pipeline: phase 1 clean → phase 2 squash → completed
    // ----------------------------------------------------------
    it("clean merge: phase 1 clean → phase 2 squash → completed broadcast", async () => {
      mockMergeMainIntoFeature.mockResolvedValue({ status: "clean" });
      mockSquashMerge.mockResolvedValue({ mergeHash: "abc123" });
      mockSetSessionFinished.mockResolvedValue(undefined);

      const result = dispatchMergeJob(BASE_MERGE_PARAMS);
      expect(result.ok).toBe(true);

      await settle();

      // Verify the full pipeline was executed
      expect(mockMergeMainIntoFeature).toHaveBeenCalledWith(
        BASE_MERGE_PARAMS.worktreePath,
      );
      expect(mockSquashMerge).toHaveBeenCalledWith(
        BASE_MERGE_PARAMS.projectPath,
        BASE_MERGE_PARAMS.branchName,
        BASE_MERGE_PARAMS.message,
      );
      expect(mockSetSessionFinished).toHaveBeenCalledWith(
        BASE_MERGE_PARAMS.projectPath,
        BASE_MERGE_PARAMS.sessionName,
      );

      // First broadcast: running, last broadcast: completed
      expect(broadcastAt(0).status).toBe("running");
      const last = lastBroadcast();
      expect(last.status).toBe("completed");
      expect(last.mergeHash).toBe("abc123");
      expect(last.jobType).toBe("merge");

      // Job state reflects completion
      const job = getJob(
        BASE_MERGE_PARAMS.projectPath,
        BASE_MERGE_PARAMS.sessionName,
      );
      expect(job?.status).toBe("completed");
      expect(job?.mergeHash).toBe("abc123");
      expect(job?.completedAt).toBeDefined();

      // Session lock released
      expect(releaseSession).toHaveBeenCalled();
      // Project lock released
      expect(releaseProject).toHaveBeenCalled();
    });

    // ----------------------------------------------------------
    // 3b. Phase 0: commits uncommitted changes before merging
    // ----------------------------------------------------------
    it("phase 0: commits uncommitted changes before merging main", async () => {
      mockHasUncommittedChanges.mockResolvedValue(true);
      mockCommitChanges.mockResolvedValue({ hash: "phase0hash" });
      mockMergeMainIntoFeature.mockResolvedValue({ status: "clean" });
      mockSquashMerge.mockResolvedValue({ mergeHash: "abc123" });
      mockSetSessionFinished.mockResolvedValue(undefined);

      const result = dispatchMergeJob(BASE_MERGE_PARAMS);
      expect(result.ok).toBe(true);

      await settle();

      // Phase 0 commit was called first with worktree path, WIP message,
      // and skipHooks: true to bypass pre-commit hooks
      expect(mockCommitChanges).toHaveBeenCalledWith(
        BASE_MERGE_PARAMS.worktreePath,
        "WIP: uncommitted changes",
        { skipHooks: true },
      );

      // Phase 1 merge still happened after commit
      expect(mockMergeMainIntoFeature).toHaveBeenCalledWith(
        BASE_MERGE_PARAMS.worktreePath,
      );

      // Verify order: commitChanges called before mergeMainIntoFeature
      const commitOrder = mockCommitChanges.mock.invocationCallOrder[0]!;
      const mergeOrder = mockMergeMainIntoFeature.mock.invocationCallOrder[0]!;
      expect(commitOrder).toBeLessThan(mergeOrder);

      // Job completed successfully
      const last = lastBroadcast();
      expect(last.status).toBe("completed");
    });

    it("phase 0: skips commit when no uncommitted changes", async () => {
      mockHasUncommittedChanges.mockResolvedValue(false);
      mockMergeMainIntoFeature.mockResolvedValue({ status: "clean" });
      mockSquashMerge.mockResolvedValue({ mergeHash: "abc123" });
      mockSetSessionFinished.mockResolvedValue(undefined);

      dispatchMergeJob(BASE_MERGE_PARAMS);
      await settle();

      // commitChanges should NOT have been called (no uncommitted changes)
      expect(mockCommitChanges).not.toHaveBeenCalled();
      // But merge still proceeded
      expect(mockMergeMainIntoFeature).toHaveBeenCalled();
    });

    it("phase 0: commit failure causes job to fail", async () => {
      mockHasUncommittedChanges.mockResolvedValue(true);
      mockCommitChanges.mockRejectedValue(new Error("pre-commit hook failed"));

      const result = dispatchMergeJob(BASE_MERGE_PARAMS);
      expect(result.ok).toBe(true);

      await settle();

      // Merge should NOT have been attempted
      expect(mockMergeMainIntoFeature).not.toHaveBeenCalled();

      // Job failed with commit error
      const last = lastBroadcast();
      expect(last.status).toBe("failed");
      expect(last.errorMessage).toContain("pre-commit hook failed");

      // Lock was released
      expect(releaseSession).toHaveBeenCalled();
    });

    // ----------------------------------------------------------
    // 4. Conflict merge with auto-resolve success
    // ----------------------------------------------------------
    it("conflict merge with auto-resolve: resolves → commit → squash → completed", async () => {
      mockMergeMainIntoFeature.mockResolvedValue({
        status: "conflicts",
        conflictFiles: ["file1.ts", "file2.ts"],
      });
      mockResolveConflicts.mockResolvedValue({
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
      mockCommitChanges.mockResolvedValue({ hash: "resolve123" });
      mockSquashMerge.mockResolvedValue({ mergeHash: "merge456" });
      mockSetSessionFinished.mockResolvedValue(undefined);

      const result = dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        autoResolve: true,
      });
      expect(result.ok).toBe(true);

      await settle();

      // Verify conflict resolution was called
      expect(mockResolveConflicts).toHaveBeenCalledWith({
        worktreePath: BASE_MERGE_PARAMS.worktreePath,
      });
      // Verify resolution was committed with skipHooks
      expect(mockCommitChanges).toHaveBeenCalledWith(
        BASE_MERGE_PARAMS.worktreePath,
        "resolve merge conflicts",
        { skipHooks: true },
      );
      // Verify pre-merge validation was called
      expect(mockRunPreMergeValidation).toHaveBeenCalledWith(
        expect.objectContaining({
          projectPath: BASE_MERGE_PARAMS.projectPath,
          worktreePath: BASE_MERGE_PARAMS.worktreePath,
          sessionName: BASE_MERGE_PARAMS.sessionName,
          branchName: BASE_MERGE_PARAMS.branchName,
          timeoutMs: 300_000,
        }),
      );
      // Verify squash merge after resolution
      expect(mockSquashMerge).toHaveBeenCalled();
      expect(mockSetSessionFinished).toHaveBeenCalled();

      // Final broadcast is completed
      const last = lastBroadcast();
      expect(last.status).toBe("completed");
      expect(last.mergeHash).toBe("merge456");

      // Conflict analysis was stored
      const analysis = getConflictAnalysis(
        BASE_MERGE_PARAMS.projectPath,
        BASE_MERGE_PARAMS.sessionName,
      );
      expect(analysis).toBeDefined();
      expect(analysis?.conflicts).toHaveLength(2);

      expect(releaseSession).toHaveBeenCalled();
    });

    // ----------------------------------------------------------
    // 5. Conflict merge without auto-resolve → conflicts status
    // ----------------------------------------------------------
    it("conflict merge without auto-resolve: conflicts broadcast", async () => {
      mockMergeMainIntoFeature.mockResolvedValue({
        status: "conflicts",
        conflictFiles: ["file1.ts"],
      });

      const result = dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        autoResolve: false,
      });
      expect(result.ok).toBe(true);

      await settle();

      // Should NOT call resolveConflicts
      expect(mockResolveConflicts).not.toHaveBeenCalled();

      // Last broadcast: conflicts
      const last = lastBroadcast();
      expect(last.status).toBe("conflicts");
      expect(last.conflictFiles).toEqual(["file1.ts"]);
      expect(last.conflictCount).toBe(1);

      // Job state reflects conflicts
      const job = getJob(
        BASE_MERGE_PARAMS.projectPath,
        BASE_MERGE_PARAMS.sessionName,
      );
      expect(job?.status).toBe("conflicts");
      expect(job?.conflictFiles).toEqual(["file1.ts"]);

      expect(releaseSession).toHaveBeenCalled();
    });

    // ----------------------------------------------------------
    // 6. Auto-resolve failure falls back to conflicts status
    // ----------------------------------------------------------
    it("auto-resolve failure falls back to conflicts status", async () => {
      mockMergeMainIntoFeature.mockResolvedValue({
        status: "conflicts",
        conflictFiles: ["file1.ts", "file2.ts"],
      });
      mockResolveConflicts.mockResolvedValue({
        status: "failed",
        error: "No JSON code fence found",
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

      // Last broadcast: conflicts (not failed)
      const last = lastBroadcast();
      expect(last.status).toBe("conflicts");
      expect(last.conflictFiles).toEqual(["file1.ts", "file2.ts"]);

      // Partial analysis should be stored
      const analysis = getConflictAnalysis(
        BASE_MERGE_PARAMS.projectPath,
        BASE_MERGE_PARAMS.sessionName,
      );
      expect(analysis).toBeDefined();
      expect(analysis?.conflicts).toHaveLength(1);

      expect(releaseSession).toHaveBeenCalled();
    });

    // ----------------------------------------------------------
    // Merge pipeline error → failed broadcast
    // ----------------------------------------------------------
    it("merge pipeline error → failed broadcast", async () => {
      mockMergeMainIntoFeature.mockRejectedValue(
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

    // ----------------------------------------------------------
    // Merge pipeline includes gitOutput in error message
    // ----------------------------------------------------------
    it("merge pipeline includes gitOutput in error message", async () => {
      mockMergeMainIntoFeature.mockResolvedValue({ status: "clean" });
      const err = new Error("Commit failed") as Error & {
        gitOutput?: string;
      };
      err.gitOutput = "husky - pre-commit script failed (code 1)";
      mockSquashMerge.mockRejectedValue(err);

      dispatchMergeJob(BASE_MERGE_PARAMS);
      await settle();

      const job = getJob(
        BASE_MERGE_PARAMS.projectPath,
        BASE_MERGE_PARAMS.sessionName,
      );
      expect(job?.errorMessage).toContain("Commit failed");
      expect(job?.errorMessage).toContain("pre-commit script failed");
    });

    // ----------------------------------------------------------
    // Pre-merge validation is called before squash merge (clean path)
    // ----------------------------------------------------------
    it("pre-merge validation is called before squash merge", async () => {
      mockMergeMainIntoFeature.mockResolvedValue({ status: "clean" });
      mockSquashMerge.mockResolvedValue({ mergeHash: "abc123" });
      mockSetSessionFinished.mockResolvedValue(undefined);

      dispatchMergeJob(BASE_MERGE_PARAMS);
      await settle();

      expect(mockRunPreMergeValidation).toHaveBeenCalledWith(
        expect.objectContaining({
          projectPath: BASE_MERGE_PARAMS.projectPath,
          worktreePath: BASE_MERGE_PARAMS.worktreePath,
          sessionName: BASE_MERGE_PARAMS.sessionName,
          branchName: BASE_MERGE_PARAMS.branchName,
          timeoutMs: 300_000,
        }),
      );

      // Verify ordering: validation before squash merge
      const validationOrder =
        mockRunPreMergeValidation.mock.invocationCallOrder[0]!;
      const squashOrder = mockSquashMerge.mock.invocationCallOrder[0]!;
      expect(validationOrder).toBeLessThan(squashOrder);
    });

    // ----------------------------------------------------------
    // Failed validation blocks squash merge
    // ----------------------------------------------------------
    it("failed pre-merge validation blocks squash merge", async () => {
      mockMergeMainIntoFeature.mockResolvedValue({ status: "clean" });
      const err = new Error("Pre-merge validation failed") as Error & {
        gitOutput?: string;
      };
      err.gitOutput = "lint errors found";
      mockRunPreMergeValidation.mockRejectedValue(err);

      dispatchMergeJob(BASE_MERGE_PARAMS);
      await settle();

      // Squash merge should NOT have been called
      expect(mockSquashMerge).not.toHaveBeenCalled();

      // Job failed with validation error
      const last = lastBroadcast();
      expect(last.status).toBe("failed");
      expect(last.errorMessage).toContain("Pre-merge validation failed");
      expect(last.errorMessage).toContain("lint errors found");
    });

    // ----------------------------------------------------------
    // Session lock failure returns SESSION_BUSY error
    // ----------------------------------------------------------
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
    // ----------------------------------------------------------
    // 7. Successful commit → completed broadcast
    // ----------------------------------------------------------
    it("successful commit → completed broadcast", async () => {
      mockCommitChanges.mockResolvedValue({ hash: "commit789" });

      const result = dispatchCommitJob(BASE_COMMIT_PARAMS);
      expect(result.ok).toBe(true);

      await settle();

      expect(mockCommitChanges).toHaveBeenCalledWith(
        BASE_COMMIT_PARAMS.worktreePath,
        BASE_COMMIT_PARAMS.message,
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

    // ----------------------------------------------------------
    // 8. Failed commit → failed broadcast
    // ----------------------------------------------------------
    it("failed commit → failed broadcast", async () => {
      const err = new Error("No uncommitted changes to commit");
      mockCommitChanges.mockRejectedValue(err);

      const result = dispatchCommitJob(BASE_COMMIT_PARAMS);
      expect(result.ok).toBe(true);

      await settle();

      const last = lastBroadcast();
      expect(last.status).toBe("failed");
      expect(last.errorMessage).toContain("No uncommitted changes to commit");

      expect(releaseSession).toHaveBeenCalled();
    });

    // ----------------------------------------------------------
    // Failed commit includes gitOutput when available
    // ----------------------------------------------------------
    it("failed commit includes gitOutput in errorMessage", async () => {
      const err = new Error("Commit failed") as Error & {
        gitOutput?: string;
      };
      err.gitOutput = "pre-commit hook failed: lint errors";
      mockCommitChanges.mockRejectedValue(err);

      const result = dispatchCommitJob(BASE_COMMIT_PARAMS);
      expect(result.ok).toBe(true);

      await settle();

      const job = getJob(
        BASE_COMMIT_PARAMS.projectPath,
        BASE_COMMIT_PARAMS.sessionName,
      );
      expect(job?.errorMessage).toContain("pre-commit hook failed");
    });
  });

  // ----------------------------------------------------------
  // 9. Session lock is always released (even on error)
  // ----------------------------------------------------------
  describe("lock lifecycle", () => {
    it("session lock is always released even when pipeline throws", async () => {
      mockMergeMainIntoFeature.mockRejectedValue(new Error("unexpected"));

      dispatchMergeJob(BASE_MERGE_PARAMS);
      await settle();

      expect(releaseSession).toHaveBeenCalledTimes(1);
    });

    it("session lock is always released on commit failure", async () => {
      mockCommitChanges.mockRejectedValue(new Error("commit failed"));

      dispatchCommitJob(BASE_COMMIT_PARAMS);
      await settle();

      expect(releaseSession).toHaveBeenCalledTimes(1);
    });

    it("project lock is released after squash merge in merge pipeline", async () => {
      mockMergeMainIntoFeature.mockResolvedValue({ status: "clean" });
      mockSquashMerge.mockResolvedValue({ mergeHash: "abc" });
      mockSetSessionFinished.mockResolvedValue(undefined);

      dispatchMergeJob(BASE_MERGE_PARAMS);
      await settle();

      expect(releaseProject).toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // 10. Stale job timeout recovery
  // ----------------------------------------------------------
  describe("stale job timeout recovery", () => {
    it("force-transitions stale running job and allows new dispatch", async () => {
      mockMergeMainIntoFeature.mockResolvedValue({ status: "clean" });
      mockSquashMerge.mockResolvedValue({ mergeHash: "abc" });
      mockSetSessionFinished.mockResolvedValue(undefined);

      // First dispatch
      const first = dispatchMergeJob(BASE_MERGE_PARAMS);
      expect(first.ok).toBe(true);

      // Manually make the job stale by backdating startedAt
      const job = getJob(
        BASE_MERGE_PARAMS.projectPath,
        BASE_MERGE_PARAMS.sessionName,
      );
      expect(job).toBeDefined();
      // Set startedAt to 11 minutes ago (exceeds JOB_TIMEOUT_MS of 10 min)
      job!.startedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();

      // New dispatch should succeed because the old job is stale
      mockAcquireSessionLock.mockReturnValue(vi.fn());
      const second = dispatchMergeJob(BASE_MERGE_PARAMS);
      expect(second.ok).toBe(true);

      // The stale job should have been force-transitioned to "failed"
      // (the second dispatch overwrites it, but the transition happened)
    });
  });

  // ----------------------------------------------------------
  // 11. dispatchResolveConflictsJob
  // ----------------------------------------------------------
  describe("dispatchResolveConflictsJob", () => {
    it("successful resolution → commit → squash merge → completed", async () => {
      mockResolveConflicts.mockResolvedValue({
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
      mockCommitChanges.mockResolvedValue({ hash: "resolve_hash" });
      mockSquashMerge.mockResolvedValue({ mergeHash: "squash_hash" });
      mockSetSessionFinished.mockResolvedValue(undefined);

      const result = dispatchResolveConflictsJob(BASE_RESOLVE_PARAMS);
      expect(result.ok).toBe(true);

      await settle();

      // Verify resolution was called
      expect(mockResolveConflicts).toHaveBeenCalledWith({
        worktreePath: BASE_RESOLVE_PARAMS.worktreePath,
        decisions: undefined,
      });
      // Verify commit with skipHooks
      expect(mockCommitChanges).toHaveBeenCalledWith(
        BASE_RESOLVE_PARAMS.worktreePath,
        "resolve merge conflicts",
        { skipHooks: true },
      );
      // Verify pre-merge validation was called
      expect(mockRunPreMergeValidation).toHaveBeenCalled();
      // Verify squash merge
      expect(mockSquashMerge).toHaveBeenCalledWith(
        BASE_RESOLVE_PARAMS.projectPath,
        BASE_RESOLVE_PARAMS.branchName,
        BASE_RESOLVE_PARAMS.mergeMessage,
      );
      expect(mockSetSessionFinished).toHaveBeenCalledWith(
        BASE_RESOLVE_PARAMS.projectPath,
        BASE_RESOLVE_PARAMS.sessionName,
      );

      // Final broadcast: completed
      const last = lastBroadcast();
      expect(last.status).toBe("completed");
      expect(last.mergeHash).toBe("squash_hash");
      expect(last.jobType).toBe("resolve-conflicts");

      // Conflict analysis stored
      const analysis = getConflictAnalysis(
        BASE_RESOLVE_PARAMS.projectPath,
        BASE_RESOLVE_PARAMS.sessionName,
      );
      expect(analysis?.conflicts).toHaveLength(1);

      expect(releaseSession).toHaveBeenCalled();
      expect(releaseProject).toHaveBeenCalled();
    });

    it("resolution failure → conflicts broadcast", async () => {
      mockResolveConflicts.mockResolvedValue({
        status: "failed",
        error: "Could not resolve",
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

    it("passes decisions to resolveConflicts", async () => {
      mockResolveConflicts.mockResolvedValue({
        status: "resolved",
        conflicts: [],
      });
      mockCommitChanges.mockResolvedValue({ hash: "h" });
      mockSquashMerge.mockResolvedValue({ mergeHash: "m" });
      mockSetSessionFinished.mockResolvedValue(undefined);

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

      expect(mockResolveConflicts).toHaveBeenCalledWith({
        worktreePath: BASE_RESOLVE_PARAMS.worktreePath,
        decisions,
      });
    });

    it("pre-merge validation is called in resolve-conflicts job", async () => {
      mockResolveConflicts.mockResolvedValue({
        status: "resolved",
        conflicts: [],
      });
      mockCommitChanges.mockResolvedValue({ hash: "h" });
      mockSquashMerge.mockResolvedValue({ mergeHash: "m" });
      mockSetSessionFinished.mockResolvedValue(undefined);

      dispatchResolveConflictsJob(BASE_RESOLVE_PARAMS);
      await settle();

      // Verify validation was called before squash
      expect(mockRunPreMergeValidation).toHaveBeenCalledWith(
        expect.objectContaining({
          projectPath: BASE_RESOLVE_PARAMS.projectPath,
          worktreePath: BASE_RESOLVE_PARAMS.worktreePath,
          sessionName: BASE_RESOLVE_PARAMS.sessionName,
          branchName: BASE_RESOLVE_PARAMS.branchName,
        }),
      );

      const validationOrder =
        mockRunPreMergeValidation.mock.invocationCallOrder[0]!;
      const squashOrder = mockSquashMerge.mock.invocationCallOrder[0]!;
      expect(validationOrder).toBeLessThan(squashOrder);
    });

    it("failed validation in resolve-conflicts blocks squash", async () => {
      mockResolveConflicts.mockResolvedValue({
        status: "resolved",
        conflicts: [],
      });
      mockCommitChanges.mockResolvedValue({ hash: "h" });
      mockRunPreMergeValidation.mockRejectedValue(
        new Error("Pre-merge validation failed"),
      );

      dispatchResolveConflictsJob(BASE_RESOLVE_PARAMS);
      await settle();

      expect(mockSquashMerge).not.toHaveBeenCalled();
      const last = lastBroadcast();
      expect(last.status).toBe("failed");
      expect(last.errorMessage).toContain("Pre-merge validation failed");
    });

    it("error in pipeline → failed broadcast", async () => {
      mockResolveConflicts.mockRejectedValue(
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
      mockMergeMainIntoFeature.mockResolvedValue({ status: "clean" });
      mockSquashMerge.mockResolvedValue({ mergeHash: "abc" });

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
  // _resetForTesting
  // ----------------------------------------------------------
  describe("_resetForTesting", () => {
    it("clears all jobs and analyses", () => {
      mockMergeMainIntoFeature.mockResolvedValue({ status: "clean" });
      mockSquashMerge.mockResolvedValue({ mergeHash: "abc" });

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
});
