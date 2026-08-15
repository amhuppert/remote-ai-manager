import { describe, expect, it, vi } from "vitest";
import {
  runPrepare,
  runPublish,
  type PrepareActorDeps,
  type PrepareActorInput,
  type PublishActorDeps,
  type PublishActorInput,
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
    getActiveGraphWorkflowExecution:
      overrides.getActiveGraphWorkflowExecution ?? vi.fn(async () => null),
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
  it("does not publish a session while its graph workflow still owns unfinished work", async () => {
    const publish = vi.fn(async () => ({
      kind: "published" as const,
      mergeHash: "merge-abc",
    }));
    const setFinished = vi.fn(async () => {});
    const deps = makePublishDeps({
      publishPreparedMerge: publish,
      setSessionFinished: setFinished,
      getActiveGraphWorkflowExecution: vi.fn().mockResolvedValue({
        id: "execution-1",
        status: "running",
      }),
    });

    const out = await runPublish(deps, basePublishInput);

    expect(out).toEqual({
      status: "failed",
      error:
        "Graph workflow execution execution-1 is running. Complete or abort it before merging this session.",
    });
    expect(publish).not.toHaveBeenCalled();
    expect(setFinished).not.toHaveBeenCalled();
  });

  /**
   * The route's check is advisory: it runs before the job, before the lock, and
   * the answer can be stale by the time the publish happens. This is the
   * authoritative one — it reads inside the project lock, which is the only
   * window in which "no run holds the lease" stays true through the publish.
   */
  it("re-reads the lease inside the project lock, refusing when a run took it after the route check", async () => {
    const publish = vi.fn(async () => ({
      kind: "published" as const,
      mergeHash: "merge-abc",
    }));
    const events: string[] = [];
    // Answers what the route saw first, then what is true under the lock.
    const getActiveGraphWorkflowExecution = vi
      .fn()
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(async () => {
        events.push("in-lock-read");
        return {
          id: "execution-late",
          status: "running",
          haltReason: null,
          abandonment: null,
          definitionApproval: null,
        };
      });
    const deps = makePublishDeps({
      publishPreparedMerge: publish,
      getActiveGraphWorkflowExecution,
      acquireProjectLock: vi.fn(() => {
        events.push("lock-acquired");
        return () => events.push("lock-released");
      }),
    });

    // The advisory read the route would have made: clear.
    expect(await deps.getActiveGraphWorkflowExecution("/proj", "feature")).toBe(
      null,
    );

    const out = await runPublish(deps, basePublishInput);

    expect(out).toEqual({
      status: "failed",
      error:
        "Graph workflow execution execution-late is running. Complete or abort it before merging this session.",
    });
    expect(publish).not.toHaveBeenCalled();
    // Order is the point: the deciding read happens after the lock is held.
    expect(events).toEqual(["lock-acquired", "in-lock-read", "lock-released"]);
  });

  it("allows graph-owned lane merges that do not finalize the session", async () => {
    const publish = vi.fn(async () => ({
      kind: "published" as const,
      mergeHash: "merge-abc",
    }));
    const getActiveGraphWorkflowExecution = vi.fn().mockResolvedValue({
      id: "execution-1",
      status: "running",
    });
    const deps = makePublishDeps({
      publishPreparedMerge: publish,
      getActiveGraphWorkflowExecution,
    });

    const out = await runPublish(deps, {
      ...basePublishInput,
      finalizeSession: false,
    });

    expect(out).toEqual({ status: "completed", mergeHash: "merge-abc" });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(getActiveGraphWorkflowExecution).not.toHaveBeenCalled();
  });

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
