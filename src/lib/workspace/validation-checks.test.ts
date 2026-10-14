import { describe, expect, it } from "vitest";
import type { ValidationRunResult } from "@/lib/validation/schemas";
import type {
  ValidationSubmission,
  ValidationSystemSubmitRequest,
} from "@/lib/validation/service";
import { createValidationCheckRunner } from "./validation-checks";

const silent = { info: () => {}, warn: () => {}, error: () => {} };
const binding = {
  kind: "session" as const,
  projectPath: "/repo",
  sessionName: "session",
  worktreePath: "/repo/.worktrees/session",
  scope: { mode: "full" as const },
};

function harness(
  submission: ValidationSubmission,
  result?: ValidationRunResult,
  target: Parameters<
    ReturnType<typeof createValidationCheckRunner>
  >[0]["binding"] = binding,
) {
  const submitted: ValidationSystemSubmitRequest[] = [];
  const run = createValidationCheckRunner({
    service: {
      async submitSystem(request) {
        submitted.push(request);
        return submission;
      },
      async waitForCompletion() {
        if (result === undefined) throw new Error("no run was accepted");
        return result;
      },
      async cancelSystemOwned() {
        return true;
      },
    },
    async branchOf() {
      return { branchName: "csm/session", targetBranch: "main" };
    },
    log: silent,
  });
  return {
    run: (signal: AbortSignal = new AbortController().signal) =>
      run({
        binding: target,
        bindingId: "ctx-1",
        command: "typecheck",
        signal,
      }),
    submitted,
  };
}

const accepted: ValidationSubmission = {
  kind: "accepted",
  runId: "vrun-1",
  status: "queued",
  position: 0,
  lease: null,
  requestedScope: "changed",
  effectiveScope: "changed",
};

describe("validation check runner", () => {
  it("checks a lane on its own branch, measured against the session branch it publishes into", async () => {
    const lane = {
      kind: "lane" as const,
      projectPath: "/repo",
      sessionName: "session",
      worktreePath: "/repo/.worktrees/session.1-api",
      branch: "csm/session-1-api",
      scope: { mode: "full" as const },
    };
    const h = harness(
      accepted,
      { kind: "passed", runId: "vrun-1", exitCode: 0, output: "ok" },
      lane,
    );
    await h.run();
    expect(h.submitted[0]?.target).toMatchObject({
      worktreePath: "/repo/.worktrees/session.1-api",
      branchName: "csm/session-1-api",
      targetBranch: "csm/session",
    });
  });

  it("cancels the system-owned validation run when the check is interrupted", async () => {
    let cancelled: string | null = null;
    let finish: (result: ValidationRunResult) => void = () => {};
    const run = createValidationCheckRunner({
      service: {
        submitSystem: async () => accepted,
        waitForCompletion: () => new Promise((resolve) => (finish = resolve)),
        async cancelSystemOwned(runId) {
          cancelled = runId;
          finish({ kind: "cancelled", runId });
          return true;
        },
      },
      branchOf: async () => ({
        branchName: "csm/session",
        targetBranch: "main",
      }),
      log: silent,
    });
    const controller = new AbortController();
    const pending = run({
      binding,
      bindingId: "ctx-1",
      command: "test",
      signal: controller.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();

    expect(await pending).toMatchObject({ status: "unavailable" });
    expect(cancelled).toBe("vrun-1");
  });

  it("runs the registered command against the binding's worktree and branch", async () => {
    const h = harness(accepted, {
      kind: "passed",
      runId: "vrun-1",
      exitCode: 0,
      output: "ok",
    });
    expect(await h.run()).toEqual({ status: "passed" });
    expect(h.submitted).toEqual([
      {
        source: "graph_script_validator",
        command: { kind: "registered", name: "typecheck" },
        scope: "changed",
        projectPath: "/repo",
        workflow: { executionId: "ctx-1", contextId: "ctx-1" },
        target: {
          worktreePath: "/repo/.worktrees/session",
          sessionName: "session",
          branchName: "csm/session",
          targetBranch: "main",
          contextId: "ctx-1",
        },
      },
    ]);
  });

  it("fails with the tail of the command's output", async () => {
    const output = `${"x".repeat(10_000)}\nsrc/a.ts(1,1): error TS2322`;
    const h = harness(accepted, {
      kind: "failed",
      runId: "vrun-1",
      exitCode: 2,
      output,
    });
    const result = await h.run();

    expect(result.status).toBe("failed");
    expect(result.detail).toContain("error TS2322");
    expect(result.detail?.length).toBeLessThan(5_000);
  });

  it("fails a timed-out run and reports cancelled or unstartable runs as unavailable", async () => {
    expect(
      await harness(accepted, {
        kind: "timed_out",
        runId: "vrun-1",
        timeoutMs: 60_000,
        output: "",
      }).run(),
    ).toMatchObject({
      status: "failed",
      detail: expect.stringContaining("timed out"),
    });
    expect(
      await harness(accepted, { kind: "interrupted", runId: "vrun-1" }).run(),
    ).toMatchObject({
      status: "unavailable",
    });
    expect(
      await harness({
        kind: "not_started",
        result: {
          kind: "command_not_found",
          name: "typecheck",
          knownCommands: ["test", "lint"],
        },
      }).run(),
    ).toMatchObject({
      status: "unavailable",
      detail: expect.stringContaining("not registered"),
    });
  });
});
