import { describe, expect, it } from "vitest";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionJoinState,
  GraphWorkflowExecutionLaneState,
} from "@/lib/workflow-graph/schemas";
import { createSessionGitLock } from "@/lib/shared/lock-retry";
import { createPerSessionMergeMutex } from "./per-session-merge-mutex";
import { createJoinRunner, type JoinRunnerMutateActive } from "./join-runner";
import { createWorkflowExecution } from "./test-fixtures";
import { resetJoinForRetry } from "./context-transitions";
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
    validationDebtSourceLaneIds: [],
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
    candidateValidation: null,
    haltReason: null,
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
    candidateValidation: null,
    haltReason: null,
    phase: null,
  };
}

function deliveryGateFailed(): MergeOutput {
  return {
    ...failed("Delivery gate refused merge"),
    haltReason: {
      type: "delivery_gate_failed",
      unmet: [
        {
          criterionId: "criterion-1",
          criterionHandle: "native-sdd/R18.4",
          outcome: "unmet",
          reason: "candidate proof is stale",
        },
      ],
      instruction: "Re-dispatch the merge to validate the candidate again.",
    },
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
  it("defers final-only validation until the last source and resolves project commands at submission", async () => {
    const execution = setupExecutionWithJoin(
      makeJoin({
        joinId: "join-validation",
        targetLaneId: "lane-a",
        sourceLaneIds: ["lane-a", "lane-b", "lane-c", "lane-d"],
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
        "lane-d": makeLane({
          laneId: "lane-d",
          branchName: "csm/lane-d",
          worktreePath: "/tmp/lane-d",
        }),
      },
    );
    execution.workingDefinition = {
      ...execution.workingDefinition,
      laneMergeValidation: {
        strategy: "final-only",
        commands: { mode: "project" },
      },
    };
    const observed: GraphMergeRunnerInput[] = [];
    const deferred: Array<{
      joinId?: unknown;
      sourceLaneId?: unknown;
      remaining?: unknown;
    }> = [];
    let sessionLockHeld = false;
    const persist = createInMemoryPersist(execution);
    const runner = createJoinRunner({
      mergeRunner: fakeMergeRunner(
        new Map([
          ["csm/lane-b", completed("hash-b")],
          ["csm/lane-c", completed("hash-c")],
          ["csm/lane-d", completed("hash-d")],
        ]),
        observed,
      ),
      sessionGitLock: {
        async withSessionGitLock(_key, run) {
          sessionLockHeld = true;
          try {
            return await run();
          } finally {
            sessionLockHeld = false;
          }
        },
      },
      mergeMutex: createPerSessionMergeMutex(),
      readRepoConfig: async () => {
        expect(sessionLockHeld).toBe(true);
        return {
          validation: {
            commands: {
              typecheck: {
                command: "scripts/typecheck.sh",
                cost: 1,
                scopeArgs: "forbid",
              },
            },
            preMerge: ["typecheck"],
          },
        };
      },
      logger: {
        debug() {},
        info(message, fields) {
          if (message === "graph-workflow.join.validation_deferred") {
            deferred.push(fields ?? {});
          }
        },
        warn() {},
        error() {},
      },
      createJobId: () => "job-validation",
      now: () => t0,
    });

    const result = await runner.run({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session",
      joinId: "join-validation",
      mutateActive: persist.mutateActive,
    });

    expect(result).toEqual({ status: "succeeded" });
    expect(observed.map((call) => call.validationMode)).toEqual([
      { mode: "skip" },
      { mode: "skip" },
      {
        mode: "run",
        source: "graph_lane_merge",
        selection: { mode: "only", commands: ["typecheck"] },
        coveredLaneIds: ["lane-b", "lane-c", "lane-d"],
      },
    ]);
    expect(observed.map((call) => call.workflowExecutionId)).toEqual([
      execution.id,
      execution.id,
      execution.id,
    ]);
    expect(deferred).toEqual([
      {
        joinId: "join-validation",
        sourceLaneId: "lane-b",
        remaining: 3,
      },
      {
        joinId: "join-validation",
        sourceLaneId: "lane-c",
        remaining: 2,
      },
    ]);
  });

  it("preserves deferred validation debt across a halt and settles it on the resumed final merge", async () => {
    const execution = setupExecutionWithJoin(
      makeJoin({
        joinId: "join-resume-validation",
        targetLaneId: "lane-a",
        sourceLaneIds: ["lane-a", "lane-b", "lane-c", "lane-d"],
        validationDebtSourceLaneIds: [],
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
          includedContextIds: ["context-plan"],
        }),
        "lane-c": makeLane({
          laneId: "lane-c",
          branchName: "csm/lane-c",
          worktreePath: "/tmp/lane-c",
          includedContextIds: ["context-implement"],
        }),
        "lane-d": makeLane({
          laneId: "lane-d",
          branchName: "csm/lane-d",
          worktreePath: "/tmp/lane-d",
          includedContextIds: ["context-verify"],
        }),
      },
    );
    execution.workingDefinition.laneMergeValidation = {
      strategy: "final-only",
      commands: { mode: "only", commands: ["typecheck"] },
    };
    execution.taskStates = {
      "task-plan-1": {
        taskId: "task-plan-1",
        contextId: "context-plan",
        order: 1,
        status: "completed",
        summary: "Planned the shared validation contract.",
        startedAt: t0,
        completedAt: t0,
        lastConversationId: null,
        failureMessage: null,
        failureHistory: [],
      },
      "task-implement-1": {
        taskId: "task-implement-1",
        contextId: "context-implement",
        order: 1,
        status: "completed",
        summary: "Implemented the scheduler integration.",
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
        summary: "Verified the final integration behavior.",
        startedAt: t0,
        completedAt: t0,
        lastConversationId: null,
        failureMessage: null,
        failureHistory: [],
      },
    };
    const observed: GraphMergeRunnerInput[] = [];
    const persist = createInMemoryPersist(execution);
    const runner = createJoinRunner({
      mergeRunner: sequencedMergeRunner(
        new Map([
          ["csm/lane-b", [completed("hash-b")]],
          [
            "csm/lane-c",
            [failed("validation service interrupted"), completed("hash-c")],
          ],
          ["csm/lane-d", [completed("hash-d")]],
        ]),
        observed,
      ),
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeMutex: createPerSessionMergeMutex(),
      createJobId: () => "job-resume-validation",
      now: () => t0,
    });

    const first = await runner.run({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session",
      joinId: "join-resume-validation",
      mutateActive: persist.mutateActive,
    });

    expect(first.status).toBe("failed");
    expect(
      persist.read().joins["join-resume-validation"]
        ?.validationDebtSourceLaneIds,
    ).toEqual(["lane-b"]);

    await persist.mutateActive((current) =>
      resetJoinForRetry(current, "join-resume-validation", t0),
    );
    const resumed = await runner.run({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session",
      joinId: "join-resume-validation",
      mutateActive: persist.mutateActive,
    });

    expect(resumed).toEqual({ status: "succeeded" });
    const finalCall = observed.at(-1);
    expect(finalCall?.validationMode).toEqual({
      mode: "run",
      source: "graph_lane_merge",
      selection: { mode: "only", commands: ["typecheck"] },
      coveredLaneIds: ["lane-b", "lane-c", "lane-d"],
    });
    expect(finalCall?.resolutionContext).toContain(
      "Planned the shared validation contract.",
    );
    expect(finalCall?.resolutionContext).toContain(
      "Implemented the scheduler integration.",
    );
    expect(finalCall?.resolutionContext).toContain(
      "Verified the final integration behavior.",
    );
    expect(
      persist.read().joins["join-resume-validation"]
        ?.validationDebtSourceLaneIds,
    ).toEqual([]);
  });

  it("validates a single-source join under final-only", async () => {
    const execution = setupExecutionWithJoin(
      makeJoin({
        joinId: "join-single",
        targetLaneId: "lane-a",
        sourceLaneIds: ["lane-b"],
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
    execution.workingDefinition = {
      ...execution.workingDefinition,
      laneMergeValidation: {
        strategy: "final-only",
        commands: { mode: "project" },
      },
    };
    const observed: GraphMergeRunnerInput[] = [];
    const persist = createInMemoryPersist(execution);
    const runner = createJoinRunner({
      mergeRunner: fakeMergeRunner(
        new Map([["csm/lane-b", completed("hash-b")]]),
        observed,
      ),
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeMutex: createPerSessionMergeMutex(),
      readRepoConfig: async () => ({
        validation: {
          commands: {
            typecheck: {
              command: "scripts/typecheck.sh",
              cost: 1,
              scopeArgs: "forbid",
            },
            test: {
              command: "scripts/test.sh",
              cost: 2,
              scopeArgs: "forbid",
            },
          },
          preMerge: ["typecheck"],
          laneMerge: ["test"],
        },
      }),
    });

    const result = await runner.run({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session",
      joinId: "join-single",
      mutateActive: persist.mutateActive,
    });

    expect(result).toEqual({ status: "succeeded" });
    expect(observed.map((call) => call.validationMode)).toEqual([
      {
        mode: "run",
        source: "graph_lane_merge",
        selection: { mode: "only", commands: ["test"] },
        coveredLaneIds: ["lane-b"],
      },
    ]);
  });

  it("validates every final-publish merge even under final-only", async () => {
    const execution = setupExecutionWithJoin(
      makeJoin({
        joinId: "join-final-validation",
        kind: "final_publish",
        targetLaneId: "lane-session",
        sourceLaneIds: ["lane-b", "lane-c"],
      }),
      {
        "lane-session": makeLane({
          laneId: "lane-session",
          branchName: "csm/session",
          worktreePath: "/tmp/session",
          kind: "session",
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
    execution.workingDefinition = {
      ...execution.workingDefinition,
      laneMergeValidation: {
        strategy: "final-only",
        commands: { mode: "only", commands: ["typecheck"] },
      },
    };
    const observed: GraphMergeRunnerInput[] = [];
    const persist = createInMemoryPersist(execution);
    const runner = createJoinRunner({
      mergeRunner: fakeMergeRunner(
        new Map([
          ["csm/lane-b", completed("hash-b")],
          ["csm/lane-c", completed("hash-c")],
        ]),
        observed,
      ),
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeMutex: createPerSessionMergeMutex(),
    });

    const result = await runner.run({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session",
      joinId: "join-final-validation",
      mutateActive: persist.mutateActive,
    });

    expect(result).toEqual({ status: "succeeded" });
    expect(observed.map((call) => call.validationMode.mode)).toEqual([
      "run",
      "run",
    ]);
    expect(observed.map((call) => call.finalPublish)).toEqual([false, false]);
  });

  it("validates every source when the strategy is every-merge", async () => {
    const execution = setupExecutionWithJoin(
      makeJoin({
        joinId: "join-every-merge",
        targetLaneId: "lane-a",
        sourceLaneIds: ["lane-a", "lane-b", "lane-c", "lane-d"],
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
        "lane-d": makeLane({
          laneId: "lane-d",
          branchName: "csm/lane-d",
          worktreePath: "/tmp/lane-d",
        }),
      },
    );
    execution.workingDefinition = {
      ...execution.workingDefinition,
      laneMergeValidation: {
        strategy: "every-merge",
        commands: { mode: "only", commands: ["typecheck"] },
      },
    };
    const observed: GraphMergeRunnerInput[] = [];
    const persist = createInMemoryPersist(execution);
    const runner = createJoinRunner({
      mergeRunner: fakeMergeRunner(
        new Map([
          ["csm/lane-b", completed("hash-b")],
          ["csm/lane-c", completed("hash-c")],
          ["csm/lane-d", completed("hash-d")],
        ]),
        observed,
      ),
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeMutex: createPerSessionMergeMutex(),
    });

    const result = await runner.run({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session",
      joinId: "join-every-merge",
      mutateActive: persist.mutateActive,
    });

    expect(result).toEqual({ status: "succeeded" });
    expect(observed.map((call) => call.validationMode.mode)).toEqual([
      "run",
      "run",
      "run",
    ]);
    expect(
      observed.map((call) =>
        call.validationMode.mode === "run"
          ? call.validationMode.coveredLaneIds
          : null,
      ),
    ).toEqual([["lane-b"], ["lane-c"], ["lane-d"]]);
  });

  it("gates every final-publish source without marking delivery at the session boundary", async () => {
    const execution = setupExecutionWithJoin(
      makeJoin({
        joinId: "join-final",
        kind: "final_publish",
        targetLaneId: "lane-session",
        sourceLaneIds: ["lane-session", "lane-feature-a", "lane-feature-b"],
      }),
      {
        "lane-session": makeLane({
          laneId: "lane-session",
          branchName: "csm/session",
          worktreePath: "/tmp/session",
        }),
        "lane-feature-a": makeLane({
          laneId: "lane-feature-a",
          branchName: "csm/feature-a",
          worktreePath: "/tmp/feature-a",
        }),
        "lane-feature-b": makeLane({
          laneId: "lane-feature-b",
          branchName: "csm/feature-b",
          worktreePath: "/tmp/feature-b",
        }),
      },
    );
    const observed: GraphMergeRunnerInput[] = [];
    const persist = createInMemoryPersist(execution);
    const runner = createJoinRunner({
      mergeRunner: fakeMergeRunner(
        new Map([
          ["csm/feature-a", completed("intermediate-sha")],
          ["csm/feature-b", completed("published-sha")],
        ]),
        observed,
      ),
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeMutex: createPerSessionMergeMutex(),
      createJobId: () => "job-final",
      now: () => t0,
    });

    const result = await runner.run({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session",
      joinId: "join-final",
      mutateActive: persist.mutateActive,
    });

    expect(result).toEqual({ status: "succeeded" });
    expect(observed).toHaveLength(2);
    expect(
      observed.map(({ executionId, finalPublish }) => ({
        executionId,
        finalPublish,
      })),
    ).toEqual([
      { executionId: execution.id, finalPublish: false },
      { executionId: execution.id, finalPublish: false },
    ]);
  });

  it("returns the machine-readable halt reason from a refused delivery gate", async () => {
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
    const persist = createInMemoryPersist(execution);
    const runner = createJoinRunner({
      mergeRunner: fakeMergeRunner(
        new Map([["csm/lane-b", deliveryGateFailed()]]),
        [],
      ),
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeMutex: createPerSessionMergeMutex(),
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
      expect(result.haltReason).toEqual(deliveryGateFailed().haltReason);
    }
  });

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

  it("binds each source-lane merge to that lane's implementer conversation", async () => {
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
          includedContextIds: ["context-target"],
        }),
        "lane-b": makeLane({
          laneId: "lane-b",
          branchName: "csm/lane-b",
          worktreePath: "/tmp/lane-b",
          includedContextIds: ["context-source"],
          lastCommittingContextId: "context-source",
        }),
      },
    );
    execution.laneStates = {
      "context-source": {
        implementer: {
          lane: "implementer",
          contextId: "context-source",
          backend: "claude",
          refKind: "conversation",
          workflowConversationId: "conv-source-implementer",
          sessionRef: {
            backend: "claude",
            ref: "conv-source-implementer",
          },
          metrics: { rotateBeforeNextTurn: false },
          limitEvaluation: "supported",
          lastUsedAt: t0,
        },
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
    expect(observed[0]?.conversationId).toBe("conv-source-implementer");
  });

  it("omits conversationId when the source lane recorded no conversation", async () => {
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
    expect(observed[0]?.conversationId).toBeUndefined();
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
