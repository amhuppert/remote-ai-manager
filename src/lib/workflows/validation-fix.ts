/**
 * Fix pre-merge validation errors in a session worktree via the conversation
 * actor.
 *
 * - Saves validation output to a temp file for the agent to read.
 * - Tells the agent what validation command is being run (for context).
 * - Routes the turn through `executeWorkflowTaskRun` so the conversation lock,
 *   transcript append, and SSE broadcast all fire — and so the conversation
 *   actor's backend runtime is reused across retries automatically.
 * - The merge machine re-runs validation after this completes and retries with
 *   `isRetry: true` on subsequent attempts to pick the retry prompt variant.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readConfig as defaultReadConfig } from "../config/loader";
import { createLogger } from "../logging";
import { executeWorkflowTaskRun as defaultExecuteWorkflowTaskRun } from "@/lib/workflows/conversation/execute-workflow-task-run";
import type {
  ExecuteWorkflowTaskRunInput,
  TaskRunResult,
} from "@/lib/workflows/conversation/execute-workflow-task-run";

const logger = createLogger("validation-fix");

// ============================================================
// Dependency Injection
// ============================================================

export interface ValidationFixDeps {
  readConfig: typeof defaultReadConfig;
  /**
   * Named entrypoint that routes a single `task_run` turn through the
   * conversation actor for the conversation identified by
   * `(projectPath, sessionName, conversationId)`.
   */
  executeWorkflowTaskRun?(
    input: ExecuteWorkflowTaskRunInput,
  ): Promise<TaskRunResult>;
}

const defaultDeps: ValidationFixDeps = {
  readConfig: defaultReadConfig,
};

// ============================================================
// Public Types
// ============================================================

export type ValidationFixResult =
  | { status: "fixed" }
  | { status: "failed"; error: string };

// ============================================================
// System Prompt
// ============================================================

const VALIDATION_FIX_INSTRUCTIONS = `You are a code quality specialist. Your task is to fix validation errors in this codebase so that the validation script passes.

You will be given the output of a validation script that failed. The errors may include:
- Linter violations (ESLint, Ruff, etc.)
- TypeScript type errors
- Formatting issues (Prettier, Black, etc.)
- Test failures

Follow these steps precisely:

1. Analyze the validation output to identify all errors.
2. For each error, read the relevant file and understand the context around the error.
3. Fix the issue — make the minimal code change that resolves the error while preserving correct behavior.
4. Stage all fixed files with \`git add <file>\`.

IMPORTANT:
- Fix ALL errors listed in the validation output.
- Make minimal changes — only fix what the validation flagged.
- Do not refactor or change behavior beyond what is needed to pass validation.
- Stage every modified file with git add.
- Do NOT run the validation script yourself — the caller will re-run it after you finish and provide feedback if issues remain.`;

// ============================================================
// Temp File Management
// ============================================================

/**
 * Write validation output to a temp file so the agent can read the full output.
 * Returns the absolute path to the file.
 */
async function writeValidationOutputFile(
  validationOutput: string,
  jobId: string,
  attempt: number,
): Promise<string> {
  const dir = path.join(tmpdir(), "cc-validation");
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${jobId}-attempt-${attempt}.txt`);
  await writeFile(filePath, validationOutput, "utf-8");
  return filePath;
}

// ============================================================
// Prompt Construction
// ============================================================

function buildFirstAttemptPrompt(params: {
  validationOutput: string;
  validationOutputPath: string;
  validationCommand?: string;
}): string {
  const { validationOutput, validationOutputPath, validationCommand } = params;

  let commandContext = "";
  if (validationCommand) {
    commandContext = `\n\nThe validation script being run is: \`${validationCommand}\``;
  }

  return [
    "Fix the following validation errors in this codebase.",
    commandContext,
    `\nThe full validation output has been saved to: \`${validationOutputPath}\``,
    "\nHere is the validation output:\n",
    "```",
    validationOutput,
    "```",
    "\nFollow the instructions in your system prompt precisely.",
  ].join("\n");
}

function buildRetryPrompt(params: {
  validationOutput: string;
  validationOutputPath: string;
  validationCommand?: string;
}): string {
  const { validationOutput, validationOutputPath, validationCommand } = params;

  let commandContext = "";
  if (validationCommand) {
    commandContext = `\nThe validation script (\`${validationCommand}\`) was re-run after your previous fix attempt.`;
  }

  return [
    "Your previous fix attempt did not fully resolve the validation errors.",
    commandContext,
    `\nThe new validation output has been saved to: \`${validationOutputPath}\``,
    "\nHere are the remaining errors:\n",
    "```",
    validationOutput,
    "```",
    "\nPlease analyze the remaining errors and fix them. Stage all fixed files with `git add`.",
  ].join("\n");
}

// ============================================================
// Main Entry Point
// ============================================================

export interface FixValidationErrorsParams {
  worktreePath: string;
  validationOutput: string;
  projectPath: string;
  sessionName: string;
  conversationId: string;
  branchName: string;
  validationCommand?: string;
  /**
   * True after the first attempt failed and the merge machine is retrying.
   * The conversation actor itself preserves the backend runtime across calls,
   * so no session-ref plumbing is needed here — this flag only selects which
   * prompt variant is built.
   */
  isRetry?: boolean;
}

/**
 * Create a validation fixer with injected dependencies.
 * Tests use this to inject mocks; production uses the default singleton export.
 */
export function createValidationFixer(deps: ValidationFixDeps = defaultDeps) {
  return {
    fixValidationErrors: (
      params: FixValidationErrorsParams,
    ): Promise<ValidationFixResult> => fixValidationErrorsImpl(params, deps),
  };
}

/**
 * Fix validation errors via the conversation actor.
 *
 * - Saves validation output to a temp file for the agent to reference.
 * - On first attempt: uses the first-attempt prompt.
 * - On retry: uses the retry prompt; the conversation actor reuses the same
 *   backend runtime so the agent retains context from the previous turn.
 */
export async function fixValidationErrors(
  params: FixValidationErrorsParams,
): Promise<ValidationFixResult> {
  return fixValidationErrorsImpl(params, defaultDeps);
}

async function fixValidationErrorsImpl(
  params: FixValidationErrorsParams,
  deps: ValidationFixDeps,
): Promise<ValidationFixResult> {
  const {
    worktreePath,
    validationOutput,
    validationCommand,
    projectPath,
    sessionName,
    conversationId,
    isRetry,
  } = params;
  const { readConfig } = deps;
  const executeWorkflowTaskRun =
    deps.executeWorkflowTaskRun ?? defaultExecuteWorkflowTaskRun;

  logger.info("validation-fix.start", {
    worktreePath,
    projectPath,
    sessionName,
    conversationId,
    isRetry: isRetry === true,
  });

  let config;
  try {
    config = await readConfig();
  } catch (err) {
    const errorMsg =
      err instanceof Error ? err.message : "Failed to read config";
    logger.error("validation-fix.config_error", { error: errorMsg });
    return { status: "failed", error: errorMsg };
  }

  const jobId = `${sessionName}-${Date.now()}`;
  const attempt = isRetry === true ? 2 : 1;
  let validationOutputPath: string;
  try {
    validationOutputPath = await writeValidationOutputFile(
      validationOutput,
      jobId,
      attempt,
    );
  } catch (err) {
    const errorMsg =
      err instanceof Error ? err.message : "Failed to write temp file";
    logger.error("validation-fix.temp_file_error", { error: errorMsg });
    return { status: "failed", error: errorMsg };
  }

  const prompt =
    isRetry === true
      ? buildRetryPrompt({
          validationOutput,
          validationOutputPath,
          validationCommand,
        })
      : buildFirstAttemptPrompt({
          validationOutput,
          validationOutputPath,
          validationCommand,
        });

  try {
    const result = await executeWorkflowTaskRun({
      projectPath,
      sessionName,
      conversationId,
      kind: "task_run",
      prompt,
      systemInstructions: VALIDATION_FIX_INSTRUCTIONS,
      timeoutMs: config.claudeTimeoutMs,
      origin: { source: "workflow" },
    });

    if (result.kind === "error") {
      logger.error("validation-fix.task_error", {
        worktreePath,
        error: result.error,
        aborted: result.aborted,
      });
      return { status: "failed", error: result.error };
    }

    logger.info("validation-fix.complete", { worktreePath });
    return { status: "fixed" };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error";
    logger.error("validation-fix.runner_error", {
      worktreePath,
      error: errorMsg,
    });
    return { status: "failed", error: errorMsg };
  }
}
