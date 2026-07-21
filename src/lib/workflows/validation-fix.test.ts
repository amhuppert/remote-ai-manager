import { describe, it, expect, vi } from "vitest";
import {
  createValidationFixer,
  type ValidationFixDeps,
} from "./validation-fix";
import type {
  ExecuteWorkflowTaskRunInput,
  TaskRunResult,
} from "@/lib/workflows/conversation/execute-workflow-task-run";

const PROJECT_PATH = "/projects/repo";
const SESSION_NAME = "feature-branch";
const CONVERSATION_ID = "conv-validation-1";
const BRANCH_NAME = "csm/feature";

function textOk(text: string): TaskRunResult {
  return {
    kind: "text",
    text,
    usage: {
      costUsd: null,
      durationMs: null,
      contextTokens: null,
      contextWindowMax: null,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
    },
    backendRef: null,
    continuationDisposition: "retain",
  };
}

function errResult(error: string): TaskRunResult {
  return {
    kind: "error",
    error,
    aborted: false,
    usage: {
      costUsd: null,
      durationMs: null,
      contextTokens: null,
      contextWindowMax: null,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
    },
    backendRef: null,
    continuationDisposition: "retain",
  };
}

function createTestDeps(
  overrides?: Partial<ValidationFixDeps>,
): ValidationFixDeps {
  return {
    executeWorkflowTaskRun: vi.fn().mockResolvedValue(textOk("fixes applied")),
    ...overrides,
  };
}

describe("validation-fix (executeWorkflowTaskRun)", () => {
  it("pins the fix turn to the merge worktree (worktreePath forwarded to executeWorkflowTaskRun)", async () => {
    const executeWorkflowTaskRun = vi
      .fn<(input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult>>()
      .mockResolvedValue(textOk("fixes applied"));
    const deps = createTestDeps({ executeWorkflowTaskRun });

    const { fixValidationErrors } = createValidationFixer(deps);
    await fixValidationErrors({
      worktreePath: "/projects/repo/.worktrees/lane-feature",
      validationOutput: "lint: 1 error",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      branchName: BRANCH_NAME,
    });

    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    expect(input.worktreePath).toBe("/projects/repo/.worktrees/lane-feature");
  });

  it("routes via executeWorkflowTaskRun with projectPath/sessionName/conversationId and kind=task_run", async () => {
    const executeWorkflowTaskRun = vi
      .fn<(input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult>>()
      .mockResolvedValue(textOk("fixes applied"));
    const deps = createTestDeps({ executeWorkflowTaskRun });

    const { fixValidationErrors } = createValidationFixer(deps);
    const result = await fixValidationErrors({
      worktreePath: "/tmp/worktree",
      validationOutput: "lint: 1 error",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      branchName: BRANCH_NAME,
    });

    expect(result.status).toBe("fixed");
    expect(executeWorkflowTaskRun).toHaveBeenCalledTimes(1);
    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    expect(input.projectPath).toBe(PROJECT_PATH);
    expect(input.sessionName).toBe(SESSION_NAME);
    expect(input.conversationId).toBe(CONVERSATION_ID);
    expect(input.kind).toBe("task_run");
    expect(input.outputFormat).toBeUndefined();
    expect(typeof input.systemInstructions).toBe("string");
    expect(input.timeoutMs).toBeUndefined();
    expect(input.prompt).toContain("lint: 1 error");
  });

  it("uses the first-attempt prompt when isRetry is false", async () => {
    const executeWorkflowTaskRun = vi
      .fn<(input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult>>()
      .mockResolvedValue(textOk("fixes applied"));
    const deps = createTestDeps({ executeWorkflowTaskRun });

    const { fixValidationErrors } = createValidationFixer(deps);
    await fixValidationErrors({
      worktreePath: "/tmp/worktree",
      validationOutput: "fail",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      branchName: BRANCH_NAME,
    });

    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    expect(input.prompt).toContain("Fix the following validation errors");
    expect(input.prompt).not.toContain("Your previous fix attempt");
  });

  it("uses the retry prompt when isRetry is true", async () => {
    const executeWorkflowTaskRun = vi
      .fn<(input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult>>()
      .mockResolvedValue(textOk("fixes applied"));
    const deps = createTestDeps({ executeWorkflowTaskRun });

    const { fixValidationErrors } = createValidationFixer(deps);
    await fixValidationErrors({
      worktreePath: "/tmp/worktree",
      validationOutput: "still failing",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      branchName: BRANCH_NAME,
      isRetry: true,
    });

    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    expect(input.prompt).toContain("Your previous fix attempt");
  });

  it("returns fixed status when executeWorkflowTaskRun resolves with kind=text", async () => {
    const executeWorkflowTaskRun = vi
      .fn()
      .mockResolvedValue(textOk("fixes applied"));
    const deps = createTestDeps({ executeWorkflowTaskRun });

    const { fixValidationErrors } = createValidationFixer(deps);
    const result = await fixValidationErrors({
      worktreePath: "/tmp/worktree",
      validationOutput: "lint: 1 error",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      branchName: BRANCH_NAME,
    });

    expect(result.status).toBe("fixed");
  });

  it("returns failed status when executeWorkflowTaskRun resolves with kind=error", async () => {
    const executeWorkflowTaskRun = vi
      .fn()
      .mockResolvedValue(errResult("SDK fail"));
    const deps = createTestDeps({ executeWorkflowTaskRun });

    const { fixValidationErrors } = createValidationFixer(deps);
    const result = await fixValidationErrors({
      worktreePath: "/tmp/worktree",
      validationOutput: "lint: 1 error",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      branchName: BRANCH_NAME,
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toContain("SDK fail");
    }
  });

  it("threads validationCommand into the prompt when provided", async () => {
    const executeWorkflowTaskRun = vi
      .fn<(input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult>>()
      .mockResolvedValue(textOk("fixes applied"));
    const deps = createTestDeps({ executeWorkflowTaskRun });

    const { fixValidationErrors } = createValidationFixer(deps);
    await fixValidationErrors({
      worktreePath: "/tmp/worktree",
      validationOutput: "fail",
      validationCommand: "/scripts/check.sh",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      branchName: BRANCH_NAME,
    });

    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    expect(input.prompt).toContain("/scripts/check.sh");
  });
});
