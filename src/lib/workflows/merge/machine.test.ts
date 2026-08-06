import { describe, it, expect } from "vitest";
import { createActor, fromPromise, toPromise } from "xstate";
import { mergeMachine } from "./machine";
import type { DeliveryGateEvaluator, MergeInput } from "./types";
import type {
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
  DiscardParkedRefInput,
  DiscardParkedRefOutput,
} from "./actors";
import { createDeliveryGateActor } from "./actors";
import type {
  CheckUncommittedInput,
  CheckUncommittedOutput,
  CommitChangesInput,
  CommitChangesOutput,
  RunValidationInput,
  RunValidationOutput,
  FixValidationInput,
  FixValidationOutput,
} from "../validation-fix/actors";
import {
  nonRemediableValidationError,
  validationFixLoopError,
} from "../validation-fix/actors";

// ============================================================
// Typed Actor Helpers
// ============================================================

function mockCheckUncommitted(
  fn: (input: CheckUncommittedInput) => Promise<CheckUncommittedOutput>,
) {
  return fromPromise<CheckUncommittedOutput, CheckUncommittedInput>(
    async ({ input }) => fn(input),
  );
}

function mockGetCurrentBranch(
  fn: (input: GetCurrentBranchInput) => Promise<GetCurrentBranchOutput>,
) {
  return fromPromise<GetCurrentBranchOutput, GetCurrentBranchInput>(
    async ({ input }) => fn(input),
  );
}

function mockCommitChanges(
  fn: (input: CommitChangesInput) => Promise<CommitChangesOutput>,
) {
  return fromPromise<CommitChangesOutput, CommitChangesInput>(
    async ({ input }) => fn(input),
  );
}

function mockMergeMain(
  fn: (input: MergeMainInput) => Promise<MergeMainOutput>,
) {
  return fromPromise<MergeMainOutput, MergeMainInput>(async ({ input }) =>
    fn(input),
  );
}

function mockResolveConflicts(
  fn: (input: ResolveConflictsInput) => Promise<ResolveConflictsOutput>,
) {
  return fromPromise<ResolveConflictsOutput, ResolveConflictsInput>(
    async ({ input }) => fn(input),
  );
}

function mockAnalyzeConflicts(
  fn: (input: AnalyzeConflictsInput) => Promise<AnalyzeConflictsOutput>,
) {
  return fromPromise<AnalyzeConflictsOutput, AnalyzeConflictsInput>(
    async ({ input }) => fn(input),
  );
}

function mockRunValidation(
  fn: (input: RunValidationInput) => Promise<RunValidationOutput>,
) {
  return fromPromise<RunValidationOutput, RunValidationInput>(
    async ({ input }) => fn(input),
  );
}

function mockFixValidation(
  fn: (input: FixValidationInput) => Promise<FixValidationOutput>,
) {
  return fromPromise<FixValidationOutput, FixValidationInput>(
    async ({ input }) => fn(input),
  );
}

function validationFailure(message: string): Error {
  return validationFixLoopError(
    {
      status: "fail",
      kind: "script_validation",
      reason: message,
      details: { failureClass: "validation_failed", timedOut: false },
    },
    "",
  );
}

function mockPrepare(
  fn: (input: PrepareActorInput) => Promise<PrepareActorOutput>,
) {
  return fromPromise<PrepareActorOutput, PrepareActorInput>(async ({ input }) =>
    fn(input),
  );
}

function mockPublish(
  fn: (input: PublishActorInput) => Promise<PublishActorOutput>,
) {
  return fromPromise<PublishActorOutput, PublishActorInput>(async ({ input }) =>
    fn(input),
  );
}

function mockDiscardParkedRef(
  fn: (input: DiscardParkedRefInput) => Promise<DiscardParkedRefOutput>,
) {
  return fromPromise<DiscardParkedRefOutput, DiscardParkedRefInput>(
    async ({ input }) => fn(input),
  );
}

// ============================================================
// Default Test Machine
// ============================================================

const defaultInput: MergeInput = {
  jobId: "test-job-001",
  projectPath: "/projects/app",
  projectName: "app",
  sessionName: "test-session",
  worktreePath: "/projects/app/.worktrees/test-session",
  branchName: "csm/test-session",
  message: "Merge: feature work",
  autoResolve: true,
  validationMode: {
    mode: "run",
    source: "smart_merge",
    selection: { mode: "project-pre-merge" },
  },
};

type ActorOverrides = {
  checkUncommitted?: ReturnType<typeof mockCheckUncommitted>;
  commitChanges?: ReturnType<typeof mockCommitChanges>;
  getCurrentBranch?: ReturnType<typeof mockGetCurrentBranch>;
  mergeMain?: ReturnType<typeof mockMergeMain>;
  resolveConflicts?: ReturnType<typeof mockResolveConflicts>;
  analyzeConflicts?: ReturnType<typeof mockAnalyzeConflicts>;
  runValidation?: ReturnType<typeof mockRunValidation>;
  fixValidation?: ReturnType<typeof mockFixValidation>;
  prepare?: ReturnType<typeof mockPrepare>;
  publish?: ReturnType<typeof mockPublish>;
  discardParkedRef?: ReturnType<typeof mockDiscardParkedRef>;
  deliveryGateEvaluator?: DeliveryGateEvaluator;
};

function createTestMachine(overrides: ActorOverrides = {}) {
  return mergeMachine.provide({
    actors: {
      checkUncommitted:
        overrides.checkUncommitted ??
        mockCheckUncommitted(async () => ({ hasChanges: false })),
      commitChanges:
        overrides.commitChanges ??
        mockCommitChanges(async () => ({ hash: "abc123" })),
      getCurrentBranch:
        overrides.getCurrentBranch ??
        mockGetCurrentBranch(async () => ({
          branch: defaultInput.branchName,
        })),
      mergeMain:
        overrides.mergeMain ??
        mockMergeMain(async () => ({ status: "clean", conflictFiles: [] })),
      resolveConflicts:
        overrides.resolveConflicts ??
        mockResolveConflicts(async () => ({
          status: "resolved",
          conflicts: [],
        })),
      analyzeConflicts:
        overrides.analyzeConflicts ??
        mockAnalyzeConflicts(async () => ({
          status: "analyzed",
          conflicts: [],
        })),
      runValidation:
        overrides.runValidation ?? mockRunValidation(async () => null),
      fixValidation:
        overrides.fixValidation ??
        mockFixValidation(async () => ({ status: "fixed" })),
      prepare:
        overrides.prepare ??
        mockPrepare(async () => ({
          status: "prepared",
          preparedSha: "prepared-sha",
          expectedTargetSha: "expected-target-sha",
          parkedRef: "refs/cc-merges/test",
        })),
      publish:
        overrides.publish ??
        mockPublish(async () => ({
          status: "completed",
          mergeHash: "merge-abc",
        })),
      discardParkedRef:
        overrides.discardParkedRef ??
        mockDiscardParkedRef(async () => undefined),
      deliveryGate: createDeliveryGateActor(
        overrides.deliveryGateEvaluator ?? {
          async evaluate() {
            throw new Error("Unexpected delivery gate evaluation");
          },
        },
      ),
    },
  });
}

// ============================================================
// Tests
// ============================================================

describe("mergeMachine", () => {
  describe("delivery gate", () => {
    it("evaluates the initially prepared candidate before publishing", async () => {
      const sequence: string[] = [];
      const evaluated: Parameters<DeliveryGateEvaluator["evaluate"]>[0][] = [];
      const candidateValidation = {
        validationRef: "validation-initial",
        validatedSha: "validated-sha",
        validatedTreeHash: "validated-tree",
        commandIdentity: "./validate.sh",
        outcome: "pass" as const,
      };
      const machine = createTestMachine({
        runValidation: mockRunValidation(async () => candidateValidation),
        prepare: mockPrepare(async () => ({
          status: "prepared",
          preparedSha: "prepared-initial",
          expectedTargetSha: "target-initial",
          parkedRef: "refs/cc-merges/initial",
        })),
        deliveryGateEvaluator: {
          async evaluate(input) {
            sequence.push("gate");
            evaluated.push(input);
            return { status: "pass", satisfied: [], deferred: [] };
          },
        },
        publish: mockPublish(async () => {
          sequence.push("publish");
          return { status: "completed", mergeHash: "merge-abc" };
        }),
      });
      const actor = createActor(machine, {
        input: { ...defaultInput, executionId: "workflow-execution-1" },
      });
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("completed");
      expect(sequence).toEqual(["gate", "publish"]);
      expect(evaluated).toEqual([
        {
          workflowExecutionId: "workflow-execution-1",
          preparedSha: "prepared-initial",
          expectedTargetSha: "target-initial",
          projectPath: defaultInput.projectPath,
          candidateValidation,
        },
      ]);
    });

    it("re-evaluates a newly prepared candidate after a publish CAS loss", async () => {
      let prepareCall = 0;
      let publishCall = 0;
      const evaluatedShas: string[] = [];
      const machine = createTestMachine({
        prepare: mockPrepare(async () => {
          prepareCall += 1;
          return {
            status: "prepared",
            preparedSha: `prepared-${prepareCall}`,
            expectedTargetSha: `target-${prepareCall}`,
            parkedRef: `refs/cc-merges/${prepareCall}`,
          };
        }),
        deliveryGateEvaluator: {
          async evaluate(input) {
            evaluatedShas.push(input.preparedSha);
            return { status: "pass", satisfied: [], deferred: [] };
          },
        },
        publish: mockPublish(async () => {
          publishCall += 1;
          if (publishCall === 1) {
            return { status: "cas-lost", actualTargetSha: "target-moved" };
          }
          return { status: "completed", mergeHash: "merge-after-retry" };
        }),
      });
      const actor = createActor(machine, {
        input: { ...defaultInput, executionId: "workflow-execution-1" },
      });
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("completed");
      expect(evaluatedShas).toEqual(["prepared-1", "prepared-2"]);
      expect(publishCall).toBe(2);
    });

    it("parks the prepared candidate and terminates with a typed halt reason on refusal", async () => {
      let publishCall = 0;
      const states: string[] = [];
      const unmet = [
        {
          criterionId: "criterion-1",
          criterionHandle: "R1.1",
          outcome: "unmet",
          reason: "No current proof",
        },
      ];
      const machine = createTestMachine({
        deliveryGateEvaluator: {
          async evaluate() {
            return {
              status: "refused",
              unmet,
              instruction: "Record fresh proof and re-dispatch the merge.",
            };
          },
        },
        publish: mockPublish(async () => {
          publishCall += 1;
          return { status: "completed", mergeHash: "must-not-publish" };
        }),
      });
      const actor = createActor(machine, {
        input: { ...defaultInput, executionId: "workflow-execution-1" },
      });
      actor.subscribe((snapshot) => states.push(String(snapshot.value)));
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("failed");
      expect(states).toContain("deliveryGateFailed");
      expect(publishCall).toBe(0);
      expect(output.preparedSha).toBe("prepared-sha");
      expect(output.parkedRef).toBe("refs/cc-merges/test");
      expect(output.haltReason).toEqual({
        type: "delivery_gate_failed",
        unmet,
        instruction: "Record fresh proof and re-dispatch the merge.",
      });
      expect(output.error).toContain("R1.1");
    });

    it("carries the approval-required presentation into the halt reason instead of the unmet-criteria template", async () => {
      const unmet = [
        {
          criterionId: "spec-execution-1:gate:1",
          criterionHandle: "audit-log",
          outcome: "gate_blocked",
          reason: "The delivery gate requires human approval.",
        },
      ];
      const spec = {
        specSlug: "audit-log",
        specName: "Audit Log",
        projectName: "command-center",
      };
      const machine = createTestMachine({
        deliveryGateEvaluator: {
          async evaluate() {
            return {
              status: "refused",
              unmet,
              instruction: "Approve delivery in Spec Studio, then resume.",
              refusalCode: "approval_required",
              spec,
            };
          },
        },
      });
      const actor = createActor(machine, {
        input: { ...defaultInput, executionId: "workflow-execution-1" },
      });
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("failed");
      expect(output.haltReason).toEqual({
        type: "delivery_gate_failed",
        unmet,
        instruction: "Approve delivery in Spec Studio, then resume.",
        refusalCode: "approval_required",
        spec,
      });
      // A sign-off wait is not an unmet-criteria failure: the error line says
      // what the run is waiting on rather than listing pseudo-criteria.
      expect(output.error).toBe(
        "Delivery gate is waiting on human delivery approval. Approve delivery in Spec Studio, then resume.",
      );
    });

    it("publishes unchanged without invoking the evaluator when executionId is absent", async () => {
      let evaluateCall = 0;
      let publishCall = 0;
      const machine = createTestMachine({
        deliveryGateEvaluator: {
          async evaluate() {
            evaluateCall += 1;
            return { status: "pass", satisfied: [], deferred: [] };
          },
        },
        publish: mockPublish(async () => {
          publishCall += 1;
          return { status: "completed", mergeHash: "merge-abc" };
        }),
      });
      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("completed");
      expect(evaluateCall).toBe(0);
      expect(publishCall).toBe(1);
    });
  });

  describe("validation mode", () => {
    it("skips only validation while preserving conflict resolution, commit, prepare, and publish", async () => {
      let resolutionCalls = 0;
      let commitCalls = 0;
      let prepareCalls = 0;
      let publishCalls = 0;
      const phases: Array<string | null> = [];
      const machine = createTestMachine({
        mergeMain: mockMergeMain(async () => ({
          status: "conflicts",
          conflictFiles: ["src/integration.ts"],
        })),
        resolveConflicts: mockResolveConflicts(async () => {
          resolutionCalls += 1;
          return { status: "resolved", conflicts: [] };
        }),
        commitChanges: mockCommitChanges(async () => {
          commitCalls += 1;
          return { hash: "resolution-hash" };
        }),
        runValidation: mockRunValidation(async () => {
          throw new Error("validation must not run in skip mode");
        }),
        prepare: mockPrepare(async () => {
          prepareCalls += 1;
          return {
            status: "prepared",
            preparedSha: "prepared-sha",
            expectedTargetSha: "expected-target-sha",
            parkedRef: "refs/cc-merges/test",
          };
        }),
        publish: mockPublish(async () => {
          publishCalls += 1;
          return { status: "completed", mergeHash: "merge-hash" };
        }),
      });
      const actor = createActor(machine, {
        input: { ...defaultInput, validationMode: { mode: "skip" } },
      });
      actor.subscribe((snapshot) => phases.push(snapshot.context.phase));
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("completed");
      expect(resolutionCalls).toBe(1);
      expect(commitCalls).toBe(1);
      expect(prepareCalls).toBe(1);
      expect(publishCalls).toBe(1);
      expect(phases).not.toContain("validating");
    });
  });

  describe("happy path without conflicts", () => {
    it("transitions: checkingUncommitted → mergingMain → validating → preparing → publishing → completed", async () => {
      const states: string[] = [];
      const machine = createTestMachine();
      const actor = createActor(machine, { input: defaultInput });

      actor.subscribe((s) => states.push(String(s.value)));
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("completed");
      expect(output.mergeHash).toBe("merge-abc");
      expect(output.error).toBeNull();
      expect(states).toContain("checkingUncommitted");
      expect(states).toContain("mergingMain");
      expect(states).toContain("validating");
      expect(states).toContain("preparing");
      expect(states).toContain("publishing");
      expect(states).toContain("completed");
    });
  });

  describe("happy path with uncommitted changes", () => {
    it("commits uncommitted changes before merging", async () => {
      const states: string[] = [];
      const machine = createTestMachine({
        checkUncommitted: mockCheckUncommitted(async () => ({
          hasChanges: true,
        })),
      });
      const actor = createActor(machine, { input: defaultInput });

      actor.subscribe((s) => states.push(String(s.value)));
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("completed");
      expect(states).toContain("committingUncommitted");
    });
  });

  describe("merge with conflicts and autoResolve", () => {
    it("resolves conflicts, commits, validates, and squash-merges", async () => {
      const states: string[] = [];
      const machine = createTestMachine({
        mergeMain: mockMergeMain(async () => ({
          status: "conflicts",
          conflictFiles: ["src/index.ts", "src/utils.ts"],
        })),
        resolveConflicts: mockResolveConflicts(async () => ({
          status: "resolved",
          conflicts: [
            {
              file: "src/index.ts",
              description: "Import conflict",
              resolution: "Kept both imports",
              rationale: "Both needed",
            },
          ],
        })),
      });
      const actor = createActor(machine, { input: defaultInput });

      actor.subscribe((s) => states.push(String(s.value)));
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("completed");
      expect(output.conflictAnalysis).toHaveLength(1);
      expect(states).toContain("resolvingConflicts");
      expect(states).toContain("committingResolution");
    });
  });

  describe("merge with conflicts without autoResolve", () => {
    it("analyzes conflicts then goes to conflicts terminal state with analysis", async () => {
      const states: string[] = [];
      const machine = createTestMachine({
        mergeMain: mockMergeMain(async () => ({
          status: "conflicts",
          conflictFiles: ["README.md"],
        })),
        analyzeConflicts: mockAnalyzeConflicts(async () => ({
          status: "analyzed",
          conflicts: [
            {
              file: "README.md",
              description: "Conflicting heading",
              resolution: "Keep feature branch heading",
              rationale: "Feature branch has the updated title",
            },
          ],
        })),
      });
      const actor = createActor(machine, {
        input: { ...defaultInput, autoResolve: false },
      });

      actor.subscribe((s) => states.push(String(s.value)));
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("conflicts");
      expect(output.conflictFiles).toEqual(["README.md"]);
      expect(output.conflictAnalysis).toHaveLength(1);
      expect(output.conflictAnalysis![0]!.file).toBe("README.md");
      expect(states).toContain("analyzingConflicts");
    });

    it("gracefully degrades to conflicts terminal when analysis fails", async () => {
      const machine = createTestMachine({
        mergeMain: mockMergeMain(async () => ({
          status: "conflicts",
          conflictFiles: ["README.md"],
        })),
        analyzeConflicts: mockAnalyzeConflicts(async () => {
          throw new Error("SDK unavailable");
        }),
      });
      const actor = createActor(machine, {
        input: { ...defaultInput, autoResolve: false },
      });
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("conflicts");
      expect(output.conflictFiles).toEqual(["README.md"]);
      expect(output.conflictAnalysis).toBeNull();
    });
  });

  describe("auto-resolve failure falls back to conflicts", () => {
    it("goes to conflicts when resolution fails", async () => {
      const machine = createTestMachine({
        mergeMain: mockMergeMain(async () => ({
          status: "conflicts",
          conflictFiles: ["a.ts"],
        })),
        resolveConflicts: mockResolveConflicts(async () => ({
          status: "failed",
          conflicts: [],
          partialConflicts: [
            {
              file: "a.ts",
              description: "Conflict",
              resolution: "",
              rationale: "Unable to resolve",
            },
          ],
        })),
      });
      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("conflicts");
      expect(output.conflictAnalysis).toHaveLength(1);
    });
  });

  describe("validation failure with auto-fix", () => {
    it("fails without dispatching the fix actor for an admission outcome", async () => {
      let fixCallCount = 0;
      const states: string[] = [];
      const machine = createTestMachine({
        runValidation: mockRunValidation(async () => {
          throw nonRemediableValidationError(
            "validation command cost exceeds limit",
          );
        }),
        fixValidation: mockFixValidation(async () => {
          fixCallCount += 1;
          return { status: "fixed" };
        }),
      });
      const actor = createActor(machine, { input: defaultInput });
      actor.subscribe((snapshot) => states.push(String(snapshot.value)));
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("failed");
      expect(output.error).toBe("validation command cost exceeds limit");
      expect(fixCallCount).toBe(0);
      expect(states).not.toContain("fixingValidation");
    });

    it("keeps a service capacity wait in validating without dispatching a fix", async () => {
      let releaseValidation!: (output: RunValidationOutput) => void;
      let markValidationStarted!: () => void;
      let received: RunValidationInput | undefined;
      let fixCallCount = 0;
      const validationCompletion = new Promise<RunValidationOutput>(
        (resolve) => {
          releaseValidation = resolve;
        },
      );
      const validationStarted = new Promise<void>((resolve) => {
        markValidationStarted = resolve;
      });
      const machine = createTestMachine({
        runValidation: mockRunValidation(async (input) => {
          received = input;
          markValidationStarted();
          return validationCompletion;
        }),
        fixValidation: mockFixValidation(async () => {
          fixCallCount += 1;
          return { status: "fixed" };
        }),
      });
      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      await validationStarted;

      expect(actor.getSnapshot().value).toBe("validating");
      expect(received?.source).toBe("smart_merge");
      expect(fixCallCount).toBe(0);

      releaseValidation(null);
      await expect(toPromise(actor)).resolves.toMatchObject({
        status: "completed",
      });
      expect(fixCallCount).toBe(0);
    });

    it("fixes validation errors and revalidates", async () => {
      let validationCallCount = 0;
      let checkCallCount = 0;
      const states: string[] = [];

      const machine = createTestMachine({
        checkUncommitted: mockCheckUncommitted(async () => {
          checkCallCount++;
          // First call: checkingUncommitted (no uncommitted changes)
          // Second call: checkingFixChanges (agent made changes)
          return { hasChanges: checkCallCount > 1 };
        }),
        runValidation: mockRunValidation(async () => {
          validationCallCount++;
          if (validationCallCount === 1) {
            throw validationFailure("typecheck failed: TS2345");
          }
          // Second call succeeds
          return null;
        }),
        fixValidation: mockFixValidation(async () => ({
          status: "fixed",
        })),
      });
      const actor = createActor(machine, { input: defaultInput });

      actor.subscribe((s) => states.push(String(s.value)));
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("completed");
      expect(states).toContain("fixingValidation");
      expect(states).toContain("checkingFixChanges");
      expect(states).toContain("committingFix");
      expect(states).toContain("revalidating");
    });
  });

  describe("validation failure without autoResolve", () => {
    it("goes directly to failed", async () => {
      const machine = createTestMachine({
        runValidation: mockRunValidation(async () => {
          throw validationFailure("Tests failed");
        }),
      });
      const actor = createActor(machine, {
        input: { ...defaultInput, autoResolve: false },
      });
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("failed");
      expect(output.error).toBe("Tests failed");
    });
  });

  describe("validation timeout short-circuits the fix loop", () => {
    it("skips fixingValidation and fails with actionable guidance when initial validation times out", async () => {
      const states: string[] = [];
      let fixCallCount = 0;
      const machine = createTestMachine({
        runValidation: mockRunValidation(async () => {
          throw Object.assign(
            new Error("Pre-merge validation timed out after 300s"),
            { timedOut: true },
          );
        }),
        fixValidation: mockFixValidation(async () => {
          fixCallCount++;
          return { status: "fixed" };
        }),
      });
      const actor = createActor(machine, { input: defaultInput });
      actor.subscribe((s) => states.push(String(s.value)));
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("failed");
      // A timeout is an environment/scope limit, not a code defect: the fix
      // agent can never resolve it, so it must not be dispatched.
      expect(states).not.toContain("fixingValidation");
      expect(fixCallCount).toBe(0);
      expect(output.error).toContain("timed out");
      expect(output.error).toContain("preMergeTimeoutMs");
    });

    it("stops retrying when a timeout occurs during revalidation", async () => {
      const states: string[] = [];
      let validationCallCount = 0;
      let fixCallCount = 0;
      const machine = createTestMachine({
        runValidation: mockRunValidation(async () => {
          validationCallCount++;
          // First validation fails normally (fixable), revalidation times out.
          if (validationCallCount === 1) {
            throw validationFailure("typecheck failed: TS2345");
          }
          throw Object.assign(
            new Error("Pre-merge validation timed out after 300s"),
            { timedOut: true },
          );
        }),
        fixValidation: mockFixValidation(async () => {
          fixCallCount++;
          return { status: "fixed" };
        }),
      });
      const actor = createActor(machine, {
        input: { ...defaultInput, maxFixAttempts: 3 },
      });
      actor.subscribe((s) => states.push(String(s.value)));
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("failed");
      // The first (fixable) failure dispatches exactly one fix; the timeout on
      // revalidation must not trigger a second fix even though retries remain.
      expect(fixCallCount).toBe(1);
      expect(states.filter((s) => s === "fixingValidation")).toHaveLength(1);
      expect(output.error).toContain("preMergeTimeoutMs");
    });
  });

  describe("fix validation failure propagates to failed", () => {
    it("fails when fix returns failed status", async () => {
      const machine = createTestMachine({
        runValidation: mockRunValidation(async () => {
          throw validationFailure("TS2345: type error");
        }),
        fixValidation: mockFixValidation(async () => ({
          status: "failed",
          error: "Could not fix",
        })),
      });
      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("failed");
    });
  });

  describe("revalidation failure (no retry)", () => {
    it("fails immediately when maxFixAttempts is 1", async () => {
      let validationCallCount = 0;
      const machine = createTestMachine({
        runValidation: mockRunValidation(async () => {
          validationCallCount++;
          throw validationFailure(`Validation error #${validationCallCount}`);
        }),
        fixValidation: mockFixValidation(async () => ({
          status: "fixed",
        })),
      });
      const actor = createActor(machine, {
        input: { ...defaultInput, maxFixAttempts: 1 },
      });
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("failed");
      expect(output.error).toContain("Validation error #2");
    });
  });

  describe("validation fix retry", () => {
    it("retries fix when revalidation fails and succeeds on retry", async () => {
      let validationCallCount = 0;
      let fixCallCount = 0;
      const states: string[] = [];

      const machine = createTestMachine({
        runValidation: mockRunValidation(async () => {
          validationCallCount++;
          // First two calls fail (initial validation + first revalidation)
          if (validationCallCount <= 2) {
            throw validationFailure(`Validation error #${validationCallCount}`);
          }
          // Third call (second revalidation) succeeds
          return null;
        }),
        fixValidation: mockFixValidation(async () => {
          fixCallCount++;
          return {
            status: "fixed",
            sessionRef: {
              backend: "claude" as const,
              sessionId: `session-${fixCallCount}`,
            },
          };
        }),
      });
      const actor = createActor(machine, { input: defaultInput });

      actor.subscribe((s) => states.push(String(s.value)));
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("completed");
      expect(fixCallCount).toBe(2);
      expect(states.filter((s) => s === "fixingValidation")).toHaveLength(2);
      expect(states.filter((s) => s === "revalidating")).toHaveLength(2);
    });

    it("fails when all fix retries are exhausted", async () => {
      let fixCallCount = 0;

      const machine = createTestMachine({
        runValidation: mockRunValidation(async () => {
          throw validationFailure("persistent error");
        }),
        fixValidation: mockFixValidation(async () => {
          fixCallCount++;
          return {
            status: "fixed",
            sessionRef: {
              backend: "claude" as const,
              sessionId: `session-${fixCallCount}`,
            },
          };
        }),
      });
      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("failed");
      expect(fixCallCount).toBe(2); // Default maxFixAttempts is 2
    });

    it("isRetry is false on first attempt and true on subsequent attempts", async () => {
      let validationCallCount = 0;
      const fixInputs: FixValidationInput[] = [];

      const machine = createTestMachine({
        runValidation: mockRunValidation(async () => {
          validationCallCount++;
          if (validationCallCount <= 2) {
            throw validationFailure(`error ${validationCallCount}`);
          }
          return null;
        }),
        fixValidation: mockFixValidation(async (input) => {
          fixInputs.push({ ...input });
          return { status: "fixed" };
        }),
      });
      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      await toPromise(actor);

      expect(fixInputs).toHaveLength(2);
      expect(fixInputs[0]!.isRetry).toBe(false);
      expect(fixInputs[1]!.isRetry).toBe(true);
    });

    it("respects custom maxFixAttempts", async () => {
      let fixCallCount = 0;

      const machine = createTestMachine({
        runValidation: mockRunValidation(async () => {
          throw validationFailure("error");
        }),
        fixValidation: mockFixValidation(async () => {
          fixCallCount++;
          return { status: "fixed" };
        }),
      });
      const actor = createActor(machine, {
        input: { ...defaultInput, maxFixAttempts: 3 },
      });
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("failed");
      expect(fixCallCount).toBe(3);
    });
  });

  describe("committingFix with no changes", () => {
    it("skips commit and proceeds to revalidating when fix agent makes no changes", async () => {
      let validationCallCount = 0;
      const states: string[] = [];

      const machine = createTestMachine({
        runValidation: mockRunValidation(async () => {
          validationCallCount++;
          if (validationCallCount === 1) {
            throw validationFailure("lint errors");
          }
          // Second call (revalidation) succeeds
          return null;
        }),
        fixValidation: mockFixValidation(async () => ({
          status: "fixed",
        })),
        commitChanges: mockCommitChanges(async (input) => {
          if (input.message === "auto-fix: validation errors") {
            throw new Error("No uncommitted changes to commit");
          }
          return { hash: "abc123" };
        }),
      });
      const actor = createActor(machine, { input: defaultInput });

      actor.subscribe((s) => states.push(String(s.value)));
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("completed");
      expect(states).toContain("fixingValidation");
      expect(states).toContain("revalidating");
      expect(states).toContain("preparing");
      expect(states).toContain("publishing");
    });
  });

  describe("publish failure", () => {
    it("goes to failed when publish throws", async () => {
      const machine = createTestMachine({
        publish: mockPublish(async () => {
          throw new Error("Project lock timeout");
        }),
      });
      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("failed");
      expect(output.error).toBe("Project lock timeout");
    });
  });

  describe("context initialization", () => {
    it("initializes all context fields from input", () => {
      const machine = createTestMachine();
      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      const ctx = actor.getSnapshot().context;
      expect(ctx.projectPath).toBe("/projects/app");
      expect(ctx.projectName).toBe("app");
      expect(ctx.sessionName).toBe("test-session");
      expect(ctx.branchName).toBe("csm/test-session");
      expect(ctx.message).toBe("Merge: feature work");
      expect(ctx.autoResolve).toBe(true);
      expect(ctx._schemaVersion).toBe(1);
      expect(ctx.error).toBeNull();
      expect(ctx.mergeHash).toBeNull();
      expect(ctx.conflictFiles).toEqual([]);
      expect(ctx.fixAttempt).toBe(0);
      expect(ctx.maxFixAttempts).toBe(2);
    });
  });

  describe("resolution context threading", () => {
    it("passes resolutionContext from input to the resolveConflicts actor", async () => {
      let capturedInput: ResolveConflictsInput | null = null;

      const machine = createTestMachine({
        mergeMain: mockMergeMain(async () => ({
          status: "conflicts",
          conflictFiles: ["src/index.ts"],
        })),
        resolveConflicts: mockResolveConflicts(async (input) => {
          capturedInput = input;
          return { status: "resolved", conflicts: [] };
        }),
      });
      const actor = createActor(machine, {
        input: {
          ...defaultInput,
          resolutionContext: "The session renamed SessionStore to SessionRepo.",
        },
      });
      actor.start();

      await toPromise(actor);

      expect(capturedInput).not.toBeNull();
      expect(capturedInput!.resolutionContext).toBe(
        "The session renamed SessionStore to SessionRepo.",
      );
      expect(capturedInput!.targetBranch).toBe("main");
    });

    it("passes resolutionContext to the analyzeConflicts actor when autoResolve is off", async () => {
      let capturedInput: AnalyzeConflictsInput | null = null;

      const machine = createTestMachine({
        mergeMain: mockMergeMain(async () => ({
          status: "conflicts",
          conflictFiles: ["src/index.ts"],
        })),
        analyzeConflicts: mockAnalyzeConflicts(async (input) => {
          capturedInput = input;
          return { status: "analyzed", conflicts: [] };
        }),
      });
      const actor = createActor(machine, {
        input: {
          ...defaultInput,
          autoResolve: false,
          resolutionContext: "The session migrated config reads to Zod v4.",
        },
      });
      actor.start();

      await toPromise(actor);

      expect(capturedInput).not.toBeNull();
      expect(capturedInput!.resolutionContext).toBe(
        "The session migrated config reads to Zod v4.",
      );
      expect(capturedInput!.targetBranch).toBe("main");
    });

    it("passes the covered-lane resolutionContext to the validation-fix actor", async () => {
      let capturedInput: FixValidationInput | null = null;
      let validationRuns = 0;
      const machine = createTestMachine({
        runValidation: mockRunValidation(async () => {
          validationRuns += 1;
          if (validationRuns === 1) {
            throw validationFailure("typecheck failed");
          }
          return null;
        }),
        fixValidation: mockFixValidation(async (input) => {
          capturedInput = input;
          return { status: "fixed" };
        }),
      });
      const actor = createActor(machine, {
        input: {
          ...defaultInput,
          resolutionContext:
            "Covered lanes: lane-b planned the contract; lane-c implemented it.",
        },
      });
      actor.start();

      await toPromise(actor);

      expect(capturedInput).not.toBeNull();
      expect(capturedInput!.resolutionContext).toContain(
        "lane-b planned the contract",
      );
      expect(capturedInput!.resolutionContext).toContain(
        "lane-c implemented it",
      );
    });

    it("passes conversationId and the detected conflictFiles to the resolveConflicts actor", async () => {
      let capturedInput: ResolveConflictsInput | null = null;

      const machine = createTestMachine({
        mergeMain: mockMergeMain(async () => ({
          status: "conflicts",
          conflictFiles: ["src/index.ts", "package.json"],
        })),
        resolveConflicts: mockResolveConflicts(async (input) => {
          capturedInput = input;
          return { status: "resolved", conflicts: [] };
        }),
      });
      const actor = createActor(machine, {
        input: {
          ...defaultInput,
          conversationId: "conv-lane-implementer",
        },
      });
      actor.start();

      await toPromise(actor);

      expect(capturedInput).not.toBeNull();
      expect(capturedInput!.conversationId).toBe("conv-lane-implementer");
      expect(capturedInput!.conflictFiles).toEqual([
        "src/index.ts",
        "package.json",
      ]);
    });

    it("passes conversationId to the analyzeConflicts actor when autoResolve is off", async () => {
      let capturedInput: AnalyzeConflictsInput | null = null;

      const machine = createTestMachine({
        mergeMain: mockMergeMain(async () => ({
          status: "conflicts",
          conflictFiles: ["src/index.ts"],
        })),
        analyzeConflicts: mockAnalyzeConflicts(async (input) => {
          capturedInput = input;
          return { status: "analyzed", conflicts: [] };
        }),
      });
      const actor = createActor(machine, {
        input: {
          ...defaultInput,
          autoResolve: false,
          conversationId: "conv-lane-implementer",
        },
      });
      actor.start();

      await toPromise(actor);

      expect(capturedInput).not.toBeNull();
      expect(capturedInput!.conversationId).toBe("conv-lane-implementer");
    });

    it("passes conversationId to the fixValidation actor", async () => {
      let capturedInput: FixValidationInput | null = null;
      let validationRuns = 0;

      const machine = createTestMachine({
        runValidation: mockRunValidation(async () => {
          validationRuns += 1;
          if (validationRuns === 1) {
            throw validationFailure("validation failed: lint error");
          }
          return null;
        }),
        fixValidation: mockFixValidation(async (input) => {
          capturedInput = input;
          return { status: "fixed" };
        }),
      });
      const actor = createActor(machine, {
        input: {
          ...defaultInput,
          conversationId: "conv-lane-implementer",
        },
      });
      actor.start();

      await toPromise(actor);

      expect(capturedInput).not.toBeNull();
      expect(capturedInput!.conversationId).toBe("conv-lane-implementer");
    });

    it("defaults resolutionContext to null in context when omitted", () => {
      const machine = createTestMachine();
      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      expect(actor.getSnapshot().context.resolutionContext).toBeNull();
    });
  });

  describe("fixValidation receives project context", () => {
    it("passes projectPath, sessionName, and branchName to fixValidation actor", async () => {
      let capturedInput: FixValidationInput | null = null;

      const machine = createTestMachine({
        runValidation: mockRunValidation(async () => {
          throw validationFailure("lint errors");
        }),
        fixValidation: mockFixValidation(async (input) => {
          capturedInput = input;
          return { status: "fixed" };
        }),
      });
      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      await toPromise(actor);

      expect(capturedInput).not.toBeNull();
      expect(capturedInput!.projectPath).toBe("/projects/app");
      expect(capturedInput!.sessionName).toBe("test-session");
      expect(capturedInput!.branchName).toBe("csm/test-session");
    });
  });

  describe("branch verification", () => {
    it("halts in failed state when worktree is on a different branch", async () => {
      const machine = createTestMachine({
        getCurrentBranch: mockGetCurrentBranch(async () => ({
          branch: "main",
        })),
      });
      const actor = createActor(machine, { input: defaultInput });
      const states: string[] = [];
      actor.subscribe((s) => states.push(String(s.value)));
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("failed");
      expect(output.error).toMatch(/csm\/test-session/);
      expect(output.error).toMatch(/main/);
      expect(states).toContain("verifyingBranch");
      expect(states).not.toContain("committingUncommitted");
      expect(states).not.toContain("mergingMain");
      expect(states).not.toContain("preparing");
      expect(states).not.toContain("publishing");
    });

    it("halts in failed state when worktree HEAD is detached", async () => {
      const machine = createTestMachine({
        getCurrentBranch: mockGetCurrentBranch(async () => ({
          branch: null,
        })),
      });
      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("failed");
      expect(output.error).toMatch(/detached/i);
    });

    it("propagates getCurrentBranch errors as failed state", async () => {
      const machine = createTestMachine({
        getCurrentBranch: mockGetCurrentBranch(async () => {
          throw new Error("git command failed");
        }),
      });
      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("failed");
      expect(output.error).toBe("git command failed");
    });

    it("invokes getCurrentBranch with the feature worktreePath", async () => {
      let capturedInput: GetCurrentBranchInput | null = null;
      const machine = createTestMachine({
        getCurrentBranch: mockGetCurrentBranch(async (input) => {
          capturedInput = input;
          return { branch: defaultInput.branchName };
        }),
      });
      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      await toPromise(actor);

      expect(capturedInput).not.toBeNull();
      expect(capturedInput!.worktreePath).toBe(defaultInput.worktreePath);
    });

    it("verifies branch even for resolve-conflicts jobs", async () => {
      const machine = createTestMachine({
        getCurrentBranch: mockGetCurrentBranch(async () => ({
          branch: "main",
        })),
      });
      const actor = createActor(machine, {
        input: { ...defaultInput, jobType: "resolve-conflicts" },
      });
      const states: string[] = [];
      actor.subscribe((s) => states.push(String(s.value)));
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("failed");
      expect(states).toContain("verifyingBranch");
      expect(states).not.toContain("resolvingConflicts");
    });
  });

  describe("phase tracking", () => {
    it("updates phase through merge lifecycle", async () => {
      const phases: (string | null)[] = [];
      const machine = createTestMachine();
      const actor = createActor(machine, { input: defaultInput });

      actor.subscribe((s) => phases.push(s.context.phase));
      actor.start();

      await toPromise(actor);

      expect(phases).toContain("committing-uncommitted");
      expect(phases).toContain("merging-main");
      expect(phases).toContain("validating");
      expect(phases).toContain("preparing");
      expect(phases).toContain("publishing");
    });

    it("transitions through verifyingBranch on happy path", async () => {
      const states: string[] = [];
      const machine = createTestMachine();
      const actor = createActor(machine, { input: defaultInput });

      actor.subscribe((s) => states.push(String(s.value)));
      actor.start();

      await toPromise(actor);

      expect(states).toContain("verifyingBranch");
      expect(states).toContain("preparing");
      expect(states).toContain("publishing");
    });

    it("includes analyzing-conflicts phase when autoResolve is false", async () => {
      const phases: (string | null)[] = [];
      const machine = createTestMachine({
        mergeMain: mockMergeMain(async () => ({
          status: "conflicts",
          conflictFiles: ["a.ts"],
        })),
        analyzeConflicts: mockAnalyzeConflicts(async () => ({
          status: "analyzed",
          conflicts: [
            {
              file: "a.ts",
              description: "Conflict",
              resolution: "Fix",
              rationale: "Reason",
            },
          ],
        })),
      });
      const actor = createActor(machine, {
        input: { ...defaultInput, autoResolve: false },
      });

      actor.subscribe((s) => phases.push(s.context.phase));
      actor.start();

      await toPromise(actor);

      expect(phases).toContain("analyzing-conflicts");
    });
  });
});
