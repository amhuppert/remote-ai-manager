import { describe, expect, it } from "vitest";
import { fromPromise } from "xstate";
import { mergeMachine } from "@/lib/workflows/merge/machine";
import type {
  AnalyzeConflictsInput,
  AnalyzeConflictsOutput,
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
} from "@/lib/workflows/merge/actors";
import type {
  CheckUncommittedInput,
  CheckUncommittedOutput,
  CommitChangesInput,
  CommitChangesOutput,
  RunValidationInput,
  RunValidationOutput,
} from "@/lib/workflows/validation-fix/actors";
import type { DeliveryGateEvaluator } from "@/lib/workflows/merge/types";
import type { MergeValidationMode } from "@/lib/workflows/validation-fix/types";
import { createGraphWorkflowMergeRunner } from "./graph-merge-runner";

const graphLaneValidationMode = {
  mode: "run",
  source: "graph_lane_merge",
  selection: { mode: "only", commands: ["typecheck"] },
} satisfies MergeValidationMode;

/** Real merge machine with stubbed actors; captures the resolver's input. */
function buildCapturingMachine(
  captured: ResolveConflictsInput[],
  publishOutput: PublishActorOutput = {
    status: "completed",
    mergeHash: "merge-hash",
  },
  capturedValidation: RunValidationInput[] = [],
) {
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
      runValidation: fromPromise<RunValidationOutput, RunValidationInput>(
        async ({ input }) => {
          capturedValidation.push(input);
          return null;
        },
      ),
      prepare: fromPromise<PrepareActorOutput, PrepareActorInput>(async () => ({
        status: "prepared",
        preparedSha: "prepared-sha",
        expectedTargetSha: "expected-sha",
        parkedRef: "refs/cc-merges/test",
      })),
      publish: fromPromise<PublishActorOutput, PublishActorInput>(
        async () => publishOutput,
      ),
    },
  });
}

describe("graph-merge-runner", () => {
  it("gates a linked final publish while preserving non-spec pass-through", async () => {
    const evaluated: string[] = [];
    const deliveryGate: DeliveryGateEvaluator = {
      async evaluate(input) {
        evaluated.push(input.workflowExecutionId);
        return {
          status: "refused",
          unmet: [
            {
              criterionId: "criterion-1",
              criterionHandle: "native-sdd/R18.1",
              outcome: "proof_required",
            },
          ],
          instruction: "Re-dispatch validation for the prepared candidate.",
        };
      },
    };
    const runner = createGraphWorkflowMergeRunner({
      buildMachine: () => buildCapturingMachine([]),
      deliveryGate,
      recordMergeIntent: () => {},
    });
    const baseInput = {
      jobId: "job-gated",
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session",
      contextId: "join-final",
      branchName: "csm/lane-b",
      featureWorktreePath: "/tmp/lane-b",
      targetBranch: "csm/session",
      targetWorktreePath: "/tmp/session",
      message: "final publish",
      finalPublish: true,
      validationMode: graphLaneValidationMode,
    } as const;

    const linked = await runner.run({
      ...baseInput,
      executionId: "workflow-execution-linked",
    });
    const unlinked = await runner.run({
      ...baseInput,
      jobId: "job-unlinked",
    });

    expect(linked).toMatchObject({
      status: "failed",
      haltReason: { type: "delivery_gate_failed" },
    });
    expect(unlinked.status).toBe("completed");
    expect(evaluated).toEqual(["workflow-execution-linked"]);
  });

  it("marks a linked execution delivered only after final publish succeeds", async () => {
    const delivered: Array<{ executionId: string; mergeHash: string }> = [];
    const runner = createGraphWorkflowMergeRunner({
      buildMachine: () => buildCapturingMachine([]),
      deliveryGate: {
        async evaluate() {
          return { status: "pass", satisfied: [], deferred: [] };
        },
      },
      async markDelivered(executionId, mergeHash) {
        delivered.push({ executionId, mergeHash });
      },
      recordMergeIntent: () => {},
    });

    await runner.run({
      jobId: "job-delivered",
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session",
      contextId: "join-final",
      branchName: "csm/lane-b",
      featureWorktreePath: "/tmp/lane-b",
      targetBranch: "csm/session",
      targetWorktreePath: "/tmp/session",
      message: "final publish",
      executionId: "workflow-execution-linked",
      finalPublish: true,
      validationMode: graphLaneValidationMode,
    });

    expect(delivered).toEqual([
      {
        executionId: "workflow-execution-linked",
        mergeHash: "merge-hash",
      },
    ]);
  });

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
      validationMode: graphLaneValidationMode,
      resolutionContext: "Ours: verification work. Theirs: implementation.",
    });

    expect(output.status).toBe("completed");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.resolutionContext).toBe(
      "Ours: verification work. Theirs: implementation.",
    );
  });

  it("threads conversationId into the machine so the conflict resolver binds to the lane conversation", async () => {
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
      validationMode: graphLaneValidationMode,
      conversationId: "conv-lane-b-implementer",
    });

    expect(output.status).toBe("completed");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.conversationId).toBe("conv-lane-b-implementer");
  });

  it("threads graph workflow attribution into lane validation submissions", async () => {
    const capturedValidation: RunValidationInput[] = [];
    const runner = createGraphWorkflowMergeRunner({
      buildMachine: () =>
        buildCapturingMachine([], undefined, capturedValidation),
      recordMergeIntent: () => {},
    });

    await runner.run({
      jobId: "job-validation-attribution",
      projectPath: "/repo",
      projectName: "repo",
      sessionName: "session",
      contextId: "context-verify",
      branchName: "csm/lane-b",
      featureWorktreePath: "/tmp/lane-b",
      targetBranch: "csm/lane-a",
      targetWorktreePath: "/tmp/lane-a",
      message: "join merge",
      conversationId: "conv-lane-b-implementer",
      executionId: "execution-1",
      validationMode: graphLaneValidationMode,
    });

    expect(capturedValidation).toContainEqual(
      expect.objectContaining({
        source: "graph_lane_merge",
        conversationId: "conv-lane-b-implementer",
        workflow: {
          executionId: "execution-1",
          contextId: "context-verify",
        },
      }),
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
      validationMode: graphLaneValidationMode,
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

  it("emits a deduped phase breadcrumb for each merge phase the join walks through", async () => {
    const phases: string[] = [];
    const runner = createGraphWorkflowMergeRunner({
      buildMachine: () => buildCapturingMachine([]),
      recordMergeIntent: () => {},
      onPhase: (info) => {
        phases.push(info.phase);
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
      validationMode: graphLaneValidationMode,
      resolutionContext: "Ours: verification. Theirs: implementation.",
    });

    // The capturing machine merges (conflicts → resolve) then validates and
    // publishes. Those phases are exactly the forensic breadcrumbs a stuck
    // join needs — invisible before this change.
    expect(phases).toContain("merging-main");
    expect(phases).toContain("resolving-conflicts");
    expect(phases).toContain("validating");
    expect(phases).toContain("preparing");
    expect(phases).toContain("publishing");
    // No adjacent duplicates: the runner only emits on an actual phase change,
    // not on every machine snapshot.
    for (let i = 1; i < phases.length; i++) {
      expect(phases[i]).not.toBe(phases[i - 1]);
    }
  });

  it("emits the terminal awaiting-land breadcrumb when a dirty target leaves the merge ready to land", async () => {
    const phases: string[] = [];
    const runner = createGraphWorkflowMergeRunner({
      buildMachine: () =>
        buildCapturingMachine([], {
          status: "ready-to-land",
          parkedRef: "refs/cc-merges/test",
          preparedSha: "prepared-sha",
          targetWorktreePath: "/tmp/lane-a",
        }),
      recordMergeIntent: () => {},
      onPhase: (info) => {
        phases.push(info.phase);
      },
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
      validationMode: graphLaneValidationMode,
    });

    expect(output.status).toBe("ready-to-land");
    // readyToLand is the one terminal state that retains a phase
    // ("awaiting-land"); the breadcrumb sequence must include it so a join
    // parked on a dirty target is forensically distinguishable from one that
    // finished publishing.
    expect(phases).toEqual([
      "committing-uncommitted",
      "merging-main",
      "resolving-conflicts",
      "validating",
      "preparing",
      "publishing",
      "awaiting-land",
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
      validationMode: graphLaneValidationMode,
    });

    expect(recorded).toEqual([]);
  });
});
