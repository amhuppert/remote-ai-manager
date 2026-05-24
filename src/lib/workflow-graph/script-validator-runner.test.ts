import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { RepoValidationCommandResult } from "@/lib/projects/repo-config";
import {
  createScriptValidatorRunner,
  type ScriptValidatorDeps,
} from "./script-validator-runner";
import type { ExecutionTarget } from "./execution-target-resolver";

function createDeps(
  overrides: Partial<ScriptValidatorDeps> = {},
): ScriptValidatorDeps {
  return {
    executeRepoValidationCommand: vi.fn(async () => ({
      executed: true,
      pass: true,
      stdout: "ok",
      stderr: "",
      output: "ok",
      timedOut: false,
      message: null,
    })),
    writeFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => undefined as unknown as string | undefined),
    now: () => new Date("2026-04-18T01:00:00.000Z"),
    ...overrides,
  };
}

const BASE_INPUT = {
  projectPath: "/projects/acme",
  worktreePath: "/projects/acme/.worktrees/ctx-abc",
  sessionName: "ctx-abc",
  branchName: "csm/ctx-abc",
  executionId: "exec-1",
  contextId: "ctx-plan",
  timeoutMs: 60_000,
};

describe("createScriptValidatorRunner", () => {
  it("returns pass when the repo validation command reports success", async () => {
    const deps = createDeps();
    const runner = createScriptValidatorRunner(deps);

    const outcome = await runner.runScriptValidator(BASE_INPUT);

    expect(outcome.kind).toBe("pass");
    expect(deps.executeRepoValidationCommand).toHaveBeenCalledWith({
      projectPath: BASE_INPUT.projectPath,
      worktreePath: BASE_INPUT.worktreePath,
      sessionName: BASE_INPUT.sessionName,
      branchName: BASE_INPUT.branchName,
      timeoutMs: BASE_INPUT.timeoutMs,
    });
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it("returns infra_error with missing_pre_merge_command when no script is configured", async () => {
    const failingResult: RepoValidationCommandResult = {
      executed: false,
      pass: true,
      stdout: "",
      stderr: "",
      output: "",
      timedOut: false,
      message: null,
    };
    const deps = createDeps({
      executeRepoValidationCommand: vi.fn(async () => failingResult),
    });
    const runner = createScriptValidatorRunner(deps);

    const outcome = await runner.runScriptValidator(BASE_INPUT);

    expect(outcome.kind).toBe("infra_error");
    if (outcome.kind !== "infra_error") return;
    expect(outcome.reason).toBe("missing_pre_merge_command");
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it("returns fail with log file path when the script fails", async () => {
    const failingResult: RepoValidationCommandResult = {
      executed: true,
      pass: false,
      stdout: "failure out",
      stderr: "failure err",
      output: "failure err\nfailure out",
      timedOut: false,
      message: "Pre-merge validation failed",
    };
    const deps = createDeps({
      executeRepoValidationCommand: vi.fn(async () => failingResult),
    });
    const runner = createScriptValidatorRunner(deps);

    const outcome = await runner.runScriptValidator(BASE_INPUT);

    expect(outcome.kind).toBe("fail");
    if (outcome.kind !== "fail") return;
    expect(outcome.logFilePath).toContain(".cc/workflow/exec-1/");
    expect(outcome.logFilePath).toMatch(/pre-merge-.*\.log$/);
    expect(outcome.logRelativePath).toMatch(
      /^\.cc\/workflow\/exec-1\/pre-merge-.*\.log$/,
    );
    expect(outcome.summary).toBe("Pre-merge validation failed");
    expect(outcome.timedOut).toBe(false);

    const mockedWriteFile = deps.writeFile as ReturnType<typeof vi.fn>;
    expect(mockedWriteFile).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenContent] = mockedWriteFile.mock.calls[0] ?? [];
    expect(writtenPath).toBe(outcome.logFilePath);
    expect(writtenContent).toContain("failure out");
    expect(writtenContent).toContain("failure err");
  });

  it("ensures the log directory exists before writing", async () => {
    const failingResult: RepoValidationCommandResult = {
      executed: true,
      pass: false,
      stdout: "",
      stderr: "tests failed",
      output: "tests failed",
      timedOut: false,
      message: "Pre-merge validation failed",
    };
    const deps = createDeps({
      executeRepoValidationCommand: vi.fn(async () => failingResult),
    });
    const runner = createScriptValidatorRunner(deps);

    const outcome = await runner.runScriptValidator(BASE_INPUT);
    if (outcome.kind !== "fail") throw new Error("expected fail");

    const mockedMkdir = deps.mkdir as ReturnType<typeof vi.fn>;
    expect(mockedMkdir).toHaveBeenCalledTimes(1);
    const [dirArg, opts] = mockedMkdir.mock.calls[0] ?? [];
    expect(dirArg).toBe(path.dirname(outcome.logFilePath));
    expect(opts).toEqual({ recursive: true });
  });

  it("includes metadata in the log file header (context + timestamp)", async () => {
    const failingResult: RepoValidationCommandResult = {
      executed: true,
      pass: false,
      stdout: "boom",
      stderr: "",
      output: "boom",
      timedOut: false,
      message: "Pre-merge validation failed",
    };
    const deps = createDeps({
      executeRepoValidationCommand: vi.fn(async () => failingResult),
    });
    const runner = createScriptValidatorRunner(deps);

    await runner.runScriptValidator(BASE_INPUT);

    const mockedWriteFile = deps.writeFile as ReturnType<typeof vi.fn>;
    const [, content] = mockedWriteFile.mock.calls[0] ?? [];
    expect(content).toContain("execution: exec-1");
    expect(content).toContain("context: ctx-plan");
    expect(content).toContain("2026-04-18T01:00:00.000Z");
  });

  it("marks timedOut when the command reports a timeout", async () => {
    const timedOutResult: RepoValidationCommandResult = {
      executed: true,
      pass: false,
      stdout: "",
      stderr: "",
      output: "",
      timedOut: true,
      message: "Pre-merge validation timed out after 60s",
    };
    const deps = createDeps({
      executeRepoValidationCommand: vi.fn(async () => timedOutResult),
    });
    const runner = createScriptValidatorRunner(deps);

    const outcome = await runner.runScriptValidator(BASE_INPUT);
    expect(outcome.kind).toBe("fail");
    if (outcome.kind !== "fail") return;
    expect(outcome.timedOut).toBe(true);
    expect(outcome.summary).toBe("Pre-merge validation timed out after 60s");
  });

  it("returns infra_error with exception reason when the command throws", async () => {
    const deps = createDeps({
      executeRepoValidationCommand: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const runner = createScriptValidatorRunner(deps);

    const outcome = await runner.runScriptValidator(BASE_INPUT);
    expect(outcome.kind).toBe("infra_error");
    if (outcome.kind !== "infra_error") return;
    expect(outcome.reason).toBe("exception");
    expect(outcome.message).toBe("boom");
  });

  it("uses executionTarget.worktreePath/branchName when an executionTarget is provided", async () => {
    const executeRepoValidationCommand = vi.fn(async () => ({
      executed: true,
      pass: true,
      stdout: "ok",
      stderr: "",
      output: "ok",
      timedOut: false,
      message: null,
    }));
    const deps = createDeps({ executeRepoValidationCommand });
    const runner = createScriptValidatorRunner(deps);

    const executionTarget: ExecutionTarget = {
      worktreePath: "/projects/acme/.worktrees/ctx-abc.ctx-plan",
      branchName: "csm/ctx-abc-ctx-plan",
      isolation: "worktree",
      laneId: null,
    };

    const outcome = await runner.runScriptValidator({
      ...BASE_INPUT,
      executionTarget,
    });

    expect(outcome.kind).toBe("pass");
    expect(executeRepoValidationCommand).toHaveBeenCalledWith({
      projectPath: BASE_INPUT.projectPath,
      worktreePath: executionTarget.worktreePath,
      sessionName: BASE_INPUT.sessionName,
      branchName: executionTarget.branchName,
      timeoutMs: BASE_INPUT.timeoutMs,
    });
  });

  it("writes failure logs under the executionTarget worktree when provided", async () => {
    const failingResult: RepoValidationCommandResult = {
      executed: true,
      pass: false,
      stdout: "",
      stderr: "fail",
      output: "fail",
      timedOut: false,
      message: "Pre-merge validation failed",
    };
    const deps = createDeps({
      executeRepoValidationCommand: vi.fn(async () => failingResult),
    });
    const runner = createScriptValidatorRunner(deps);

    const executionTarget: ExecutionTarget = {
      worktreePath: "/projects/acme/.worktrees/ctx-abc.ctx-plan",
      branchName: "csm/ctx-abc-ctx-plan",
      isolation: "worktree",
      laneId: null,
    };

    const outcome = await runner.runScriptValidator({
      ...BASE_INPUT,
      executionTarget,
    });
    if (outcome.kind !== "fail") throw new Error("expected fail");

    expect(outcome.logFilePath.startsWith(executionTarget.worktreePath)).toBe(
      true,
    );
  });

  it("falls back to input.worktreePath/branchName when no executionTarget is provided", async () => {
    const executeRepoValidationCommand = vi.fn(async () => ({
      executed: true,
      pass: true,
      stdout: "ok",
      stderr: "",
      output: "ok",
      timedOut: false,
      message: null,
    }));
    const deps = createDeps({ executeRepoValidationCommand });
    const runner = createScriptValidatorRunner(deps);

    await runner.runScriptValidator(BASE_INPUT);

    expect(executeRepoValidationCommand).toHaveBeenCalledWith({
      projectPath: BASE_INPUT.projectPath,
      worktreePath: BASE_INPUT.worktreePath,
      sessionName: BASE_INPUT.sessionName,
      branchName: BASE_INPUT.branchName,
      timeoutMs: BASE_INPUT.timeoutMs,
    });
  });

  it("places the log file under the worktree at .cc/workflow/<executionId>/", async () => {
    const failingResult: RepoValidationCommandResult = {
      executed: true,
      pass: false,
      stdout: "",
      stderr: "fail",
      output: "fail",
      timedOut: false,
      message: "Pre-merge validation failed",
    };
    const deps = createDeps({
      executeRepoValidationCommand: vi.fn(async () => failingResult),
    });
    const runner = createScriptValidatorRunner(deps);

    const outcome = await runner.runScriptValidator(BASE_INPUT);
    if (outcome.kind !== "fail") throw new Error("expected fail");

    expect(outcome.logFilePath.startsWith(BASE_INPUT.worktreePath)).toBe(true);
    expect(outcome.logRelativePath).toMatch(
      /^\.cc\/workflow\/exec-1\/pre-merge-\d{8}T\d{6}Z\.log$/,
    );
  });
});
