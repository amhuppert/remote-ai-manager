/**
 * Invoke Claude Agent SDK to fix pre-merge validation errors in a session worktree.
 *
 * - Saves validation output to a temp file for the agent to read
 * - Tells the agent what validation command is being run (for context)
 * - Supports session resume for retry attempts (same conversation)
 * - The merge machine re-runs validation after this completes and retries if needed
 */

import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readConfig } from "./config";
import { createLogger } from "./logging";

const logger = createLogger("validation-fix");

// Prevent nested session detection when CC runs inside Claude Code
import "@/lib/sdk-env";

// ============================================================
// Public Types
// ============================================================

export type ValidationFixResult =
  | { status: "fixed"; claudeSessionId?: string }
  | { status: "failed"; error: string; claudeSessionId?: string };

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
// Session ID Extraction
// ============================================================

function extractSessionId(message: SDKMessage): string | undefined {
  if (message.type === "system" && "subtype" in message) {
    const sysMsg = message as SDKMessage & { session_id?: string };
    return sysMsg.session_id;
  }
  if (message.type === "result" && "session_id" in message) {
    return (message as SDKMessage & { session_id: string }).session_id;
  }
  return undefined;
}

// ============================================================
// Main Entry Point
// ============================================================

/**
 * Invoke Claude Agent SDK to fix validation errors in a session worktree.
 *
 * - Saves validation output to a temp file for the agent to reference
 * - On first attempt: creates a new persisted session
 * - On retry: resumes the previous session for accumulated context
 * - Returns the session ID so the caller can resume on retry
 */
export async function fixValidationErrors(params: {
  worktreePath: string;
  validationOutput: string;
  validationCommand?: string;
  projectPath?: string;
  sessionName?: string;
  branchName?: string;
  claudeSessionId?: string;
}): Promise<ValidationFixResult> {
  const { worktreePath, validationOutput, validationCommand, claudeSessionId } =
    params;
  const isRetry = claudeSessionId != null;

  logger.info("validation-fix.start", {
    worktreePath,
    isRetry,
    claudeSessionId,
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

  let sessionId: string | undefined;

  try {
    const abortController = new AbortController();

    // Safety-net timeout: abort if fix session exceeds configured max duration
    const timeoutHandle = setTimeout(() => {
      logger.warn("validation-fix.timeout", {
        worktreePath,
        timeoutMs: config.claudeTimeoutMs,
      });
      abortController.abort();
    }, config.claudeTimeoutMs);

    try {
      const stream = query({
        prompt,
        options: {
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: VALIDATION_FIX_INSTRUCTIONS,
          },
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          cwd: worktreePath,
          persistSession: true,
          resume: claudeSessionId,
          abortController,
          settingSources: ["user", "project", "local"],
          env: { CLAUDECODE: "" },
        },
      });

      // Consume the stream and extract the session ID for resume
      for await (const message of stream) {
        const id = extractSessionId(message);
        if (id) {
          sessionId = id;
        }
      }
    } finally {
      clearTimeout(timeoutHandle);
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Unknown SDK error";
    logger.error("validation-fix.sdk_error", {
      worktreePath,
      error: errorMsg,
    });
    return { status: "failed", error: errorMsg, claudeSessionId: sessionId };
  }

  logger.info("validation-fix.complete", {
    worktreePath,
    claudeSessionId: sessionId,
  });
  return { status: "fixed", claudeSessionId: sessionId };
}
