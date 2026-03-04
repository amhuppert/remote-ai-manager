/**
 * Invoke Claude Agent SDK to fix pre-merge validation errors in a session worktree.
 *
 * Follows the same pattern as conflict-resolution.ts:
 * - Gives Claude the validation output so it knows what to fix
 * - Claude edits files and stages them with git add
 * - No structured JSON output needed — the validation script re-runs to verify
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { readConfig } from "./config";
import { createLogger } from "./logging";

const logger = createLogger("validation-fix");

// Prevent nested session detection when CC runs inside Claude Code
import "@/lib/sdk-env";

// ============================================================
// Public Types
// ============================================================

export type ValidationFixResult =
  | { status: "fixed" }
  | { status: "failed"; error: string };

// ============================================================
// System Prompt
// ============================================================

const VALIDATION_FIX_INSTRUCTIONS = `You are a code quality specialist. Your task is to fix validation errors in this codebase.

You will be given the output of a validation script that failed. The errors may include:
- ESLint violations (e.g., @typescript-eslint/no-explicit-any, unused variables)
- TypeScript type errors (e.g., error TS2345)
- Prettier formatting issues
- Test failures

Follow these steps precisely:

1. Analyze the validation output to identify all errors.
2. For each error, read the relevant file and fix the issue.
3. Stage all fixed files with \`git add <file>\`.

IMPORTANT:
- Fix ALL errors listed in the validation output.
- Make minimal changes — only fix what the validation flagged.
- Do not refactor or change behavior beyond what is needed to pass validation.
- Stage every modified file with git add.
- Do NOT run the validation script yourself — the caller will re-run it.`;

// ============================================================
// Main Entry Point
// ============================================================

/**
 * Invoke Claude Agent SDK to fix validation errors in a session worktree.
 *
 * - Sends the validation output as context so Claude knows what to fix
 * - Claude reads files, makes edits, and stages changes
 * - Returns "fixed" if the SDK session completed without error
 * - The caller is responsible for re-running validation to verify the fix
 */
export async function fixValidationErrors(params: {
  worktreePath: string;
  validationOutput: string;
}): Promise<ValidationFixResult> {
  const { worktreePath, validationOutput } = params;

  logger.info("validation-fix.start", { worktreePath });

  let config;
  try {
    config = await readConfig();
  } catch (err) {
    const errorMsg =
      err instanceof Error ? err.message : "Failed to read config";
    logger.error("validation-fix.config_error", { error: errorMsg });
    return { status: "failed", error: errorMsg };
  }

  const prompt = `Fix the following validation errors in this codebase:\n\n\`\`\`\n${validationOutput}\n\`\`\`\n\nFollow the instructions in your system prompt precisely.`;

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
          persistSession: false,
          abortController,
          settingSources: ["user", "project", "local"],
          env: { CLAUDECODE: "" },
        },
      });

      // Consume the stream — we don't need to parse output,
      // just let Claude make its edits
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _message of stream) {
        // no-op: stream must be consumed for SDK to complete
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
    return { status: "failed", error: errorMsg };
  }

  logger.info("validation-fix.complete", { worktreePath });
  return { status: "fixed" };
}
