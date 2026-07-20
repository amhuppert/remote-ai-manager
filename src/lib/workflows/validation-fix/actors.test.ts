import { describe, expect, it } from "vitest";
import type { RepoValidationCommandResult } from "@/lib/projects/repo-config";
import { isTimeoutError } from "../utils";
import {
  mergeValidationGateFromResult,
  performMergeValidation,
  type MergeValidationDeps,
  type RunValidationInput,
} from "./actors";

function commandResult(
  overrides: Partial<RepoValidationCommandResult> = {},
): RepoValidationCommandResult {
  return {
    executed: true,
    pass: true,
    stdout: "",
    stderr: "",
    output: "",
    timedOut: false,
    message: null,
    ...overrides,
  };
}

const BASE_INPUT: RunValidationInput = {
  projectPath: "/projects/foo",
  worktreePath: "/projects/foo/.worktrees/my-session",
  sessionName: "my-session",
  branchName: "csm/my-session",
  targetBranch: "main",
  timeoutMs: 300_000,
};

interface DepsHarness {
  deps: MergeValidationDeps;
  validationCalls: Array<{
    projectPath: string;
    worktreePath: string;
    sessionName: string;
    branchName: string;
    targetBranch?: string;
    timeoutMs?: number;
  }>;
  commitCalls: Array<{
    worktreePath: string;
    message: string;
    opts: { skipHooks?: boolean };
  }>;
}

function createDepsHarness(overrides: {
  result?: RepoValidationCommandResult;
  repoConfig?: {
    preMergeTimeoutMs?: number;
    preMergeCommand?: string | null;
  } | null;
  repoConfigError?: Error;
  globalConfig?: { preMergeTimeoutMs?: number };
  globalConfigError?: Error;
  hasChanges?: boolean;
}): DepsHarness {
  const validationCalls: DepsHarness["validationCalls"] = [];
  const commitCalls: DepsHarness["commitCalls"] = [];
  const deps: MergeValidationDeps = {
    async readGlobalConfig() {
      if (overrides.globalConfigError) throw overrides.globalConfigError;
      return overrides.globalConfig ?? {};
    },
    async readRepoConfig() {
      if (overrides.repoConfigError) throw overrides.repoConfigError;
      return overrides.repoConfig ?? null;
    },
    async executeRepoValidationCommand(params) {
      validationCalls.push(params);
      return overrides.result ?? commandResult();
    },
    async hasUncommittedChanges() {
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
  return { deps, validationCalls, commitCalls };
}

describe("mergeValidationGateFromResult", () => {
  it("returns null when the project has no preMergeCommand configured", () => {
    const gate = mergeValidationGateFromResult(
      commandResult({ executed: false }),
    );
    expect(gate).toBeNull();
  });

  it("maps a passing run to a passing script_validation gate", () => {
    const gate = mergeValidationGateFromResult(commandResult());
    expect(gate?.status).toBe("pass");
    expect(gate?.kind).toBe("script_validation");
  });

  it("maps a failing run to a failing gate carrying the script message and timedOut", () => {
    const gate = mergeValidationGateFromResult(
      commandResult({
        pass: false,
        output: "lint errors found",
        message: "Pre-merge validation failed",
      }),
    );
    expect(gate?.status).toBe("fail");
    if (gate?.status !== "fail") return;
    expect(gate.reason).toBe("Pre-merge validation failed");
    expect(gate.details).toMatchObject({
      failureClass: "validation_failed",
      timedOut: false,
    });
  });

  it("falls back to a generic reason when the result carries no message", () => {
    const gate = mergeValidationGateFromResult(
      commandResult({ pass: false, message: null }),
    );
    expect(gate?.status).toBe("fail");
    if (gate?.status !== "fail") return;
    expect(gate.reason).toBe("Pre-merge validation failed");
  });
});

describe("performMergeValidation", () => {
  it("returns a candidate-validation fact for the committed tree that passed", async () => {
    const harness = createDepsHarness({
      repoConfig: { preMergeCommand: "./scripts/pre-merge.sh" },
    });

    const fact = await performMergeValidation(BASE_INPUT, harness.deps);

    expect(fact).toEqual({
      validationRef: "validation-ref-1",
      validatedSha: "validated-sha",
      validatedTreeHash: "validated-tree",
      commandIdentity: "./scripts/pre-merge.sh",
      outcome: "pass",
    });
  });

  it("resolves without committing when validation is not configured", async () => {
    const harness = createDepsHarness({
      result: commandResult({ executed: false }),
    });

    await performMergeValidation(BASE_INPUT, harness.deps);

    expect(harness.commitCalls).toHaveLength(0);
  });

  it("forwards the machine timeout and target branch to the validation command", async () => {
    const harness = createDepsHarness({});

    await performMergeValidation(BASE_INPUT, harness.deps);

    expect(harness.validationCalls).toEqual([
      {
        projectPath: BASE_INPUT.projectPath,
        worktreePath: BASE_INPUT.worktreePath,
        sessionName: BASE_INPUT.sessionName,
        branchName: BASE_INPUT.branchName,
        targetBranch: "main",
        timeoutMs: 300_000,
      },
    ]);
  });

  it("prefers the per-repo preMergeTimeoutMs over the machine default", async () => {
    const harness = createDepsHarness({
      repoConfig: { preMergeTimeoutMs: 42_000 },
    });

    await performMergeValidation(BASE_INPUT, harness.deps);

    expect(harness.validationCalls[0]?.timeoutMs).toBe(42_000);
  });

  it("uses the machine timeout when the repo config cannot be read", async () => {
    const harness = createDepsHarness({
      repoConfigError: new Error("unreadable"),
    });

    await performMergeValidation(BASE_INPUT, harness.deps);

    expect(harness.validationCalls[0]?.timeoutMs).toBe(300_000);
  });

  it("uses the global config timeout when no per-repo override exists", async () => {
    const harness = createDepsHarness({
      globalConfig: { preMergeTimeoutMs: 3_600_000 },
      repoConfig: null,
    });

    await performMergeValidation(BASE_INPUT, harness.deps);

    expect(harness.validationCalls[0]?.timeoutMs).toBe(3_600_000);
  });

  it("lets the per-repo timeout override the global config", async () => {
    const harness = createDepsHarness({
      globalConfig: { preMergeTimeoutMs: 3_600_000 },
      repoConfig: { preMergeTimeoutMs: 600_000 },
    });

    await performMergeValidation(BASE_INPUT, harness.deps);

    expect(harness.validationCalls[0]?.timeoutMs).toBe(600_000);
  });

  it("is best-effort: a failing global config read falls through to the per-repo timeout", async () => {
    const harness = createDepsHarness({
      globalConfigError: new Error("config unreadable"),
      repoConfig: { preMergeTimeoutMs: 900_000 },
    });

    await performMergeValidation(BASE_INPUT, harness.deps);

    expect(harness.validationCalls[0]?.timeoutMs).toBe(900_000);
  });

  it("throws with gitOutput on a validation failure so the fix loop sees the script output", async () => {
    const harness = createDepsHarness({
      result: commandResult({
        pass: false,
        output: "lint errors found\n2 problems",
        message: "Pre-merge validation failed",
      }),
    });

    try {
      await performMergeValidation(BASE_INPUT, harness.deps);
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as Error & { gitOutput?: string; timedOut?: boolean };
      expect(e.message).toBe("Pre-merge validation failed");
      expect(e.gitOutput).toContain("lint errors found");
      expect(e.gitOutput).toContain("2 problems");
      expect(isTimeoutError(e)).toBe(false);
    }
    expect(harness.commitCalls).toHaveLength(0);
  });

  it("omits gitOutput when the failing script produced no output", async () => {
    const harness = createDepsHarness({
      result: commandResult({ pass: false, output: "" }),
    });

    try {
      await performMergeValidation(BASE_INPUT, harness.deps);
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as Error & { gitOutput?: string };
      expect(e.gitOutput).toBeUndefined();
    }
  });

  it("preserves timeout-ness on the thrown error so the fragment can short-circuit the fix loop", async () => {
    const harness = createDepsHarness({
      result: commandResult({
        pass: false,
        output: "tests starting...",
        timedOut: true,
        message: "Pre-merge validation timed out after 300s",
      }),
    });

    try {
      await performMergeValidation(BASE_INPUT, harness.deps);
      expect.unreachable("should have thrown");
    } catch (err) {
      const e = err as Error & { timedOut?: boolean };
      expect(e.message).toContain("timed out");
      expect(isTimeoutError(e)).toBe(true);
    }
  });

  it("auto-commits script fixes on pass so they are included in the squash merge", async () => {
    const harness = createDepsHarness({ hasChanges: true });

    await performMergeValidation(BASE_INPUT, harness.deps);

    expect(harness.commitCalls).toEqual([
      {
        worktreePath: BASE_INPUT.worktreePath,
        message: "auto-fix: pre-merge validation",
        opts: { skipHooks: true },
      },
    ]);
  });

  it("does not commit when the passing script leaves no changes", async () => {
    const harness = createDepsHarness({ hasChanges: false });

    await performMergeValidation(BASE_INPUT, harness.deps);

    expect(harness.commitCalls).toHaveLength(0);
  });
});
