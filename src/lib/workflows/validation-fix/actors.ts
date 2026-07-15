/**
 * Actor logic (fromPromise) shared by every machine that embeds the
 * validation-fix loop (Smart Merge, Smart Commit).
 *
 * Each actor wraps an existing function from the codebase and provides
 * typed input/output for the XState machine to invoke. Machines register
 * these under the actor names the `createValidationFixStates` fragment
 * invokes: `runValidation`, `fixValidation`, `checkUncommitted`,
 * `commitChanges`.
 */

import { fromPromise } from "xstate";
import { createLogger } from "@/lib/logging";
import type { RepoValidationCommandResult } from "@/lib/projects/repo-config";
import type { GateFailResult } from "@/lib/workflows/primitives/gate-vocabulary";
import {
  scriptValidationGateFromOutcome,
  type ScriptValidationGateResult,
} from "@/lib/workflows/primitives/script-validation-gate";

const logger = createLogger("validation-fix-actors");

/**
 * Fallback conversation for conflict-resolution and validation-fix turns
 * when the machine input carries no explicit `conversationId`: the session's
 * most-recently-active conversation. Only safe when every session
 * conversation shares the session worktree (user-driven Smart Merge and
 * Smart Commit); graph joins must pass the source lane's conversation
 * explicitly instead. Throws when the session has no conversation so the
 * workflow fails loudly rather than dispatching against an undefined
 * identifier.
 */
export async function resolveSessionConversationId(
  projectPath: string,
  sessionName: string,
): Promise<string> {
  const { getSessionConversations } = await import("@/lib/state-store");
  const conversations = await getSessionConversations(projectPath, sessionName);
  const id = conversations[0]?.id;
  if (!id) {
    throw new Error(
      `No conversation found for session ${projectPath}::${sessionName}; cannot dispatch conflict-resolution / validation-fix turn`,
    );
  }
  return id;
}

// ============================================================
// Actor Input/Output Types
// ============================================================

export interface CheckUncommittedInput {
  worktreePath: string;
}
export interface CheckUncommittedOutput {
  hasChanges: boolean;
}

export interface CommitChangesInput {
  worktreePath: string;
  message: string;
  skipHooks?: boolean;
}
export interface CommitChangesOutput {
  hash: string;
}

export interface RunValidationInput {
  projectPath: string;
  worktreePath: string;
  sessionName: string;
  branchName: string;
  /**
   * Branch the work merges into, forwarded to the validation script as
   * `TARGET_BRANCH` so it scopes checks to the diff against that base. Omitted
   * by callers that have no distinct target (e.g. Smart Commit), letting the
   * script default to main.
   */
  targetBranch?: string;
  timeoutMs: number;
}
export type RunValidationOutput = void;

// ============================================================
// Merge/commit validation outcome mapping
// ============================================================

/**
 * Project a repo validation command result onto the shared script-validation
 * gate vocabulary. Returns `null` when the project has no `preMergeCommand`
 * configured — the merge and commit workflows treat that as "validation not
 * configured", not a failure.
 */
export function mergeValidationGateFromResult(
  result: RepoValidationCommandResult,
): ScriptValidationGateResult | null {
  if (!result.executed) return null;
  return scriptValidationGateFromOutcome(
    result.pass
      ? { kind: "pass" }
      : {
          kind: "fail",
          summary: result.message ?? "Pre-merge validation failed",
          timedOut: result.timedOut,
        },
  );
}

/**
 * Build the error the validation-fix loop consumes from a failing gate.
 * The fragment's transitions key on this shape: `message`/`gitOutput` feed
 * `extractErrorMessage` (the fix agent's validationOutput), and `timedOut`
 * feeds `isTimeoutError` (the unfixable-timeout short-circuit).
 */
export function validationFixLoopError(
  gate: GateFailResult,
  output: string,
): Error & { gitOutput?: string; timedOut?: boolean } {
  const err = new Error(gate.reason) as Error & {
    gitOutput?: string;
    timedOut?: boolean;
  };
  err.gitOutput = output || undefined;
  err.timedOut = gate.details?.timedOut === true;
  return err;
}

export interface MergeValidationDeps {
  readGlobalConfig(): Promise<{ preMergeTimeoutMs?: number }>;
  readRepoConfig(
    projectPath: string,
  ): Promise<{ preMergeTimeoutMs?: number } | null>;
  executeRepoValidationCommand(params: {
    projectPath: string;
    worktreePath: string;
    sessionName: string;
    branchName: string;
    targetBranch?: string;
    timeoutMs?: number;
  }): Promise<RepoValidationCommandResult>;
  hasUncommittedChanges(worktreePath: string): Promise<boolean>;
  commitChanges(
    worktreePath: string,
    message: string,
    options?: { skipHooks?: boolean },
  ): Promise<{ hash: string }>;
}

/**
 * Run the pre-merge validation script and interpret its result through the
 * script-validation gate: pass → auto-commit any script fixes so they land in
 * the squash merge; fail → throw the loop error the validation-fix fragment
 * routes on.
 */
export async function performMergeValidation(
  input: RunValidationInput,
  deps: MergeValidationDeps,
): Promise<void> {
  // Timeout precedence: per-repo `CommandCenter.json` `preMergeTimeoutMs` >
  // global config ("Limits and Timeouts") `preMergeTimeoutMs` > the machine's
  // hardcoded default (`input.timeoutMs`). Both config reads are best-effort —
  // an unreadable config falls through to the next source rather than failing
  // the merge. Reading the global config here is what lets the UI's global
  // timeout govern every merge path (manual and graph join), since no dispatch
  // site passes an explicit `validationTimeoutMs` into the machine.
  let globalTimeoutMs: number | undefined;
  try {
    globalTimeoutMs = (await deps.readGlobalConfig()).preMergeTimeoutMs;
  } catch {
    // Best-effort: fall through to the next timeout source.
  }

  let perRepoTimeoutMs: number | undefined;
  try {
    perRepoTimeoutMs = (await deps.readRepoConfig(input.projectPath))
      ?.preMergeTimeoutMs;
  } catch {
    // Best-effort: fall through to the next timeout source.
  }

  const timeoutMs = perRepoTimeoutMs ?? globalTimeoutMs ?? input.timeoutMs;

  const result = await deps.executeRepoValidationCommand({
    projectPath: input.projectPath,
    worktreePath: input.worktreePath,
    sessionName: input.sessionName,
    branchName: input.branchName,
    targetBranch: input.targetBranch,
    timeoutMs,
  });

  const gate = mergeValidationGateFromResult(result);
  if (!gate) {
    logger.info("validation_fix.validation_not_configured", {
      projectPath: input.projectPath,
      sessionName: input.sessionName,
    });
    return;
  }

  if (gate.status === "fail") {
    const timedOut = gate.details?.timedOut === true;
    logger.warn("validation_fix.validation_failed", {
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      worktreePath: input.worktreePath,
      timedOut,
      timeoutMs,
      reason: gate.reason,
    });
    throw validationFixLoopError(gate, result.output);
  }

  // Auto-commit any changes the script made (e.g. prettier/eslint auto-fixes)
  if (await deps.hasUncommittedChanges(input.worktreePath)) {
    logger.info("validation_fix.auto_commit_fixes", {
      sessionName: input.sessionName,
      worktreePath: input.worktreePath,
    });
    await deps.commitChanges(
      input.worktreePath,
      "auto-fix: pre-merge validation",
      { skipHooks: true },
    );
  }

  logger.info("validation_fix.validation_passed", {
    projectPath: input.projectPath,
    sessionName: input.sessionName,
  });
}

export interface FixValidationInput {
  worktreePath: string;
  validationOutput: string;
  projectPath: string;
  sessionName: string;
  /** Explicit conversation for the fix turn (graph joins pass the source
   *  lane's implementer conversation). Falls back to the session's
   *  most-recently-active conversation when omitted. */
  conversationId?: string;
  branchName: string;
  isRetry: boolean;
}
export interface FixValidationOutput {
  status: "fixed" | "failed";
  error?: string;
}

// ============================================================
// Actor Definitions
// ============================================================

/** Check if a worktree has uncommitted changes. */
export const checkUncommitted = fromPromise<
  CheckUncommittedOutput,
  CheckUncommittedInput
>(async ({ input }) => {
  const { hasUncommittedChanges } = await import("@/lib/git/commits");
  const hasChanges = await hasUncommittedChanges(input.worktreePath);
  return { hasChanges };
});

/** Commit changes in a worktree. */
export const commitChangesActor = fromPromise<
  CommitChangesOutput,
  CommitChangesInput
>(async ({ input }) => {
  const { commitChanges } = await import("@/lib/git/commits");
  const { hash } = await commitChanges(input.worktreePath, input.message, {
    skipHooks: input.skipHooks,
  });
  return { hash };
});

/** Run pre-merge validation (typecheck + tests). */
export const runValidation = fromPromise<
  RunValidationOutput,
  RunValidationInput
>(async ({ input }) => {
  const { executeRepoValidationCommand, readRepoConfig } =
    await import("@/lib/projects/repo-config");
  const { readConfig } = await import("@/lib/config/loader");
  const { hasUncommittedChanges, commitChanges } =
    await import("@/lib/git/commits");

  await performMergeValidation(input, {
    readGlobalConfig: readConfig,
    readRepoConfig,
    executeRepoValidationCommand,
    hasUncommittedChanges,
    commitChanges,
  });
});

/** Fix validation errors via the conversation actor. */
export const fixValidation = fromPromise<
  FixValidationOutput,
  FixValidationInput
>(async ({ input }) => {
  const { fixValidationErrors } =
    await import("@/lib/workflows/validation-fix");
  const { readRepoConfig } = await import("@/lib/projects/repo-config");
  const path = await import("node:path");

  // Resolve the validation command so the agent can verify its own fixes
  let validationCommand: string | undefined;
  try {
    const repoConfig = await readRepoConfig(input.projectPath);
    if (repoConfig?.preMergeCommand) {
      const scriptPath = path.default.isAbsolute(repoConfig.preMergeCommand)
        ? repoConfig.preMergeCommand
        : path.default.join(input.projectPath, repoConfig.preMergeCommand);
      validationCommand = scriptPath;
    }
  } catch {
    // Best-effort: if we can't read the config, the agent just won't verify
  }

  const conversationId =
    input.conversationId ??
    (await resolveSessionConversationId(input.projectPath, input.sessionName));

  logger.info("validation_fix.dispatch", {
    projectPath: input.projectPath,
    sessionName: input.sessionName,
    conversationId,
    branchName: input.branchName,
    isRetry: input.isRetry,
  });

  const result = await fixValidationErrors({
    worktreePath: input.worktreePath,
    validationOutput: input.validationOutput,
    validationCommand,
    projectPath: input.projectPath,
    sessionName: input.sessionName,
    conversationId,
    branchName: input.branchName,
    isRetry: input.isRetry,
  });

  logger.info("validation_fix.result", {
    projectPath: input.projectPath,
    sessionName: input.sessionName,
    conversationId,
    status: result.status,
  });

  return {
    status: result.status === "fixed" ? "fixed" : "failed",
    error: result.status === "failed" ? result.error : undefined,
  };
});
