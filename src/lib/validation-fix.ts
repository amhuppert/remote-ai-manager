/**
 * Fix pre-merge validation errors in a session worktree via the task runner.
 *
 * - Saves validation output to a temp file for the agent to read
 * - Tells the agent what validation command is being run (for context)
 * - Supports session resume for retry attempts (same conversation)
 * - The merge machine re-runs validation after this completes and retries if needed
 */

import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readConfig } from "./config";
import { createLogger } from "./logging";
import { getTaskRunner } from "./agent-backends/registry";
import type { AgentSessionRef } from "./agent-backends/types";

const logger = createLogger("validation-fix");

// ============================================================
// Public Types
// ============================================================

export type ValidationFixResult =
  | { status: "fixed"; sessionRef?: AgentSessionRef | null }
  | { status: "failed"; error: string; sessionRef?: AgentSessionRef | null };

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

/**
 * Fix validation errors in a session worktree via the task runner.
 *
 * - Saves validation output to a temp file for the agent to reference
 * - On first attempt: creates a new persisted session
 * - On retry: resumes the previous session for accumulated context
 * - Returns the session ref so the caller can resume on retry
 */
export async function fixValidationErrors(params: {
  worktreePath: string;
  validationOutput: string;
  validationCommand?: string;
  projectPath?: string;
  sessionName?: string;
  branchName?: string;
  sessionRef?: AgentSessionRef | null;
}): Promise<ValidationFixResult> {
  const { worktreePath, validationOutput, validationCommand, sessionRef } =
    params;
  const isRetry = sessionRef != null;

  logger.info("validation-fix.start", {
    worktreePath,
    isRetry,
    sessionRef,
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

  // Write validation output to a temp file
  const jobId = `${params.sessionName ?? "unknown"}-${Date.now()}`;
  const attempt = isRetry ? 2 : 1;
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

  const prompt = isRetry
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
    const runner = getTaskRunner("claude");
    const result = await runner.run({
      workingDirectory: worktreePath,
      prompt,
      systemInstructions: [VALIDATION_FIX_INSTRUCTIONS],
      resumeRef: sessionRef,
      autonomous: true,
      timeoutMs: config.claudeTimeoutMs,
    });

    if (result.error) {
      logger.error("validation-fix.task_error", {
        worktreePath,
        error: result.error,
        timedOut: result.timedOut,
      });
      return {
        status: "failed",
        error: result.error,
        sessionRef: result.backendRef,
      };
    }

    logger.info("validation-fix.complete", {
      worktreePath,
      sessionRef: result.backendRef,
    });
    return { status: "fixed", sessionRef: result.backendRef };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown error";
    logger.error("validation-fix.runner_error", {
      worktreePath,
      error: errorMsg,
    });
    return { status: "failed", error: errorMsg };
  }
}
