import { describe, it, expect } from "vitest";
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
  validationMode: {
    mode: "run",
    source: "smart_commit",
    selection: { mode: "project-pre-merge" },
  },
};

type ActorOverrides = {
  checkUncommitted?: ReturnType<typeof mockCheckUncommitted>;
  commitChanges?: ReturnType<typeof mockCommitChanges>;
  runValidation?: ReturnType<typeof mockRunValidation>;
  fixValidation?: ReturnType<typeof mockFixValidation>;
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
        overrides.runValidation ?? mockRunValidation(async () => null),
      fixValidation:
        overrides.fixValidation ??
        mockFixValidation(async () => ({ status: "fixed" })),
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
    it("fails without dispatching the fix actor for an infrastructure outcome", async () => {
      let fixCallCount = 0;
      const states: string[] = [];
      const machine = createTestMachine({
        runValidation: mockRunValidation(async () => {
          throw nonRemediableValidationError("validation service unavailable");
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
      expect(output.error).toBe("validation service unavailable");
      expect(fixCallCount).toBe(0);
      expect(states).not.toContain("fixingValidation");
    });

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
            throw validationFailure("typecheck failed: TS2345");
          }
          return null;
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
          throw validationFailure("lint errors");
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
          throw validationFailure("lint errors");
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

    it("max retries exceeded → failed", async () => {
      let fixCallCount = 0;

      const machine = createTestMachine({
        runValidation: mockRunValidation(async () => {
          throw validationFailure("persistent error");
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
            throw validationFailure("lint errors");
          }
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
      expect(states).toContain("checkingFixChanges");
      expect(states).not.toContain("committingFix");
      expect(states).toContain("revalidating");
    });
  });

  describe("isRetry flag propagation", () => {
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
  });

  describe("custom maxFixAttempts", () => {
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
            throw validationFailure("errors");
          }
          return null;
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
      expect(ctx.validationTimeoutMs).toBe(300_000);
      expect(ctx.finalStatus).toBeNull();
    });

    it("defaults targetBranch to main when input omits it", () => {
      const machine = createTestMachine();
      const actor = createActor(machine, { input: defaultInput });
      actor.start();

      expect(actor.getSnapshot().context.targetBranch).toBe("main");
    });

    it("uses a non-main targetBranch from input", () => {
      const machine = createTestMachine();
      const actor = createActor(machine, {
        input: { ...defaultInput, targetBranch: "csm/parent" },
      });
      actor.start();

      expect(actor.getSnapshot().context.targetBranch).toBe("csm/parent");
    });
  });

  describe("validation input", () => {
    it("forwards targetBranch to the validation actor", async () => {
      let received: RunValidationInput | undefined;
      const machine = createTestMachine({
        runValidation: mockRunValidation(async (input) => {
          received = input;
          return null;
        }),
      });
      const actor = createActor(machine, {
        input: { ...defaultInput, targetBranch: "csm/parent" },
      });
      actor.start();

      await toPromise(actor);

      expect(received?.targetBranch).toBe("csm/parent");
      expect(received?.source).toBe("smart_commit");
    });
  });

  describe("commitHash preservation", () => {
    it("commitHash available in output even when validation fails", async () => {
      const machine = createTestMachine({
        commitChanges: mockCommitChanges(async () => ({
          hash: "user-commit-abc",
        })),
        runValidation: mockRunValidation(async () => {
          throw validationFailure("validation failed");
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
