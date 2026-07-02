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
    conflictGuidance: null,
    createdAt: t0,
    updatedAt: t0,
    completedAt: null,
    ...overrides,
  };
}

function sequencedMergeRunner(
  outputsBySource: Map<string, MergeOutput[]>,
  observed: GraphMergeRunnerInput[],
): GraphMergeRunner {
  return {
    async run(input) {
      observed.push(input);
      const queue = outputsBySource.get(input.branchName);
      const output = queue?.shift();
      if (!output) {
        throw new Error(
          `sequencedMergeRunner: unexpected merge call for branch ${input.branchName}`,
        );
      }
      return output;
    },
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
  it("passes an assembled resolutionContext describing both lanes to the merge runner", async () => {
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
          includedContextIds: ["context-implement"],
        }),
        "lane-b": makeLane({
          laneId: "lane-b",
          branchName: "csm/lane-b",
          worktreePath: "/tmp/lane-b",
          includedContextIds: ["context-verify"],
        }),
      },
    );
    execution.taskStates = {
      "task-implement-1": {
        taskId: "task-implement-1",
        contextId: "context-implement",
        order: 1,
        status: "completed",
        summary: "Implemented the feature behind the settings flag.",
        startedAt: t0,
        completedAt: t0,
        lastConversationId: null,
        failureMessage: null,
        failureHistory: [],
      },
      "task-verify-1": {
        taskId: "task-verify-1",
        contextId: "context-verify",
        order: 1,
        status: "completed",
        summary: "Added integration checks for the new flow.",
        startedAt: t0,
        completedAt: t0,
        lastConversationId: null,
        failureMessage: null,
        failureHistory: [],
      },
    };

    const observed: GraphMergeRunnerInput[] = [];
    const mergeRunner = fakeMergeRunner(
      new Map([["csm/lane-b", completed("hash-b")]]),
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
    const brief = observed[0]?.resolutionContext;
    expect(brief).toBeDefined();
    // Ours = source lane (the worktree the merge runs in)
    expect(brief).toContain("Added integration checks for the new flow.");
    // Theirs = target lane
    expect(brief).toContain(
      "Implemented the feature behind the settings flag.",
    );
  });

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

  it("retries a conflicted merge once from a clean tree and succeeds", async () => {
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
    const observed: GraphMergeRunnerInput[] = [];
    const mergeRunner = sequencedMergeRunner(
      new Map([
        [
          "csm/lane-b",
          [failed("resolution failed", ["src/foo.ts"]), completed("hash-b")],
        ],
      ]),
      observed,
    );
    const aborts: string[] = [];

    const persist = createInMemoryPersist(execution);
    const runner = createJoinRunner({
      mergeRunner,
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeMutex: createPerSessionMergeMutex(),
      abortInProgressMerge: async (worktreePath) => {
        aborts.push(worktreePath);
        return aborts.length > 1;
      },
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
    // Preflight abort before the first attempt, then one abort between attempts.
    expect(aborts).toEqual(["/tmp/lane-b", "/tmp/lane-b"]);
    expect(observed).toHaveLength(2);
    const finalJoin = persist.read().joins["join-1"]!;
    expect(finalJoin.status).toBe("succeeded");
    expect(finalJoin.mergedSourceLaneIds).toEqual(["lane-b"]);
    expect(finalJoin.conflicts).toBeNull();
  });

  it("does not retry a non-conflict merge failure", async () => {
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
    const observed: GraphMergeRunnerInput[] = [];
    const mergeRunner = sequencedMergeRunner(
      new Map([["csm/lane-b", [failed("validation exhausted")]]]),
      observed,
    );

    const persist = createInMemoryPersist(execution);
    const runner = createJoinRunner({
      mergeRunner,
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeMutex: createPerSessionMergeMutex(),
      abortInProgressMerge: async () => false,
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
    expect(observed).toHaveLength(1);
    expect(persist.read().joins["join-1"]?.status).toBe("failed");
  });

  it("persists conflict analysis when the retry also fails, and clears guidance", async () => {
    const analysis = [
      {
        file: "src/foo.ts",
        description: "both sides changed the loader",
        resolution: "combine both hunks",
        rationale: "changes are independent",
      },
    ];
    const conflictsOutput: MergeOutput = {
      ...failed("resolution failed", ["src/foo.ts"]),
      conflictAnalysis: analysis,
    };
    const execution = setupExecutionWithJoin(
      makeJoin({
        joinId: "join-1",
        targetLaneId: "lane-a",
        sourceLaneIds: ["lane-a", "lane-b"],
        conflictGuidance: [
          { file: "src/foo.ts", decision: "rejected", feedback: "keep both" },
        ],
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
    const observed: GraphMergeRunnerInput[] = [];
    const mergeRunner = sequencedMergeRunner(
      new Map([["csm/lane-b", [conflictsOutput, conflictsOutput]]]),
      observed,
    );

    const persist = createInMemoryPersist(execution);
    const runner = createJoinRunner({
      mergeRunner,
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeMutex: createPerSessionMergeMutex(),
      abortInProgressMerge: async () => true,
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
    expect(observed).toHaveLength(2);
    // Operator guidance is threaded into every resolution attempt.
    for (const call of observed) {
      expect(call.decisions).toEqual([
        { file: "src/foo.ts", decision: "rejected", feedback: "keep both" },
      ]);
    }
    const finalJoin = persist.read().joins["join-1"]!;
    expect(finalJoin.status).toBe("conflicts");
    expect(finalJoin.conflicts?.analysis).toEqual(analysis);
    // Consumed guidance does not leak into the next retry.
    expect(finalJoin.conflictGuidance).toBeNull();
  });

  it("clears consumed guidance when the join succeeds", async () => {
    const execution = setupExecutionWithJoin(
      makeJoin({
        joinId: "join-1",
        targetLaneId: "lane-a",
        sourceLaneIds: ["lane-a", "lane-b"],
        conflictGuidance: [{ file: "src/foo.ts", decision: "approved" }],
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
    const observed: GraphMergeRunnerInput[] = [];
    const mergeRunner = sequencedMergeRunner(
      new Map([["csm/lane-b", [completed("hash-b")]]]),
      observed,
    );

    const persist = createInMemoryPersist(execution);
    const runner = createJoinRunner({
      mergeRunner,
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeMutex: createPerSessionMergeMutex(),
      abortInProgressMerge: async () => false,
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
    expect(observed[0]!.decisions).toEqual([
      { file: "src/foo.ts", decision: "approved" },
    ]);
    expect(persist.read().joins["join-1"]?.conflictGuidance).toBeNull();
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
    // A conflicted merge is retried once from a clean tree before failing;
    // lane-c is never attempted.
    expect(observed).toHaveLength(2);
    expect(observed.map((o) => o.branchName)).toEqual([
      "csm/lane-b",
      "csm/lane-b",
    ]);
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
