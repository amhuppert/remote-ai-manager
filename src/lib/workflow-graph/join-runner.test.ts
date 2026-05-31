import { describe, expect, it } from "vitest";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionJoinState,
  GraphWorkflowExecutionLaneState,
} from "@/lib/workflows/schemas";
import { createSessionGitLock } from "./session-git-lock";
import { createPerSessionMergeMutex } from "./per-session-merge-mutex";
import { createJoinRunner, type JoinRunnerMutateActive } from "./join-runner";
import { createWorkflowExecution } from "./test-fixtures";
import type {
  GraphMergeRunner,
  GraphMergeRunnerInput,
} from "./graph-merge-runner";
import type { MergeOutput } from "@/lib/workflows/merge/types";

const t0 = "2026-03-27T12:00:00.000Z";

function makeLane(
  overrides: Partial<GraphWorkflowExecutionLaneState> &
    Pick<
      GraphWorkflowExecutionLaneState,
      "laneId" | "branchName" | "worktreePath"
    >,
): GraphWorkflowExecutionLaneState {
  return {
    kind: "worktree",
    status: "active",
    includedContextIds: [],
    lastCommittingContextId: null,
    commitSnapshots: [],
    createdAt: t0,
    updatedAt: t0,
    ...overrides,
  };
}

function makeJoin(
  overrides: Partial<GraphWorkflowExecutionJoinState> &
    Pick<
      GraphWorkflowExecutionJoinState,
      "joinId" | "targetLaneId" | "sourceLaneIds"
    >,
): GraphWorkflowExecutionJoinState {
  return {
    kind: "context_merge",
    contextId: null,
    mergedSourceLaneIds: [],
    status: "pending",
    errorMessage: null,
    conflicts: null,
    createdAt: t0,
    updatedAt: t0,
    completedAt: null,
    ...overrides,
  };
}

function createInMemoryPersist(initial: GraphWorkflowExecution): {
  mutateActive: JoinRunnerMutateActive;
  read(): GraphWorkflowExecution;
} {
  let current = initial;
  return {
    async mutateActive(mutator) {
      current = await mutator(current);
      return current;
    },
    read() {
      return current;
    },
  };
}

function fakeMergeRunner(
  outputsBySource: Map<string, MergeOutput>,
  observed: GraphMergeRunnerInput[],
): GraphMergeRunner {
  return {
    async run(input) {
      observed.push(input);
      const output = outputsBySource.get(input.branchName);
      if (!output) {
        throw new Error(
          `fakeMergeRunner: unexpected merge call for branch ${input.branchName}`,
        );
      }
      return output;
    },
  };
}

function completed(mergeHash = "abc123"): MergeOutput {
  return {
    status: "completed",
    mergeHash,
    commitHash: mergeHash,
    error: null,
    conflictFiles: [],
    conflictAnalysis: null,
    preparedSha: null,
    expectedTargetSha: null,
    parkedRef: null,
    refreshWarning: null,
    phase: null,
  };
}

function failed(error: string, conflictFiles: string[] = []): MergeOutput {
  return {
    status: conflictFiles.length > 0 ? "conflicts" : "failed",
    mergeHash: null,
    commitHash: null,
    error,
    conflictFiles,
    conflictAnalysis: null,
    preparedSha: null,
    expectedTargetSha: null,
    parkedRef: null,
    refreshWarning: null,
    phase: null,
  };
}

function setupExecutionWithJoin(
  join: GraphWorkflowExecutionJoinState,
  lanes: Record<string, GraphWorkflowExecutionLaneState>,
): GraphWorkflowExecution {
  const base = createWorkflowExecution();
  return {
    ...base,
    executionLanes: lanes,
    joins: { [join.joinId]: join },
  };
}

describe("join-runner", () => {
  it("merges each remaining source lane into target and marks join succeeded", async () => {
    const execution = setupExecutionWithJoin(
      makeJoin({
        joinId: "join-1",
        targetLaneId: "lane-a",
        sourceLaneIds: ["lane-a", "lane-b", "lane-c"],
      }),
      {
        "lane-a": makeLane({
          laneId: "lane-a",
          branchName: "csm/lane-a",
          worktreePath: "/tmp/lane-a",
        }),
        "lane-b": makeLane({
          laneId: "lane-b",
          branchName: "csm/lane-b",
          worktreePath: "/tmp/lane-b",
        }),
        "lane-c": makeLane({
          laneId: "lane-c",
          branchName: "csm/lane-c",
          worktreePath: "/tmp/lane-c",
        }),
      },
    );
    const observed: GraphMergeRunnerInput[] = [];
    const mergeRunner = fakeMergeRunner(
      new Map([
        ["csm/lane-b", completed("hash-b")],
        ["csm/lane-c", completed("hash-c")],
      ]),
      observed,
    );

    const persist = createInMemoryPersist(execution);
    const runner = createJoinRunner({
      mergeRunner,
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeMutex: createPerSessionMergeMutex(),
      createJobId: () => "job-x",
      now: () => t0,
    });

    const result = await runner.run({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session",
      joinId: "join-1",
      mutateActive: persist.mutateActive,
    });

    expect(result.status).toBe("succeeded");
    const finalJoin = persist.read().joins["join-1"]!;
    expect(finalJoin.status).toBe("succeeded");
    expect(finalJoin.mergedSourceLaneIds.sort()).toEqual(["lane-b", "lane-c"]);
    expect(observed.map((o) => o.branchName).sort()).toEqual([
      "csm/lane-b",
      "csm/lane-c",
    ]);
    for (const call of observed) {
      expect(call.targetBranch).toBe("csm/lane-a");
      expect(call.targetWorktreePath).toBe("/tmp/lane-a");
    }
  });

  it("skips source lanes already in mergedSourceLaneIds (resume)", async () => {
    const execution = setupExecutionWithJoin(
      makeJoin({
        joinId: "join-1",
        targetLaneId: "lane-a",
        sourceLaneIds: ["lane-a", "lane-b", "lane-c"],
        mergedSourceLaneIds: ["lane-b"],
        status: "running",
      }),
      {
        "lane-a": makeLane({
          laneId: "lane-a",
          branchName: "csm/lane-a",
          worktreePath: "/tmp/lane-a",
        }),
        "lane-b": makeLane({
          laneId: "lane-b",
          branchName: "csm/lane-b",
          worktreePath: "/tmp/lane-b",
        }),
        "lane-c": makeLane({
          laneId: "lane-c",
          branchName: "csm/lane-c",
          worktreePath: "/tmp/lane-c",
        }),
      },
    );
    const observed: GraphMergeRunnerInput[] = [];
    const mergeRunner = fakeMergeRunner(
      new Map([["csm/lane-c", completed("hash-c")]]),
      observed,
    );

    const persist = createInMemoryPersist(execution);
    const runner = createJoinRunner({
      mergeRunner,
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeMutex: createPerSessionMergeMutex(),
      createJobId: () => "job-x",
      now: () => t0,
    });

    const result = await runner.run({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session",
      joinId: "join-1",
      mutateActive: persist.mutateActive,
    });

    expect(result.status).toBe("succeeded");
    expect(observed).toHaveLength(1);
    expect(observed[0]!.branchName).toBe("csm/lane-c");
    const finalJoin = persist.read().joins["join-1"]!;
    expect(finalJoin.mergedSourceLaneIds.sort()).toEqual(["lane-b", "lane-c"]);
  });

  it("marks join failed and stops on first failed merge, recording conflict files", async () => {
    const execution = setupExecutionWithJoin(
      makeJoin({
        joinId: "join-1",
        targetLaneId: "lane-a",
        sourceLaneIds: ["lane-a", "lane-b", "lane-c"],
      }),
      {
        "lane-a": makeLane({
          laneId: "lane-a",
          branchName: "csm/lane-a",
          worktreePath: "/tmp/lane-a",
        }),
        "lane-b": makeLane({
          laneId: "lane-b",
          branchName: "csm/lane-b",
          worktreePath: "/tmp/lane-b",
        }),
        "lane-c": makeLane({
          laneId: "lane-c",
          branchName: "csm/lane-c",
          worktreePath: "/tmp/lane-c",
        }),
      },
    );
    const observed: GraphMergeRunnerInput[] = [];
    const mergeRunner = fakeMergeRunner(
      new Map([
        ["csm/lane-b", failed("merge conflict", ["src/foo.ts"])],
        ["csm/lane-c", completed("hash-c")],
      ]),
      observed,
    );

    const persist = createInMemoryPersist(execution);
    const runner = createJoinRunner({
      mergeRunner,
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeMutex: createPerSessionMergeMutex(),
      createJobId: () => "job-x",
      now: () => t0,
    });

    const result = await runner.run({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session",
      joinId: "join-1",
      mutateActive: persist.mutateActive,
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failedSourceLaneId).toBe("lane-b");
      expect(result.conflictFiles).toEqual(["src/foo.ts"]);
    }
    expect(observed).toHaveLength(1);
    expect(observed[0]!.branchName).toBe("csm/lane-b");
    const finalJoin = persist.read().joins["join-1"]!;
    expect(finalJoin.status).toBe("conflicts");
    expect(finalJoin.errorMessage).toBe("merge conflict");
    expect(finalJoin.conflicts?.files).toEqual(["src/foo.ts"]);
  });

  it("succeeds with no merges when only the target lane is in sourceLaneIds", async () => {
    const execution = setupExecutionWithJoin(
      makeJoin({
        joinId: "join-1",
        targetLaneId: "lane-a",
        sourceLaneIds: ["lane-a"],
      }),
      {
        "lane-a": makeLane({
          laneId: "lane-a",
          branchName: "csm/lane-a",
          worktreePath: "/tmp/lane-a",
        }),
      },
    );
    const observed: GraphMergeRunnerInput[] = [];
    const mergeRunner = fakeMergeRunner(new Map(), observed);

    const persist = createInMemoryPersist(execution);
    const runner = createJoinRunner({
      mergeRunner,
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeMutex: createPerSessionMergeMutex(),
      createJobId: () => "job-x",
      now: () => t0,
    });

    const result = await runner.run({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session",
      joinId: "join-1",
      mutateActive: persist.mutateActive,
    });

    expect(result.status).toBe("succeeded");
    expect(observed).toHaveLength(0);
    const finalJoin = persist.read().joins["join-1"]!;
    expect(finalJoin.status).toBe("succeeded");
  });

  it("holds the session git lock during each merge call", async () => {
    const execution = setupExecutionWithJoin(
      makeJoin({
        joinId: "join-1",
        targetLaneId: "lane-a",
        sourceLaneIds: ["lane-a", "lane-b"],
      }),
      {
        "lane-a": makeLane({
          laneId: "lane-a",
          branchName: "csm/lane-a",
          worktreePath: "/tmp/lane-a",
        }),
        "lane-b": makeLane({
          laneId: "lane-b",
          branchName: "csm/lane-b",
          worktreePath: "/tmp/lane-b",
        }),
      },
    );
    let lockHeld = false;
    let mergeObservedLockHeld = false;
    const acquireSessionLock = () => {
      lockHeld = true;
      return () => {
        lockHeld = false;
      };
    };
    const observed: GraphMergeRunnerInput[] = [];
    const mergeRunner: GraphMergeRunner = {
      async run(input) {
        observed.push(input);
        if (lockHeld) mergeObservedLockHeld = true;
        return completed("hash-b");
      },
    };

    const persist = createInMemoryPersist(execution);
    const runner = createJoinRunner({
      mergeRunner,
      sessionGitLock: createSessionGitLock({
        acquireSessionLock,
      }),
      mergeMutex: createPerSessionMergeMutex(),
      createJobId: () => "job-x",
      now: () => t0,
    });

    const result = await runner.run({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session",
      joinId: "join-1",
      mutateActive: persist.mutateActive,
    });

    expect(result.status).toBe("succeeded");
    expect(mergeObservedLockHeld).toBe(true);
    expect(lockHeld).toBe(false);
  });

  it("returns failed (and persists failure) when target lane is missing worktree path", async () => {
    const execution = setupExecutionWithJoin(
      makeJoin({
        joinId: "join-1",
        targetLaneId: "lane-a",
        sourceLaneIds: ["lane-a", "lane-b"],
      }),
      {
        "lane-a": makeLane({
          laneId: "lane-a",
          branchName: "csm/lane-a",
          worktreePath: null,
        }),
        "lane-b": makeLane({
          laneId: "lane-b",
          branchName: "csm/lane-b",
          worktreePath: "/tmp/lane-b",
        }),
      },
    );
    const observed: GraphMergeRunnerInput[] = [];
    const mergeRunner = fakeMergeRunner(new Map(), observed);

    const persist = createInMemoryPersist(execution);
    const runner = createJoinRunner({
      mergeRunner,
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeMutex: createPerSessionMergeMutex(),
      createJobId: () => "job-x",
      now: () => t0,
    });

    const result = await runner.run({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session",
      joinId: "join-1",
      mutateActive: persist.mutateActive,
    });

    expect(result.status).toBe("failed");
    expect(observed).toHaveLength(0);
    const finalJoin = persist.read().joins["join-1"]!;
    expect(finalJoin.status).toBe("failed");
    expect(finalJoin.errorMessage).toMatch(/lane-a/);
  });
});
