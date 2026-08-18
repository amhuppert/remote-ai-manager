import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultGitClient } from "@/lib/git/client";
import { commitOwnedPaths } from "@/lib/git/owned-landing";
import { resyncSharedIndexToHead } from "@/lib/git/shared-index";
import { abortInProgressMerge } from "@/lib/git/worktree";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionJoinState,
  GraphWorkflowExecutionLaneState,
} from "@/lib/workflow-graph/schemas";
import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";
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
import type { AgentFailureClassification } from "@/lib/agent-backends/errors";

const t0 = "2026-03-27T12:00:00.000Z";

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await defaultGitClient.git(args, repo);
  return stdout.trim();
}

/**
 * A landed lane worktree whose shared index describes the pre-landing tree.
 *
 * A landing points its own entries back at what it published, so the drift is
 * induced here rather than left behind: what the join has to survive is an
 * index that disagrees with HEAD at all — an interrupted write-back, another
 * tool, an operator — not one particular way of getting there.
 */
async function createPrivateIndexResidueRepo(
  prefix: string,
  branchName: string,
  cleanupPaths: string[],
): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), prefix));
  cleanupPaths.push(repo);
  await git(repo, ["init", `--initial-branch=${branchName}`, "."]);
  await git(repo, ["config", "user.email", "engine@command-center.test"]);
  await git(repo, ["config", "user.name", "Command Center"]);
  await writeFile(path.join(repo, "README.md"), "base\n", "utf-8");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "base"]);
  const preLandingHead = await git(repo, ["rev-parse", "HEAD"]);

  await mkdir(path.join(repo, "owned"), { recursive: true });
  await writeFile(
    path.join(repo, "owned", "result.txt"),
    `${branchName}\n`,
    "utf-8",
  );
  const landed = await commitOwnedPaths({
    worktreePath: repo,
    message: `Land ${branchName}`,
    ownedPaths: ["owned"],
  });
  if (landed.status !== "committed") {
    throw new Error(`Expected private-index landing in ${repo}`);
  }
  await git(repo, ["reset", "--quiet", preLandingHead, "--", "owned"]);
  return repo;
}

/**
 * A repo whose checked-out branch is mid-merge against a sibling branch.
 * `resolve` stages a marker-free resolution without committing it — the
 * "operator resolved by hand, has not committed yet" shape.
 */
async function createMidMergeRepo(
  prefix: string,
  cleanupPaths: string[],
  options: { resolve: boolean },
): Promise<{ repoPath: string; conflictedFile: string }> {
  const repo = await mkdtemp(path.join(tmpdir(), prefix));
  cleanupPaths.push(repo);
  await git(repo, ["init", "--initial-branch=lane-source", "."]);
  await git(repo, ["config", "user.email", "engine@command-center.test"]);
  await git(repo, ["config", "user.name", "Command Center"]);
  await writeFile(path.join(repo, "shared.txt"), "base\n", "utf-8");
  await git(repo, ["add", "shared.txt"]);
  await git(repo, ["commit", "-m", "base"]);

  await git(repo, ["checkout", "-b", "sibling"]);
  await writeFile(path.join(repo, "shared.txt"), "sibling side\n", "utf-8");
  await git(repo, ["commit", "-am", "sibling change"]);

  await git(repo, ["checkout", "lane-source"]);
  await writeFile(path.join(repo, "shared.txt"), "lane side\n", "utf-8");
  await git(repo, ["commit", "-am", "lane change"]);

  await expect(git(repo, ["merge", "sibling"])).rejects.toThrow();

  if (options.resolve) {
    await writeFile(path.join(repo, "shared.txt"), "both sides\n", "utf-8");
    await git(repo, ["add", "shared.txt"]);
  }
  return { repoPath: repo, conflictedFile: path.join(repo, "shared.txt") };
}

async function mergeHeadPresent(repoPath: string): Promise<boolean> {
  try {
    await git(repoPath, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    return true;
  } catch {
    return false;
  }
}

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

function resolutionInfrastructureFailed(
  failure: AgentFailureClassification,
  conflictFiles: string[] = ["src/foo.ts"],
): MergeOutput {
  return {
    ...failed(
      `Conflict resolution could not run (${failure.kind}): ${failure.message}`,
    ),
    conflictFiles,
    haltReason: {
      type: "resolution_infrastructure",
      failure,
      conflictFiles,
    },
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
  it("resyncs both worktree indexes before merging a sibling lane", async () => {
    const execution = setupExecutionWithJoin(
      makeJoin({
        joinId: "join-private-index",
        targetLaneId: "lane-target",
        sourceLaneIds: ["lane-target", "lane-source"],
      }),
      {
        "lane-target": makeLane({
          laneId: "lane-target",
          branchName: "csm/lane-target",
          worktreePath: "/tmp/lane-target",
        }),
        "lane-source": makeLane({
          laneId: "lane-source",
          branchName: "csm/lane-source",
          worktreePath: "/tmp/lane-source",
        }),
      },
    );
    const calls: string[] = [];
    const persist = createInMemoryPersist(execution);
    const runner = createJoinRunner({
      mergeRunner: {
        async run() {
          calls.push("merge");
          return completed();
        },
      },
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeMutex: createPerSessionMergeMutex(),
      async resyncSharedIndex(worktreePath) {
        calls.push(`resync:${worktreePath}`);
      },
      now: () => t0,
    });

    const result = await runner.run({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session",
      joinId: "join-private-index",
      mutateActive: persist.mutateActive,
    });

    expect(result).toEqual({ status: "succeeded" });
    expect(calls).toEqual([
      "resync:/tmp/lane-source",
      "resync:/tmp/lane-target",
      "merge",
    ]);
  });

  it("repairs real private-index residue on both worktree sides before merge dispatch", async () => {
    const cleanupPaths: string[] = [];
    try {
      const targetWorktreePath = await createPrivateIndexResidueRepo(
        "cc-join-target-index-",
        "lane-target",
        cleanupPaths,
      );
      const sourceWorktreePath = await createPrivateIndexResidueRepo(
        "cc-join-source-index-",
        "lane-source",
        cleanupPaths,
      );

      expect(
        await git(targetWorktreePath, [
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ]),
      ).not.toBe("");
      expect(
        await git(sourceWorktreePath, [
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ]),
      ).not.toBe("");

      const execution = setupExecutionWithJoin(
        makeJoin({
          joinId: "join-real-private-index",
          targetLaneId: "lane-target",
          sourceLaneIds: ["lane-target", "lane-source"],
        }),
        {
          "lane-target": makeLane({
            laneId: "lane-target",
            branchName: "lane-target",
            worktreePath: targetWorktreePath,
          }),
          "lane-source": makeLane({
            laneId: "lane-source",
            branchName: "lane-source",
            worktreePath: sourceWorktreePath,
          }),
        },
      );
      const persist = createInMemoryPersist(execution);
      let mergeDispatched = false;
      const runner = createJoinRunner({
        mergeRunner: {
          async run(input) {
            expect(input.featureWorktreePath).toBe(sourceWorktreePath);
            expect(input.targetWorktreePath).toBe(targetWorktreePath);
            expect(
              await git(sourceWorktreePath, [
                "status",
                "--porcelain=v1",
                "--untracked-files=all",
              ]),
            ).toBe("");
            expect(
              await git(targetWorktreePath, [
                "status",
                "--porcelain=v1",
                "--untracked-files=all",
              ]),
            ).toBe("");
            mergeDispatched = true;
            return completed();
          },
        },
        sessionGitLock: createSessionGitLock({
          acquireSessionLock: () => () => {},
        }),
        mergeMutex: createPerSessionMergeMutex(),
        abortInProgressMerge: async () => false,
        resyncSharedIndex: resyncSharedIndexToHead,
        readRepoConfig: async () => null,
        now: () => t0,
      });

      const result = await runner.run({
        projectPath: targetWorktreePath,
        projectName: "repo",
        sessionName: "session",
        joinId: "join-real-private-index",
        mutateActive: persist.mutateActive,
      });

      expect(result).toEqual({ status: "succeeded" });
      expect(mergeDispatched).toBe(true);
    } finally {
      await Promise.all(
        cleanupPaths.map((cleanupPath) =>
          rm(cleanupPath, { recursive: true, force: true }),
        ),
      );
    }
  });

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
                command: { full: "scripts/typecheck.sh" },
                cost: 1,
                pathArgs: "forbid",
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
      coveredContextIds: [
        "context-plan",
        "context-implement",
        "context-verify",
      ],
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
              command: { full: "scripts/typecheck.sh" },
              cost: 1,
              pathArgs: "forbid",
            },
            test: {
              command: { full: "scripts/test.sh" },
              cost: 2,
              pathArgs: "forbid",
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

  it("runs one barrier for a replayed three-member lane and records member evidence", async () => {
    const memberContextIds = [
      "context-plan",
      "context-implement",
      "context-verify",
    ];
    const execution = setupExecutionWithJoin(
      makeJoin({
        joinId: "join-three-member-lane",
        targetLaneId: "lane-session",
        sourceLaneIds: ["lane-shared"],
        sourceLaneContextIds: { "lane-shared": memberContextIds },
      }),
      {
        "lane-session": makeLane({
          laneId: "lane-session",
          branchName: "csm/session",
          worktreePath: "/tmp/session",
          kind: "session",
        }),
        "lane-shared": makeLane({
          laneId: "lane-shared",
          branchName: "csm/lane-shared",
          worktreePath: "/tmp/lane-shared",
          includedContextIds: [...memberContextIds],
        }),
      },
    );
    execution.workingDefinition.laneMergeValidation = {
      strategy: "final-only",
      commands: { mode: "only", commands: ["typecheck"] },
    };

    const replayed = graphWorkflowExecutionSchema.parse(
      JSON.parse(JSON.stringify(execution)),
    );
    replayed.executionLanes["lane-shared"]!.includedContextIds.push(
      "context-late",
    );
    const observed: GraphMergeRunnerInput[] = [];
    const persist = createInMemoryPersist(replayed);
    const runner = createJoinRunner({
      mergeRunner: fakeMergeRunner(
        new Map([["csm/lane-shared", completed("hash-shared")]]),
        observed,
      ),
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeMutex: createPerSessionMergeMutex(),
      now: () => t0,
    });

    const result = await runner.run({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session",
      joinId: "join-three-member-lane",
      mutateActive: persist.mutateActive,
    });

    expect(result).toEqual({ status: "succeeded" });
    expect(observed).toHaveLength(1);
    expect(observed[0]?.validationMode).toEqual({
      mode: "run",
      source: "graph_lane_merge",
      selection: { mode: "only", commands: ["typecheck"] },
      coveredLaneIds: ["lane-shared"],
      coveredContextIds: memberContextIds,
    });
    const replayedEvidence = graphWorkflowExecutionSchema.parse(
      JSON.parse(JSON.stringify(persist.read())),
    ).joins["join-three-member-lane"]?.validationEvidence;
    expect(replayedEvidence).toEqual([
      {
        sourceLaneIds: ["lane-shared"],
        contextIds: memberContextIds,
        commandIdentity: "typecheck",
        recordedAt: t0,
      },
    ]);
  });

  /**
   * Evidence that clears validation debt has to name what ran; a barrier
   * record that only says "validated" cannot be audited against a repo whose
   * lane-merge command list changed between joins.
   */
  it("records the commands that ran in the join's validation evidence", async () => {
    const execution = setupExecutionWithJoin(
      makeJoin({
        joinId: "join-identity",
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
        strategy: "every-merge",
        commands: { mode: "only", commands: ["typecheck", "test"] },
      },
    };
    const persist = createInMemoryPersist(execution);
    const runner = createJoinRunner({
      mergeRunner: fakeMergeRunner(
        new Map([["csm/lane-b", completed("hash-b")]]),
        [],
      ),
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeMutex: createPerSessionMergeMutex(),
      now: () => t0,
    });

    const result = await runner.run({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session",
      joinId: "join-identity",
      mutateActive: persist.mutateActive,
    });

    expect(result).toEqual({ status: "succeeded" });
    const replayed = graphWorkflowExecutionSchema.parse(
      JSON.parse(JSON.stringify(persist.read())),
    ).joins["join-identity"];
    expect(replayed?.validationEvidence).toEqual([
      {
        sourceLaneIds: ["lane-b"],
        contextIds: [],
        commandIdentity: "typecheck+test",
        recordedAt: t0,
      },
    ]);
  });

  it("records an empty command identity when the configured selection runs nothing", async () => {
    const execution = setupExecutionWithJoin(
      makeJoin({
        joinId: "join-no-commands",
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
        strategy: "every-merge",
        commands: { mode: "only", commands: [] },
      },
    };
    const persist = createInMemoryPersist(execution);
    const runner = createJoinRunner({
      mergeRunner: fakeMergeRunner(
        new Map([["csm/lane-b", completed("hash-b")]]),
        [],
      ),
      sessionGitLock: createSessionGitLock({
        acquireSessionLock: () => () => {},
      }),
      mergeMutex: createPerSessionMergeMutex(),
      now: () => t0,
    });

    const result = await runner.run({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session",
      joinId: "join-no-commands",
      mutateActive: persist.mutateActive,
    });

    expect(result).toEqual({ status: "succeeded" });
    const join = persist.read().joins["join-no-commands"];
    // Debt still clears — there is nothing to run, and debt nothing can clear
    // would strand the join — but the ledger says so instead of implying a run.
    expect(join?.validationDebtSourceLaneIds).toEqual([]);
    expect(join?.validationEvidence).toEqual([
      {
        sourceLaneIds: ["lane-b"],
        contextIds: [],
        commandIdentity: "",
        recordedAt: t0,
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
    expect(observed.map((call) => call.finalPublish)).toEqual([
      undefined,
      undefined,
    ]);
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

  it("keeps final-publish integration separate from project delivery gating", async () => {
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
      { executionId: undefined, finalPublish: undefined },
      { executionId: undefined, finalPublish: undefined },
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
    // The conversation is an identity/conflict-guidance source only; the
    // validation-fix turn must run fresh — an enveloped implementer's
    // conversation is filed under its scratch cwd and cannot be resumed from
    // the merge worktree (command-center#78).
    expect(observed[0]?.agentTurnDispatch).toBe("fresh-run");
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
    expect(observed[0]?.agentTurnDispatch).toBe("fresh-run");
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
      inspectInProgressMerge: async () => ({ kind: "none" }),
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
    // No merge was in progress at preflight, so the only abort is the one the
    // clean retry takes between attempts.
    expect(aborts).toEqual(["/tmp/lane-b"]);
    expect(observed).toHaveLength(2);
    const finalJoin = persist.read().joins["join-1"]!;
    expect(finalJoin.status).toBe("succeeded");
    expect(finalJoin.mergedSourceLaneIds).toEqual(["lane-b"]);
    expect(finalJoin.conflicts).toBeNull();
  });

  it("records a sub-turn-resolved conflict on the join when the merge completes after resolution", async () => {
    // Audit 1beec403: join 2 resolved a schemas.ts both-sides-added conflict
    // via a smart-merge sub-turn, but the join recorded conflicts: null and
    // the audit reported a false "merged without conflicts" positive.
    const analysis = [
      {
        file: "src/lib/naming/schemas.ts",
        description: "both sides added the file",
        resolution: "merged complementary request + response schemas",
        rationale: "additions are disjoint",
      },
    ];
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
      new Map([
        [
          "csm/lane-b",
          {
            ...completed("hash-b"),
            conflictFiles: ["src/lib/naming/schemas.ts"],
            conflictAnalysis: analysis,
          },
        ],
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
    const finalJoin = persist.read().joins["join-1"]!;
    expect(finalJoin.status).toBe("succeeded");
    // The merge succeeded, so `conflicts` (terminal failure detail) stays
    // null — the resolved conflict is recorded separately.
    expect(finalJoin.conflicts).toBeNull();
    expect(finalJoin.resolvedConflicts).toEqual([
      {
        sourceLaneId: "lane-b",
        files: ["src/lib/naming/schemas.ts"],
        resolution: "sub_turn",
        analysis,
      },
    ]);
  });

  it("emits per-lane lifecycle sub-step records so join time is attributable", async () => {
    // Audit 1beec403: joins ran up to 27 minutes with only join.started /
    // join.completed brackets — per-lane merges, validation deferral, and
    // sub-turn conflict resolution were invisible to the lifecycle log.
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
        [
          "csm/lane-b",
          {
            ...completed("hash-b"),
            conflictFiles: ["src/x.ts"],
            conflictAnalysis: null,
          },
        ],
        ["csm/lane-c", completed("hash-c")],
      ]),
      observed,
    );
    const lifecycle: Array<{ event: string; fields: Record<string, unknown> }> =
      [];

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
      lifecycle: (event, fields) => lifecycle.push({ event, fields }),
    });

    expect(result.status).toBe("succeeded");
    const started = lifecycle.filter(
      (r) => r.event === "join.lane_merge.started",
    );
    const completedRecords = lifecycle.filter(
      (r) => r.event === "join.lane_merge.completed",
    );
    expect(started.map((r) => r.fields.sourceLaneId)).toEqual([
      "lane-b",
      "lane-c",
    ]);
    expect(completedRecords.map((r) => r.fields.sourceLaneId)).toEqual([
      "lane-b",
      "lane-c",
    ]);
    const laneB = completedRecords[0]!.fields;
    expect(laneB.joinId).toBe("join-1");
    expect(laneB.conflictResolution).toBe("sub_turn");
    expect(laneB.conflictFileCount).toBe(1);
    const laneC = completedRecords[1]!.fields;
    expect(laneC.conflictResolution).toBeNull();
  });

  it("emits a lifecycle record when a lane merge fails", async () => {
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
    const mergeRunner = fakeMergeRunner(
      new Map([["csm/lane-b", failed("validation exhausted")]]),
      [],
    );
    const lifecycle: Array<{ event: string; fields: Record<string, unknown> }> =
      [];

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

    await runner.run({
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session",
      joinId: "join-1",
      mutateActive: persist.mutateActive,
      lifecycle: (event, fields) => lifecycle.push({ event, fields }),
    });

    const failedRecord = lifecycle.find(
      (r) => r.event === "join.lane_merge.failed",
    );
    expect(failedRecord?.fields.sourceLaneId).toBe("lane-b");
    expect(failedRecord?.fields.mergeStatus).toBe("failed");
  });

  it("records a clean-retry-resolved conflict with the first attempt's files", async () => {
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

    expect(result.status).toBe("succeeded");
    const finalJoin = persist.read().joins["join-1"]!;
    expect(finalJoin.resolvedConflicts).toEqual([
      {
        sourceLaneId: "lane-b",
        files: ["src/foo.ts"],
        resolution: "clean_retry",
        analysis: null,
      },
    ]);
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

  it("spends no retry on a non-retryable resolver failure and names the classification", async () => {
    // Incident 3edd5fd7: four resolution attempts died on the same quota wall,
    // and the halt blamed the conflict files nothing had read.
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
    const failure: AgentFailureClassification = {
      kind: "quota_exhausted",
      message: "You've hit your usage limit.",
      retryable: false,
      retryAfterHint: "Aug 19th, 2026 11:29 PM",
    };
    const observed: GraphMergeRunnerInput[] = [];
    const mergeRunner = sequencedMergeRunner(
      new Map([
        [
          "csm/lane-b",
          [resolutionInfrastructureFailed(failure, ["src/binding.ts"])],
        ],
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
      abortInProgressMerge: async () => false,
      inspectInProgressMerge: async () => ({ kind: "none" }),
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

    expect(observed).toHaveLength(1);
    expect(result).toEqual({
      status: "failed",
      message:
        "Conflict resolution failed before reaching the conflict: quota_exhausted — " +
        "You've hit your usage limit. (capacity hint: Aug 19th, 2026 11:29 PM)",
      conflictFiles: ["src/binding.ts"],
      failedSourceLaneId: "lane-b",
      haltReason: null,
      resolutionFailure: failure,
    });
    const finalJoin = persist.read().joins["join-1"]!;
    expect(finalJoin.status).toBe("failed");
    expect(finalJoin.errorMessage).toMatch(/quota_exhausted/);
    // The resolver never read these files, so they are not recorded as the
    // join's conflict.
    expect(finalJoin.conflicts).toBeNull();
  });

  it("retries once when the resolver failure is retryable, and succeeds on the retry", async () => {
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
          [
            resolutionInfrastructureFailed({
              kind: "schema_validation",
              message: "no schema-valid resolution survived",
              retryable: true,
            }),
            completed("hash-b"),
          ],
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
        return true;
      },
      inspectInProgressMerge: async () => ({ kind: "none" }),
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
    expect(observed).toHaveLength(2);
    expect(aborts).toEqual(["/tmp/lane-b"]);
    expect(persist.read().joins["join-1"]?.status).toBe("succeeded");
  });

  it("stops after exactly one retry when the retryable resolver failure repeats", async () => {
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
    const failure: AgentFailureClassification = {
      kind: "timeout",
      message: "resolution turn exceeded 900000ms",
      retryable: true,
    };
    const observed: GraphMergeRunnerInput[] = [];
    const mergeRunner = sequencedMergeRunner(
      new Map([
        [
          "csm/lane-b",
          [
            resolutionInfrastructureFailed(failure),
            resolutionInfrastructureFailed(failure),
          ],
        ],
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
      abortInProgressMerge: async () => true,
      inspectInProgressMerge: async () => ({ kind: "none" }),
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

    expect(observed).toHaveLength(2);
    expect(result).toMatchObject({
      status: "failed",
      message:
        "Conflict resolution failed before reaching the conflict: timeout — " +
        "resolution turn exceeded 900000ms",
      resolutionFailure: failure,
    });
  });

  it("aborts a real unresolved mid-merge source worktree before its index is resynced", async () => {
    // Incident 3edd5fd7: the index resync ran first, `git reset --mixed HEAD`
    // erased MERGE_HEAD, and the abort behind it found nothing to abort —
    // leaving a marker-bearing tree that the merge machine then committed.
    const cleanupPaths: string[] = [];
    try {
      const source = await createMidMergeRepo(
        "cc-join-midmerge-source-",
        cleanupPaths,
        { resolve: false },
      );
      const targetWorktreePath = await createPrivateIndexResidueRepo(
        "cc-join-midmerge-target-",
        "lane-target",
        cleanupPaths,
      );

      expect(await mergeHeadPresent(source.repoPath)).toBe(true);
      const preMergeHead = await git(source.repoPath, ["rev-parse", "HEAD"]);

      const execution = setupExecutionWithJoin(
        makeJoin({
          joinId: "join-midmerge",
          targetLaneId: "lane-target",
          sourceLaneIds: ["lane-target", "lane-source"],
        }),
        {
          "lane-target": makeLane({
            laneId: "lane-target",
            branchName: "lane-target",
            worktreePath: targetWorktreePath,
          }),
          "lane-source": makeLane({
            laneId: "lane-source",
            branchName: "lane-source",
            worktreePath: source.repoPath,
          }),
        },
      );
      const persist = createInMemoryPersist(execution);
      const calls: string[] = [];
      let dispatchState: {
        mergeHeadPresent: boolean;
        status: string;
        fileContent: string;
        head: string;
      } | null = null;

      const runner = createJoinRunner({
        mergeRunner: {
          async run() {
            dispatchState = {
              mergeHeadPresent: await mergeHeadPresent(source.repoPath),
              status: await git(source.repoPath, [
                "status",
                "--porcelain=v1",
                "--untracked-files=all",
              ]),
              fileContent: await readFile(source.conflictedFile, "utf-8"),
              head: await git(source.repoPath, ["rev-parse", "HEAD"]),
            };
            return completed("hash-source");
          },
        },
        sessionGitLock: createSessionGitLock({
          acquireSessionLock: () => () => {},
        }),
        mergeMutex: createPerSessionMergeMutex(),
        abortInProgressMerge: async (worktreePath) => {
          calls.push(`abort:${worktreePath}`);
          return abortInProgressMerge(worktreePath);
        },
        resyncSharedIndex: async (worktreePath) => {
          calls.push(`resync:${worktreePath}`);
          await resyncSharedIndexToHead(worktreePath);
        },
        readRepoConfig: async () => null,
        now: () => t0,
      });

      const result = await runner.run({
        projectPath: targetWorktreePath,
        projectName: "repo",
        sessionName: "session",
        joinId: "join-midmerge",
        mutateActive: persist.mutateActive,
      });

      expect(result.status).toBe("succeeded");
      expect(calls).toEqual([
        `abort:${source.repoPath}`,
        `resync:${source.repoPath}`,
        `resync:${targetWorktreePath}`,
      ]);
      expect(dispatchState).not.toBeNull();
      const dispatched = dispatchState as unknown as {
        mergeHeadPresent: boolean;
        status: string;
        fileContent: string;
        head: string;
      };
      expect(dispatched.mergeHeadPresent).toBe(false);
      expect(dispatched.status).toBe("");
      expect(dispatched.fileContent).not.toMatch(/^<{7} /m);
      // Nothing committed the conflicted tree: the lane tip is still the
      // pre-merge commit, so no "WIP" commit could carry markers forward.
      expect(dispatched.head).toBe(preMergeHead);
    } finally {
      await Promise.all(
        cleanupPaths.map((cleanupPath) =>
          rm(cleanupPath, { recursive: true, force: true }),
        ),
      );
    }
  });

  it("halts the join instead of destroying an operator resolution awaiting commit", async () => {
    const cleanupPaths: string[] = [];
    try {
      const source = await createMidMergeRepo(
        "cc-join-resolved-source-",
        cleanupPaths,
        { resolve: true },
      );
      const targetWorktreePath = await createPrivateIndexResidueRepo(
        "cc-join-resolved-target-",
        "lane-target",
        cleanupPaths,
      );

      const execution = setupExecutionWithJoin(
        makeJoin({
          joinId: "join-resolved",
          targetLaneId: "lane-target",
          sourceLaneIds: ["lane-target", "lane-source"],
        }),
        {
          "lane-target": makeLane({
            laneId: "lane-target",
            branchName: "lane-target",
            worktreePath: targetWorktreePath,
          }),
          "lane-source": makeLane({
            laneId: "lane-source",
            branchName: "lane-source",
            worktreePath: source.repoPath,
          }),
        },
      );
      const persist = createInMemoryPersist(execution);
      const observed: GraphMergeRunnerInput[] = [];

      const runner = createJoinRunner({
        mergeRunner: fakeMergeRunner(new Map(), observed),
        sessionGitLock: createSessionGitLock({
          acquireSessionLock: () => () => {},
        }),
        mergeMutex: createPerSessionMergeMutex(),
        abortInProgressMerge,
        resyncSharedIndex: resyncSharedIndexToHead,
        readRepoConfig: async () => null,
        now: () => t0,
      });

      const result = await runner.run({
        projectPath: targetWorktreePath,
        projectName: "repo",
        sessionName: "session",
        joinId: "join-resolved",
        mutateActive: persist.mutateActive,
      });

      expect(result.status).toBe("failed");
      expect(result).toMatchObject({
        failedSourceLaneId: "lane-source",
        message: expect.stringMatching(/resolved but not committed/i),
      });
      expect(result).toMatchObject({
        message: expect.stringContaining(source.repoPath),
      });
      expect(observed).toHaveLength(0);
      // The operator's staged resolution survives untouched.
      expect(await mergeHeadPresent(source.repoPath)).toBe(true);
      expect(await readFile(source.conflictedFile, "utf-8")).toBe(
        "both sides\n",
      );
      expect(persist.read().joins["join-resolved"]?.status).toBe("failed");
    } finally {
      await Promise.all(
        cleanupPaths.map((cleanupPath) =>
          rm(cleanupPath, { recursive: true, force: true }),
        ),
      );
    }
  });
});
