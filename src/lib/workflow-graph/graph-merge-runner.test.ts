import { describe, expect, it } from "vitest";
import { fromPromise } from "xstate";
import { mergeMachine } from "@/lib/workflows/merge/machine";
import type {
  AnalyzeConflictsInput,
  AnalyzeConflictsOutput,
  CheckUncommittedInput,
  CheckUncommittedOutput,
  CommitChangesInput,
  CommitChangesOutput,
  GetCurrentBranchInput,
  GetCurrentBranchOutput,
  MergeMainInput,
  MergeMainOutput,
  PrepareActorInput,
  PrepareActorOutput,
  PublishActorInput,
  PublishActorOutput,
  ResolveConflictsInput,
  ResolveConflictsOutput,
  RunValidationInput,
} from "@/lib/workflows/merge/actors";
import { createGraphWorkflowMergeRunner } from "./graph-merge-runner";

/** Real merge machine with stubbed actors; captures the resolver's input. */
function buildCapturingMachine(captured: ResolveConflictsInput[]) {
  return mergeMachine.provide({
    actors: {
      checkUncommitted: fromPromise<
        CheckUncommittedOutput,
        CheckUncommittedInput
      >(async () => ({ hasChanges: false })),
      getCurrentBranch: fromPromise<
        GetCurrentBranchOutput,
        GetCurrentBranchInput
      >(async () => ({ branch: "csm/lane-b" })),
      commitChanges: fromPromise<CommitChangesOutput, CommitChangesInput>(
        async () => ({ hash: "h" }),
      ),
      mergeMain: fromPromise<MergeMainOutput, MergeMainInput>(async () => ({
        status: "conflicts",
        conflictFiles: ["src/a.ts"],
      })),
      resolveConflicts: fromPromise<
        ResolveConflictsOutput,
        ResolveConflictsInput
      >(async ({ input }) => {
        captured.push(input);
        return { status: "resolved", conflicts: [] };
      }),
      analyzeConflicts: fromPromise<
        AnalyzeConflictsOutput,
        AnalyzeConflictsInput
      >(async () => ({ status: "analyzed", conflicts: [] })),
      runValidation: fromPromise<void, RunValidationInput>(
        async () => undefined,
      ),
      prepare: fromPromise<PrepareActorOutput, PrepareActorInput>(async () => ({
        status: "prepared",
        preparedSha: "prepared-sha",
        expectedTargetSha: "expected-sha",
        parkedRef: "refs/cc-merges/test",
      })),
      publish: fromPromise<PublishActorOutput, PublishActorInput>(async () => ({
        status: "completed",
        mergeHash: "merge-hash",
      })),
    },
  });
}

describe("graph-merge-runner", () => {
  it("threads resolutionContext into the machine so the conflict resolver receives it", async () => {
    const captured: ResolveConflictsInput[] = [];
    const runner = createGraphWorkflowMergeRunner({
      buildMachine: () => buildCapturingMachine(captured),
      recordMergeIntent: () => {},
    });

    const output = await runner.run({
      jobId: "job-1",
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session",
      contextId: "context-verify",
      branchName: "csm/lane-b",
      featureWorktreePath: "/tmp/lane-b",
      targetBranch: "csm/lane-a",
      targetWorktreePath: "/tmp/lane-a",
      message: "join merge",
      resolutionContext: "Ours: verification work. Theirs: implementation.",
    });

    expect(output.status).toBe("completed");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.resolutionContext).toBe(
      "Ours: verification work. Theirs: implementation.",
    );
  });

  it("records the intent against the landed squash commit when the merge completes", async () => {
    const recorded: unknown[] = [];
    const runner = createGraphWorkflowMergeRunner({
      buildMachine: () => buildCapturingMachine([]),
      recordMergeIntent: (input) => {
        recorded.push(input);
      },
    });

    await runner.run({
      jobId: "job-1",
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session",
      contextId: "context-verify",
      branchName: "csm/lane-b",
      featureWorktreePath: "/tmp/lane-b",
      targetBranch: "csm/lane-a",
      targetWorktreePath: "/tmp/lane-a",
      message: "join merge",
      resolutionContext: "Ours: verification work. Theirs: implementation.",
    });

    expect(recorded).toEqual([
      {
        projectPath: "/repo",
        commitSha: "merge-hash",
        intent: "Ours: verification work. Theirs: implementation.",
        source: "graph-join",
      },
    ]);
  });

  it("does not record an intent when no resolutionContext was provided", async () => {
    const recorded: unknown[] = [];
    const runner = createGraphWorkflowMergeRunner({
      buildMachine: () => buildCapturingMachine([]),
      recordMergeIntent: (input) => {
        recorded.push(input);
      },
    });

    await runner.run({
      jobId: "job-1",
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session",
      contextId: "context-verify",
      branchName: "csm/lane-b",
      featureWorktreePath: "/tmp/lane-b",
      targetBranch: "csm/lane-a",
      targetWorktreePath: "/tmp/lane-a",
      message: "join merge",
    });

    expect(recorded).toEqual([]);
  });
});
