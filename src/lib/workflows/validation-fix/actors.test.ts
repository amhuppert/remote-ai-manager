import { describe, expect, it, vi } from "vitest";
import { createActor } from "xstate";
import type { PerRepoConfig } from "@/lib/config/schemas";
import type {
  ValidationService,
  ValidationSubmission,
  ValidationSystemSubmitRequest,
} from "@/lib/validation/service";
import type { ValidationRunResult } from "@/lib/validation/schemas";
import { isTimeoutError } from "../utils";
import {
  createRunValidationActor,
  performMergeValidation,
  type MergeValidationDeps,
  type RunValidationInput,
} from "./actors";

const BASE_INPUT: RunValidationInput = {
  source: "smart_merge",
  selection: { mode: "project-pre-merge" },
  projectPath: "/projects/foo",
  worktreePath: "/projects/foo/.worktrees/my-session",
  sessionName: "my-session",
  branchName: "csm/my-session",
  targetBranch: "main",
  timeoutMs: 300_000,
};

const REGISTERED_CONFIG: PerRepoConfig = {
  validation: {
    commands: {
      typecheck: {
        command: { full: "./scripts/typecheck.sh" },
        cost: 2,
        pathArgs: "forbid",
      },
      test: {
        command: { full: "./scripts/test.sh" },
        cost: 3,
        pathArgs: "forbid",
      },
      lint: {
        command: { full: "./scripts/lint.sh" },
        cost: 1,
        pathArgs: "forbid",
      },
    },
    preMerge: ["typecheck", "test"],
  },
};

function accepted(
  runId: string,
  status: "queued" | "running" = "running",
): ValidationSubmission {
  return {
    kind: "accepted",
    runId,
    status,
    position: status === "queued" ? 0 : null,
    lease: null,
    requestedScope: "changed",
    effectiveScope: "full",
  };
}

function passed(runId: string): ValidationRunResult {
  return { kind: "passed", runId, exitCode: 0, output: "" };
}

interface DepsHarness {
  deps: MergeValidationDeps;
  submissions: ValidationSystemSubmitRequest[];
  waitedRunIds: string[];
  cancelledRunIds: string[];
  commitCalls: Array<{
    worktreePath: string;
    message: string;
    opts: { skipHooks?: boolean };
  }>;
  uncommittedChecks: string[];
}

function createDepsHarness(
  overrides: {
    repoConfig?: PerRepoConfig | null;
    repoConfigError?: Error;
    submissions?: ValidationSubmission[];
    results?: ValidationRunResult[];
    waitForCompletion?: (runId: string) => Promise<ValidationRunResult>;
    cancelSystemOwned?: (runId: string) => Promise<boolean>;
    hasChanges?: boolean;
  } = {},
): DepsHarness {
  const submissionCalls: ValidationSystemSubmitRequest[] = [];
  const waitedRunIds: string[] = [];
  const cancelledRunIds: string[] = [];
  const commitCalls: DepsHarness["commitCalls"] = [];
  const uncommittedChecks: string[] = [];
  let submissionIndex = 0;
  let resultIndex = 0;
  const validationService: Pick<
    ValidationService,
    "submitSystem" | "waitForCompletion" | "cancelSystemOwned"
  > = {
    async submitSystem(request) {
      submissionCalls.push(request);
      const index = submissionIndex++;
      return overrides.submissions?.[index] ?? accepted(`run-${index + 1}`);
    },
    async waitForCompletion(runId) {
      waitedRunIds.push(runId);
      if (overrides.waitForCompletion) {
        return overrides.waitForCompletion(runId);
      }
      return overrides.results?.[resultIndex++] ?? passed(runId);
    },
    async cancelSystemOwned(runId) {
      cancelledRunIds.push(runId);
      return overrides.cancelSystemOwned?.(runId) ?? true;
    },
  };
  const deps: MergeValidationDeps = {
    async readRepoConfig() {
      if (overrides.repoConfigError) throw overrides.repoConfigError;
      return overrides.repoConfig === undefined
        ? REGISTERED_CONFIG
        : overrides.repoConfig;
    },
    validationService,
    async hasUncommittedChanges(worktreePath) {
      uncommittedChecks.push(worktreePath);
      return overrides.hasChanges ?? false;
    },
    async commitChanges(worktreePath, message, opts) {
      commitCalls.push({ worktreePath, message, opts: opts ?? {} });
      return { hash: "autofix123" };
    },
    async resolveGitObject(_worktreePath, ref) {
      return ref === "HEAD" ? "validated-sha" : "validated-tree";
    },
    createValidationRef() {
      return "validation-ref-1";
    },
  };
  return {
    deps,
    submissions: submissionCalls,
    waitedRunIds,
    cancelledRunIds,
    commitCalls,
    uncommittedChecks,
  };
}

describe("performMergeValidation", () => {
  it("runs the registered preMerge selection sequentially through the service", async () => {
    const harness = createDepsHarness();

    const fact = await performMergeValidation(BASE_INPUT, harness.deps);

    expect(harness.submissions).toEqual([
      {
        source: "smart_merge",
        command: { kind: "registered", name: "typecheck" },
        scope: "changed",
        projectPath: BASE_INPUT.projectPath,
        target: {
          worktreePath: BASE_INPUT.worktreePath,
          sessionName: BASE_INPUT.sessionName,
          branchName: BASE_INPUT.branchName,
          targetBranch: BASE_INPUT.targetBranch,
        },
      },
      {
        source: "smart_merge",
        command: { kind: "registered", name: "test" },
        scope: "changed",
        projectPath: BASE_INPUT.projectPath,
        target: {
          worktreePath: BASE_INPUT.worktreePath,
          sessionName: BASE_INPUT.sessionName,
          branchName: BASE_INPUT.branchName,
          targetBranch: BASE_INPUT.targetBranch,
        },
      },
    ]);
    expect(harness.waitedRunIds).toEqual(["run-1", "run-2"]);
    expect(fact).toEqual({
      validationRef: "validation-ref-1",
      validatedSha: "validated-sha",
      validatedTreeHash: "validated-tree",
      commandIdentity: "typecheck+test",
      outcome: "pass",
    });
  });

  it("uses the smart_commit source supplied by the commit machine", async () => {
    const harness = createDepsHarness({
      repoConfig: {
        ...REGISTERED_CONFIG,
        validation: {
          ...REGISTERED_CONFIG.validation!,
          preMerge: ["typecheck"],
        },
      },
    });

    await performMergeValidation(
      { ...BASE_INPUT, source: "smart_commit" },
      harness.deps,
    );

    expect(harness.submissions[0]?.source).toBe("smart_commit");
  });

  it("submits an explicit graph lane selection as system-owned wait work", async () => {
    const harness = createDepsHarness();

    await performMergeValidation(
      {
        ...BASE_INPUT,
        source: "graph_lane_merge",
        selection: { mode: "only", commands: ["typecheck"] },
        conversationId: "conv-lane",
        workflow: { executionId: "exec-1", contextId: "context-verify" },
      },
      harness.deps,
    );

    expect(harness.submissions).toEqual([
      {
        source: "graph_lane_merge",
        command: { kind: "registered", name: "typecheck" },
        scope: "changed",
        projectPath: BASE_INPUT.projectPath,
        conversationId: "conv-lane",
        workflow: { executionId: "exec-1", contextId: "context-verify" },
        target: {
          worktreePath: BASE_INPUT.worktreePath,
          sessionName: BASE_INPUT.sessionName,
          branchName: BASE_INPUT.branchName,
          targetBranch: BASE_INPUT.targetBranch,
          contextId: "context-verify",
        },
      },
    ]);
    expect(harness.waitedRunIds).toEqual(["run-1"]);
  });

  it("stops at the first failure and sends its output to the fix loop", async () => {
    const harness = createDepsHarness({
      results: [
        passed("run-1"),
        {
          kind: "failed",
          runId: "run-2",
          exitCode: 1,
          output: "2 tests failed",
        },
      ],
    });

    await expect(
      performMergeValidation(BASE_INPUT, harness.deps),
    ).rejects.toMatchObject({
      message: 'Validation command "test" failed',
      gitOutput: "2 tests failed",
      timedOut: false,
    });
    expect(harness.submissions.map((call) => call.command.name)).toEqual([
      "typecheck",
      "test",
    ]);
    expect(harness.commitCalls).toHaveLength(0);
  });

  it("classifies a service spawn failure as non-remediable infrastructure", async () => {
    const harness = createDepsHarness({
      results: [
        {
          kind: "failed",
          runId: "run-1",
          exitCode: null,
          output: "spawn ./scripts/typecheck.sh ENOENT",
        },
      ],
    });

    await expect(
      performMergeValidation(BASE_INPUT, harness.deps),
    ).rejects.toMatchObject({
      message:
        'Validation command "typecheck" could not be spawned: spawn ./scripts/typecheck.sh ENOENT',
      validationFailureClass: "infrastructure",
    });
    expect(harness.submissions.map((call) => call.command.name)).toEqual([
      "typecheck",
    ]);
    expect(harness.commitCalls).toHaveLength(0);
  });

  it("preserves timeout-ness so the fragment short-circuits the fix loop", async () => {
    const harness = createDepsHarness({
      repoConfig: {
        ...REGISTERED_CONFIG,
        validation: {
          ...REGISTERED_CONFIG.validation!,
          preMerge: ["test"],
        },
      },
      results: [
        {
          kind: "timed_out",
          runId: "run-1",
          timeoutMs: 120_000,
          output: "tests starting...",
        },
      ],
    });

    try {
      await performMergeValidation(BASE_INPUT, harness.deps);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toMatchObject({
        message: 'Validation command "test" timed out after 120000ms',
        gitOutput: "tests starting...",
      });
      expect(isTimeoutError(error)).toBe(true);
    }
  });

  it("treats an explicitly empty preMerge selection as disabled", async () => {
    const harness = createDepsHarness({
      repoConfig: {
        validation: { commands: {}, preMerge: [] },
      },
    });

    const fact = await performMergeValidation(BASE_INPUT, harness.deps);

    expect(fact).toBeNull();
    expect(harness.submissions).toHaveLength(0);
    expect(harness.commitCalls).toHaveLength(0);
  });

  it("does not submit or commit when validation is not configured", async () => {
    const harness = createDepsHarness({ repoConfig: null });

    const fact = await performMergeValidation(BASE_INPUT, harness.deps);

    expect(fact).toBeNull();
    expect(harness.submissions).toHaveLength(0);
    expect(harness.commitCalls).toHaveLength(0);
  });

  it("fails closed when the repository validation config cannot be read", async () => {
    const harness = createDepsHarness({
      repoConfigError: new Error("malformed CommandCenter.json"),
    });

    await expect(
      performMergeValidation(BASE_INPUT, harness.deps),
    ).rejects.toMatchObject({
      message: expect.stringContaining("malformed CommandCenter.json"),
      validationFailureClass: "infrastructure",
    });
    expect(harness.submissions).toHaveLength(0);
  });

  it("keeps queued capacity waits inside the validation actor", async () => {
    let release!: (result: ValidationRunResult) => void;
    let markWaitStarted!: () => void;
    const completion = new Promise<ValidationRunResult>((resolve) => {
      release = resolve;
    });
    const waitStarted = new Promise<void>((resolve) => {
      markWaitStarted = resolve;
    });
    const harness = createDepsHarness({
      repoConfig: {
        ...REGISTERED_CONFIG,
        validation: {
          ...REGISTERED_CONFIG.validation!,
          preMerge: ["typecheck"],
        },
      },
      submissions: [accepted("queued-run", "queued")],
      waitForCompletion: async () => {
        markWaitStarted();
        return completion;
      },
    });

    const pending = performMergeValidation(BASE_INPUT, harness.deps);
    await waitStarted;

    expect(harness.waitedRunIds).toEqual(["queued-run"]);
    expect(harness.uncommittedChecks).toHaveLength(0);

    release(passed("queued-run"));
    await expect(pending).resolves.toMatchObject({ outcome: "pass" });
    expect(harness.uncommittedChecks).toEqual([BASE_INPUT.worktreePath]);
  });

  it("cancels an accepted run on actor abort and waits for cancellation to finish", async () => {
    let resolveCompletion!: (result: ValidationRunResult) => void;
    const completion = new Promise<ValidationRunResult>((resolve) => {
      resolveCompletion = resolve;
    });
    let finishCancellation!: () => void;
    const cancellationFinished = new Promise<void>((resolve) => {
      finishCancellation = resolve;
    });
    const harness = createDepsHarness({
      repoConfig: {
        ...REGISTERED_CONFIG,
        validation: {
          ...REGISTERED_CONFIG.validation!,
          preMerge: ["typecheck"],
        },
      },
      waitForCompletion: async () => completion,
      cancelSystemOwned: async () => {
        await cancellationFinished;
        return true;
      },
    });
    const controller = new AbortController();
    let settled = false;
    const validation = performMergeValidation(
      BASE_INPUT,
      harness.deps,
      controller.signal,
    ).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(harness.waitedRunIds).toEqual(["run-1"]));

    controller.abort();
    resolveCompletion({ kind: "cancelled", runId: "run-1" });
    await vi.waitFor(() => expect(harness.cancelledRunIds).toEqual(["run-1"]));
    expect(settled).toBe(false);
    finishCancellation();

    await expect(validation).rejects.toMatchObject({
      validationFailureClass: "infrastructure",
      message: 'Validation command "typecheck" was cancelled',
    });
  });

  it("forwards the XState actor abort signal into system-run cancellation", async () => {
    let resolveCompletion!: (result: ValidationRunResult) => void;
    const completion = new Promise<ValidationRunResult>((resolve) => {
      resolveCompletion = resolve;
    });
    let finishCancellation!: () => void;
    const cancellationFinished = new Promise<void>((resolve) => {
      finishCancellation = resolve;
    });
    let cancellationSettled = false;
    const harness = createDepsHarness({
      repoConfig: {
        ...REGISTERED_CONFIG,
        validation: {
          ...REGISTERED_CONFIG.validation!,
          preMerge: ["typecheck"],
        },
      },
      waitForCompletion: async () => completion,
      cancelSystemOwned: async () => {
        await cancellationFinished;
        resolveCompletion({ kind: "cancelled", runId: "run-1" });
        cancellationSettled = true;
        return true;
      },
    });
    const actor = createActor(
      createRunValidationActor(async () => harness.deps),
      { input: BASE_INPUT },
    );
    actor.start();
    await vi.waitFor(() => expect(harness.waitedRunIds).toEqual(["run-1"]));

    actor.stop();
    await vi.waitFor(() => expect(harness.cancelledRunIds).toEqual(["run-1"]));
    expect(cancellationSettled).toBe(false);
    finishCancellation();
    await vi.waitFor(() => expect(cancellationSettled).toBe(true));
  });

  it("auto-commits formatter changes only after every command passes", async () => {
    const harness = createDepsHarness({ hasChanges: true });

    await performMergeValidation(BASE_INPUT, harness.deps);

    expect(harness.waitedRunIds).toEqual(["run-1", "run-2"]);
    expect(harness.commitCalls).toEqual([
      {
        worktreePath: BASE_INPUT.worktreePath,
        message: "auto-fix: pre-merge validation",
        opts: { skipHooks: true },
      },
    ]);
  });

  it("fails configuration errors without spawning a validation-fix command", async () => {
    const harness = createDepsHarness({
      submissions: [
        {
          kind: "not_started",
          result: {
            kind: "command_not_found",
            name: "typecheck",
            knownCommands: ["test"],
          },
        },
      ],
    });

    await expect(
      performMergeValidation(BASE_INPUT, harness.deps),
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        'Validation command "typecheck" is not registered',
      ),
      validationFailureClass: "infrastructure",
    });
    expect(harness.waitedRunIds).toHaveLength(0);
  });
});
