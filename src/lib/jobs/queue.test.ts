import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fromPromise } from "xstate";
import { defaultGitClient } from "../git/client";
import {
  abortSessionJob,
  dispatchMergeJob,
  dispatchCommitJob,
  dispatchResolveConflictsJob,
  dispatchRebaseJob,
  getJob,
  getActiveJobs,
  getConflictAnalysis,
  getFinalizingSessionMergeJob,
  runRegisteredMergeJob,
  _resetForTesting,
  type AcquireSessionLockFn,
} from "./queue";
import { mergeMachine } from "../workflows/merge/machine";
import {
  registerMergeAssociationResolver,
  _resetMergeAssociationResolverForTesting,
} from "../workflows/merge/association-port";
import {
  registerMergeDeliveryLifecycle,
  _resetMergeDeliveryLifecycleForTesting,
} from "../workflows/merge/delivery-lifecycle-port";
import { commitMachine } from "../workflows/commit/machine";
import { rebaseMachine } from "../workflows/rebase/machine";
import type {
  CheckTrackedChangesInput,
  CheckTrackedChangesOutput,
  ResolveOntoInput,
  ResolveOntoOutput,
  StartRebaseInput,
  ContinueRebaseInput,
  RebaseStepOutput,
  ResolveConflictsInput as RebaseResolveConflictsInput,
  ResolveConflictsOutput as RebaseResolveConflictsOutput,
  AbortRebaseInput,
  AbortRebaseOutput,
} from "../workflows/rebase/actors";
import type {
  AbortMergeCleanupInput,
  AbortMergeCleanupOutput,
  AbortStaleMergeInput,
  AbortStaleMergeOutput,
  ClassifyWorktreeInput,
  ClassifyWorktreeOutput,
  CommitResolutionInput,
  CommitResolutionOutput,
  GetCurrentBranchInput,
  GetCurrentBranchOutput,
  MergeMainInput,
  MergeMainOutput,
  ResolveConflictsInput,
  ResolveConflictsOutput,
  AnalyzeConflictsInput,
  AnalyzeConflictsOutput,
  PrepareActorInput,
  PrepareActorOutput,
  PublishActorInput,
  PublishActorOutput,
  DeliveryGateActorInput,
  DeliveryGateActorOutput,
  DiscardParkedRefInput,
  DiscardParkedRefOutput,
} from "../workflows/merge/actors";
import type {
  CheckUncommittedInput,
  CheckUncommittedOutput,
  CommitChangesInput,
  CommitChangesOutput,
  RunValidationInput,
  RunValidationOutput,
  FixValidationInput,
  FixValidationOutput,
} from "../workflows/validation-fix/actors";
import { validationFixLoopError } from "../workflows/validation-fix/actors";
import { getTraceContext, runWithTrace, type TraceContext } from "../logging";
import type {
  BackgroundJob,
  JobRecord,
  JobStatusEvent,
} from "@/lib/jobs/schemas";
import type { PublishFn } from "@/lib/events/publication";
import { createJobsRepo } from "./repo";

import {
  createMergeIntentsRepo,
  type MergeIntentsRepo,
} from "../merge-intents/repo";
import {
  createNotificationsRepo,
  type NotificationsRepo,
} from "../notifications/repo";
import { _createTestDb, _installTestDb } from "../state-store/state-db";
import type { Db } from "../state-store/schemas";

// The queue persists job records + merge intents through its real repos and
// records terminal-state notifications through the real notification service,
// all resolving `getStateDb()`. Installing a real in-memory SQLite DB (schema
// floored on open) lets those production paths run end-to-end — no
// internal-module mocks — so tests read the persisted rows back instead of
// asserting on fakes. Push dispatch inside the service is fire-and-forget and
// no-ops without push config, so it never reaches the network here. The DB is
// (re)installed per test because the shared setup's beforeEach resets the
// state-db singleton, which closes any previously installed connection.
let testDb: Db;
let mergeIntentsRepo: MergeIntentsRepo;
let notificationsRepo: NotificationsRepo;

// ============================================================
// Actor mock fns — injected via mergeMachine.provide()
// ============================================================

const mockClassifyWorktree = vi.fn();
const mockAbortStaleMerge = vi.fn();
const mockAbortMergeCleanup = vi.fn();
const mockCheckUncommitted = vi.fn();
const mockGetCurrentBranch = vi.fn();
const mockCommitChangesActor = vi.fn();
const mockCommitResolutionActor = vi.fn();
const mockMergeMain = vi.fn();
const mockResolveConflictsActor = vi.fn();
const mockAnalyzeConflictsActor = vi.fn();
const mockRunValidation = vi.fn();
const mockFixValidation = vi.fn();
const mockPrepareActor = vi.fn();
const mockPublishActor = vi.fn();
const mockDeliveryGateActor = vi.fn();
const mockDiscardParkedRefActor = vi.fn();

/** Test machine: real merge machine with mock actors */
const testMachine = mergeMachine.provide({
  actors: {
    classifyWorktree: fromPromise<
      ClassifyWorktreeOutput,
      ClassifyWorktreeInput
    >(async ({ input }) => mockClassifyWorktree(input)),
    abortStaleMerge: fromPromise<AbortStaleMergeOutput, AbortStaleMergeInput>(
      async ({ input }) => mockAbortStaleMerge(input),
    ),
    abortMergeCleanup: fromPromise<
      AbortMergeCleanupOutput,
      AbortMergeCleanupInput
    >(async ({ input }) => mockAbortMergeCleanup(input)),
    checkUncommitted: fromPromise<
      CheckUncommittedOutput,
      CheckUncommittedInput
    >(async ({ input }) => mockCheckUncommitted(input)),
    getCurrentBranch: fromPromise<
      GetCurrentBranchOutput,
      GetCurrentBranchInput
    >(async ({ input }) => mockGetCurrentBranch(input)),
    commitChanges: fromPromise<CommitChangesOutput, CommitChangesInput>(
      async ({ input }) => mockCommitChangesActor(input),
    ),
    commitResolution: fromPromise<
      CommitResolutionOutput,
      CommitResolutionInput
    >(async ({ input }) => mockCommitResolutionActor(input)),
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
    runValidation: fromPromise<RunValidationOutput, RunValidationInput>(
      async ({ input }) => mockRunValidation(input),
    ),
    fixValidation: fromPromise<FixValidationOutput, FixValidationInput>(
      async ({ input }) => mockFixValidation(input),
    ),
    prepare: fromPromise<PrepareActorOutput, PrepareActorInput>(
      async ({ input }) => mockPrepareActor(input),
    ),
    publish: fromPromise<PublishActorOutput, PublishActorInput>(
      async ({ input }) => mockPublishActor(input),
    ),
    deliveryGate: fromPromise<DeliveryGateActorOutput, DeliveryGateActorInput>(
      async ({ input }) => mockDeliveryGateActor(input),
    ),
    discardParkedRef: fromPromise<
      DiscardParkedRefOutput,
      DiscardParkedRefInput
    >(async ({ input }) => mockDiscardParkedRefActor(input)),
  },
});

/** Test machine: real commit machine with mock actors */
const testCommitMachine = commitMachine.provide({
  actors: {
    classifyWorktree: fromPromise<
      ClassifyWorktreeOutput,
      ClassifyWorktreeInput
    >(async ({ input }) => mockClassifyWorktree(input)),
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

const mockCheckTrackedChanges = vi.fn();
const mockResolveOnto = vi.fn();
const mockStartRebase = vi.fn();
const mockContinueRebase = vi.fn();
const mockRebaseResolveConflicts = vi.fn();
const mockAbortRebase = vi.fn();

/** Test machine: real rebase machine with mock actors */
const testRebaseMachine = rebaseMachine.provide({
  actors: {
    getCurrentBranch: fromPromise<
      GetCurrentBranchOutput,
      GetCurrentBranchInput
    >(async ({ input }) => mockGetCurrentBranch(input)),
    checkTrackedChanges: fromPromise<
      CheckTrackedChangesOutput,
      CheckTrackedChangesInput
    >(async ({ input }) => mockCheckTrackedChanges(input)),
    resolveOnto: fromPromise<ResolveOntoOutput, ResolveOntoInput>(
      async ({ input }) => mockResolveOnto(input),
    ),
    startRebase: fromPromise<RebaseStepOutput, StartRebaseInput>(
      async ({ input }) => mockStartRebase(input),
    ),
    continueRebase: fromPromise<RebaseStepOutput, ContinueRebaseInput>(
      async ({ input }) => mockContinueRebase(input),
    ),
    resolveConflicts: fromPromise<
      RebaseResolveConflictsOutput,
      RebaseResolveConflictsInput
    >(async ({ input }) => mockRebaseResolveConflicts(input)),
    abortRebase: fromPromise<AbortRebaseOutput, AbortRebaseInput>(
      async ({ input }) => mockAbortRebase(input),
    ),
  },
});

// ============================================================
// Injected deps — no vi.mock needed
// ============================================================

interface JobCompletionSignal {
  promise: Promise<void>;
  resolve(): void;
}

const pendingJobCompletions = new Map<string, JobCompletionSignal>();
const mockBroadcast = vi.fn<PublishFn>((event) => {
  if (event.type !== "job-status") return { delivered: true };

  if (event.status === "running") {
    if (!pendingJobCompletions.has(event.jobId)) {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      pendingJobCompletions.set(event.jobId, { promise, resolve });
    }
    return { delivered: true };
  }

  pendingJobCompletions.get(event.jobId)?.resolve();
  return { delivered: true };
});
const mockAcquireSessionLock = vi.fn();

// ============================================================
// Helpers
// ============================================================

/** Await every fire-and-forget job's terminal status broadcast. */
async function waitForJobCompletions(): Promise<void> {
  await Promise.all(
    Array.from(pendingJobCompletions.values(), ({ promise }) => promise),
  );
  pendingJobCompletions.clear();
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

const BASE_REBASE_PARAMS = {
  projectPath: "/projects/foo",
  projectName: "foo",
  sessionName: "my-session",
  worktreePath: "/projects/foo/.worktrees/my-session",
  branchName: "csm/my-session",
  onto: { kind: "remote" as const, remote: "origin", branch: "main" },
  targetLabel: "origin/main",
  broadcast: mockBroadcast,
  acquireSessionLock: mockAcquireSessionLock,
  machine: testRebaseMachine,
};

/** Extract the most recent broadcast call's event */
function lastBroadcast(): JobStatusEvent {
  const calls = mockBroadcast.mock.calls;
  return calls[calls.length - 1]![0] as JobStatusEvent;
}

/**
 * A validation failure the fix loop is allowed to remediate. Only failures
 * carrying the `validation_failed` class dispatch the fix agent; plain errors
 * are treated as infrastructure faults and fail the job outright.
 */
function remediableValidationFailure(reason: string): Error {
  return validationFixLoopError(
    {
      status: "fail",
      kind: "script_validation",
      reason,
      details: { failureClass: "validation_failed", timedOut: false },
    },
    "",
  );
}

/** Extract broadcast at a given index */
function broadcastAt(index: number): JobStatusEvent {
  return mockBroadcast.mock.calls[index]![0] as JobStatusEvent;
}

/** Every job-status event broadcast for one job, in order. */
function broadcastsForJob(jobId: string): JobStatusEvent[] {
  return mockBroadcast.mock.calls
    .map((call) => call[0])
    .filter((event): event is JobStatusEvent => event.type === "job-status")
    .filter((event) => event.jobId === jobId);
}

/** Poll the registered job until the machine reports the given phase. */
async function waitForJobPhase(phase: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (getJob("/projects/foo", "my-session")?.phase !== phase) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for job phase ${phase}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** Total merge-intent rows persisted (no per-sha lookup needed). */
function countMergeIntents(): number {
  const row = testDb
    .prepare("SELECT COUNT(*) AS count FROM merge_intents")
    .get() as { count: number };
  return row.count;
}

// ============================================================
// Test Suite
// ============================================================

describe("background-jobs", () => {
  let releaseSession: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    // Let any background XState actors from previous tests complete
    await waitForJobCompletions();
    vi.clearAllMocks();
    _resetForTesting();

    // Fresh in-memory DB per test — installed AFTER the shared setup's
    // beforeEach reset so the queue's real repos + notification service run
    // against an isolated store this test can read back from.
    testDb = _createTestDb({ inMemory: true });
    _installTestDb(testDb);
    mergeIntentsRepo = createMergeIntentsRepo(testDb);
    notificationsRepo = createNotificationsRepo(testDb);

    releaseSession = vi.fn();

    // The resolution commit succeeds unless a test says otherwise.
    mockCommitResolutionActor.mockResolvedValue({
      hash: "resolution_hash",
      committedBy: "orchestrator",
    });

    // Default: session lock acquired successfully
    mockAcquireSessionLock.mockReturnValue(releaseSession);
    // Default: a committed worktree with no merge in progress
    mockClassifyWorktree.mockResolvedValue({ kind: "clean" });
    mockAbortStaleMerge.mockResolvedValue({ aborted: true });
    mockAbortMergeCleanup.mockResolvedValue({
      abortedMerge: false,
      preservedMerge: false,
    });
    // Default: no uncommitted changes
    mockCheckUncommitted.mockResolvedValue({ hasChanges: false });
    // Default: worktree is on the expected branch
    mockGetCurrentBranch.mockResolvedValue({ branch: "csm/my-session" });
    // Default: analyze conflicts returns empty analysis
    mockAnalyzeConflictsActor.mockResolvedValue({
      status: "analyzed" as const,
      conflicts: [],
    });
    // Default: pre-merge validation passes
    mockRunValidation.mockResolvedValue(null);
    // Default: linked delivery gate passes
    mockDeliveryGateActor.mockResolvedValue({
      status: "pass" as const,
      satisfied: [],
      deferred: [],
    });
    // Default: fix validation succeeds
    mockFixValidation.mockResolvedValue({ status: "fixed" as const });
    // Default: prepare actor succeeds with a parked SHA
    mockPrepareActor.mockResolvedValue({
      status: "prepared" as const,
      preparedSha: "prepared-sha",
      expectedTargetSha: "expected-target-sha",
      parkedRef: "refs/cc-merges/test",
    });
    // Default: discard parked ref succeeds (used when entryMode === "discard")
    mockDiscardParkedRefActor.mockResolvedValue(undefined);

    // Rebase defaults: clean worktree, resolvable target, clean replay.
    mockCheckTrackedChanges.mockResolvedValue({ hasChanges: false });
    mockResolveOnto.mockResolvedValue({
      ref: "deadbeef",
      label: "origin/main",
    });
    mockStartRebase.mockResolvedValue({ status: "completed" as const });
    mockContinueRebase.mockResolvedValue({ status: "completed" as const });
    mockRebaseResolveConflicts.mockResolvedValue({
      status: "resolved" as const,
      conflicts: [],
    });
    mockAbortRebase.mockResolvedValue(undefined);
  });

  // ----------------------------------------------------------
  // dispatchRebaseJob
  // ----------------------------------------------------------
  describe("dispatchRebaseJob", () => {
    it("clean rebase broadcasts running → completed and records the target", async () => {
      const result = dispatchRebaseJob(BASE_REBASE_PARAMS);
      expect(result.ok).toBe(true);

      await waitForJobCompletions();

      expect(broadcastAt(0).status).toBe("running");
      expect(broadcastAt(0).jobType).toBe("rebase");
      const last = lastBroadcast();
      expect(last.status).toBe("completed");
      // resolveOnto/startRebase actually ran (not just the mock returning early)
      expect(mockResolveOnto).toHaveBeenCalledTimes(1);
      expect(mockStartRebase).toHaveBeenCalledTimes(1);

      // A terminal notification was persisted through the real repo.
      const { notifications } = notificationsRepo.getNotifications();
      const rebaseNotif = notifications.find(
        (n) => n.title === "Rebase completed",
      );
      expect(rebaseNotif?.message).toContain("rebased onto origin/main");
    });

    it("aborts and fails when automatic resolution cannot resolve a conflict", async () => {
      mockStartRebase.mockResolvedValue({
        status: "conflicts" as const,
        conflictFiles: ["a.ts"],
      });
      mockRebaseResolveConflicts.mockResolvedValue({
        status: "failed" as const,
        conflicts: [],
        partialConflicts: [
          { file: "a.ts", description: "", resolution: "", rationale: "" },
        ],
      });

      dispatchRebaseJob(BASE_REBASE_PARAMS);
      await waitForJobCompletions();

      expect(mockAbortRebase).toHaveBeenCalledTimes(1);
      const last = lastBroadcast();
      expect(last.status).toBe("failed");
      expect(last.errorMessage).toMatch(/aborted/i);
    });

    it("rejects a second rebase while one is running", async () => {
      let resolveStart!: (value: RebaseStepOutput) => void;
      // Hold the first job open until the duplicate-dispatch assertion lands,
      // then complete it so shared test cleanup does not hang.
      mockStartRebase.mockReturnValue(
        new Promise<RebaseStepOutput>((resolve) => {
          resolveStart = resolve;
        }),
      );
      const first = dispatchRebaseJob(BASE_REBASE_PARAMS);
      expect(first.ok).toBe(true);

      const second = dispatchRebaseJob(BASE_REBASE_PARAMS);
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.error).toBe("JOB_ALREADY_RUNNING");

      resolveStart({ status: "completed" as const });
      await waitForJobCompletions();
    });
  });

  // ----------------------------------------------------------
  // dispatchMergeJob
  // ----------------------------------------------------------
  describe("dispatchMergeJob", () => {
    it("returns ok with jobId when no active job", () => {
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "abc123",
      });

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
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "abc123",
      });

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
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "abc123",
      });

      const result = dispatchMergeJob(BASE_MERGE_PARAMS);
      expect(result.ok).toBe(true);

      await waitForJobCompletions();

      // Verify actors were invoked with correct inputs
      expect(mockMergeMain).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreePath: BASE_MERGE_PARAMS.worktreePath,
        }),
      );
      expect(mockPrepareActor).toHaveBeenCalledWith(
        expect.objectContaining({
          projectPath: BASE_MERGE_PARAMS.projectPath,
          branchName: BASE_MERGE_PARAMS.branchName,
          message: BASE_MERGE_PARAMS.message,
        }),
      );
      expect(mockPublishActor).toHaveBeenCalledWith(
        expect.objectContaining({
          projectPath: BASE_MERGE_PARAMS.projectPath,
          preparedSha: "prepared-sha",
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

    it("reports an already-merged branch as a completed no-op and says so", async () => {
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockPrepareActor.mockResolvedValue({
        status: "up-to-date" as const,
        expectedTargetSha: "target-tip",
      });
      mockPublishActor.mockResolvedValue({ status: "up-to-date" as const });

      dispatchMergeJob({ ...BASE_MERGE_PARAMS, targetBranch: "main" });
      await waitForJobCompletions();

      const last = lastBroadcast();
      expect(last.status).toBe("completed");
      expect(last.upToDate).toBe(true);
      expect(last.mergeHash).toBeUndefined();

      const job = getJob(
        BASE_MERGE_PARAMS.projectPath,
        BASE_MERGE_PARAMS.sessionName,
      );
      expect(job?.upToDate).toBe(true);
      expect(job?.mergeHash).toBeUndefined();

      const [notification] = notificationsRepo.getNotifications().notifications;
      expect(notification?.message).toBe(
        "Branch csm/my-session is already fully merged into main — session finished (nothing new to merge)",
      );
    });

    it("does not claim a session finished for a no-op merge that never finalizes one", async () => {
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockPrepareActor.mockResolvedValue({
        status: "up-to-date" as const,
        expectedTargetSha: "target-tip",
      });
      mockPublishActor.mockResolvedValue({ status: "up-to-date" as const });

      dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        targetBranch: "main",
        finalizeSessionOnPublish: false,
      });
      await waitForJobCompletions();

      const [notification] = notificationsRepo.getNotifications().notifications;
      expect(notification?.message).toBe(
        "Branch csm/my-session is already fully merged into main (nothing new to merge)",
      );
    });

    it("phase 0: commits uncommitted changes before merging main", async () => {
      mockClassifyWorktree.mockResolvedValue({ kind: "dirty" });
      mockCommitChangesActor.mockResolvedValue({ hash: "phase0hash" });
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "abc123",
      });

      const result = dispatchMergeJob(BASE_MERGE_PARAMS);
      expect(result.ok).toBe(true);

      await waitForJobCompletions();

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
      mockClassifyWorktree.mockResolvedValue({ kind: "clean" });
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "abc123",
      });

      dispatchMergeJob(BASE_MERGE_PARAMS);
      await waitForJobCompletions();

      expect(mockCommitChangesActor).not.toHaveBeenCalled();
      expect(mockMergeMain).toHaveBeenCalled();
    });

    it("phase 0: commit failure causes job to fail", async () => {
      mockClassifyWorktree.mockResolvedValue({ kind: "dirty" });
      mockCommitChangesActor.mockRejectedValue(
        new Error("pre-commit hook failed"),
      );

      const result = dispatchMergeJob(BASE_MERGE_PARAMS);
      expect(result.ok).toBe(true);

      await waitForJobCompletions();

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
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "merge456",
      });

      const result = dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        autoResolve: true,
      });
      expect(result.ok).toBe(true);

      await waitForJobCompletions();

      expect(mockResolveConflictsActor).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreePath: BASE_MERGE_PARAMS.worktreePath,
        }),
      );
      expect(mockCommitResolutionActor).toHaveBeenCalledWith({
        worktreePath: BASE_MERGE_PARAMS.worktreePath,
        targetBranch: "main",
        message: "resolve merge conflicts",
      });
      expect(mockRunValidation).toHaveBeenCalledWith(
        expect.objectContaining({
          projectPath: BASE_MERGE_PARAMS.projectPath,
          worktreePath: BASE_MERGE_PARAMS.worktreePath,
          sessionName: BASE_MERGE_PARAMS.sessionName,
          branchName: BASE_MERGE_PARAMS.branchName,
          timeoutMs: 300_000,
        }),
      );
      expect(mockPublishActor).toHaveBeenCalled();

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
        targetBranch: "csm/parent-branch",
      });
      expect(result.ok).toBe(true);

      await waitForJobCompletions();

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
      expect(job?.targetBranch).toBe("csm/parent-branch");

      const [notification] = notificationsRepo.getNotifications().notifications;
      expect(notification?.message).toContain("csm/parent-branch");

      expect(releaseSession).toHaveBeenCalled();
    });

    it("auto-resolve failure falls back to conflicts status", async () => {
      mockMergeMain.mockResolvedValue({
        status: "conflicts",
        conflictFiles: ["file1.ts", "file2.ts"],
      });
      mockResolveConflictsActor.mockResolvedValue({
        status: "unresolved",
        error: "Conflict resolution left conflict markers in: file1.ts",
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

      await waitForJobCompletions();

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

      await waitForJobCompletions();

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
      mockPublishActor.mockRejectedValue(err);

      dispatchMergeJob(BASE_MERGE_PARAMS);
      await waitForJobCompletions();

      const job = getJob(
        BASE_MERGE_PARAMS.projectPath,
        BASE_MERGE_PARAMS.sessionName,
      );
      expect(job?.errorMessage).toContain("Commit failed");
      expect(job?.errorMessage).toContain("pre-commit script failed");
    });

    it("pre-merge validation is called before squash merge", async () => {
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "abc123",
      });

      dispatchMergeJob(BASE_MERGE_PARAMS);
      await waitForJobCompletions();

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
      const squashOrder = mockPublishActor.mock.invocationCallOrder[0]!;
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
      await waitForJobCompletions();

      expect(mockPublishActor).not.toHaveBeenCalled();

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
    it("commits, validates, and broadcasts completed state", async () => {
      mockCommitChangesActor.mockResolvedValue({ hash: "commit789" });

      const result = dispatchCommitJob(BASE_COMMIT_PARAMS);
      expect(result.ok).toBe(true);

      await waitForJobCompletions();

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

      expect(mockRunValidation).toHaveBeenCalledWith(
        expect.objectContaining({
          projectPath: BASE_COMMIT_PARAMS.projectPath,
          worktreePath: BASE_COMMIT_PARAMS.worktreePath,
        }),
      );
      const phaseEvents = mockBroadcast.mock.calls
        .map((call) => (call[0] as JobStatusEvent).phase)
        .filter(Boolean);
      expect(phaseEvents).toContain("committing");
      expect(phaseEvents).toContain("validating");

      expect(releaseSession).toHaveBeenCalled();
    });

    it("threads targetBranch into pre-merge validation", async () => {
      mockCommitChangesActor.mockResolvedValue({ hash: "commit789" });

      const result = dispatchCommitJob({
        ...BASE_COMMIT_PARAMS,
        targetBranch: "csm/parent",
      });
      expect(result.ok).toBe(true);

      await waitForJobCompletions();

      expect(mockRunValidation).toHaveBeenCalledWith(
        expect.objectContaining({ targetBranch: "csm/parent" }),
      );
    });

    it("failed commit includes git output in the failed broadcast", async () => {
      const err = new Error("No uncommitted changes to commit") as Error & {
        gitOutput?: string;
      };
      err.gitOutput = "pre-commit hook failed: lint errors";
      mockCommitChangesActor.mockRejectedValue(err);

      const result = dispatchCommitJob(BASE_COMMIT_PARAMS);
      expect(result.ok).toBe(true);

      await waitForJobCompletions();

      const last = lastBroadcast();
      expect(last.status).toBe("failed");
      expect(last.errorMessage).toContain("No uncommitted changes to commit");
      expect(last.errorMessage).toContain("pre-commit hook failed");

      expect(releaseSession).toHaveBeenCalled();
    });

    it("validation fails → fix → re-validate → completed", async () => {
      mockCommitChangesActor.mockResolvedValue({ hash: "commit789" });
      mockRunValidation
        .mockRejectedValueOnce(remediableValidationFailure("lint errors"))
        .mockResolvedValueOnce(undefined);
      mockFixValidation.mockResolvedValue({
        status: "fixed" as const,
      });
      mockCheckUncommitted.mockResolvedValue({ hasChanges: true });

      const result = dispatchCommitJob(BASE_COMMIT_PARAMS);
      expect(result.ok).toBe(true);

      await waitForJobCompletions();

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
      mockRunValidation.mockRejectedValue(
        remediableValidationFailure("lint errors"),
      );
      mockFixValidation.mockResolvedValue({
        status: "fixed" as const,
      });
      mockCheckUncommitted.mockResolvedValue({ hasChanges: true });

      const result = dispatchCommitJob(BASE_COMMIT_PARAMS);
      expect(result.ok).toBe(true);

      await waitForJobCompletions();

      const last = lastBroadcast();
      expect(last.status).toBe("failed");
    });

    it("commitHash present even when validation fails permanently", async () => {
      mockCommitChangesActor.mockResolvedValue({ hash: "commit789" });
      mockRunValidation.mockRejectedValue(
        remediableValidationFailure("lint errors"),
      );
      mockFixValidation.mockResolvedValue({
        status: "failed" as const,
      });

      const result = dispatchCommitJob(BASE_COMMIT_PARAMS);
      expect(result.ok).toBe(true);

      await waitForJobCompletions();

      const job = getJob(
        BASE_COMMIT_PARAMS.projectPath,
        BASE_COMMIT_PARAMS.sessionName,
      );
      expect(job?.status).toBe("failed");
      expect(job?.commitHash).toBe("commit789");
    });
  });

  // ----------------------------------------------------------
  // Progress stamping
  // ----------------------------------------------------------
  describe("job progress stamping", () => {
    const DISPATCHED_AT = "2026-08-16T00:00:00.000Z";
    const MERGED_AT = "2026-08-16T00:05:00.000Z";
    const PUBLISHED_AT = "2026-08-16T00:09:00.000Z";

    afterEach(() => {
      vi.useRealTimers();
    });

    it("advances lastProgressAt on every status broadcast", async () => {
      // Only the clock is faked: the machine's promise actors and the
      // completion signals still run on real microtasks.
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(DISPATCHED_AT));
      mockMergeMain.mockImplementation(async () => {
        vi.setSystemTime(new Date(MERGED_AT));
        return { status: "clean", conflictFiles: [] };
      });
      mockPublishActor.mockImplementation(async () => {
        vi.setSystemTime(new Date(PUBLISHED_AT));
        return { status: "completed" as const, mergeHash: "abc123" };
      });

      dispatchMergeJob(BASE_MERGE_PARAMS);
      await waitForJobCompletions();

      expect(broadcastAt(0)).toMatchObject({
        status: "running",
        lastProgressAt: DISPATCHED_AT,
      });
      const stamps = mockBroadcast.mock.calls.map(
        (call) => (call[0] as JobStatusEvent).lastProgressAt,
      );
      expect(stamps).toContain(MERGED_AT);
      expect(stamps).toEqual([...stamps].sort());
      expect(lastBroadcast().lastProgressAt).toBe(PUBLISHED_AT);
      expect(
        getJob(BASE_MERGE_PARAMS.projectPath, BASE_MERGE_PARAMS.sessionName)
          ?.lastProgressAt,
      ).toBe(PUBLISHED_AT);
    });

    it("advances lastProgressAt when a durable progress write lands", async () => {
      const candidateValidation = {
        validationRef: "validation-progress",
        validatedSha: "validated-sha",
        validatedTreeHash: "validated-tree",
        commandIdentity: "./validate.sh",
        outcome: "pass" as const,
      };
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(DISPATCHED_AT));
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockRunValidation.mockImplementation(async () => {
        vi.setSystemTime(new Date(MERGED_AT));
        return candidateValidation;
      });
      // A publish that reports nothing new: only the validation proof moved.
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "abc123",
      });

      const result = dispatchMergeJob(BASE_MERGE_PARAMS);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      await waitForJobCompletions();

      // The proof reached the durable record, so the progress write ran.
      expect(
        createJobsRepo(testDb).getJobRecord(result.value.jobId),
      ).toMatchObject({ candidateValidation });
      expect(
        getJob(BASE_MERGE_PARAMS.projectPath, BASE_MERGE_PARAMS.sessionName)
          ?.lastProgressAt,
      ).toBe(MERGED_AT);
    });
  });

  // ----------------------------------------------------------
  // Stale job recovery
  // ----------------------------------------------------------
  describe("stale job recovery", () => {
    const INACTIVE_MS = 31 * 60 * 1000;
    const LONG_RUNTIME_MS = 3 * 60 * 60 * 1000;

    /** The registered job for the shared test session. */
    function registeredJob(): BackgroundJob {
      const job = getJob(
        BASE_MERGE_PARAMS.projectPath,
        BASE_MERGE_PARAMS.sessionName,
      );
      if (job === undefined) throw new Error("no job is registered");
      return job;
    }

    /**
     * A session lock with the exclusivity the production single-flight manager
     * enforces: while a job holds it, acquiring throws. Stale recovery is
     * exactly the case where the difference shows — the closed-out job keeps
     * the lock until its teardown settles.
     */
    function createExclusiveSessionLock(): {
      acquire: AcquireSessionLockFn;
      isHeld(): boolean;
    } {
      let held = false;
      return {
        acquire: () => {
          if (held) throw new Error("Session is busy");
          held = true;
          return () => {
            held = false;
          };
        },
        isHeld: () => held,
      };
    }

    it("tears down the actor and records the forced terminal state when a job stops reporting progress", async () => {
      mockMergeMain.mockResolvedValue({
        status: "conflicts",
        conflictFiles: ["src/a.ts"],
      });
      // A resolver turn that never returns — the shape of the hang stale
      // recovery exists for.
      mockResolveConflictsActor.mockImplementation(() => new Promise(() => {}));

      const lock = createExclusiveSessionLock();
      const stalling = dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        autoResolve: true,
        acquireSessionLock: lock.acquire,
      });
      expect(stalling.ok).toBe(true);
      if (!stalling.ok) return;
      await waitForJobPhase("resolving-conflicts");
      const stalledJobId = stalling.value.jobId;
      registeredJob().lastProgressAt = new Date(
        Date.now() - INACTIVE_MS,
      ).toISOString();

      // The dispatch that detects the stall starts nothing: the closed-out job
      // holds the session until its own teardown finishes, and starting a merge
      // in a worktree another machine is still aborting in would be worse than
      // asking the operator to retry.
      const next = dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        acquireSessionLock: lock.acquire,
      });
      expect(next).toEqual({ ok: false, error: "SESSION_BUSY" });

      // The machine was told to stop and ran its own abort cleanup.
      await vi.waitFor(() => {
        expect(mockAbortMergeCleanup).toHaveBeenCalled();
      });

      const staleEvents = broadcastsForJob(stalledJobId);
      expect(staleEvents[staleEvents.length - 1]).toMatchObject({
        status: "failed",
      });
      expect(staleEvents[staleEvents.length - 1]?.errorMessage).toMatch(
        /progress/i,
      );

      const persisted = createJobsRepo(testDb).getJobRecord(stalledJobId);
      expect(persisted?.status).toBe("failed");
      expect(persisted?.errorMessage).toMatch(/progress/i);
      expect(persisted?.completedAt).toBeDefined();

      await waitForJobCompletions();

      // The torn-down machine's own terminal does not overwrite the verdict
      // the operator was already shown.
      expect(
        createJobsRepo(testDb).getJobRecord(stalledJobId)?.errorMessage,
      ).toMatch(/progress/i);

      // Once the teardown released the session, a retry does start.
      await vi.waitFor(() => {
        expect(lock.isHeld()).toBe(false);
      });
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "after-recovery",
      });
      const retry = dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        acquireSessionLock: lock.acquire,
      });
      expect(retry.ok).toBe(true);
      await waitForJobCompletions();
    });

    it("answers the graph merge awaiting a job it closed out", async () => {
      mockMergeMain.mockResolvedValue({
        status: "conflicts",
        conflictFiles: ["src/a.ts"],
      });
      mockResolveConflictsActor.mockImplementation(() => new Promise(() => {}));

      const laneMerge = runRegisteredMergeJob({
        machine: testMachine,
        broadcast: mockBroadcast,
        input: {
          jobId: "graph-job-stalled",
          projectPath: BASE_MERGE_PARAMS.projectPath,
          projectName: BASE_MERGE_PARAMS.projectName,
          sessionName: BASE_MERGE_PARAMS.sessionName,
          worktreePath: BASE_MERGE_PARAMS.worktreePath,
          branchName: BASE_MERGE_PARAMS.branchName,
          message: BASE_MERGE_PARAMS.message,
          autoResolve: true,
          validationMode: {
            mode: "run",
            source: "graph_lane_merge",
            selection: { mode: "only", commands: ["typecheck"] },
          },
          targetBranch: "main",
          finalizeSessionOnPublish: false,
          executionId: "workflow-execution-stalled",
        },
      });
      await waitForJobPhase("resolving-conflicts");
      registeredJob().lastProgressAt = new Date(
        Date.now() - INACTIVE_MS,
      ).toISOString();

      expect(dispatchMergeJob(BASE_MERGE_PARAMS).ok).toBe(true);

      // The join is waiting on this promise: a teardown that never settles it
      // would hang the lane instead of failing it.
      await expect(laneMerge).resolves.toMatchObject({ status: "failed" });
      await waitForJobCompletions();
    });

    it("leaves a long-running job alone while it is still reporting progress", async () => {
      let finishMerge!: (value: MergeMainOutput) => void;
      mockMergeMain.mockReturnValue(
        new Promise<MergeMainOutput>((resolve) => {
          finishMerge = resolve;
        }),
      );
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "abc123",
      });

      expect(dispatchMergeJob(BASE_MERGE_PARAMS).ok).toBe(true);
      const running = registeredJob();
      running.startedAt = new Date(Date.now() - LONG_RUNTIME_MS).toISOString();
      running.lastProgressAt = new Date(Date.now() - 60_000).toISOString();

      const second = dispatchMergeJob(BASE_MERGE_PARAMS);

      expect(second).toEqual({ ok: false, error: "JOB_ALREADY_RUNNING" });
      expect(mockAbortMergeCleanup).not.toHaveBeenCalled();
      expect(registeredJob().status).toBe("running");

      finishMerge({ status: "clean", conflictFiles: [] });
      await waitForJobCompletions();
    });

    it("measures a job that carries no progress stamp from when it started", async () => {
      let finishMerge!: (value: MergeMainOutput) => void;
      mockMergeMain.mockReturnValue(
        new Promise<MergeMainOutput>((resolve) => {
          finishMerge = resolve;
        }),
      );
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "abc123",
      });

      const lock = createExclusiveSessionLock();
      const stalling = dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        acquireSessionLock: lock.acquire,
      });
      expect(stalling.ok).toBe(true);
      if (!stalling.ok) return;
      await waitForJobPhase("merging-main");
      const stalled = registeredJob();
      // A job registered before the progress stamp existed (the live registry
      // outlives a module reload).
      delete stalled.lastProgressAt;
      stalled.startedAt = new Date(Date.now() - INACTIVE_MS).toISOString();

      expect(
        dispatchMergeJob({
          ...BASE_MERGE_PARAMS,
          acquireSessionLock: lock.acquire,
        }),
      ).toEqual({ ok: false, error: "SESSION_BUSY" });

      await vi.waitFor(() => {
        expect(mockAbortMergeCleanup).toHaveBeenCalled();
      });
      expect(
        createJobsRepo(testDb).getJobRecord(stalling.value.jobId)?.status,
      ).toBe("failed");

      finishMerge({ status: "clean", conflictFiles: [] });
      await waitForJobCompletions();
    });
  });

  // ----------------------------------------------------------
  // Superseded parked candidates
  // ----------------------------------------------------------
  describe("parked candidate replacement", () => {
    let repo: string;
    let parkedSha: string;

    async function repoGit(args: string[]): Promise<string> {
      const { stdout } = await defaultGitClient.git(args, repo);
      return stdout.trim();
    }

    beforeEach(async () => {
      // Temp root, not the worktree path: this repository's absolute path ends
      // up inside git's own bookkeeping, and a session worktree path is long
      // enough to hit ENAMETOOLONG.
      repo = await mkdtemp(path.join(tmpdir(), "cc-parked-replace-"));
      await repoGit(["init", "--initial-branch=main", "."]);
      await repoGit(["config", "user.email", "engine@command-center.test"]);
      await repoGit(["config", "user.name", "Command Center"]);
      await writeFile(path.join(repo, "a.txt"), "base\n", "utf-8");
      await repoGit(["add", "-A"]);
      await repoGit(["commit", "-m", "base"]);
      parkedSha = await repoGit(["rev-parse", "HEAD"]);
    });

    afterEach(async () => {
      await rm(repo, { recursive: true, force: true });
    });

    /**
     * Park a merge for the session and return its job id. The parked ref exists
     * in the real repository, exactly as the prepare step would have left it.
     */
    async function parkMerge(): Promise<string> {
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockPrepareActor.mockResolvedValue({
        status: "prepared" as const,
        preparedSha: parkedSha,
        expectedTargetSha: parkedSha,
        parkedRef: "refs/cc-merges/parked-candidate",
      });
      mockPublishActor.mockResolvedValue({
        status: "ready-to-land" as const,
        parkedRef: "refs/cc-merges/parked-candidate",
        preparedSha: parkedSha,
        targetWorktreePath: repo,
      });
      await repoGit([
        "update-ref",
        "refs/cc-merges/parked-candidate",
        parkedSha,
      ]);

      const result = dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        projectPath: repo,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("parked merge dispatch was refused");
      await waitForJobCompletions();
      expect(getJob(repo, BASE_MERGE_PARAMS.sessionName)).toMatchObject({
        status: "ready-to-land",
      });
      return result.value.jobId;
    }

    /**
     * The registry holds one job per session, so a new dispatch takes the parked
     * candidate's place. Left alone, its commit stays parked under a ref nothing
     * can ever land — and after a restart the durable row would offer it as this
     * session's landable candidate.
     */
    it("deletes the superseded parked ref and records the old job as discarded", async () => {
      const parkedJobId = await parkMerge();

      const replacement = dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        projectPath: repo,
      });
      expect(replacement.ok).toBe(true);

      await vi.waitFor(async () => {
        await expect(
          repoGit(["rev-parse", "--verify", "refs/cc-merges/parked-candidate"]),
        ).rejects.toThrow();
      });
      expect(createJobsRepo(testDb).getJobRecord(parkedJobId)).toMatchObject({
        status: "discarded",
      });
      expect(broadcastsForJob(parkedJobId).at(-1)).toMatchObject({
        status: "discarded",
      });

      await waitForJobCompletions();
    });

    /**
     * The registry dies with the process; the row offering the candidate and
     * the commit under `refs/cc-merges/` do not. A dispatch after a restart is
     * the first act that can end that offer — left alone the ref is unreachable
     * and no sweep collects it, because the row still claims it.
     */
    it("discards a parked candidate the registry lost to a restart", async () => {
      const parkedJobId = await parkMerge();
      // A restart: the registry is empty, the durable row and the ref are not.
      _resetForTesting();
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "landed-sha",
      });

      const replacement = dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        projectPath: repo,
      });
      expect(replacement.ok).toBe(true);

      await vi.waitFor(async () => {
        await expect(
          repoGit(["rev-parse", "--verify", "refs/cc-merges/parked-candidate"]),
        ).rejects.toThrow();
      });
      await vi.waitFor(() => {
        expect(createJobsRepo(testDb).getJobRecord(parkedJobId)).toMatchObject({
          status: "discarded",
        });
      });
      expect(broadcastsForJob(parkedJobId).at(-1)).toMatchObject({
        status: "discarded",
      });

      await waitForJobCompletions();
    });

    /**
     * A candidate whose commit was already published leaves nothing but a row.
     * Closing it is bookkeeping, and announcing it as a discard would describe
     * a merge that landed as one that was dropped.
     */
    it("closes out a consumed candidate's row without announcing a discard", async () => {
      const parkedJobId = await parkMerge();
      // What a land leaves behind: the commit is on the target and the ref that
      // held it is gone, but the row that offered it is still there.
      await repoGit(["update-ref", "-d", "refs/cc-merges/parked-candidate"]);
      _resetForTesting();
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "landed-sha",
      });

      const next = dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        projectPath: repo,
      });
      expect(next.ok).toBe(true);

      await vi.waitFor(() => {
        expect(createJobsRepo(testDb).getJobRecord(parkedJobId)).toMatchObject({
          status: "discarded",
        });
      });
      expect(
        broadcastsForJob(parkedJobId).some(
          (event) => event.status === "discarded",
        ),
      ).toBe(false);
      expect(
        notificationsRepo
          .getNotifications()
          .notifications.some(
            (notification) => notification.type === "merge-discarded",
          ),
      ).toBe(false);

      await waitForJobCompletions();
    });

    /**
     * A dispatch the session lock refuses replaces nothing — no job runs, and
     * the operator is told to try again — so it must leave the candidate it
     * would have superseded exactly as landable as it found it.
     */
    it("keeps the parked candidate when the replacing dispatch is refused", async () => {
      const parkedJobId = await parkMerge();

      const refused = dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        projectPath: repo,
        acquireSessionLock: () => {
          throw new Error("session is busy");
        },
      });

      expect(refused).toEqual({ ok: false, error: "SESSION_BUSY" });
      expect(createJobsRepo(testDb).getJobRecord(parkedJobId)).toMatchObject({
        status: "ready-to-land",
      });
      expect(getJob(repo, BASE_MERGE_PARAMS.sessionName)).toMatchObject({
        status: "ready-to-land",
      });
      expect(
        broadcastsForJob(parkedJobId).some(
          (event) => event.status === "discarded",
        ),
      ).toBe(false);
      // The ref deletion is fired without being awaited, so the candidate's
      // survival is only proven after a window in which it could have run.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(
        await repoGit(["rev-parse", "refs/cc-merges/parked-candidate"]),
      ).toBe(parkedSha);
    });

    /** A land re-entry IS that candidate's job — deleting its ref would destroy
     *  the very commit it is about to publish. */
    it("keeps the parked ref when the replacing job is the candidate's land re-entry", async () => {
      await parkMerge();
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: parkedSha,
      });

      const land = dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        projectPath: repo,
        entryMode: "land",
        preparedSha: parkedSha,
        expectedTargetSha: parkedSha,
        parkedRef: "refs/cc-merges/parked-candidate",
      });
      expect(land.ok).toBe(true);
      await waitForJobCompletions();

      expect(
        await repoGit(["rev-parse", "refs/cc-merges/parked-candidate"]),
      ).toBe(parkedSha);
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
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "squash_hash",
      });

      const result = dispatchResolveConflictsJob(BASE_RESOLVE_PARAMS);
      expect(result.ok).toBe(true);

      await waitForJobCompletions();

      expect(mockResolveConflictsActor).toHaveBeenCalledWith(
        expect.objectContaining({
          worktreePath: BASE_RESOLVE_PARAMS.worktreePath,
        }),
      );
      expect(mockCommitResolutionActor).toHaveBeenCalledWith({
        worktreePath: BASE_RESOLVE_PARAMS.worktreePath,
        targetBranch: "main",
        message: "resolve merge conflicts",
      });
      expect(mockRunValidation).toHaveBeenCalled();
      expect(mockPrepareActor).toHaveBeenCalledWith(
        expect.objectContaining({
          projectPath: BASE_RESOLVE_PARAMS.projectPath,
          branchName: BASE_RESOLVE_PARAMS.branchName,
          message: BASE_RESOLVE_PARAMS.mergeMessage,
        }),
      );
      expect(mockPublishActor).toHaveBeenCalled();

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
        status: "unresolved",
        error: "Conflict resolution left conflict markers in: a.ts",
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

      await waitForJobCompletions();

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
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "m",
      });

      const decisions = [
        { file: "file1.ts", decision: "approved" as const },
        {
          file: "file2.ts",
          decision: "rejected" as const,
          feedback: "use theirs",
        },
      ];

      dispatchResolveConflictsJob({ ...BASE_RESOLVE_PARAMS, decisions });
      await waitForJobCompletions();

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
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "m",
      });

      dispatchResolveConflictsJob(BASE_RESOLVE_PARAMS);
      await waitForJobCompletions();

      expect(mockRunValidation).toHaveBeenCalledWith(
        expect.objectContaining({
          projectPath: BASE_RESOLVE_PARAMS.projectPath,
          worktreePath: BASE_RESOLVE_PARAMS.worktreePath,
          sessionName: BASE_RESOLVE_PARAMS.sessionName,
          branchName: BASE_RESOLVE_PARAMS.branchName,
        }),
      );

      const validationOrder = mockRunValidation.mock.invocationCallOrder[0]!;
      const squashOrder = mockPublishActor.mock.invocationCallOrder[0]!;
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
      await waitForJobCompletions();

      expect(mockPublishActor).not.toHaveBeenCalled();
      const last = lastBroadcast();
      expect(last.status).toBe("failed");
      expect(last.errorMessage).toContain("Pre-merge validation failed");
    });

    it("error in pipeline → failed broadcast", async () => {
      mockResolveConflictsActor.mockRejectedValue(
        new Error("SDK connection failed"),
      );

      dispatchResolveConflictsJob(BASE_RESOLVE_PARAMS);
      await waitForJobCompletions();

      const last = lastBroadcast();
      expect(last.status).toBe("failed");
      expect(last.errorMessage).toContain("SDK connection failed");

      expect(releaseSession).toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // merge association at dispatch (MA1/MA2/MA5)
  // ----------------------------------------------------------
  describe("merge association at dispatch", () => {
    afterEach(() => {
      _resetMergeAssociationResolverForTesting();
      _resetMergeDeliveryLifecycleForTesting();
    });

    function completeCleanMerge(): void {
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "assoc-merge-hash",
      });
    }

    it("stamps resolved provenance durably on the job and gates the merge", async () => {
      completeCleanMerge();
      registerMergeAssociationResolver({
        resolve(input) {
          return input.sessionName === "my-session"
            ? {
                kind: "linked",
                executionId: "wf-exec-assoc",
                finalPublish: true,
              }
            : { kind: "none" };
        },
      });

      const result = dispatchMergeJob(BASE_MERGE_PARAMS);
      expect(result.ok).toBe(true);
      await waitForJobCompletions();

      if (!result.ok) throw new Error("dispatch failed");
      const record = createJobsRepo(testDb).getJobRecord(result.value.jobId);
      expect(record?.executionId).toBe("wf-exec-assoc");
      expect(record?.finalPublish).toBe(true);
      expect(mockDeliveryGateActor).toHaveBeenCalledWith(
        expect.objectContaining({ workflowExecutionId: "wf-exec-assoc" }),
      );
    });

    it("refuses dispatch with the resolver's refusal and creates no job", () => {
      registerMergeAssociationResolver({
        resolve() {
          return {
            kind: "refused",
            reason: "Session hosts 2 active spec executions",
            instruction: "Abandon one execution, then retry the merge.",
          };
        },
      });

      const result = dispatchMergeJob(BASE_MERGE_PARAMS);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected refusal");
      expect(result.error).toEqual({
        code: "MERGE_ASSOCIATION_REFUSED",
        reason: "Session hosts 2 active spec executions",
        instruction: "Abandon one execution, then retry the merge.",
      });
      expect(getActiveJobs()).toHaveLength(0);
      expect(mockAcquireSessionLock).not.toHaveBeenCalled();
    });

    it("does not consult the resolver when explicit provenance is supplied", async () => {
      completeCleanMerge();
      const resolve = vi.fn();
      registerMergeAssociationResolver({ resolve });

      const result = dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        executionId: "wf-exec-explicit",
        finalPublish: false,
      });
      expect(result.ok).toBe(true);
      await waitForJobCompletions();

      expect(resolve).not.toHaveBeenCalled();
      expect(mockDeliveryGateActor).toHaveBeenCalledWith(
        expect.objectContaining({ workflowExecutionId: "wf-exec-explicit" }),
      );
    });

    it("passes through unlinked when no resolver is registered", async () => {
      completeCleanMerge();

      const result = dispatchMergeJob(BASE_MERGE_PARAMS);
      expect(result.ok).toBe(true);
      await waitForJobCompletions();

      if (!result.ok) throw new Error("dispatch failed");
      const record = createJobsRepo(testDb).getJobRecord(result.value.jobId);
      expect(record?.executionId).toBeUndefined();
      const gateInput = mockDeliveryGateActor.mock.calls[0]?.[0] as
        | { workflowExecutionId?: string }
        | undefined;
      expect(gateInput?.workflowExecutionId).toBeUndefined();
    });

    it("resolve-conflicts dispatch persists explicit provenance", async () => {
      mockResolveConflictsActor.mockResolvedValue({
        status: "resolved",
        conflicts: [],
      });
      mockCommitChangesActor.mockResolvedValue({ hash: "resolve_hash" });
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "squash_hash",
      });

      const result = dispatchResolveConflictsJob({
        ...BASE_RESOLVE_PARAMS,
        executionId: "wf-exec-retry",
        finalPublish: true,
      });
      expect(result.ok).toBe(true);
      await waitForJobCompletions();

      if (!result.ok) throw new Error("dispatch failed");
      const record = createJobsRepo(testDb).getJobRecord(result.value.jobId);
      expect(record?.executionId).toBe("wf-exec-retry");
      expect(record?.finalPublish).toBe(true);
      expect(mockDeliveryGateActor).toHaveBeenCalledWith(
        expect.objectContaining({ workflowExecutionId: "wf-exec-retry" }),
      );
    });

    it("notifies the registered delivery lifecycle when a gated final-publish merge completes", async () => {
      completeCleanMerge();
      const markDelivered = vi.fn().mockResolvedValue(undefined);
      registerMergeDeliveryLifecycle({ markDelivered });

      const result = dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        executionId: "wf-exec-deliver",
        finalPublish: true,
      });
      expect(result.ok).toBe(true);
      await waitForJobCompletions();

      expect(markDelivered).toHaveBeenCalledWith(
        "wf-exec-deliver",
        "assoc-merge-hash",
      );
    });

    /**
     * A final publish with nothing to land delivered the same content as one
     * that landed a commit, so it owes the same Delivered marking; the target
     * tip the delivery gate evaluated is the commit that carries the work.
     */
    it("notifies delivery with the target tip when the final publish had nothing to land", async () => {
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockPrepareActor.mockResolvedValue({
        status: "up-to-date" as const,
        expectedTargetSha: "target-tip",
      });
      mockPublishActor.mockResolvedValue({ status: "up-to-date" as const });
      const markDelivered = vi.fn().mockResolvedValue(undefined);
      registerMergeDeliveryLifecycle({ markDelivered });

      const result = dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        executionId: "wf-exec-noop-deliver",
        finalPublish: true,
      });
      expect(result.ok).toBe(true);
      await waitForJobCompletions();

      expect(markDelivered).toHaveBeenCalledWith(
        "wf-exec-noop-deliver",
        "target-tip",
      );
    });

    it("does not notify delivery for a linked merge that is not the final publish", async () => {
      completeCleanMerge();
      const markDelivered = vi.fn().mockResolvedValue(undefined);
      registerMergeDeliveryLifecycle({ markDelivered });

      const result = dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        executionId: "wf-exec-not-final",
      });
      expect(result.ok).toBe(true);
      await waitForJobCompletions();

      expect(markDelivered).not.toHaveBeenCalled();
    });

    it("resolve-conflicts dispatch falls back to the registered resolver", async () => {
      mockResolveConflictsActor.mockResolvedValue({
        status: "resolved",
        conflicts: [],
      });
      mockCommitChangesActor.mockResolvedValue({ hash: "resolve_hash" });
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "squash_hash",
      });
      registerMergeAssociationResolver({
        resolve() {
          return {
            kind: "linked",
            executionId: "wf-exec-retry-resolved",
            finalPublish: false,
          };
        },
      });

      const result = dispatchResolveConflictsJob(BASE_RESOLVE_PARAMS);
      expect(result.ok).toBe(true);
      await waitForJobCompletions();

      if (!result.ok) throw new Error("dispatch failed");
      const record = createJobsRepo(testDb).getJobRecord(result.value.jobId);
      expect(record?.executionId).toBe("wf-exec-retry-resolved");
      expect(record?.finalPublish).toBeUndefined();
    });
  });

  // ----------------------------------------------------------
  // getJob / getConflictAnalysis
  // ----------------------------------------------------------
  describe("getJob and getConflictAnalysis", () => {
    it("keeps a graph merge's parked candidate registered for later land re-entry", async () => {
      const candidateValidation = {
        validationRef: "validation-parked-graph",
        validatedSha: "validated-graph-sha",
        validatedTreeHash: "validated-graph-tree",
        commandIdentity: "./validate.sh",
        outcome: "pass" as const,
      };
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockRunValidation.mockResolvedValue(candidateValidation);
      mockPublishActor.mockResolvedValue({
        status: "ready-to-land" as const,
        parkedRef: "refs/cc-merges/graph-job",
        preparedSha: "prepared-sha",
        targetWorktreePath: "/projects/foo",
      });

      const output = await runRegisteredMergeJob({
        machine: testMachine,
        broadcast: mockBroadcast,
        input: {
          jobId: "graph-job",
          projectPath: BASE_MERGE_PARAMS.projectPath,
          projectName: BASE_MERGE_PARAMS.projectName,
          sessionName: BASE_MERGE_PARAMS.sessionName,
          worktreePath: BASE_MERGE_PARAMS.worktreePath,
          branchName: BASE_MERGE_PARAMS.branchName,
          message: BASE_MERGE_PARAMS.message,
          autoResolve: true,
          validationMode: {
            mode: "run",
            source: "graph_lane_merge",
            selection: { mode: "only", commands: ["typecheck"] },
          },
          targetBranch: "main",
          finalizeSessionOnPublish: false,
          executionId: "workflow-execution-parked",
          finalPublish: true,
        },
      });

      expect(output.status).toBe("ready-to-land");
      expect(
        getJob(BASE_MERGE_PARAMS.projectPath, BASE_MERGE_PARAMS.sessionName),
      ).toMatchObject({
        jobId: "graph-job",
        status: "ready-to-land",
        preparedSha: "prepared-sha",
        expectedTargetSha: "expected-target-sha",
        parkedRef: "refs/cc-merges/test",
        executionId: "workflow-execution-parked",
        finalPublish: true,
        candidateValidation,
      });
      expect(createJobsRepo(testDb).getJobRecord("graph-job")).toMatchObject({
        executionId: "workflow-execution-parked",
        finalPublish: true,
        candidateValidation,
      });
    });

    /**
     * The registry dies with the process; the parked commit does not. Everything
     * a land or discard re-entry has to reconstruct — the ref, the two SHAs, the
     * finalization decision, the resolver's intent notes — must therefore be on
     * the durable row, not only on the in-memory job.
     */
    it("persists the parked candidate's bookkeeping for a land re-entry after a restart", async () => {
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockPublishActor.mockResolvedValue({
        status: "ready-to-land" as const,
        parkedRef: "refs/cc-merges/test",
        preparedSha: "prepared-sha",
        targetWorktreePath: "/projects/foo",
      });

      const result = dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        resolutionContext: "kept the session's rename",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      await waitForJobCompletions();

      expect(
        createJobsRepo(testDb).getJobRecord(result.value.jobId),
      ).toMatchObject({
        status: "ready-to-land",
        parkedRef: "refs/cc-merges/test",
        preparedSha: "prepared-sha",
        expectedTargetSha: "expected-target-sha",
        finalizeSessionOnPublish: true,
        resolutionContext: "kept the session's rename",
      });
    });

    /**
     * Whether a merge finalizes its session is a fact about the job, and the
     * launch guard is the reader that needs it: only a session-finalizing merge
     * makes a session exclusively busy. Inferring it from jobType would refuse
     * launches during every graph lane merge — which the workflow itself runs.
     */
    it("records that a user-driven session merge finalizes the session on publish", async () => {
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockPublishActor.mockResolvedValue({
        status: "ready-to-land" as const,
        parkedRef: "refs/cc-merges/session-job",
        preparedSha: "prepared-sha",
        targetWorktreePath: "/projects/foo",
      });

      const result = dispatchMergeJob(BASE_MERGE_PARAMS);
      expect(result.ok).toBe(true);
      await waitForJobCompletions();

      expect(
        getJob(BASE_MERGE_PARAMS.projectPath, BASE_MERGE_PARAMS.sessionName),
      ).toMatchObject({ finalizeSessionOnPublish: true });
    });

    it("records that a graph lane merge does not finalize the session", async () => {
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockPublishActor.mockResolvedValue({
        status: "ready-to-land" as const,
        parkedRef: "refs/cc-merges/graph-job",
        preparedSha: "prepared-sha",
        targetWorktreePath: "/projects/foo",
      });

      await runRegisteredMergeJob({
        machine: testMachine,
        broadcast: mockBroadcast,
        input: {
          jobId: "lane-job",
          projectPath: BASE_MERGE_PARAMS.projectPath,
          projectName: BASE_MERGE_PARAMS.projectName,
          sessionName: BASE_MERGE_PARAMS.sessionName,
          worktreePath: BASE_MERGE_PARAMS.worktreePath,
          branchName: BASE_MERGE_PARAMS.branchName,
          message: BASE_MERGE_PARAMS.message,
          autoResolve: true,
          validationMode: {
            mode: "run",
            source: "graph_lane_merge",
            selection: { mode: "only", commands: ["typecheck"] },
          },
          targetBranch: "main",
          finalizeSessionOnPublish: false,
          executionId: "workflow-execution-lane",
        },
      });

      expect(
        getJob(BASE_MERGE_PARAMS.projectPath, BASE_MERGE_PARAMS.sessionName),
      ).toMatchObject({ finalizeSessionOnPublish: false });
    });

    /**
     * The reader behind the workflow launch guard. What it must NOT do is
     * report a graph lane merge: the engine runs those itself, so a false block
     * there has the engine refuse its own next launch.
     */
    describe("getFinalizingSessionMergeJob", () => {
      it("reports a running session merge", async () => {
        let finishMerge!: (value: MergeMainOutput) => void;
        mockMergeMain.mockReturnValue(
          new Promise<MergeMainOutput>((resolve) => {
            finishMerge = resolve;
          }),
        );
        mockPublishActor.mockResolvedValue({
          status: "completed" as const,
          mergeHash: "abc123",
        });

        const result = dispatchMergeJob(BASE_MERGE_PARAMS);
        expect(result.ok).toBe(true);

        expect(
          getFinalizingSessionMergeJob(
            BASE_MERGE_PARAMS.projectPath,
            BASE_MERGE_PARAMS.sessionName,
          ),
        ).toMatchObject({
          branchName: BASE_MERGE_PARAMS.branchName,
          finalizeSessionOnPublish: true,
        });

        finishMerge({ status: "clean", conflictFiles: [] });
        await waitForJobCompletions();
      });

      it("reports nothing for a running graph lane merge", async () => {
        let finishMerge!: (value: MergeMainOutput) => void;
        mockMergeMain.mockReturnValue(
          new Promise<MergeMainOutput>((resolve) => {
            finishMerge = resolve;
          }),
        );
        mockPublishActor.mockResolvedValue({
          status: "completed" as const,
          mergeHash: "abc123",
        });

        const running = runRegisteredMergeJob({
          machine: testMachine,
          broadcast: mockBroadcast,
          input: {
            jobId: "lane-job-running",
            projectPath: BASE_MERGE_PARAMS.projectPath,
            projectName: BASE_MERGE_PARAMS.projectName,
            sessionName: BASE_MERGE_PARAMS.sessionName,
            worktreePath: BASE_MERGE_PARAMS.worktreePath,
            branchName: BASE_MERGE_PARAMS.branchName,
            message: BASE_MERGE_PARAMS.message,
            autoResolve: true,
            validationMode: {
              mode: "run",
              source: "graph_lane_merge",
              selection: { mode: "only", commands: ["typecheck"] },
            },
            targetBranch: "main",
            finalizeSessionOnPublish: false,
            executionId: "workflow-execution-lane-running",
          },
        });

        expect(
          getJob(BASE_MERGE_PARAMS.projectPath, BASE_MERGE_PARAMS.sessionName),
        ).toMatchObject({ status: "running" });
        expect(
          getFinalizingSessionMergeJob(
            BASE_MERGE_PARAMS.projectPath,
            BASE_MERGE_PARAMS.sessionName,
          ),
        ).toBeNull();

        finishMerge({ status: "clean", conflictFiles: [] });
        await running;
        await waitForJobCompletions();
      });

      it("reports nothing once the session merge is parked ready to land", async () => {
        mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
        mockPublishActor.mockResolvedValue({
          status: "ready-to-land" as const,
          parkedRef: "refs/cc-merges/session-parked",
          preparedSha: "prepared-sha",
          targetWorktreePath: "/projects/foo",
        });

        const result = dispatchMergeJob(BASE_MERGE_PARAMS);
        expect(result.ok).toBe(true);
        await waitForJobCompletions();

        // Parked awaiting an operator decision: it publishes nothing until a
        // land re-entry starts a new running job, so it is not in flight.
        expect(
          getJob(BASE_MERGE_PARAMS.projectPath, BASE_MERGE_PARAMS.sessionName),
        ).toMatchObject({ status: "ready-to-land" });
        expect(
          getFinalizingSessionMergeJob(
            BASE_MERGE_PARAMS.projectPath,
            BASE_MERGE_PARAMS.sessionName,
          ),
        ).toBeNull();
      });

      it("reports nothing for a session with no job at all", () => {
        expect(
          getFinalizingSessionMergeJob(
            BASE_MERGE_PARAMS.projectPath,
            "some-other-session",
          ),
        ).toBeNull();
      });

      /**
       * A discard drops the parked commit and publishes nothing, so it finishes
       * no session. Marking it finalizing would block every launch for the
       * duration of a git ref delete.
       */
      it("reports nothing for a running discard of a parked merge", async () => {
        let finishDiscard!: () => void;
        mockDiscardParkedRefActor.mockReturnValue(
          new Promise<void>((resolve) => {
            finishDiscard = resolve;
          }),
        );

        const result = dispatchMergeJob({
          ...BASE_MERGE_PARAMS,
          entryMode: "discard",
          preparedSha: "prepared-sha",
          parkedRef: "refs/cc-merges/discarded",
        });
        expect(result.ok).toBe(true);

        expect(
          getJob(BASE_MERGE_PARAMS.projectPath, BASE_MERGE_PARAMS.sessionName),
        ).toMatchObject({ status: "running", finalizeSessionOnPublish: false });
        expect(
          getFinalizingSessionMergeJob(
            BASE_MERGE_PARAMS.projectPath,
            BASE_MERGE_PARAMS.sessionName,
          ),
        ).toBeNull();

        finishDiscard();
        await waitForJobCompletions();
      });

      /**
       * Re-entry is the same saga, not a new one: a graph lane merge parked as
       * ready-to-land is still the workflow's own work when an operator lands
       * it, so the fact has to survive the new job. Losing it here would both
       * false-block the engine's next launch and hand the publish actor a
       * session delivery gate to run against the workflow's own Current run.
       */
      it("carries an explicit non-finalizing fact through a land re-entry", async () => {
        let finishPublish!: (value: PublishActorOutput) => void;
        mockPublishActor.mockReturnValue(
          new Promise<PublishActorOutput>((resolve) => {
            finishPublish = resolve;
          }),
        );

        const result = dispatchMergeJob({
          ...BASE_MERGE_PARAMS,
          entryMode: "land",
          preparedSha: "prepared-sha",
          expectedTargetSha: "expected-target-sha",
          parkedRef: "refs/cc-merges/graph-parked",
          executionId: "workflow-execution-landed",
          finalizeSessionOnPublish: false,
        });
        expect(result.ok).toBe(true);
        // The land entry routes straight to the delivery gate and then to
        // publish; hold the publish open so the job is observably in flight.
        await vi.waitFor(() => {
          expect(mockPublishActor).toHaveBeenCalled();
        });

        expect(
          getJob(BASE_MERGE_PARAMS.projectPath, BASE_MERGE_PARAMS.sessionName),
        ).toMatchObject({ status: "running", finalizeSessionOnPublish: false });
        expect(
          getFinalizingSessionMergeJob(
            BASE_MERGE_PARAMS.projectPath,
            BASE_MERGE_PARAMS.sessionName,
          ),
        ).toBeNull();
        // The machine context reads the same decision the job record does, so
        // the publish actor neither runs the session delivery gate nor finishes
        // the session.
        expect(mockPublishActor).toHaveBeenCalledWith(
          expect.objectContaining({ finalizeSession: false }),
        );

        finishPublish({ status: "completed", mergeHash: "landed-hash" });
        await waitForJobCompletions();
      });

      it("carries an explicit non-finalizing fact through a conflict-resolution retry", async () => {
        mockResolveConflictsActor.mockResolvedValue({
          status: "resolved",
          conflicts: [],
        });
        mockCommitChangesActor.mockResolvedValue({ hash: "resolve_hash" });
        let finishPublish!: (value: PublishActorOutput) => void;
        mockPublishActor.mockReturnValue(
          new Promise<PublishActorOutput>((resolve) => {
            finishPublish = resolve;
          }),
        );

        const result = dispatchResolveConflictsJob({
          ...BASE_RESOLVE_PARAMS,
          executionId: "workflow-execution-retry",
          finalizeSessionOnPublish: false,
        });
        expect(result.ok).toBe(true);
        await vi.waitFor(() => {
          expect(mockPublishActor).toHaveBeenCalled();
        });

        expect(
          getJob(BASE_MERGE_PARAMS.projectPath, BASE_MERGE_PARAMS.sessionName),
        ).toMatchObject({ status: "running", finalizeSessionOnPublish: false });
        expect(
          getFinalizingSessionMergeJob(
            BASE_MERGE_PARAMS.projectPath,
            BASE_MERGE_PARAMS.sessionName,
          ),
        ).toBeNull();
        expect(mockPublishActor).toHaveBeenCalledWith(
          expect.objectContaining({ finalizeSession: false }),
        );

        finishPublish({ status: "completed", mergeHash: "resolved-hash" });
        await waitForJobCompletions();
      });
    });
  });

  // ----------------------------------------------------------
  // targetBranch threading
  // ----------------------------------------------------------
  describe("targetBranch threading", () => {
    it("persists a fresh candidate-validation fact before delivery-gate evaluation", async () => {
      const candidateValidation = {
        validationRef: "validation-before-gate",
        validatedSha: "validated-before-gate-sha",
        validatedTreeHash: "validated-before-gate-tree",
        commandIdentity: "./validate.sh",
        outcome: "pass" as const,
      };
      const dispatchState: { jobId?: string } = {};
      let durableRecordAtGate: JobRecord | null | undefined;
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockRunValidation.mockResolvedValue(candidateValidation);
      mockDeliveryGateActor.mockImplementation(async () => {
        if (dispatchState.jobId === undefined) {
          throw new Error(
            "Delivery gate ran before dispatch returned the job id",
          );
        }
        durableRecordAtGate = createJobsRepo(testDb).getJobRecord(
          dispatchState.jobId,
        );
        return {
          status: "pass" as const,
          satisfied: [],
          deferred: [],
        };
      });
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "landed-sha",
      });

      const result = dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        executionId: "workflow-execution-before-gate",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      dispatchState.jobId = result.value.jobId;

      await waitForJobCompletions();

      expect(mockDeliveryGateActor).toHaveBeenCalledTimes(1);
      expect(mockPublishActor).toHaveBeenCalledTimes(1);
      expect(durableRecordAtGate).toMatchObject({
        executionId: "workflow-execution-before-gate",
        candidateValidation,
      });
    });

    it("publishes the typed halt reason when the delivery gate refuses a merge", async () => {
      const haltReason = {
        type: "delivery_gate_failed" as const,
        unmet: [
          {
            criterionId: "criterion-1",
            criterionHandle: "native-sdd/R18.4",
            outcome: "unmet",
            reason: "candidate proof is stale",
          },
        ],
        instruction: "Re-dispatch the merge to validate the candidate again.",
      };
      mockDeliveryGateActor.mockResolvedValue({
        status: "refused" as const,
        unmet: haltReason.unmet,
        instruction: haltReason.instruction,
      });

      const result = dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        entryMode: "land",
        preparedSha: "prepared-land-sha",
        expectedTargetSha: "target-land-sha",
        parkedRef: "refs/cc-merges/land",
        executionId: "workflow-execution-land",
      });
      expect(result.ok).toBe(true);

      await waitForJobCompletions();

      expect(lastBroadcast()).toMatchObject({
        type: "job-status",
        status: "failed",
        parkedRef: "refs/cc-merges/land",
        haltReason,
      });
      expect(mockPublishActor).not.toHaveBeenCalled();
    });

    it("carries persisted delivery-gate fields from a land dispatch into MergeInput", async () => {
      const candidateValidation = {
        validationRef: "validation-land",
        validatedSha: "validated-land-sha",
        validatedTreeHash: "validated-land-tree",
        commandIdentity: "./validate.sh",
        outcome: "pass" as const,
      };
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "landed-sha",
      });

      const result = dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        entryMode: "land",
        preparedSha: "prepared-land-sha",
        expectedTargetSha: "target-land-sha",
        parkedRef: "refs/cc-merges/land",
        executionId: "workflow-execution-land",
        candidateValidation,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(
        createJobsRepo(testDb).getJobRecord(result.value.jobId),
      ).toMatchObject({
        executionId: "workflow-execution-land",
        candidateValidation,
      });

      await waitForJobCompletions();

      expect(mockDeliveryGateActor).toHaveBeenCalledWith({
        workflowExecutionId: "workflow-execution-land",
        preparedSha: "prepared-land-sha",
        expectedTargetSha: "target-land-sha",
        projectPath: BASE_MERGE_PARAMS.projectPath,
        candidateValidation,
      });
    });

    it("dispatchMergeJob passes targetBranch to MergeInput", async () => {
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "abc123",
      });

      const result = dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        targetBranch: "csm/parent-branch",
      });
      expect(result.ok).toBe(true);

      await waitForJobCompletions();

      // mergeMain actor should receive targetBranch
      expect(mockMergeMain).toHaveBeenCalledWith(
        expect.objectContaining({
          targetBranch: "csm/parent-branch",
        }),
      );
      // prepare actor should receive targetBranch; the publish discovers the
      // target checkout from the branch
      expect(mockPrepareActor).toHaveBeenCalledWith(
        expect.objectContaining({
          targetBranch: "csm/parent-branch",
        }),
      );
      expect(mockPublishActor).toHaveBeenCalledWith(
        expect.objectContaining({
          targetBranch: "csm/parent-branch",
        }),
      );
    });

    it("dispatchResolveConflictsJob passes targetBranch to MergeInput", async () => {
      mockResolveConflictsActor.mockResolvedValue({
        status: "resolved",
        conflicts: [],
      });
      mockCommitChangesActor.mockResolvedValue({ hash: "h" });
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "m",
      });

      const result = dispatchResolveConflictsJob({
        ...BASE_RESOLVE_PARAMS,
        targetBranch: "csm/parent-branch",
      });
      expect(result.ok).toBe(true);

      await waitForJobCompletions();

      expect(mockPrepareActor).toHaveBeenCalledWith(
        expect.objectContaining({ targetBranch: "csm/parent-branch" }),
      );
      expect(mockPublishActor).toHaveBeenCalledWith(
        expect.objectContaining({ targetBranch: "csm/parent-branch" }),
      );
    });

    it("dispatchMergeJob threads resolutionContext to the resolveConflicts actor and keeps it on the terminal job", async () => {
      mockMergeMain.mockResolvedValue({
        status: "conflicts",
        conflictFiles: ["src/a.ts"],
      });
      mockResolveConflictsActor.mockResolvedValue({
        status: "failed",
        conflicts: [],
      });

      const result = dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        autoResolve: true,
        resolutionContext: "Session renamed SessionStore to SessionRepo.",
      });
      expect(result.ok).toBe(true);

      await waitForJobCompletions();

      expect(mockResolveConflictsActor).toHaveBeenCalledWith(
        expect.objectContaining({
          resolutionContext: "Session renamed SessionStore to SessionRepo.",
        }),
      );

      // The conflicts-terminal job keeps the context so a later
      // resolve-conflicts retry can reuse it.
      const job = getJob(
        BASE_MERGE_PARAMS.projectPath,
        BASE_MERGE_PARAMS.sessionName,
      );
      expect(job?.status).toBe("conflicts");
      expect(job?.resolutionContext).toBe(
        "Session renamed SessionStore to SessionRepo.",
      );
    });

    it("dispatchMergeJob refuses a worktree left mid-merge (default refuse policy)", async () => {
      mockClassifyWorktree.mockResolvedValue({
        kind: "mid-merge",
        unresolved: true,
      });

      const result = dispatchMergeJob(BASE_MERGE_PARAMS);
      expect(result.ok).toBe(true);

      await waitForJobCompletions();

      expect(mockAbortStaleMerge).not.toHaveBeenCalled();
      expect(mockMergeMain).not.toHaveBeenCalled();
      const last = lastBroadcast();
      expect(last.status).toBe("failed");
      expect(last.errorMessage).toContain("mid-merge");
    });

    it("dispatchResolveConflictsJob seeds the resolver's conflictFiles from the job it resumes", async () => {
      mockResolveConflictsActor.mockResolvedValue({
        status: "resolved",
        conflicts: [],
      });
      mockCommitChangesActor.mockResolvedValue({ hash: "h" });
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "m",
      });

      dispatchResolveConflictsJob({
        ...BASE_RESOLVE_PARAMS,
        conflictFiles: ["src/a.ts", "src/b.ts"],
      });
      await waitForJobCompletions();

      expect(mockResolveConflictsActor).toHaveBeenCalledWith(
        expect.objectContaining({ conflictFiles: ["src/a.ts", "src/b.ts"] }),
      );
    });

    /**
     * The retry resumes a merge that had the fix loop; losing it here would
     * fail a conflict resolution on a lint error the original merge would have
     * fixed itself.
     */
    it("dispatchResolveConflictsJob still runs the validation fix loop", async () => {
      mockResolveConflictsActor.mockResolvedValue({
        status: "resolved",
        conflicts: [],
      });
      mockCommitChangesActor.mockResolvedValue({ hash: "h" });
      mockCheckUncommitted.mockResolvedValue({ hasChanges: true });
      mockRunValidation
        .mockRejectedValueOnce(remediableValidationFailure("lint errors"))
        .mockResolvedValueOnce(undefined);
      mockFixValidation.mockResolvedValue({ status: "fixed" as const });
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "m",
      });

      dispatchResolveConflictsJob(BASE_RESOLVE_PARAMS);
      await waitForJobCompletions();

      expect(mockFixValidation).toHaveBeenCalled();
      expect(mockRunValidation).toHaveBeenCalledTimes(2);
      expect(lastBroadcast().status).toBe("completed");
    });

    it("dispatchResolveConflictsJob threads resolutionContext to the resolveConflicts actor", async () => {
      mockResolveConflictsActor.mockResolvedValue({
        status: "resolved",
        conflicts: [],
      });
      mockCommitChangesActor.mockResolvedValue({ hash: "h" });
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "m",
      });

      dispatchResolveConflictsJob({
        ...BASE_RESOLVE_PARAMS,
        resolutionContext: "Session migrated config reads to Zod v4.",
      });
      await waitForJobCompletions();

      expect(mockResolveConflictsActor).toHaveBeenCalledWith(
        expect.objectContaining({
          resolutionContext: "Session migrated config reads to Zod v4.",
        }),
      );
    });

    it("records the merge intent against the landed commit when a merge with resolutionContext completes", async () => {
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "landed-sha",
      });

      dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        resolutionContext: "Session renamed SessionStore to SessionRepo.",
      });
      await waitForJobCompletions();

      const intents = mergeIntentsRepo.getMergeIntents(
        BASE_MERGE_PARAMS.projectPath,
        ["landed-sha"],
      );
      expect(intents).toEqual([
        expect.objectContaining({
          projectPath: BASE_MERGE_PARAMS.projectPath,
          commitSha: "landed-sha",
          intent: "Session renamed SessionStore to SessionRepo.",
          source: "session-merge",
        }),
      ]);
    });

    /**
     * One landed commit gets one intent row, attributed to the surface that
     * dispatched the merge. The graph join's own recording used to run beside
     * this one and write the same SHA twice under a different source.
     */
    it("records a graph-owned merge's intent once, as a graph join", async () => {
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "lane-sha",
      });

      await runRegisteredMergeJob({
        machine: testMachine,
        broadcast: mockBroadcast,
        input: {
          jobId: "graph-job-intent",
          projectPath: BASE_MERGE_PARAMS.projectPath,
          projectName: BASE_MERGE_PARAMS.projectName,
          sessionName: BASE_MERGE_PARAMS.sessionName,
          worktreePath: BASE_MERGE_PARAMS.worktreePath,
          branchName: BASE_MERGE_PARAMS.branchName,
          message: BASE_MERGE_PARAMS.message,
          autoResolve: true,
          validationMode: {
            mode: "run",
            source: "graph_lane_merge",
            selection: { mode: "only", commands: ["typecheck"] },
          },
          targetBranch: "main",
          finalizeSessionOnPublish: false,
          resolutionContext: "Lane B rewrote the scheduler.",
        },
      });

      expect(countMergeIntents()).toBe(1);
      expect(
        mergeIntentsRepo.getMergeIntents(BASE_MERGE_PARAMS.projectPath, [
          "lane-sha",
        ]),
      ).toEqual([
        expect.objectContaining({
          commitSha: "lane-sha",
          intent: "Lane B rewrote the scheduler.",
          source: "graph-join",
        }),
      ]);
    });

    it("does not record a merge intent when the merge completes without resolutionContext", async () => {
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "landed-sha",
      });

      dispatchMergeJob(BASE_MERGE_PARAMS);
      await waitForJobCompletions();

      expect(
        mergeIntentsRepo.getMergeIntents(BASE_MERGE_PARAMS.projectPath, [
          "landed-sha",
        ]),
      ).toEqual([]);
    });

    it("does not record a merge intent when the merge ends in conflicts", async () => {
      mockMergeMain.mockResolvedValue({
        status: "conflicts",
        conflictFiles: ["src/a.ts"],
      });
      mockResolveConflictsActor.mockResolvedValue({
        status: "failed",
        conflicts: [],
      });

      dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        autoResolve: true,
        resolutionContext: "Some intent.",
      });
      await waitForJobCompletions();

      expect(countMergeIntents()).toBe(0);
    });

    it("notification message includes target branch for merge completion", async () => {
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "abc123",
      });

      dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        targetBranch: "csm/parent-branch",
      });
      await waitForJobCompletions();

      const [notification] = notificationsRepo.getNotifications().notifications;
      expect(notification?.message).toContain("csm/parent-branch");
    });
  });

  describe("getActiveJobs", () => {
    it("returns only running jobs from the registry", async () => {
      // Dispatch a merge job (stays running because actors block)
      let resolveActor: (() => void) | undefined;
      mockClassifyWorktree.mockReturnValue(
        new Promise<{ kind: string }>((resolve) => {
          resolveActor = () => resolve({ kind: "clean" });
        }),
      );
      mockAcquireSessionLock.mockReturnValue(() => {});

      dispatchMergeJob(BASE_MERGE_PARAMS);

      const active = getActiveJobs();
      expect(active).toHaveLength(1);
      expect(active[0]?.status).toBe("running");

      // Clean up — resolve the blocked actor
      resolveActor?.();
      await waitForJobCompletions();
    });
  });

  describe("trace context propagation", () => {
    it("dispatchMergeJob inherits parent traceId and overrides action to job:merge", async () => {
      const captured: TraceContext[] = [];
      mockClassifyWorktree.mockImplementation(async () => {
        const ctx = getTraceContext();
        if (ctx) captured.push(ctx);
        return { kind: "clean" };
      });
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "abc123",
      });

      const parent: TraceContext = {
        traceId: "parent-request-trace",
        action: "request:POST /api/jobs/merge",
        projectName: "foo",
        sessionName: "my-session",
      };

      runWithTrace(parent, () => {
        const result = dispatchMergeJob(BASE_MERGE_PARAMS);
        expect(result.ok).toBe(true);
      });

      await waitForJobCompletions();

      expect(captured.length).toBeGreaterThan(0);
      const ctx = captured[0]!;
      expect(ctx.traceId).toBe("parent-request-trace");
      expect(ctx.action).toBe("job:merge");
      expect(ctx.projectName).toBe("foo");
      expect(ctx.sessionName).toBe("my-session");
    });

    it("dispatchMergeJob mints a fresh traceId when dispatched without parent scope", async () => {
      const captured: TraceContext[] = [];
      mockClassifyWorktree.mockImplementation(async () => {
        const ctx = getTraceContext();
        if (ctx) captured.push(ctx);
        return { kind: "clean" };
      });
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "abc123",
      });

      dispatchMergeJob(BASE_MERGE_PARAMS);

      await waitForJobCompletions();

      expect(captured.length).toBeGreaterThan(0);
      const ctx = captured[0]!;
      expect(ctx.action).toBe("job:merge");
      expect(ctx.traceId).toBeTypeOf("string");
      expect(ctx.traceId.length).toBeGreaterThan(0);
    });
  });

  // ----------------------------------------------------------
  // abortSessionJob
  // ----------------------------------------------------------
  describe("abortSessionJob", () => {
    it("fails a running merge with the operator's reason and releases the session lock", async () => {
      mockMergeMain.mockResolvedValue({
        status: "conflicts",
        conflictFiles: ["src/a.ts"],
      });
      // A resolver turn that only ends when the machine stops it.
      mockResolveConflictsActor.mockImplementation(() => new Promise(() => {}));

      const dispatched = dispatchMergeJob({
        ...BASE_MERGE_PARAMS,
        autoResolve: true,
      });
      expect(dispatched.ok).toBe(true);
      await waitForJobPhase("resolving-conflicts");

      const aborted = abortSessionJob("/projects/foo", "my-session");
      expect(aborted).toEqual({
        ok: true,
        jobId: dispatched.ok ? dispatched.value.jobId : "",
        delivery: "stopping",
      });

      await waitForJobCompletions();

      const event = lastBroadcast();
      expect(event.status).toBe("failed");
      expect(event.errorMessage).toBe("Aborted by operator");
      expect(releaseSession).toHaveBeenCalledTimes(1);

      const persisted = createJobsRepo(testDb).getJobRecord(
        dispatched.ok ? dispatched.value.jobId : "",
      );
      expect(persisted?.status).toBe("failed");
      expect(persisted?.errorMessage).toBe("Aborted by operator");
    });

    it("fails a running commit with the operator's reason", async () => {
      mockCommitChangesActor.mockResolvedValue({ hash: "abc123" });
      mockRunValidation.mockImplementation(() => new Promise(() => {}));

      const dispatched = dispatchCommitJob(BASE_COMMIT_PARAMS);
      expect(dispatched.ok).toBe(true);
      await waitForJobPhase("validating");

      expect(abortSessionJob("/projects/foo", "my-session")).toMatchObject({
        ok: true,
        delivery: "stopping",
      });
      await waitForJobCompletions();

      const event = lastBroadcast();
      expect(event.status).toBe("failed");
      expect(event.errorMessage).toBe("Aborted by operator");
      expect(releaseSession).toHaveBeenCalledTimes(1);
    });

    it("reports a stop it could only record while the merge is publishing", async () => {
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      // The publish's CAS update and session finalization are exactly what
      // cannot be recalled, so the job lands despite the accepted stop.
      let publishStarted = false;
      let landPublish!: (output: {
        status: "completed";
        mergeHash: string;
      }) => void;
      mockPublishActor.mockImplementation(
        () =>
          new Promise((resolve) => {
            landPublish = resolve;
            publishStarted = true;
          }),
      );

      const dispatched = dispatchMergeJob(BASE_MERGE_PARAMS);
      expect(dispatched.ok).toBe(true);

      const deadline = Date.now() + 2_000;
      while (!publishStarted) {
        if (Date.now() > deadline) throw new Error("publish never started");
        await new Promise((resolve) => setTimeout(resolve, 1));
      }

      expect(abortSessionJob("/projects/foo", "my-session")).toEqual({
        ok: true,
        jobId: dispatched.ok ? dispatched.value.jobId : "",
        delivery: "deferred",
      });

      landPublish({ status: "completed", mergeHash: "landed-anyway" });
      await waitForJobCompletions();
      expect(lastBroadcast().status).toBe("completed");
    });

    it("reports nothing to abort when the session has no job", () => {
      expect(abortSessionJob("/projects/foo", "my-session")).toEqual({
        ok: false,
        error: "NO_ABORTABLE_JOB",
      });
    });

    it("reports nothing to abort once the job has finished", async () => {
      mockMergeMain.mockResolvedValue({ status: "clean", conflictFiles: [] });
      mockPublishActor.mockResolvedValue({
        status: "completed" as const,
        mergeHash: "abc123",
      });

      dispatchMergeJob(BASE_MERGE_PARAMS);
      await waitForJobCompletions();

      expect(abortSessionJob("/projects/foo", "my-session")).toEqual({
        ok: false,
        error: "NO_ABORTABLE_JOB",
      });
    });
  });
});
