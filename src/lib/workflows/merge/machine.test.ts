import { describe, it, expect, vi } from "vitest";
import { createActor, fromPromise, toPromise } from "xstate";
import { mergeMachine } from "./machine";
import type { MergeInput } from "./types";
import type {
  CheckUncommittedInput,
  CheckUncommittedOutput,
  CommitChangesInput,
  CommitChangesOutput,
  MergeMainInput,
  MergeMainOutput,
  ResolveConflictsInput,
  ResolveConflictsOutput,
  AnalyzeConflictsInput,
  AnalyzeConflictsOutput,
  RunValidationInput,
  RunValidationOutput,
  FixValidationInput,
  FixValidationOutput,
  SquashMergeInput,
  SquashMergeOutput,
} from "./actors";

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

function mockSquashMerge(
  fn: (input: SquashMergeInput) => Promise<SquashMergeOutput>,
) {
  return fromPromise<SquashMergeOutput, SquashMergeInput>(async ({ input }) =>
    fn(input),
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
};

type ActorOverrides = {
  checkUncommitted?: ReturnType<typeof mockCheckUncommitted>;
  commitChanges?: ReturnType<typeof mockCommitChanges>;
  mergeMain?: ReturnType<typeof mockMergeMain>;
  resolveConflicts?: ReturnType<typeof mockResolveConflicts>;
  analyzeConflicts?: ReturnType<typeof mockAnalyzeConflicts>;
  runValidation?: ReturnType<typeof mockRunValidation>;
  fixValidation?: ReturnType<typeof mockFixValidation>;
  squashMerge?: ReturnType<typeof mockSquashMerge>;
  onTerminal?: () => void;
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
        overrides.runValidation ?? mockRunValidation(async () => undefined),
      fixValidation:
        overrides.fixValidation ??
        mockFixValidation(async () => ({ status: "fixed" })),
      squashMerge:
        overrides.squashMerge ??
        mockSquashMerge(async () => ({ mergeHash: "merge-abc" })),
    },
    actions: {
      onTerminal: overrides.onTerminal ?? vi.fn(),
    },
  });
}

// ============================================================
// Tests
// ============================================================

describe("mergeMachine", () => {
  describe("happy path without conflicts", () => {
    it("transitions: checkingUncommitted → mergingMain → validating → squashMerging → completed", async () => {
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
      expect(states).toContain("squashMerging");
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
            throw new Error("typecheck failed: TS2345");
          }
          // Second call succeeds
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
          throw new Error("Tests failed");
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

  describe("fix validation failure propagates to failed", () => {
    it("fails when fix returns failed status", async () => {
      const machine = createTestMachine({
        runValidation: mockRunValidation(async () => {
          throw new Error("TS2345: type error");
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
          throw new Error(`Validation error #${validationCallCount}`);
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
            throw new Error(`Validation error #${validationCallCount}`);
          }
          // Third call (second revalidation) succeeds
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
          throw new Error("persistent error");
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

    it("passes sessionRef from first attempt to retry", async () => {
      let validationCallCount = 0;
      const fixInputs: FixValidationInput[] = [];

      const machine = createTestMachine({
        runValidation: mockRunValidation(async () => {
          validationCallCount++;
          if (validationCallCount <= 2) {
            throw new Error(`error ${validationCallCount}`);
          }
        }),
        fixValidation: mockFixValidation(async (input) => {
          fixInputs.push({ ...input });
          return {
            status: "fixed",
            sessionRef: { backend: "claude", sessionId: "sdk-session-42" },
          };
        }),
      });
      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      await toPromise(actor);

      expect(fixInputs).toHaveLength(2);
      expect(fixInputs[0]!.sessionRef).toBeUndefined();
      expect(fixInputs[1]!.sessionRef).toEqual({
        backend: "claude",
        sessionId: "sdk-session-42",
      });
    });

    it("respects custom maxFixAttempts", async () => {
      let fixCallCount = 0;

      const machine = createTestMachine({
        runValidation: mockRunValidation(async () => {
          throw new Error("error");
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
            throw new Error("lint errors");
          }
          // Second call (revalidation) succeeds
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
      expect(states).toContain("squashMerging");
    });
  });

  describe("squash merge failure", () => {
    it("goes to failed when squash merge throws", async () => {
      const machine = createTestMachine({
        squashMerge: mockSquashMerge(async () => {
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

  describe("onTerminal action", () => {
    it("calls onTerminal on completed", async () => {
      const onTerminal = vi.fn();
      const machine = createTestMachine({ onTerminal });
      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      await toPromise(actor);

      expect(onTerminal).toHaveBeenCalled();
    });

    it("calls onTerminal on failed", async () => {
      const onTerminal = vi.fn();
      const machine = createTestMachine({
        onTerminal,
        mergeMain: mockMergeMain(async () => {
          throw new Error("git error");
        }),
      });
      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      await toPromise(actor);

      expect(onTerminal).toHaveBeenCalled();
    });

    it("calls onTerminal on conflicts", async () => {
      const onTerminal = vi.fn();
      const machine = createTestMachine({
        onTerminal,
        mergeMain: mockMergeMain(async () => ({
          status: "conflicts",
          conflictFiles: ["a.ts"],
        })),
      });
      const actor = createActor(machine, {
        input: { ...defaultInput, autoResolve: false },
      });
      actor.start();

      await toPromise(actor);

      expect(onTerminal).toHaveBeenCalled();
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
      expect(ctx.fixSessionRef).toBeNull();
    });
  });

  describe("fixValidation receives project context", () => {
    it("passes projectPath, sessionName, and branchName to fixValidation actor", async () => {
      let capturedInput: FixValidationInput | null = null;

      const machine = createTestMachine({
        runValidation: mockRunValidation(async () => {
          throw new Error("lint errors");
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

  describe("phase tracking", () => {
    it("updates phase through merge lifecycle", async () => {
      const phases: (string | null)[] = [];
      const machine = createTestMachine();
      const actor = createActor(machine, { input: defaultInput });

      actor.subscribe((s) => phases.push(s.context.phase));
      actor.start();

      await toPromise(actor);

      // Should see committing-uncommitted, merging-main, validating, squash-merging, null
      expect(phases).toContain("committing-uncommitted");
      expect(phases).toContain("merging-main");
      expect(phases).toContain("validating");
      expect(phases).toContain("squash-merging");
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
