import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ValidationSubmission } from "@/lib/validation/service";
import type { ValidationRunResult } from "@/lib/validation/schemas";
import {
  createScriptValidatorRunner,
  type ScriptValidatorDeps,
} from "./script-validator-runner";

const BASE_INPUT = {
  projectPath: "/projects/acme",
  worktreePath: "/projects/acme/.worktrees/ctx-abc",
  sessionName: "ctx-abc",
  branchName: "csm/ctx-abc",
  executionId: "exec-1",
  contextId: "ctx-plan",
  targetBranch: "csm/ctx-abc",
  timeoutMs: 60_000,
  commands: ["pre-merge"],
};

function accepted(runId: string): ValidationSubmission {
  return {
    kind: "accepted",
    runId,
    status: "running",
    position: null,
    lease: null,
    requestedScope: "changed",
    effectiveScope: "changed",
  };
}

function createDeps(
  options: {
    submissions?: ValidationSubmission[];
    results?: ValidationRunResult[];
    resolveTreeState?: ScriptValidatorDeps["resolveTreeState"];
  } = {},
): ScriptValidatorDeps & {
  validationService: ScriptValidatorDeps["validationService"] & {
    submitSystem: ReturnType<typeof vi.fn>;
    waitForCompletion: ReturnType<typeof vi.fn>;
    cancelSystemOwned: ReturnType<typeof vi.fn>;
  };
  writeFile: ReturnType<typeof vi.fn>;
  mkdir: ReturnType<typeof vi.fn>;
} {
  const submissions = [...(options.submissions ?? [accepted("run-1")])];
  const results = [
    ...(options.results ?? [
      {
        kind: "passed" as const,
        runId: "run-1",
        exitCode: 0,
        output: "clean",
      },
    ]),
  ];
  const submitSystem = vi.fn(async () => {
    const submission = submissions.shift();
    if (!submission) throw new Error("unexpected submission");
    return submission;
  });
  const waitForCompletion = vi.fn(async () => {
    const result = results.shift();
    if (!result) throw new Error("unexpected completion wait");
    return result;
  });
  const cancelSystemOwned = vi.fn(async () => true);
  return {
    validationService: {
      submitSystem,
      waitForCompletion,
      cancelSystemOwned,
    },
    writeFile: vi.fn(async () => {}),
    mkdir: vi.fn(async () => undefined as unknown as string | undefined),
    now: () => new Date("2026-04-18T01:00:00.000Z"),
    resolveTreeState:
      options.resolveTreeState ??
      vi.fn(async () => ({ headSha: "abc123", dirty: false })),
  };
}

describe("createScriptValidatorRunner", () => {
  it("retries warning-bearing readiness reports despite successful command exits", async () => {
    const deps = createDeps({
      submissions: [accepted("warning"), accepted("ready")],
      results: [
        {
          kind: "passed",
          runId: "warning",
          exitCode: 0,
          output: JSON.stringify({
            status: "ready",
            warnings: ["Figma component discovery incomplete"],
            summary: "Partial inventory",
          }),
        },
        {
          kind: "passed",
          runId: "ready",
          exitCode: 0,
          output: JSON.stringify({
            status: "ready",
            warnings: [],
            summary: "Inventory complete",
          }),
        },
      ],
    });
    const result = await createScriptValidatorRunner(deps).runScriptValidator({
      ...BASE_INPUT,
      purpose: "infrastructure",
    });
    expect(result.kind).toBe("pass");
    expect(deps.writeFile).toHaveBeenCalledTimes(2);
    expect(deps.writeFile.mock.calls[0]?.[1]).toContain(
      "Figma component discovery incomplete",
    );
  });

  it.each(["warning", "malformed", "timeout"])(
    "exhausts readiness retries without reporting semantic failure (%s)",
    async (failure) => {
      const deps = createDeps({
        submissions: [1, 2, 3].map((attempt) => accepted(`run-${attempt}`)),
        results: [1, 2, 3].map(
          (attempt): ValidationRunResult =>
            failure === "timeout"
              ? {
                  kind: "timed_out",
                  runId: `run-${attempt}`,
                  timeoutMs: 60000,
                  output: "Figma unavailable",
                }
              : {
                  kind: "passed",
                  runId: `run-${attempt}`,
                  exitCode: 0,
                  output:
                    failure === "malformed"
                      ? "discovery succeeded"
                      : JSON.stringify({
                          status: "ready",
                          warnings: ["Discovery incomplete"],
                          summary: "Partial inventory",
                        }),
                },
        ),
      });
      const result = await createScriptValidatorRunner(deps).runScriptValidator(
        { ...BASE_INPUT, purpose: "infrastructure" },
      );
      expect(result).toMatchObject({
        kind: "infra_error",
        reason: "exception",
        readinessBlock: { commandName: "pre-merge", attempts: 3 },
      });
      expect(deps.writeFile).toHaveBeenCalledTimes(3);
    },
  );

  it("runs registered commands sequentially, stops on failure, and writes one artifact per command", async () => {
    const deps = createDeps({
      submissions: [accepted("run-typecheck"), accepted("run-test")],
      results: [
        {
          kind: "passed",
          runId: "run-typecheck",
          exitCode: 0,
          output: "types clean",
        },
        {
          kind: "failed",
          runId: "run-test",
          exitCode: 1,
          output: "one failing test",
        },
      ],
    });
    const runner = createScriptValidatorRunner(deps);

    const outcome = await runner.runScriptValidator({
      ...BASE_INPUT,
      commands: ["typecheck", "test", "format"],
    });

    expect(deps.validationService.submitSystem).toHaveBeenCalledTimes(2);
    expect(
      deps.validationService.submitSystem.mock.calls.map(
        ([request]) => request.command,
      ),
    ).toEqual([
      { kind: "registered", name: "typecheck" },
      { kind: "registered", name: "test" },
    ]);
    expect(
      deps.validationService.waitForCompletion.mock.calls.map(
        ([runId]) => runId,
      ),
    ).toEqual(["run-typecheck", "run-test"]);
    expect(deps.writeFile).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({
      kind: "fail",
      command: "test",
      runId: "run-test",
      summary: 'Validation command "test" failed',
      timedOut: false,
    });
  });

  it("runs each command against the resolved lane target and returns the final tree identity", async () => {
    const resolveTreeState = vi
      .fn()
      .mockResolvedValueOnce({ headSha: "before-1", dirty: false })
      .mockResolvedValueOnce({ headSha: "after-1", dirty: false })
      .mockResolvedValueOnce({ headSha: "before-2", dirty: false })
      .mockResolvedValueOnce({ headSha: "after-2", dirty: true });
    const deps = createDeps({
      submissions: [accepted("run-1"), accepted("run-2")],
      results: [
        { kind: "passed", runId: "run-1", exitCode: 0, output: "one" },
        { kind: "passed", runId: "run-2", exitCode: 0, output: "two" },
      ],
      resolveTreeState,
    });
    const runner = createScriptValidatorRunner(deps);
    const executionTarget = {
      worktreePath: "/projects/acme/.worktrees/ctx-abc.ctx-plan",
      branchName: "csm/ctx-abc-ctx-plan",
      isolation: "worktree" as const,
      laneId: null,
    };

    const outcome = await runner.runScriptValidator({
      ...BASE_INPUT,
      commands: ["typecheck", "test"],
      executionTarget,
    });

    expect(outcome).toEqual({
      kind: "pass",
      treeState: { headSha: "after-2", dirty: true },
      command: "test",
    });
    expect(resolveTreeState).toHaveBeenCalledTimes(4);
    expect(resolveTreeState).toHaveBeenCalledWith(executionTarget.worktreePath);
    expect(deps.validationService.submitSystem).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        source: "graph_script_validator",
        scope: "changed",
        workflow: { executionId: "exec-1", contextId: "ctx-plan" },
        target: {
          worktreePath: executionTarget.worktreePath,
          sessionName: BASE_INPUT.sessionName,
          branchName: executionTarget.branchName,
          targetBranch: BASE_INPUT.targetBranch,
          contextId: BASE_INPUT.contextId,
        },
      }),
    );
    expect(deps.writeFile).toHaveBeenCalledTimes(2);
    const [writtenPath, content] = deps.writeFile.mock.calls[1] ?? [];
    expect(writtenPath).toContain(
      path.join(".cc", "workflow", "exec-1", "test-"),
    );
    expect(content).toContain("tree-before: before-2");
    expect(content).toContain("tree-after: after-2 (dirty)");
    expect(content).toContain("run: run-2");
  });

  it("reports an unknown registered command distinctly without submitting later commands", async () => {
    const deps = createDeps({
      submissions: [
        {
          kind: "not_started",
          result: {
            kind: "command_not_found",
            name: "missing",
            knownCommands: ["typecheck", "test"],
          },
        },
      ],
    });
    const runner = createScriptValidatorRunner(deps);

    const outcome = await runner.runScriptValidator({
      ...BASE_INPUT,
      commands: ["missing", "test"],
    });

    expect(outcome).toEqual({
      kind: "infra_error",
      reason: "unknown_command",
      commandName: "missing",
      message:
        'Script validator command "missing" is not registered; registered commands: typecheck, test',
    });
    expect(deps.validationService.submitSystem).toHaveBeenCalledTimes(1);
    expect(deps.validationService.waitForCompletion).not.toHaveBeenCalled();
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it("treats an empty registered-command selection as disabled", async () => {
    const deps = createDeps();
    const runner = createScriptValidatorRunner(deps);

    const outcome = await runner.runScriptValidator({
      ...BASE_INPUT,
      commands: [],
    });

    expect(outcome).toEqual({ kind: "pass", command: null });
    expect(deps.validationService.submitSystem).not.toHaveBeenCalled();
  });

  it("maps a service timeout to a command-specific failure artifact", async () => {
    const deps = createDeps({
      results: [
        {
          kind: "timed_out",
          runId: "run-1",
          timeoutMs: 60_000,
          output: "partial output",
        },
      ],
    });
    const runner = createScriptValidatorRunner(deps);

    const outcome = await runner.runScriptValidator({
      ...BASE_INPUT,
      commands: ["test"],
    });

    expect(outcome).toMatchObject({
      kind: "fail",
      command: "test",
      timedOut: true,
      summary: 'Validation command "test" timed out',
    });
    const [, content] = deps.writeFile.mock.calls[0] ?? [];
    expect(content).toContain("partial output");
    expect(content).toContain("outcome: timed_out");
  });

  it("maps a service spawn failure to infrastructure without remediation", async () => {
    const deps = createDeps({
      results: [
        {
          kind: "failed",
          runId: "run-1",
          exitCode: null,
          output: "spawn scripts/validate.sh ENOENT",
        },
      ],
    });
    const runner = createScriptValidatorRunner(deps);

    const outcome = await runner.runScriptValidator({
      ...BASE_INPUT,
      commands: ["test"],
    });

    expect(outcome).toEqual({
      kind: "infra_error",
      reason: "exception",
      message:
        'Validation command "test" could not be spawned: spawn scripts/validate.sh ENOENT',
    });
    expect(deps.writeFile).toHaveBeenCalledTimes(1);
    const [, content] = deps.writeFile.mock.calls[0] ?? [];
    expect(content).toContain("outcome: failed");
    expect(content).toContain("spawn scripts/validate.sh ENOENT");
  });

  it("returns an infrastructure error when the service refuses submission", async () => {
    const deps = createDeps({
      submissions: [
        {
          kind: "invalid",
          reason: "service_unavailable",
          message: "validation unavailable",
        },
      ],
    });
    const runner = createScriptValidatorRunner(deps);

    const outcome = await runner.runScriptValidator({
      ...BASE_INPUT,
      commands: ["test"],
    });

    expect(outcome).toEqual({
      kind: "infra_error",
      reason: "exception",
      message: "validation unavailable",
    });
  });

  it("cancels an accepted system run on orchestration abort and waits for cancellation to finish", async () => {
    const deps = createDeps();
    let resolveWait!: (result: ValidationRunResult) => void;
    const waitResult = new Promise<ValidationRunResult>((resolve) => {
      resolveWait = resolve;
    });
    let finishCancellation!: () => void;
    const cancellationFinished = new Promise<void>((resolve) => {
      finishCancellation = resolve;
    });
    deps.validationService.waitForCompletion.mockImplementation(
      async () => waitResult,
    );
    deps.validationService.cancelSystemOwned.mockImplementation(async () => {
      await cancellationFinished;
      return true;
    });
    const controller = new AbortController();
    const runner = createScriptValidatorRunner(deps);
    let settled = false;
    const outcomePromise = runner
      .runScriptValidator({
        ...BASE_INPUT,
        commands: ["test"],
        signal: controller.signal,
      })
      .then((outcome) => {
        settled = true;
        return outcome;
      });
    await vi.waitFor(() =>
      expect(deps.validationService.waitForCompletion).toHaveBeenCalledWith(
        "run-1",
      ),
    );

    controller.abort();
    resolveWait({ kind: "cancelled", runId: "run-1" });
    await Promise.resolve();

    try {
      expect(deps.validationService.cancelSystemOwned).toHaveBeenCalledWith(
        "run-1",
      );
      expect(settled).toBe(false);
    } finally {
      finishCancellation();
    }

    await expect(outcomePromise).resolves.toMatchObject({
      kind: "infra_error",
      reason: "exception",
      message: 'Validation command "test" ended with cancelled',
    });
  });
});
