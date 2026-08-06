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

  /**
   * The agent used to be barred from running any check itself. That works for
   * an error whose remedy is legible in its own message, and fails for the
   * ones that are not: a seam/architecture rule whose sanctioned fix is a new
   * module rather than the edit the message suggests, or a ratchet reporting
   * only a count. Those need the agent to re-run the check to know whether it
   * actually resolved. The bar stays on the FULL validation script, which
   * rebuilds and runs the whole suite — the caller re-runs that and feeds any
   * remainder back.
   */
  it("lets the agent re-run lint and typecheck, but not the full validation script", async () => {
    const executeWorkflowTaskRun = vi
      .fn<(input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult>>()
      .mockResolvedValue(textOk("fixes applied"));
    const deps = createTestDeps({ executeWorkflowTaskRun });

    const { fixValidationErrors } = createValidationFixer(deps);
    await fixValidationErrors({
      worktreePath: "/tmp/worktree",
      validationOutput: "lint: 1 error",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      branchName: BRANCH_NAME,
    });

    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    const instructions = input.systemInstructions ?? "";
    expect(instructions).toMatch(/run the project's linter/i);
    expect(instructions).toMatch(/full validation script/i);
    // The old blanket prohibition, which also covered the linter.
    expect(instructions).not.toMatch(/not run the validation script yourself/i);
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

  /**
   * Session names are free text — a ticket session is named after its ticket
   * title, which routinely carries "/" (and on Windows "\"). Those reach the
   * scratch filename, where an unescaped separator makes the write target a
   * directory that was never created and the fix agent dies before its first
   * turn, halting the merge on a validation failure it could have fixed.
   */
  it("dispatches the fix turn for a session name containing path separators", async () => {
    const executeWorkflowTaskRun = vi
      .fn<(input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult>>()
      .mockResolvedValue(textOk("fixes applied"));
    const deps = createTestDeps({ executeWorkflowTaskRun });

    const { fixValidationErrors } = createValidationFixer(deps);
    const result = await fixValidationErrors({
      worktreePath: "/tmp/worktree",
      validationOutput: "lint: 1 error",
      projectPath: PROJECT_PATH,
      sessionName: "Ticket: roadmap D0-D2 delivered; pick up at D3/D4",
      conversationId: CONVERSATION_ID,
      branchName: BRANCH_NAME,
    });

    expect(result).toEqual({ status: "fixed" });
    expect(executeWorkflowTaskRun).toHaveBeenCalledTimes(1);
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

  it("includes covered-lane intent context in the remediation brief", async () => {
    const executeWorkflowTaskRun = vi
      .fn<(input: ExecuteWorkflowTaskRunInput) => Promise<TaskRunResult>>()
      .mockResolvedValue(textOk("fixes applied"));
    const deps = createTestDeps({ executeWorkflowTaskRun });

    const { fixValidationErrors } = createValidationFixer(deps);
    await fixValidationErrors({
      worktreePath: "/tmp/worktree",
      validationOutput: "typecheck failed",
      resolutionContext:
        "Covered lane lane-b planned the contract. Covered lane lane-c implemented it.",
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      branchName: BRANCH_NAME,
    });

    const [input] = executeWorkflowTaskRun.mock.calls[0]!;
    expect(input.prompt).toContain("Covered lane lane-b planned the contract");
    expect(input.prompt).toContain("Covered lane lane-c implemented it");
  });
});
