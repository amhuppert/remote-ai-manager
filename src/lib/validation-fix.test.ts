import { describe, it, expect, vi } from "vitest";
import {
  createValidationFixer,
  type ValidationFixDeps,
} from "./validation-fix";
import type { AgentTaskRunner, AgentTaskResult } from "./agent-backends/task";
import { executeAgentCall as defaultExecuteAgentCall } from "@/lib/workflows/primitives/agent-call-facade";

function createMockRunner(result: Partial<AgentTaskResult>): AgentTaskRunner {
  return {
    backend: "claude",
    run: vi.fn().mockResolvedValue({
      backendRef: null,
      text: null,
      structuredOutput: undefined,
      usage: null,
      error: null,
      timedOut: false,
      ...result,
    }),
  };
}

function createTestDeps(
  overrides?: Partial<ValidationFixDeps>,
): ValidationFixDeps {
  return {
    getTaskRunner: vi
      .fn()
      .mockReturnValue(
        createMockRunner({ text: "fixed" }),
      ) as ValidationFixDeps["getTaskRunner"],
    readConfig: vi.fn().mockResolvedValue({
      baseDir: "/home/user/projects",
      ignorePatterns: [],
      stateFilePath: "/tmp/state.json",
      claudeTimeoutMs: 60_000,
      defaultModel: "opus",
    }) as unknown as ValidationFixDeps["readConfig"],
    ...overrides,
  };
}

describe("validation-fix", () => {
  it("returns fixed status when runner succeeds on first attempt", async () => {
    const runner = createMockRunner({
      text: "fixes applied",
      backendRef: { backend: "claude", sessionId: "sess-1" },
    });
    const deps = createTestDeps({
      getTaskRunner: vi.fn().mockReturnValue(runner),
    });

    const { fixValidationErrors } = createValidationFixer(deps);
    const result = await fixValidationErrors({
      worktreePath: "/tmp/worktree",
      validationOutput: "lint: 1 error",
    });

    expect(result.status).toBe("fixed");
    if (result.status === "fixed") {
      expect(result.sessionRef).toEqual({
        backend: "claude",
        sessionId: "sess-1",
      });
    }
  });

  it("returns failed status when runner errors", async () => {
    const runner = createMockRunner({ error: "SDK fail" });
    const deps = createTestDeps({
      getTaskRunner: vi.fn().mockReturnValue(runner),
    });

    const { fixValidationErrors } = createValidationFixer(deps);
    const result = await fixValidationErrors({
      worktreePath: "/tmp/worktree",
      validationOutput: "lint: 1 error",
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("SDK fail");
    }
  });
});

describe("validation-fix Task 6.3 parity (executeAgentCall route)", () => {
  it("routes fixValidationErrors through deps.executeAgentCall as kind=task_run with write_capable", async () => {
    const runner = createMockRunner({ text: "fixes applied" });
    const executeAgentCallSpy = vi.fn(defaultExecuteAgentCall);
    const deps = createTestDeps({
      getTaskRunner: vi.fn().mockReturnValue(runner),
      executeAgentCall: executeAgentCallSpy,
    });

    const { fixValidationErrors } = createValidationFixer(deps);
    const result = await fixValidationErrors({
      worktreePath: "/tmp/worktree",
      validationOutput: "lint: 1 error",
    });

    expect(result.status).toBe("fixed");
    expect(executeAgentCallSpy).toHaveBeenCalledTimes(1);
    const [request] = executeAgentCallSpy.mock.calls[0]!;
    expect(request).toMatchObject({
      kind: "task_run",
      backend: "claude",
      writeCapability: "write_capable",
    });
  });

  it("forwards sessionRef as resumeRef on retry", async () => {
    const runner = createMockRunner({ text: "fixes applied" });
    const executeAgentCallSpy = vi.fn(defaultExecuteAgentCall);
    const deps = createTestDeps({
      getTaskRunner: vi.fn().mockReturnValue(runner),
      executeAgentCall: executeAgentCallSpy,
    });

    const { fixValidationErrors } = createValidationFixer(deps);
    await fixValidationErrors({
      worktreePath: "/tmp/worktree",
      validationOutput: "still failing",
      sessionRef: { backend: "claude", sessionId: "sess-1" },
    });

    const taskRequest = (runner.run as ReturnType<typeof vi.fn>).mock
      .calls[0]![0];
    expect(taskRequest.resumeRef).toEqual({
      backend: "claude",
      sessionId: "sess-1",
    });
  });
});
