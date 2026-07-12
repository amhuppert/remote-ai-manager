import { describe, expect, it, vi } from "vitest";
import {
  runPrepare,
  runPublish,
  runValidationInner,
  type PrepareActorDeps,
  type PrepareActorInput,
  type PublishActorDeps,
  type PublishActorInput,
  type RunValidationDeps,
  type RunValidationInput,
} from "./actors";
import type {
  PrepareResult,
  PublishResult,
  TargetCheckoutState,
} from "@/lib/git/worktree";

// ============================================================
// prepareActor (runPrepare inner)
// ============================================================

const baseInput: PrepareActorInput = {
  projectPath: "/proj",
  worktreePath: "/proj/.worktrees/feature",
  branchName: "csm/feature",
  targetBranch: "main",
  message: "Merge: feature",
  jobId: "job-1",
};

function makePrepareDeps(
  overrides: Partial<PrepareActorDeps> = {},
): PrepareActorDeps {
  return {
    prepareSquashMerge:
      overrides.prepareSquashMerge ??
      vi.fn(
        async (): Promise<PrepareResult> => ({
          kind: "prepared",
          preparedSha: "prep-1",
          expectedTargetSha: "tgt-old",
          parkedRef: "refs/cc-merges/job-1",
        }),
      ),
    revParse: overrides.revParse ?? vi.fn(async () => "abc"),
  };
}

describe("runPrepare", () => {
  it("captures expectedTargetSha and featureSha immediately before invoking prepareSquashMerge", async () => {
    const callOrder: string[] = [];
    const revParse = vi.fn(async (cwd: string, ref: string) => {
      callOrder.push(`rev-parse ${cwd} ${ref}`);
      if (ref === "refs/heads/main") return "tgt-sha-123\n";
      if (ref === "HEAD") return "feat-sha-456\n";
      throw new Error(`unexpected ref ${ref}`);
    });
    const prepareSquashMerge = vi.fn(async (input): Promise<PrepareResult> => {
      callOrder.push(`prepare ${input.targetSha} ${input.featureSha}`);
      return {
        kind: "prepared",
        preparedSha: "prep-sha-789",
        expectedTargetSha: input.targetSha,
        parkedRef: `refs/cc-merges/${input.jobId}`,
      };
    });

    const out = await runPrepare(
      makePrepareDeps({ revParse, prepareSquashMerge }),
      baseInput,
    );

    expect(callOrder).toEqual([
      "rev-parse /proj refs/heads/main",
      "rev-parse /proj/.worktrees/feature HEAD",
      "prepare tgt-sha-123 feat-sha-456",
    ]);
    expect(out).toEqual({
      status: "prepared",
      preparedSha: "prep-sha-789",
      expectedTargetSha: "tgt-sha-123",
      parkedRef: "refs/cc-merges/job-1",
    });
  });

  it("forwards branchName, message, and jobId to prepareSquashMerge", async () => {
    const prepareSquashMerge = vi.fn(
      async (): Promise<PrepareResult> => ({
        kind: "prepared",
        preparedSha: "p",
        expectedTargetSha: "t",
        parkedRef: "r",
      }),
    );
    const revParse = vi.fn(async (_cwd: string, ref: string) =>
      ref === "HEAD" ? "feat" : "tgt",
    );

    await runPrepare(
      makePrepareDeps({ prepareSquashMerge, revParse }),
      baseInput,
    );

    expect(prepareSquashMerge).toHaveBeenCalledWith({
      projectPath: "/proj",
      featureBranch: "csm/feature",
      featureSha: "feat",
      targetBranch: "main",
      targetSha: "tgt",
      message: "Merge: feature",
      jobId: "job-1",
    });
  });

  it("maps conflicts kind to a conflicts status with files and expectedTargetSha", async () => {
    const prepareSquashMerge = vi.fn(
      async (): Promise<PrepareResult> => ({
        kind: "conflicts",
        expectedTargetSha: "tgt-sha",
        conflictFiles: ["a.ts", "b.ts"],
      }),
    );

    const out = await runPrepare(
      makePrepareDeps({ prepareSquashMerge }),
      baseInput,
    );

    expect(out).toEqual({
      status: "conflicts",
      expectedTargetSha: "tgt-sha",
      conflictFiles: ["a.ts", "b.ts"],
    });
  });
});

// ============================================================
// publishActor (runPublish inner)
// ============================================================

const basePublishInput: PublishActorInput = {
  projectPath: "/proj",
  sessionName: "feature",
  targetBranch: "main",
  preparedSha: "prep-1",
  expectedTargetSha: "tgt-old",
  parkedRef: "refs/cc-merges/job-1",
  finalizeSession: true,
};

function makePublishDeps(
  overrides: Partial<PublishActorDeps> = {},
): PublishActorDeps {
  return {
    discoverTargetCheckout:
      overrides.discoverTargetCheckout ??
      vi.fn(
        async (): Promise<TargetCheckoutState> => ({
          kind: "clean",
          worktreePath: "/proj/.worktrees/main",
        }),
      ),
    publishPreparedMerge:
      overrides.publishPreparedMerge ??
      vi.fn(
        async (): Promise<PublishResult> => ({
          kind: "published",
          mergeHash: "merge-abc",
        }),
      ),
    acquireProjectLock: overrides.acquireProjectLock ?? vi.fn(() => () => {}),
    runSessionLifecycleOperation:
      overrides.runSessionLifecycleOperation ??
      ((_projectPath, _sessionName, operation) => operation()),
    setSessionFinished: overrides.setSessionFinished ?? vi.fn(async () => {}),
    reconcileTicketSessionLifecycle:
      overrides.reconcileTicketSessionLifecycle ?? vi.fn(async () => {}),
    retargetOrphanedChildren:
      overrides.retargetOrphanedChildren ?? vi.fn(async () => {}),
    stopAllForSession: overrides.stopAllForSession ?? vi.fn(async () => {}),
    maxLockWaitMs: overrides.maxLockWaitMs ?? 50,
    retryMs: overrides.retryMs ?? 2,
    sleep: overrides.sleep,
  };
}

describe("runPublish", () => {
  it("returns ready-to-land without acquiring the lock when target is dirty", async () => {
    const acquire = vi.fn(() => () => {});
    const publish = vi.fn(async () => ({
      kind: "published" as const,
      mergeHash: "x",
    }));
    const setFinished = vi.fn(async () => {});
    const deps = makePublishDeps({
      acquireProjectLock: acquire,
      publishPreparedMerge: publish,
      setSessionFinished: setFinished,
      discoverTargetCheckout: vi.fn(
        async (): Promise<TargetCheckoutState> => ({
          kind: "dirty",
          worktreePath: "/proj/.worktrees/main",
          trackedDirtyPaths: [
            { path: "x.ts", statusCode: " M", tracked: true },
          ],
        }),
      ),
    });

    const out = await runPublish(deps, basePublishInput);

    expect(out).toEqual({
      status: "ready-to-land",
      parkedRef: "refs/cc-merges/job-1",
      preparedSha: "prep-1",
      targetWorktreePath: "/proj/.worktrees/main",
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(setFinished).not.toHaveBeenCalled();
  });

  it("acquires the project lock and publishes when target is clean", async () => {
    const release = vi.fn();
    const acquire = vi.fn(() => release);
    const publish = vi.fn(async () => ({
      kind: "published" as const,
      mergeHash: "merge-xyz",
    }));
    const deps = makePublishDeps({
      acquireProjectLock: acquire,
      publishPreparedMerge: publish,
    });

    const out = await runPublish(deps, basePublishInput);

    expect(out).toEqual({ status: "completed", mergeHash: "merge-xyz" });
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      projectPath: "/proj",
      targetBranch: "main",
      preparedSha: "prep-1",
      expectedTargetSha: "tgt-old",
      parkedRef: "refs/cc-merges/job-1",
      cleanTargetWorktreePath: "/proj/.worktrees/main",
    });
  });

  it("publishes with null cleanTargetWorktreePath when target is not checked out", async () => {
    const publish = vi.fn(async () => ({
      kind: "published" as const,
      mergeHash: "m",
    }));
    const deps = makePublishDeps({
      publishPreparedMerge: publish,
      discoverTargetCheckout: vi.fn(
        async (): Promise<TargetCheckoutState> => ({ kind: "not-checked-out" }),
      ),
    });

    await runPublish(deps, basePublishInput);

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ cleanTargetWorktreePath: null }),
    );
  });

  it("surfaces refreshWarning on completed when publish returns one", async () => {
    const deps = makePublishDeps({
      publishPreparedMerge: vi.fn(async () => ({
        kind: "published" as const,
        mergeHash: "m",
        refreshWarning: "worktree refresh failed: dirty",
      })),
    });

    const out = await runPublish(deps, basePublishInput);

    expect(out).toEqual({
      status: "completed",
      mergeHash: "m",
      refreshWarning: "worktree refresh failed: dirty",
    });
  });

  it("returns cas-lost without finalizing when CAS fails", async () => {
    const setFinished = vi.fn(async () => {});
    const stopAll = vi.fn(async () => {});
    const retarget = vi.fn(async () => {});
    const release = vi.fn();
    const deps = makePublishDeps({
      acquireProjectLock: vi.fn(() => release),
      publishPreparedMerge: vi.fn(async () => ({
        kind: "cas-lost" as const,
        actualTargetSha: "tgt-new",
      })),
      setSessionFinished: setFinished,
      stopAllForSession: stopAll,
      retargetOrphanedChildren: retarget,
    });

    const out = await runPublish(deps, basePublishInput);

    expect(out).toEqual({ status: "cas-lost", actualTargetSha: "tgt-new" });
    expect(setFinished).not.toHaveBeenCalled();
    expect(stopAll).not.toHaveBeenCalled();
    expect(retarget).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("finalizes session lifecycle only when finalizeSession is true", async () => {
    const setFinished = vi.fn(async () => {});
    const stopAll = vi.fn(async () => {});
    const retarget = vi.fn(async () => {});
    const deps = makePublishDeps({
      setSessionFinished: setFinished,
      stopAllForSession: stopAll,
      retargetOrphanedChildren: retarget,
    });

    await runPublish(deps, { ...basePublishInput, finalizeSession: false });
    expect(setFinished).not.toHaveBeenCalled();
    expect(stopAll).not.toHaveBeenCalled();
    expect(retarget).not.toHaveBeenCalled();

    await runPublish(deps, { ...basePublishInput, finalizeSession: true });
    expect(setFinished).toHaveBeenCalledWith("/proj", "feature");
    expect(stopAll).toHaveBeenCalledWith({
      projectPath: "/proj",
      sessionName: "feature",
    });
    expect(retarget).toHaveBeenCalledWith("/proj", "feature");
  });

  it("reconciles the ticket link as finished after marking the merged session finished", async () => {
    const setFinished = vi.fn(async () => {});
    const reconcileTicketSessionLifecycle = vi.fn(async () => {});
    const deps = makePublishDeps({
      setSessionFinished: setFinished,
      reconcileTicketSessionLifecycle,
    });

    await runPublish(deps, basePublishInput);

    expect(reconcileTicketSessionLifecycle).toHaveBeenCalledWith({
      projectPath: "/proj",
      sessionName: "feature",
      endReason: "finished",
    });
    expect(setFinished.mock.invocationCallOrder[0]).toBeLessThan(
      reconcileTicketSessionLifecycle.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("holds the session lifecycle gate across finish and ticket reconciliation", async () => {
    const phases: string[] = [];
    const deps = makePublishDeps({
      async runSessionLifecycleOperation(projectPath, sessionName, operation) {
        phases.push(`gate:${projectPath}:${sessionName}:start`);
        const result = await operation();
        phases.push(`gate:${projectPath}:${sessionName}:end`);
        return result;
      },
      setSessionFinished: vi.fn(async () => {
        phases.push("finished");
      }),
      reconcileTicketSessionLifecycle: vi.fn(async () => {
        phases.push("reconciled");
      }),
    });

    await runPublish(deps, basePublishInput);

    expect(phases).toEqual([
      "gate:/proj:feature:start",
      "finished",
      "reconciled",
      "gate:/proj:feature:end",
    ]);
  });

  it("releases the project lock when publishPreparedMerge throws", async () => {
    const release = vi.fn();
    const err = new Error("publish boom");
    const deps = makePublishDeps({
      acquireProjectLock: vi.fn(() => release),
      publishPreparedMerge: vi.fn(async () => {
        throw err;
      }),
    });

    await expect(runPublish(deps, basePublishInput)).rejects.toBe(err);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("survives stopAllForSession failure and still marks session finished", async () => {
    const setFinished = vi.fn(async () => {});
    const stopAll = vi.fn(async () => {
      throw new Error("dev-server cleanup failed");
    });
    const deps = makePublishDeps({
      setSessionFinished: setFinished,
      stopAllForSession: stopAll,
    });

    const out = await runPublish(deps, basePublishInput);
    expect(out.status).toBe("completed");
    expect(setFinished).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// runValidationInner — pre-merge timeout resolution
// ============================================================

const baseValidationInput: RunValidationInput = {
  projectPath: "/proj",
  worktreePath: "/proj/.worktrees/feature",
  sessionName: "feature",
  branchName: "csm/feature",
  targetBranch: "main",
  // The merge machine's hardcoded default; the last-resort fallback.
  timeoutMs: 300_000,
};

function makeValidationDeps(
  overrides: Partial<RunValidationDeps> = {},
): RunValidationDeps {
  return {
    readGlobalConfig: overrides.readGlobalConfig ?? vi.fn(async () => ({})),
    readRepoConfig: overrides.readRepoConfig ?? vi.fn(async () => null),
    runPreMergeValidation:
      overrides.runPreMergeValidation ?? vi.fn(async () => {}),
  };
}

describe("runValidationInner", () => {
  it("uses the global config timeout when no per-repo override exists", async () => {
    const runPreMergeValidation = vi.fn(async () => {});
    const deps = makeValidationDeps({
      readGlobalConfig: vi.fn(async () => ({ preMergeTimeoutMs: 3_600_000 })),
      readRepoConfig: vi.fn(async () => null),
      runPreMergeValidation,
    });

    await runValidationInner(deps, baseValidationInput);

    expect(runPreMergeValidation).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 3_600_000 }),
    );
  });

  it("lets the per-repo timeout override the global config", async () => {
    const runPreMergeValidation = vi.fn(async () => {});
    const deps = makeValidationDeps({
      readGlobalConfig: vi.fn(async () => ({ preMergeTimeoutMs: 3_600_000 })),
      readRepoConfig: vi.fn(async () => ({ preMergeTimeoutMs: 600_000 })),
      runPreMergeValidation,
    });

    await runValidationInner(deps, baseValidationInput);

    expect(runPreMergeValidation).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 600_000 }),
    );
  });

  it("falls back to the machine default when neither config sets a timeout", async () => {
    const runPreMergeValidation = vi.fn(async () => {});
    const deps = makeValidationDeps({
      readGlobalConfig: vi.fn(async () => ({})),
      readRepoConfig: vi.fn(async () => null),
      runPreMergeValidation,
    });

    await runValidationInner(deps, baseValidationInput);

    expect(runPreMergeValidation).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 300_000 }),
    );
  });

  it("is best-effort: a failing global config read falls through to the per-repo timeout", async () => {
    const runPreMergeValidation = vi.fn(async () => {});
    const deps = makeValidationDeps({
      readGlobalConfig: vi.fn(async () => {
        throw new Error("config unreadable");
      }),
      readRepoConfig: vi.fn(async () => ({ preMergeTimeoutMs: 900_000 })),
      runPreMergeValidation,
    });

    await runValidationInner(deps, baseValidationInput);

    expect(runPreMergeValidation).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 900_000 }),
    );
  });

  it("forwards the merge context (paths, branch, target) to the validation runner", async () => {
    const runPreMergeValidation = vi.fn(async () => {});
    const deps = makeValidationDeps({ runPreMergeValidation });

    await runValidationInner(deps, baseValidationInput);

    expect(runPreMergeValidation).toHaveBeenCalledWith({
      projectPath: "/proj",
      worktreePath: "/proj/.worktrees/feature",
      sessionName: "feature",
      branchName: "csm/feature",
      targetBranch: "main",
      timeoutMs: 300_000,
    });
  });
});
