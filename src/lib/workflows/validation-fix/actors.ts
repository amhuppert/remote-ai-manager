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

import { randomUUID } from "node:crypto";
import { fromPromise } from "xstate";
import type { PerRepoConfig } from "@/lib/config/schemas";
import { createLogger } from "@/lib/logging";
import { defaultGitClient } from "@/lib/git/client";
import type { CandidateValidationFact } from "@/lib/jobs/schemas";
import { getValidationService } from "@/lib/validation/singleton";
import type {
  ValidationService,
  ValidationSubmission,
  ValidationSystemCommandRef,
} from "@/lib/validation/service";
import { waitForSystemValidationCompletion } from "@/lib/validation/service";
import type { ValidationRunResult } from "@/lib/validation/schemas";
import type { GateFailResult } from "@/lib/workflows/primitives/gate-vocabulary";
import { scriptValidationGateFromOutcome } from "@/lib/workflows/primitives/script-validation-gate";
import { getErrorMessage } from "@/lib/shared/errors";
import type {
  MergeValidationSource,
  ValidationCommandSelection,
  ValidationWorkflowRef,
} from "./types";

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
  source: MergeValidationSource;
  selection: ValidationCommandSelection;
  conversationId?: string;
  workflow?: ValidationWorkflowRef;
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
export type RunValidationOutput = CandidateValidationFact | null;

// ============================================================
// Merge/commit validation outcome mapping
// ============================================================

/**
 * Build the error the validation-fix loop consumes from a failing gate.
 * The fragment's transitions key on this shape: `message`/`gitOutput` feed
 * `extractErrorMessage` (the fix agent's validationOutput), and `timedOut`
 * feeds `isTimeoutError` (the unfixable-timeout short-circuit).
 */
export function validationFixLoopError(
  gate: GateFailResult,
  output: string,
): Error & {
  gitOutput?: string;
  timedOut?: boolean;
  validationFailureClass: "validation_failed";
} {
  const err = new Error(gate.reason) as Error & {
    gitOutput?: string;
    timedOut?: boolean;
    validationFailureClass: "validation_failed";
  };
  err.gitOutput = output || undefined;
  err.timedOut = gate.details?.timedOut === true;
  err.validationFailureClass = "validation_failed";
  return err;
}

export function nonRemediableValidationError(
  message: string,
  cause?: unknown,
): Error & { validationFailureClass: "infrastructure" } {
  const error = new Error(message) as Error & {
    validationFailureClass: "infrastructure";
    cause?: unknown;
  };
  error.validationFailureClass = "infrastructure";
  if (cause !== undefined) error.cause = cause;
  return error;
}

export function isRemediableValidationFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "validationFailureClass" in error &&
    error.validationFailureClass === "validation_failed"
  );
}

export interface MergeValidationDeps {
  readRepoConfig(projectPath: string): Promise<PerRepoConfig | null>;
  validationService: Pick<
    ValidationService,
    "submitSystem" | "waitForCompletion" | "cancelSystemOwned"
  >;
  hasUncommittedChanges(worktreePath: string): Promise<boolean>;
  commitChanges(
    worktreePath: string,
    message: string,
    options?: { skipHooks?: boolean },
  ): Promise<{ hash: string }>;
  resolveGitObject(worktreePath: string, ref: string): Promise<string>;
  createValidationRef(): string;
}

interface SelectedValidationCommand {
  identity: string;
  command: ValidationSystemCommandRef;
}

function selectPreMergeCommands(
  repoConfig: PerRepoConfig | null | undefined,
): SelectedValidationCommand[] {
  return (repoConfig?.validation?.preMerge ?? []).map((name) => ({
    identity: name,
    command: { kind: "registered", name },
  }));
}

function selectValidationCommands(
  repoConfig: PerRepoConfig | null | undefined,
  selection: ValidationCommandSelection,
): SelectedValidationCommand[] {
  if (selection.mode === "only") {
    return selection.commands.map((name) => ({
      identity: name,
      command: { kind: "registered", name },
    }));
  }
  return selectPreMergeCommands(repoConfig);
}

function submissionError(
  commandName: string,
  submission: Exclude<ValidationSubmission, { kind: "accepted" }>,
): Error {
  if (submission.kind === "invalid") {
    return nonRemediableValidationError(submission.message);
  }
  const result = submission.result;
  switch (result.kind) {
    case "command_not_found":
      return nonRemediableValidationError(
        `Validation command "${commandName}" is not registered; known commands: ${
          result.knownCommands.length > 0
            ? result.knownCommands.join(", ")
            : "(none)"
        }`,
      );
    case "cost_exceeds_limit":
      return nonRemediableValidationError(
        `Validation command "${commandName}" costs ${result.cost}, exceeding the concurrency limit ${result.limit}`,
      );
    case "capacity_unavailable":
      return nonRemediableValidationError(
        `Validation command "${commandName}" was refused despite system wait mode`,
      );
    case "skipped_by_policy":
      return nonRemediableValidationError(
        `Validation command "${commandName}" was unexpectedly skipped by agent policy`,
      );
  }
}

function terminalResultError(
  commandName: string,
  result: ValidationRunResult,
): Error | null {
  if (result.kind === "passed") return null;
  if (result.kind === "failed" && result.exitCode === null) {
    const detail = result.output.trim();
    return nonRemediableValidationError(
      `Validation command "${commandName}" could not be spawned${detail.length > 0 ? `: ${detail}` : ""}`,
    );
  }
  if (result.kind === "failed" || result.kind === "timed_out") {
    const timedOut = result.kind === "timed_out";
    const reason = timedOut
      ? `Validation command "${commandName}" timed out after ${result.timeoutMs}ms`
      : `Validation command "${commandName}" failed`;
    const gate = scriptValidationGateFromOutcome({
      kind: "fail",
      summary: reason,
      timedOut,
    });
    return validationFixLoopError(gate, result.output);
  }
  if (result.kind === "cancelled" || result.kind === "interrupted") {
    return nonRemediableValidationError(
      `Validation command "${commandName}" was ${result.kind.replace("_", " ")}`,
    );
  }
  return nonRemediableValidationError(
    `Validation command "${commandName}" returned unexpected result ${result.kind}`,
  );
}

/**
 * Run the ordered pre-merge validation selection through the shared service.
 * Each command independently acquires and releases capacity; only a terminal
 * command failure reaches the validation-fix loop.
 */
export async function performMergeValidation(
  input: RunValidationInput,
  deps: MergeValidationDeps,
  signal?: AbortSignal,
): Promise<RunValidationOutput> {
  let repoConfig: PerRepoConfig | null;
  try {
    repoConfig = await deps.readRepoConfig(input.projectPath);
  } catch (error) {
    const message = getErrorMessage(error);
    logger.error("validation_fix.repo_config_unavailable", {
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      error: message,
    });
    throw nonRemediableValidationError(
      `Unable to read repository validation configuration: ${message}`,
      error,
    );
  }

  const selection = selectValidationCommands(repoConfig, input.selection);
  if (selection.length === 0) {
    logger.info("validation_fix.validation_not_configured", {
      projectPath: input.projectPath,
      sessionName: input.sessionName,
    });
    return null;
  }

  for (const selected of selection) {
    if (signal?.aborted) {
      throw nonRemediableValidationError(
        "Validation was cancelled before the command could be submitted",
      );
    }
    let submission: ValidationSubmission;
    try {
      submission = await deps.validationService.submitSystem({
        source: input.source,
        command: selected.command,
        scope: "changed",
        projectPath: input.projectPath,
        ...(input.conversationId !== undefined
          ? { conversationId: input.conversationId }
          : {}),
        ...(input.workflow !== undefined ? { workflow: input.workflow } : {}),
        target: {
          worktreePath: input.worktreePath,
          sessionName: input.sessionName,
          branchName: input.branchName,
          targetBranch: input.targetBranch,
          ...(input.workflow ? { contextId: input.workflow.contextId } : {}),
        },
      });
    } catch (error) {
      throw nonRemediableValidationError(getErrorMessage(error), error);
    }
    if (submission.kind !== "accepted") {
      logger.error("validation_fix.validation_not_started", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        commandName: selected.identity,
        result:
          submission.kind === "invalid"
            ? submission.reason
            : submission.result.kind,
      });
      throw submissionError(selected.identity, submission);
    }

    let result: ValidationRunResult;
    try {
      result = await waitForSystemValidationCompletion(
        deps.validationService,
        submission.runId,
        signal,
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "validationFailureClass" in error
      ) {
        throw error;
      }
      throw nonRemediableValidationError(getErrorMessage(error), error);
    }
    const error = terminalResultError(selected.identity, result);
    if (!error) continue;
    logger.warn("validation_fix.validation_failed", {
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      worktreePath: input.worktreePath,
      commandName: selected.identity,
      runId: submission.runId,
      outcome: result.kind,
      timedOut: result.kind === "timed_out",
      reason: error.message,
    });
    throw error;
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

  const [validatedSha, validatedTreeHash] = await Promise.all([
    deps.resolveGitObject(input.worktreePath, "HEAD"),
    deps.resolveGitObject(input.worktreePath, "HEAD^{tree}"),
  ]);
  const fact: CandidateValidationFact = {
    validationRef: deps.createValidationRef(),
    validatedSha,
    validatedTreeHash,
    commandIdentity: selection.map(({ identity }) => identity).join("+"),
    outcome: "pass",
  };
  logger.info("validation_fix.candidate_fact_created", {
    projectPath: input.projectPath,
    sessionName: input.sessionName,
    validationRef: fact.validationRef,
    validatedSha: fact.validatedSha,
    validatedTreeHash: fact.validatedTreeHash,
    commandIdentity: fact.commandIdentity,
    outcome: fact.outcome,
  });
  return fact;
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
  resolutionContext?: string;
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

export function createRunValidationActor(
  loadDeps: () => Promise<MergeValidationDeps>,
) {
  return fromPromise<RunValidationOutput, RunValidationInput>(
    async ({ input, signal }) =>
      performMergeValidation(input, await loadDeps(), signal),
  );
}

/** Run pre-merge validation (typecheck + tests). */
export const runValidation = createRunValidationActor(async () => {
  const { readRepoConfig } = await import("@/lib/projects/repo-config");
  const { hasUncommittedChanges, commitChanges } =
    await import("@/lib/git/commits");

  return {
    readRepoConfig,
    validationService: {
      submitSystem: (request) => getValidationService().submitSystem(request),
      waitForCompletion: (runId) =>
        getValidationService().waitForCompletion(runId),
      cancelSystemOwned: (runId) =>
        getValidationService().cancelSystemOwned(runId),
    },
    hasUncommittedChanges,
    commitChanges,
    async resolveGitObject(worktreePath, ref) {
      const { stdout } = await defaultGitClient.git(
        ["rev-parse", ref],
        worktreePath,
      );
      const resolved = stdout.trim();
      if (!resolved) {
        throw new Error(`git rev-parse ${ref} returned empty output`);
      }
      return resolved;
    },
    createValidationRef: randomUUID,
  };
});

/** Fix validation errors via the conversation actor. */
export const fixValidation = fromPromise<
  FixValidationOutput,
  FixValidationInput
>(async ({ input }) => {
  const { fixValidationErrors } =
    await import("@/lib/workflows/validation-fix");
  const { readRepoConfig } = await import("@/lib/projects/repo-config");

  // Give the fix turn stable registry identities, never the underlying script
  // path that would bypass server-side admission if executed directly.
  let validationCommand: string | undefined;
  try {
    const repoConfig = await readRepoConfig(input.projectPath);
    validationCommand = repoConfig?.validation?.preMerge.join("+");
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
    resolutionContext: input.resolutionContext,
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
