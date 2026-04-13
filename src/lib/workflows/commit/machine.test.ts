import { describe, it, expect, vi } from "vitest";
import { createActor, fromPromise, toPromise } from "xstate";
import { commitMachine } from "./machine";
import type { CommitInput } from "./types";
import type {
  CheckUncommittedInput,
  CheckUncommittedOutput,
  CommitChangesInput,
  CommitChangesOutput,
  RunValidationInput,
  RunValidationOutput,
  FixValidationInput,
  FixValidationOutput,
} from "../merge/actors";

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

// ============================================================
// Default Test Machine
// ============================================================

const defaultInput: CommitInput = {
  jobId: "test-job-001",
  projectPath: "/projects/app",
  projectName: "app",
  sessionName: "test-session",
  worktreePath: "/projects/app/.worktrees/test-session",
  branchName: "csm/test-session",
  message: "feat: add feature",
};

type ActorOverrides = {
  checkUncommitted?: ReturnType<typeof mockCheckUncommitted>;
  commitChanges?: ReturnType<typeof mockCommitChanges>;
  runValidation?: ReturnType<typeof mockRunValidation>;
  fixValidation?: ReturnType<typeof mockFixValidation>;
  onTerminal?: () => void;
};

function createTestMachine(overrides: ActorOverrides = {}) {
  return commitMachine.provide({
    actors: {
      checkUncommitted:
        overrides.checkUncommitted ??
        mockCheckUncommitted(async () => ({ hasChanges: false })),
      commitChanges:
        overrides.commitChanges ??
        mockCommitChanges(async () => ({ hash: "abc123" })),
      runValidation:
        overrides.runValidation ?? mockRunValidation(async () => undefined),
      fixValidation:
        overrides.fixValidation ??
        mockFixValidation(async () => ({ status: "fixed" })),
    },
    actions: {
      onTerminal: overrides.onTerminal ?? vi.fn(),
    },
  });
}

// ============================================================
// Tests
// ============================================================

describe("commitMachine", () => {
  describe("happy path", () => {
    it("commit + validation passes → completed", async () => {
      const states: string[] = [];
      const machine = createTestMachine();
      const actor = createActor(machine, { input: defaultInput });

      actor.subscribe((s) => states.push(String(s.value)));
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("completed");
      expect(output.commitHash).toBe("abc123");
      expect(output.error).toBeNull();
      expect(states).toContain("committing");
      expect(states).toContain("validating");
      expect(states).toContain("completed");
    });

    it("initial commit skips hooks so pre-commit linters do not block", async () => {
      const commitInputs: CommitChangesInput[] = [];
      const machine = createTestMachine({
        commitChanges: mockCommitChanges(async (input) => {
          commitInputs.push(input);
          return { hash: "abc123" };
        }),
      });
      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      await toPromise(actor);

      expect(commitInputs).toHaveLength(1);
      expect(commitInputs[0]!.skipHooks).toBe(true);
    });
  });

  describe("commit failure", () => {
    it("commit fails → failed", async () => {
      const machine = createTestMachine({
        commitChanges: mockCommitChanges(async () => {
          throw new Error("git commit failed: nothing to commit");
        }),
      });
      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("failed");
      expect(output.error).toBe("git commit failed: nothing to commit");
      expect(output.commitHash).toBeNull();
    });
  });

  describe("validation failure with auto-fix", () => {
    it("validation fails → fix → re-validate → completed", async () => {
      let validationCallCount = 0;
      const states: string[] = [];

      const machine = createTestMachine({
        checkUncommitted: mockCheckUncommitted(async () => ({
          hasChanges: true,
        })),
        runValidation: mockRunValidation(async () => {
          validationCallCount++;
          if (validationCallCount === 1) {
            throw new Error("typecheck failed: TS2345");
          }
        }),
        fixValidation: mockFixValidation(async () => ({
          status: "fixed",
          sessionRef: { backend: "claude", sessionId: "sdk-session-1" },
        })),
      });
      const actor = createActor(machine, { input: defaultInput });

      actor.subscribe((s) => states.push(String(s.value)));
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("completed");
      expect(output.commitHash).toBe("abc123");
      expect(states).toContain("fixingValidation");
      expect(states).toContain("checkingFixChanges");
      expect(states).toContain("committingFix");
      expect(states).toContain("revalidating");
    });

    it("fix fails (returns status: failed) → failed", async () => {
      const machine = createTestMachine({
        runValidation: mockRunValidation(async () => {
          throw new Error("lint errors");
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

    it("fix throws error → failed", async () => {
      const machine = createTestMachine({
        runValidation: mockRunValidation(async () => {
          throw new Error("lint errors");
        }),
        fixValidation: mockFixValidation(async () => {
          throw new Error("SDK unavailable");
        }),
      });
      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("failed");
      expect(output.error).toBe("SDK unavailable");
    });
  });

  describe("revalidation retry loop", () => {
    it("revalidation fails → retry → completed (multiple fix rounds)", async () => {
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

    it("max retries exceeded → failed", async () => {
      let fixCallCount = 0;

      const machine = createTestMachine({
        runValidation: mockRunValidation(async () => {
          throw new Error("persistent error");
        }),
        fixValidation: mockFixValidation(async () => {
          fixCallCount++;
          return { status: "fixed" };
        }),
      });
      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      const output = await toPromise(actor);

      expect(output.status).toBe("failed");
      expect(fixCallCount).toBe(2); // Default maxFixAttempts is 2
    });
  });

  describe("committingFix with no changes", () => {
    it("skips committingFix when fix agent makes no changes", async () => {
      let validationCallCount = 0;
      const states: string[] = [];

      const machine = createTestMachine({
        checkUncommitted: mockCheckUncommitted(async () => ({
          hasChanges: false,
        })),
        runValidation: mockRunValidation(async () => {
          validationCallCount++;
          if (validationCallCount === 1) {
            throw new Error("lint errors");
          }
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
      expect(states).toContain("checkingFixChanges");
      expect(states).not.toContain("committingFix");
      expect(states).toContain("revalidating");
    });
  });

  describe("sessionRef propagation", () => {
    it("sessionRef passed from first attempt to retry", async () => {
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
  });

  describe("custom maxFixAttempts", () => {
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

  describe("phase tracking", () => {
    it("tracks phases through commit lifecycle", async () => {
      const phases: (string | null)[] = [];
      const machine = createTestMachine();
      const actor = createActor(machine, { input: defaultInput });

      actor.subscribe((s) => phases.push(s.context.phase));
      actor.start();

      await toPromise(actor);

      expect(phases).toContain("committing");
      expect(phases).toContain("validating");
      // Phase should be null at terminal state
      expect(phases[phases.length - 1]).toBeNull();
    });

    it("tracks phases through fix lifecycle", async () => {
      let validationCallCount = 0;
      const phases: (string | null)[] = [];

      const machine = createTestMachine({
        runValidation: mockRunValidation(async () => {
          validationCallCount++;
          if (validationCallCount === 1) {
            throw new Error("errors");
          }
        }),
        fixValidation: mockFixValidation(async () => ({
          status: "fixed",
        })),
      });
      const actor = createActor(machine, { input: defaultInput });

      actor.subscribe((s) => phases.push(s.context.phase));
      actor.start();

      await toPromise(actor);

      expect(phases).toContain("fixing-validation");
      expect(phases).toContain("re-validating");
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
      expect(ctx.message).toBe("feat: add feature");
      expect(ctx.worktreePath).toBe("/projects/app/.worktrees/test-session");
      expect(ctx._schemaVersion).toBe(1);
      expect(ctx.error).toBeNull();
      expect(ctx.commitHash).toBeNull();
      expect(ctx.fixAttempt).toBe(0);
      expect(ctx.maxFixAttempts).toBe(2);
      expect(ctx.fixSessionRef).toBeNull();
      expect(ctx.validationTimeoutMs).toBe(300_000);
      expect(ctx.finalStatus).toBeNull();
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
        commitChanges: mockCommitChanges(async () => {
          throw new Error("git error");
        }),
      });
      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      await toPromise(actor);

      expect(onTerminal).toHaveBeenCalled();
    });
  });

  describe("commitHash preservation", () => {
    it("commitHash available in output even when validation fails", async () => {
      const machine = createTestMachine({
        commitChanges: mockCommitChanges(async () => ({
          hash: "user-commit-abc",
        })),
        runValidation: mockRunValidation(async () => {
          throw new Error("validation failed");
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
      expect(output.commitHash).toBe("user-commit-abc");
    });
  });
});
