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
import { createLogger } from "../logging";
import { executeWorkflowTaskRun as defaultExecuteWorkflowTaskRun } from "@/lib/workflows/conversation/execute-workflow-task-run";
import { executeFreshTaskRun as defaultExecuteFreshTaskRun } from "@/lib/workflows/conversation/execute-fresh-task-run";
import type {
  AgentTurnDispatch,
  ExecuteFreshTaskRunInput,
} from "@/lib/workflows/conversation/execute-fresh-task-run";
import type {
  ExecuteWorkflowTaskRunInput,
  TaskRunResult,
} from "@/lib/workflows/conversation/execute-workflow-task-run";

const logger = createLogger("validation-fix");

// ============================================================
// Dependency Injection
// ============================================================

export interface ValidationFixDeps {
  /**
   * Named entrypoint that routes a single `task_run` turn through the
   * conversation actor for the conversation identified by
   * `(projectPath, sessionName, conversationId)`.
   */
  executeWorkflowTaskRun?(
    input: ExecuteWorkflowTaskRunInput,
  ): Promise<TaskRunResult>;
  /** One-shot entrypoint for the `fresh-run` dispatch (graph joins — see
   *  {@link AgentTurnDispatch}); same result contract, no conversation. */
  executeFreshTaskRun?(input: ExecuteFreshTaskRunInput): Promise<TaskRunResult>;
}

const defaultDeps: ValidationFixDeps = {};

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
4. Re-run the specific check that reported the error, scoped to the files you changed, to confirm the fix landed.
5. Stage all fixed files with \`git add <file>\`.

IMPORTANT:
- Fix ALL errors listed in the validation output.
- Make minimal changes — only fix what the validation flagged.
- Do not refactor or change behavior beyond what is needed to pass validation.
- Stage every modified file with git add.
- You MAY run the project's linter, formatter, and typechecker directly (eslint, prettier, tsc, and any project-specific lint/architecture script), scoped to the files you changed. Not every error's remedy is legible in its message: an architecture or seam rule may name a violation whose sanctioned fix is a new module rather than the edit the message suggests, and a lint ratchet may report only a count. For those, re-running the check is the only way to know whether your change actually resolved it.
- Suppressing a check is not fixing it. Do not add allowlist, baseline, or ignore entries, and do not add inline disable comments, unless the rule's own message says that is the sanctioned remedy.
- Do NOT run the full validation script — it typically rebuilds the project and runs the whole test suite, which is slow. The caller re-runs it for you after you finish and feeds any remaining errors back.
- The output you were given may stop at the first failing check, so more errors can surface once yours are fixed. That is expected, not a sign your fix was wrong.`;

// ============================================================
// Temp File Management
// ============================================================

/**
 * A single filename component built from free text. The job id carries the
 * session name, and a session named after a ticket routinely contains "/" —
 * left raw, that names a directory nothing created and the write fails with
 * ENOENT before the fix agent takes its first turn. The length cap keeps the
 * result inside the 255-byte filename limit for a long session name.
 */
function toFilenameSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120);
}

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
  const filePath = path.join(
    dir,
    `${toFilenameSegment(jobId)}-attempt-${attempt}.txt`,
  );
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
  resolutionContext?: string;
}): string {
  const {
    validationOutput,
    validationOutputPath,
    validationCommand,
    resolutionContext,
  } = params;

  let commandContext = "";
  if (validationCommand) {
    commandContext = `\n\nThe validation script being run is: \`${validationCommand}\``;
  }
  const integrationContext = resolutionContext
    ? `\n\nThis validation covers integrated work from multiple lanes. The defect may originate in any lane described below:\n\n${resolutionContext}`
    : "";

  return [
    "Fix the following validation errors in this codebase.",
    commandContext,
    integrationContext,
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
  resolutionContext?: string;
}): string {
  const {
    validationOutput,
    validationOutputPath,
    validationCommand,
    resolutionContext,
  } = params;

  let commandContext = "";
  if (validationCommand) {
    commandContext = `\nThe validation script (\`${validationCommand}\`) was re-run after your previous fix attempt.`;
  }
  const integrationContext = resolutionContext
    ? `\nThe validation still covers integrated work from these lanes; reconsider any of them as the source of the remaining defect:\n\n${resolutionContext}`
    : "";

  return [
    "Your previous fix attempt did not fully resolve the validation errors.",
    commandContext,
    integrationContext,
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
  /** Required for `conversation` dispatch; for `fresh-run` it is only the
   *  preferred identity source and may be absent. */
  conversationId?: string;
  branchName: string;
  validationCommand?: string;
  resolutionContext?: string;
  /**
   * How the fix turn executes. `conversation` (default) routes through the
   * conversation actor. `fresh-run` executes a one-shot backend task in the
   * merge worktree — required for graph joins, whose enveloped implementer
   * conversations are filed under scratch cwds that a resume from the merge
   * worktree can never find (command-center#78).
   */
  agentTurnDispatch?: AgentTurnDispatch;
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
    resolutionContext,
    projectPath,
    sessionName,
    conversationId,
    isRetry,
  } = params;
  const dispatch = params.agentTurnDispatch ?? "conversation";
  const executeWorkflowTaskRun =
    deps.executeWorkflowTaskRun ?? defaultExecuteWorkflowTaskRun;

  logger.info("validation-fix.start", {
    worktreePath,
    projectPath,
    sessionName,
    conversationId,
    dispatch,
    isRetry: isRetry === true,
  });

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
          resolutionContext,
        })
      : buildFirstAttemptPrompt({
          validationOutput,
          validationOutputPath,
          validationCommand,
          resolutionContext,
        });

  if (dispatch === "fresh-run") {
    const executeFreshTaskRun =
      deps.executeFreshTaskRun ?? defaultExecuteFreshTaskRun;
    try {
      const result = await executeFreshTaskRun({
        projectPath,
        sessionName,
        ...(conversationId !== undefined
          ? { identityConversationId: conversationId }
          : {}),
        worktreePath,
        prompt,
        systemInstructions: VALIDATION_FIX_INSTRUCTIONS,
      });
      if (result.kind === "error") {
        logger.error("validation-fix.fresh_run_error", {
          worktreePath,
          error: result.error,
          aborted: result.aborted,
        });
        return { status: "failed", error: result.error };
      }
      logger.info("validation-fix.complete", { worktreePath, dispatch });
      return { status: "fixed" };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Unknown error";
      logger.error("validation-fix.fresh_run_dispatch_error", {
        worktreePath,
        error: errorMsg,
      });
      return { status: "failed", error: errorMsg };
    }
  }

  if (conversationId === undefined) {
    return {
      status: "failed",
      error:
        "Conversation dispatch requires a conversationId; callers without one must use the fresh-run dispatch",
    };
  }

  try {
    const result = await executeWorkflowTaskRun({
      projectPath,
      sessionName,
      conversationId,
      worktreePath,
      kind: "task_run",
      executionClass: "governed-execution",
      executionProfile: "standard",
      prompt,
      systemInstructions: VALIDATION_FIX_INSTRUCTIONS,
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
